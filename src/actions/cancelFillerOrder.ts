import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
import { findCancelItemsLinkOnOrderDetails } from '../parsers/amazonCheckout.js';
import {
  bodySample,
  clickRequestCancellation,
  isCancelConfirmed,
  isCancelRefused,
  openCancelPage,
  waitForCancelOutcome,
} from './cancelForm.js';

export type CancelOrderResult =
  | { ok: true; itemsChecked: number }
  | { ok: false; reason: string; detail?: string };

/**
 * Cancel every item in a not-yet-shipped Amazon order via the preship
 * cancel-items form. Used for our "filler-only" orders — Amazon often
 * fans a single Place Order click into multiple orders by shipping
 * group, and the orders that don't contain the target item are pure
 * filler noise we want to remove ASAP (before any of it ships).
 *
 * Best-effort. Failures return ok:false with a reason — the caller is
 * expected to retry or queue for a later sweep. Never throws.
 */
export async function cancelFillerOrder(
  page: Page,
  orderId: string,
  opts: { correlationId?: string } = {},
): Promise<CancelOrderResult> {
  const cid = opts.correlationId;
  logger.info('step.cancelFillerOrder.start', { orderId }, cid);

  const opened = await openCancelPage(page, orderId);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason, ...(opened.detail ? { detail: opened.detail } : {}) };
  }
  const here = page.url();

  // Tick every item checkbox in the form. Amazon's form ships each
  // item as an <input type="checkbox" name="itemId[…]"> or similar;
  // we select every visible + enabled + unchecked checkbox inside the
  // main form. Unrelated page-level checkboxes (marketing opt-ins,
  // etc.) should fail the visibility / form-membership check.
  const checkedCount = await page
    .evaluate(() => {
      // Scope to any form on the cancel page — excludes header/footer
      // checkboxes (newsletter signup etc).
      const forms = Array.from(document.querySelectorAll('form'));
      const primary = forms.find((f) =>
        /cancel/i.test(f.getAttribute('action') || '') ||
        /cancel/i.test(f.getAttribute('name') || '') ||
        f.querySelector('input[name*="itemId" i], input[name*="orderItem" i]'),
      );
      const scope: ParentNode = primary ?? document;
      const boxes = Array.from(
        scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      let count = 0;
      for (const cb of boxes) {
        if (cb.disabled) continue;
        if (cb.offsetParent === null && cb.getClientRects().length === 0) continue;
        if (cb.checked) {
          count++;
          continue;
        }
        cb.click();
        count++;
      }
      return count;
    })
    .catch(() => 0);

  if (checkedCount === 0) {
    return {
      ok: false,
      reason: 'no item checkboxes found on cancel page',
      detail: `url=${here}`,
    };
  }

  // Amazon's preship-cancel form almost always requires a cancellation
  // reason before it'll accept the submit — either a <select> dropdown
  // or a radio group. Pick the first non-default option (typically
  // "No longer needed") so the form validates. Best-effort; silent
  // success if no reason widget is on the page.
  const reasonChosen = await page
    .evaluate(() => {
      // Strategy 1: <select> with name/id hinting at reason.
      const sel = document.querySelector<HTMLSelectElement>(
        'select[name*="reason" i], select[id*="reason" i], select[name*="cancelReason" i]',
      );
      if (sel && sel.options.length > 1) {
        // Skip placeholder "Select a reason" (usually option 0 or empty
        // value). Pick the first real option.
        let pickIdx = -1;
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i];
          if (!opt) continue;
          const t = (opt.textContent ?? '').trim();
          if (!opt.value || /^(select|choose|--|please)/i.test(t)) continue;
          pickIdx = i;
          break;
        }
        if (pickIdx >= 0) {
          sel.selectedIndex = pickIdx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          const chosen = sel.options[pickIdx];
          return { via: 'select', text: (chosen?.textContent ?? '').trim() };
        }
      }
      // Strategy 2: radio group for reason.
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name*="reason" i]',
        ),
      );
      const firstRadio = radios.find(
        (r) => !r.disabled && r.offsetParent !== null,
      );
      if (firstRadio) {
        firstRadio.click();
        const label =
          firstRadio.closest('label')?.textContent?.trim() ||
          firstRadio.getAttribute('aria-label') ||
          '';
        return { via: 'radio', text: label.slice(0, 80) };
      }
      return null;
    })
    .catch(() => null);
  if (reasonChosen) {
    logger.info(
      'step.cancelFillerOrder.reason.selected',
      { via: reasonChosen.via, text: reasonChosen.text },
      cid,
    );
    // Wait until the submit button actually enables instead of guessing
    // 500ms. Amazon's reason-required forms toggle disabled→enabled in
    // ~50-200ms after the change event; the 2s ceiling covers any
    // pathological hydration delay.
    await page
      .waitForFunction(
        () => {
          const submit = document.querySelector(
            'input[name*="cancel" i][type="submit"]:not([disabled]), button[name*="cancel" i]:not([disabled])',
          );
          return !!submit;
        },
        undefined,
        { timeout: 2_000 },
      )
      .catch(() => undefined);
  }

  const submitted = await clickRequestCancellation(page);
  if (!submitted.clicked) {
    return {
      ok: false,
      reason: 'Request Cancellation submit button not found',
      detail: `itemsChecked=${checkedCount}`,
    };
  }

  // Amazon may either navigate to a confirmation page or re-render the
  // same page with a success/refusal banner. Poll up to 15s — a bare
  // sleep wasn't enough: the confirmation widget is often still
  // spinning when we probe, and we'd return "no confirmation detected"
  // while the page was actively succeeding.
  await waitForCancelOutcome(page);

  // First: did Amazon tell us the order can't be cancelled? That's a
  // terminal state ("Unable to cancel requested items. We apologize
  // for the inconvenience. You can return the eligible items after
  // they arrive for a refund.") — usually means the items already
  // started shipping or Amazon's algorithm locked them from pre-ship
  // cancellation. No amount of retrying will fix this; the caller
  // (verify phase) should handle via return/refund instead.
  if (await isCancelRefused(page)) {
    return {
      ok: false,
      reason:
        'Amazon refused: unable to cancel requested items (already processing, shipped, or locked from pre-ship cancel)',
      detail: `url=${page.url()}`,
    };
  }

  if (!(await isCancelConfirmed(page))) {
    // Capture a sample of the body so we can see what Amazon actually
    // rendered — a validation error ("please select a reason"), a
    // confirmation worded in a way our regex missed, or a modal we
    // didn't handle.
    const sample = await bodySample(page, 300);
    return {
      ok: false,
      reason: 'no cancellation confirmation detected after submit',
      detail:
        `url=${page.url()}, itemsChecked=${checkedCount}, ` +
        `clickedVia=${submitted.clicked ? submitted.via : 'none'}, ` +
        `bodySample="${sample}"`,
    };
  }

  logger.info(
    'step.cancelFillerOrder.ok',
    { orderId, itemsChecked: checkedCount },
    cid,
  );
  return { ok: true, itemsChecked: checkedCount };
}

