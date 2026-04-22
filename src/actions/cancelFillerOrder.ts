import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
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
    // Give the form a beat to react to the change (some Amazon forms
    // enable the submit button only after a reason is picked).
    await page.waitForTimeout(500);
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