/**
 * Order-details fallback for filler-order cancellation.
 *
 * Some not-yet-shipped Amazon orders redirect the direct
 * `/progress-tracker/.../cancel-items?orderID=…` URL away (the
 * primary `cancelFillerOrder` flow's `openCancelPage` returns a "not
 * on cancel-items page" reason in that case). The same orders DO
 * still expose a "Cancel items" link/button on their order-details
 * page (`/gp/your-account/order-details?orderID=…`) — that link
 * leads to the same cancel-items form, but Amazon only routes to it
 * via the order-details page for these particular orders.
 *
 * Flow: open order-details → parse the page for the "Cancel items"
 * link → if found, navigate to it and reuse the existing
 * `clickRequestCancellation` / `waitForCancelOutcome` form-submit
 * code path. Best-effort, never throws.
 *
 * This is the LAST attempt for a given filler order — caller (the
 * `cancelFillerOrdersOnly` retry loop) only runs it once after the
 * primary cancel-items-page approach has exhausted its 3 tries.
 */
export async function cancelFillerOrderViaOrderDetails(
  page: Page,
  orderId: string,
  opts: { correlationId?: string } = {},
): Promise<CancelOrderResult> {
  const cid = opts.correlationId;
  logger.info('step.cancelFillerOrderViaOrderDetails.start', { orderId }, cid);

  const detailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;
  try {
    await page.goto(detailsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'failed to load order-details page',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  // The cancel-items link + `[data-component="cancelled"]` blocks are
  // server-side rendered (verified via raw HTTP fetch — 60 data-component
  // attrs in the SSR HTML, the cancel link is in the static markup). So
  // both targets are in the DOM the moment `domcontentloaded` settles —
  // the previous blind `waitForTimeout(1_500)` was pure padding.
  // Replace with an event-driven selector wait that fires immediately on
  // cancellable orders and falls through silently on already-shipped
  // ones (the next page.evaluate then returns `cancelHref: null` and we
  // report "no cancel link" exactly as before). Saves up to 1,450ms per
  // cancel-detail nav (× up to 3 phases per filler buy).
  await page
    .waitForSelector(
      '[data-component="cancelled"], a[href*="preship/cancel-items"]',
      { timeout: 1_500 },
    )
    .catch(() => undefined);

  // Pull the parser-friendly snapshot of the page and feed it to the
  // pure helper. Keeps detection logic testable from a saved fixture.
  const linkInfo = await page
    .evaluate(() => {
      const cancelledBlocks = Array.from(
        document.querySelectorAll('[data-component="cancelled"]'),
      );
      let alreadyCancelled = false;
      for (const block of cancelledBlocks) {
        const t = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (/cancel/i.test(t)) {
          alreadyCancelled = true;
          break;
        }
      }
      const anchors = Array.from(
        document.querySelectorAll('a[href]'),
      ) as HTMLAnchorElement[];
      // Mirror parser strategy 1→3 inline so we don't need to ship the
      // helper into the page context (Playwright's evaluate runs in the
      // browser, not Node).
      let cancelHref: string | null = null;
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        if (/\/progress-tracker\/package\/preship\/cancel-items\b/i.test(href)) {
          cancelHref = href;
          break;
        }
      }
      if (!cancelHref) {
        for (const a of anchors) {
          const href = a.getAttribute('href') ?? '';
          if (/cancel_items/i.test(href)) {
            cancelHref = href;
            break;
          }
        }
      }
      if (!cancelHref) {
        for (const a of anchors) {
          const label = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (/^cancel items?$/i.test(label)) {
            cancelHref = a.getAttribute('href') ?? '';
            if (cancelHref) break;
          }
        }
      }
      return { cancelHref, alreadyCancelled };
    })
    .catch(
      (): ReturnType<typeof findCancelItemsLinkOnOrderDetails> => ({
        cancelHref: null,
        alreadyCancelled: false,
      }),
    );

  if (linkInfo.alreadyCancelled && !linkInfo.cancelHref) {
    // Order-details says it's already cancelled — count it as success.
    logger.info(
      'step.cancelFillerOrderViaOrderDetails.alreadyCancelled',
      { orderId },
      cid,
    );
    return { ok: true, itemsChecked: 0 };
  }

  if (!linkInfo.cancelHref) {
    return {
      ok: false,
      reason:
        'no cancel-items link on order-details page — order likely already shipped or otherwise not cancellable',
      detail: `url=${page.url()}`,
    };
  }

  // Resolve the (likely relative) href against amazon.com and navigate.
  let absoluteHref: string;
  try {
    absoluteHref = new URL(linkInfo.cancelHref, 'https://www.amazon.com').toString();
  } catch {
    return {
      ok: false,
      reason: 'failed to parse cancel-items link href',
      detail: `href=${linkInfo.cancelHref}`,
    };
  }

  try {
    await page.goto(absoluteHref, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'failed to navigate to cancel-items link',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  // The cancel-items form (with its checkboxes) is server-side rendered
  // — same SSR pattern as order-details above. Replace the blind 1500ms
  // padding with an event-driven selector wait. Falls through silently
  // when the page didn't land on /cancel-items (the URL check below
  // catches that case explicitly).
  await page
    .waitForSelector('form input[type="checkbox"]', { timeout: 1_500 })
    .catch(() => undefined);

  // We should now be on the same cancel-items form `openCancelPage`
  // would have given us — verify, then reuse the same submit/confirm
  // flow as the primary path.
  const here = page.url();
  if (!/cancel-items/i.test(here)) {
    return {
      ok: false,
      reason:
        'order-details cancel link did not land on cancel-items form (redirected away)',
      detail: `url=${here}`,
    };
  }

  const checkedCount = await page
    .evaluate(() => {
      const forms = Array.from(document.querySelectorAll('form'));
      const primary = forms.find(
        (f) =>
          /cancel/i.test(f.getAttribute('action') || '') ||
          /cancel/i.test(f.getAttribute('name') || '') ||
          f.querySelector('input[name*="itemId" i], input[name*="orderItem" i]'),
      );
      const scope: ParentNode = primary ?? document;
      const boxes = Array.from(
        scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      let count = 0;
      for (const cb of boxes) {
        if (cb.disabled) continue;
        if (cb.offsetParent === null && cb.getClientRects().length === 0) continue;
        if (cb.checked) {
          count++;
          continue;
        }
        cb.click();
        count++;
      }
      return count;
    })
    .catch(() => 0);

  if (checkedCount === 0) {
    return {
      ok: false,
      reason: 'no item checkboxes found on cancel page (via order-details)',
      detail: `url=${here}`,
    };
  }

  // Reason picker — same as primary flow.
  await page
    .evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>(
        'select[name*="reason" i], select[id*="reason" i], select[name*="cancelReason" i]',
      );
      if (sel && sel.options.length > 1) {
        let pickIdx = -1;
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i];
          if (!opt) continue;
          const t = (opt.textContent ?? '').trim();
          if (!opt.value || /^(select|choose|--|please)/i.test(t)) continue;
          pickIdx = i;
          break;
        }
        if (pickIdx >= 0) {
          sel.selectedIndex = pickIdx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name*="reason" i]',
        ),
      );
      const firstRadio = radios.find(
        (r) => !r.disabled && r.offsetParent !== null,
      );
      if (firstRadio) firstRadio.click();
    })
    .catch(() => undefined);
  await page.waitForTimeout(500);

  const submitted = await clickRequestCancellation(page);
  if (!submitted.clicked) {
    return {
      ok: false,
      reason:
        'Request Cancellation submit button not found (via order-details)',
      detail: `itemsChecked=${checkedCount}`,
    };
  }

  await waitForCancelOutcome(page);

  if (await isCancelRefused(page)) {
    return {
      ok: false,
      reason:
        'Amazon refused via order-details: unable to cancel requested items',
      detail: `url=${page.url()}`,
    };
  }

  if (!(await isCancelConfirmed(page))) {
    const sample = await bodySample(page, 300);
    return {
      ok: false,
      reason:
        'no cancellation confirmation detected after submit (via order-details)',
      detail:
        `url=${page.url()}, itemsChecked=${checkedCount}, ` +
        `clickedVia=${submitted.clicked ? submitted.via : 'none'}, ` +
        `bodySample="${sample}"`,
    };
  }

  logger.info(
    'step.cancelFillerOrderViaOrderDetails.ok',
    { orderId, itemsChecked: checkedCount },
    cid,
  );
  return { ok: true, itemsChecked: checkedCount };
}
