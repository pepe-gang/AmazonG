import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../shared/logger.js';
import { findCashbackPct, parsePrice } from '../parsers/amazonProduct.js';
import { parseOrderConfirmation } from '../parsers/amazonCheckout.js';
import type { BuyResult } from '../shared/types.js';

type BuyOptions = {
  dryRun: boolean;
  minCashbackPct: number;
  maxPrice: number | null;
  allowedAddressPrefixes: string[];
  correlationId?: string;
  /** Directory for debug screenshots captured on silent checkout failures. */
  debugDir?: string;
};

/**
 * Drop a full-page screenshot into `debugDir` for ambiguous checkout
 * failures (e.g. confirmation URL never loads, address picker in an
 * unrecognized layout). Best-effort: never throws; returns null if the
 * caller didn't configure a debugDir.
 */
async function captureDebugShot(
  page: Page,
  debugDir: string | undefined,
  tag: string,
): Promise<string | null> {
  if (!debugDir) return null;
  try {
    await mkdir(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(debugDir, `${ts}_${tag}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}

type StepEmitter = (message: string, data?: Record<string, unknown>) => void;

const CHECKOUT_PLACE_SELECTORS = [
  'input[name="placeYourOrder1"]',
  '#submitOrderButtonId input',
  '#submitOrderButtonId button',
  'input[aria-labelledby*="submitOrderButton"]',
  '#placeYourOrder1 input[type="submit"]',
  'input[data-testid="place-order-button"]',
  'span#bottomSubmitOrderButtonId input',
];

/**
 * Drive a real Amazon checkout from the product page that's ALREADY loaded
 * in `page`. The workflow shares its product-page tab with this action so
 * we don't re-navigate (saves a page load + keeps cookies/session warm).
 *
 * Mirrors old AutoG's `driveCheckout` end-to-end: click Buy Now → wait for
 * /spc → verify price + address + cashback (with BG1/BG2 name-toggle
 * fallback) → place order.
 *
 * On dry-run, stops right before clicking "Place Order" and reports what
 * WOULD have happened.
 */
export async function buyNow(page: Page, opts: BuyOptions): Promise<BuyResult> {
  const cid = opts.correlationId;
  const step: StepEmitter = (message, data) => logger.info(message, data, cid);
  const warn: StepEmitter = (message, data) => logger.warn(message, data, cid);

  try {
    step('step.buy.start', { dryRun: opts.dryRun, productUrl: page.url() });

    // 1. Confirm the page is on a product page with a Buy Now button.
    //    scrapeProduct already loaded + hydrated the page; just verify the
    //    button is still there before clicking.
    try {
      await page.waitForSelector('#buy-now-button', { state: 'visible', timeout: 10_000 });
    } catch (err) {
      return fail('buy_click', 'buy-now button never appeared', String(err));
    }

    // 1.5. Set quantity to the highest numeric option in the #quantity
    //      dropdown (skipping "10+" / custom-input entries). Mirrors old
    //      AutoG — BG always wants the max units per order. Best-effort:
    //      products with no dropdown (qty fixed at 1) just skip cleanly.
    const qty = await setMaxQuantity(page);
    if (qty.ok) {
      step('step.buy.quantity.set', {
        selected: qty.selected,
        options: qty.allOptions,
      });
    } else {
      step('step.buy.quantity.skip', { reason: qty.reason });
    }

    // 2. Click Buy Now.
    step('step.buy.click', { button: 'buy-now' });
    try {
      await page.locator('#buy-now-button').first().click({ timeout: 10_000 });
    } catch (err) {
      return fail('buy_click', 'failed to click Buy Now', String(err));
    }

    // 3. Wait for /spc — may show "Deliver to this address" interstitial
    //    first. Pass the allowed prefixes so the interstitial path picks
    //    the right radio (otherwise Amazon may default to a non-allowed
    //    saved address and we'd ship there).
    const checkoutPage = await waitForCheckout(
      page,
      opts.allowedAddressPrefixes,
      opts.debugDir,
    );
    if (!checkoutPage.ok) {
      // Amazon's "This item is currently unavailable" page is a terminal
      // failure — surface as item_unavailable so BG sees the real reason.
      if (checkoutPage.kind === 'unavailable') {
        warn('step.buy.unavailable', { reason: checkoutPage.reason, detail: checkoutPage.detail });
        return fail('item_unavailable', checkoutPage.reason, checkoutPage.detail);
      }
      return fail('checkout_wait', checkoutPage.reason, checkoutPage.detail);
    }
    step('step.buy.checkout', { detected: checkoutPage.detected });

    // 4. Checkout[0]: re-verify item price on /spc (catches taxes/shipping
    //    that push the total past the retail cap).
    if (opts.maxPrice !== null) {
      const priceCheck = await verifyCheckoutPrice(page, opts.maxPrice);
      if (!priceCheck.ok) {
        warn('step.checkout.price.fail', {
          observed: priceCheck.priceText,
          max: opts.maxPrice,
          reason: priceCheck.reason,
        });
        return fail('checkout_price', priceCheck.reason, priceCheck.detail);
      }
      step('step.checkout.price.ok', {
        observed: priceCheck.priceText,
        max: opts.maxPrice,
      });
    }

    // 5. Checkout[1]: verify + (if needed) select the delivery address.
    if (opts.allowedAddressPrefixes.length > 0) {
      const addr = await ensureAddress(page, opts.allowedAddressPrefixes, { step, warn });
      if (!addr.ok) {
        return fail('checkout_address', addr.reason, addr.detail);
      }
      step('step.checkout.address.ok', {
        matchedPrefix: addr.prefix,
        current: addr.current,
      });
    }

    // 6. Checkout[1.5]: pick the delivery option with the highest cashback.
    //    Many /spc pages show multiple shipping-speed radios where the
    //    default selection has a lower N% back than a slower option. Mirror
    //    old AutoG — scan non-address/payment radio groups, find the best
    //    "N% back" option (≥ minCashbackPct), click it.
    const delivery = await pickBestCashbackDelivery(page, opts.minCashbackPct);
    if (delivery.changes.length > 0) {
      step('step.checkout.delivery.picked', { changes: delivery.changes });
      // Let the page settle after the radio click — Amazon re-renders the
      // total + cashback banner and sometimes re-evaluates "place order"
      // button state after delivery updates.
      await page.waitForTimeout(1_500);
    } else {
      step('step.checkout.delivery.nochange', {
        note: 'default delivery already optimal (or no options found)',
      });
    }

    // 7. Checkout[2]: cashback gate. If below minimum, try the BG1/BG2
    //    name-toggle workaround before giving up.
    let cashbackPct = await readCashbackOnPage(page);
    step('step.buy.cashback', {
      pct: cashbackPct,
      minRequired: opts.minCashbackPct,
      pass: cashbackPct !== null && cashbackPct >= opts.minCashbackPct,
    });
    if (cashbackPct === null || cashbackPct < opts.minCashbackPct) {
      // Dry-run still runs the BG1/BG2 toggle (it's part of the workflow we
      // need to verify). The ONLY thing dry-run skips is the final Place
      // Order click. Saved-address mutations are intentional.
      warn('step.buy.cashback.retry', { via: 'bg-name-toggle' });
      const toggled = await toggleBGNameAndRetry(page, opts.allowedAddressPrefixes, {
        step,
        warn,
      });
      if (!toggled.ok) {
        return fail('cashback_gate', toggled.reason, toggled.detail);
      }
      cashbackPct = toggled.cashbackPct;
      step('step.buy.cashback.retry.ok', {
        pct: cashbackPct,
        minRequired: opts.minCashbackPct,
      });
      if (cashbackPct === null || cashbackPct < opts.minCashbackPct) {
        return fail(
          'cashback_gate',
          cashbackPct === null ? 'cashback missing' : `cashback ${cashbackPct}%`,
        );
      }
    }

    // 8. Dry-run gate — stop before clicking Place Order. Treat as a
    //    POSITIVE outcome: every check passed, the only thing skipped was
    //    the final irreversible click.
    if (opts.dryRun) {
      step('step.buy.dryrun.success', {
        cashbackPct,
        message: `✓ Dry run successful — order would have been placed (cashback ${cashbackPct ?? 'n/a'}%). Skipped Place Order click.`,
      });
      return {
        ok: true,
        dryRun: true,
        orderId: null,
        finalPrice: null,
        finalPriceText: null,
        cashbackPct,
      };
    }

    // 9. Pre-place settle. Amazon can flag orders submitted mid-render
    //    after a delivery/address update — match old AutoG's 1-second
    //    pause before the Place Order click.
    step('step.buy.place.settle', { waitMs: 1_000 });
    await page.waitForTimeout(1_000);

    // 10. Click Place Order.
    const placeLocator = await findPlaceOrderLocator(page);
    if (!placeLocator) {
      return fail('place_order', 'no Place Order button selector matched');
    }
    try {
      await placeLocator.click({ timeout: 10_000 });
    } catch (err) {
      return fail('place_order', 'failed to click Place Order', String(err));
    }
    step('step.buy.place', { clicked: true });

    // 11. Wait for confirmation. Amazon may show a "This is a pending
    //     order — you placed an order for these items recently. Do you want
    //     to place the same order again?" interstitial first; if so, click
    //     "Place your order" once to confirm.
    const confirmWait = await waitForConfirmationOrPending(page, step);
    if (!confirmWait.ok) {
      // Capture what's on screen — often Amazon stalled the redirect or
      // showed an unexpected interstitial we don't yet recognize. Path is
      // logged so the user can find the PNG under userData/debug-screenshots.
      const shotPath = await captureDebugShot(page, opts.debugDir, 'confirm_parse');
      if (shotPath) {
        warn('step.buy.confirm.screenshot', { path: shotPath, currentUrl: page.url() });
      }
      return fail('confirm_parse', confirmWait.reason);
    }
    // Optional: parse the confirmation page for the final price (the
    // orderId pulled from it is unreliable — recommendation sections and
    // "items you may like" carousels can contain stale order ids that
    // would false-match our regex). Order id comes from Your Orders below.
    const confirmationHtml = await page.content();
    const confirmation = parseOrderConfirmation(
      new JSDOM(confirmationHtml).window.document,
      page.url(),
    );

    // 12. Canonical orderId source: navigate to Your Orders and grep the
    //     most recent "Order # 123-…" — matches old AutoG. Most-recent
    //     wins because the just-placed order sits at the top.
    step('step.buy.orderid.fetch', { url: 'https://www.amazon.com/gp/css/order-history' });
    const orderId = await fetchOrderIdFromHistory(page).catch(() => null);
    if (!orderId) {
      warn('step.buy.orderid.notfound', {
        note: 'order-history page did not reveal a parseable order id within 10s',
      });
    }

    step('step.buy.placed', {
      orderId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
    });

    return {
      ok: true,
      dryRun: false,
      orderId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
      cashbackPct,
    };
  } catch (err) {
    return fail('confirm_parse', 'unexpected error in buyNow flow', String(err));
  }
  // Note: page lifecycle is managed by the caller (workflow) so we don't
  // close it here. The workflow needs to share the same page with the
  // earlier scrape step.
}

/* ============================================================
   Sub-steps
   ============================================================ */

type CheckoutReadyResult =
  | { ok: true; detected: string }
  | { ok: false; reason: string; detail?: string; kind?: 'unavailable' | 'timeout' };

async function waitForCheckout(
  page: Page,
  allowedAddressPrefixes: string[] = [],
  debugDir?: string,
): Promise<CheckoutReadyResult> {
  // Poll for either a Place Order button (success — we're on /spc), a
  // "Deliver to this address" button (interstitial — Amazon parked us at the
  // address picker after Buy Now), or Amazon's "This item is currently
  // unavailable" error page (terminal — bail fast). When we see the address
  // picker we first select the radio whose street matches our allowed
  // prefixes (otherwise Amazon ships to whatever default it preselected),
  // then click the deliver button. Mirrors old AutoG with the prefix gate
  // pulled forward into the early Buy Now → /spc transition.
  const deadline = Date.now() + 30_000;
  let deliverClickedTimes = 0;
  const MAX_DELIVER_CLICKS = 3;

  while (Date.now() < deadline) {
    const state = await page
      .evaluate((placeSelectors) => {
        const body = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ');

        // 0. Terminal failure — Amazon's "This item is currently
        //    unavailable" page. Surface its message to the worker.
        if (
          /this item is currently unavailable/i.test(body) ||
          /items?\s+you selected\s+(are|is)\s+not available/i.test(body)
        ) {
          const headline = body.match(/this item is currently unavailable/i)?.[0];
          const detail = body.match(
            /sorry,\s*the items?\s+you selected[^.]*\.?/i,
          )?.[0];
          return {
            kind: 'unavailable' as const,
            message: headline ? headline.trim() : 'This item is currently unavailable',
            detail: detail ? detail.trim().slice(0, 250) : null,
          };
        }

        // 1. Place Order — terminal success state.
        for (const s of placeSelectors) {
          const el = document.querySelector(s) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            return { kind: 'place' as const, sel: s };
          }
        }
        // 2. Look for an "Deliver to this address" labeled element. Amazon
        //    uses several wrappers (span/button/input), so match by visible
        //    text rather than a specific selector.
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('span, button, input, a'),
        );
        for (const el of candidates) {
          if (el.offsetParent === null) continue;
          const label = (
            (el as HTMLInputElement).value ||
            el.getAttribute('aria-label') ||
            el.textContent ||
            ''
          ).trim();
          if (/^deliver to this address$/i.test(label)) {
            return { kind: 'deliver' as const, label };
          }
        }
        // 3. "Make updates to your items" confirm page — a Buy-Now/cart
        //    pre-checkout panel where Amazon asks us to verify quantity +
        //    address before moving on. Gate the Continue-button click on
        //    this exact headline so we don't accidentally click a random
        //    "Continue" elsewhere on the page flow.
        if (/make updates to your items/i.test(body)) {
          return { kind: 'updates' as const };
        }
        return { kind: 'none' as const };
      }, CHECKOUT_PLACE_SELECTORS)
      .catch(() => ({ kind: 'none' as const }));

    if (state.kind === 'place') {
      return { ok: true, detected: state.sel };
    }

    if (state.kind === 'unavailable') {
      return {
        ok: false,
        kind: 'unavailable',
        reason: state.message,
        ...(state.detail ? { detail: state.detail } : {}),
      };
    }

    if (state.kind === 'deliver') {
      if (deliverClickedTimes >= MAX_DELIVER_CLICKS) {
        return {
          ok: false,
          reason: `Deliver button persisted after ${MAX_DELIVER_CLICKS} clicks`,
        };
      }

      // Before clicking Deliver, make sure the radio that's currently
      // selected matches one of our allowed house-number prefixes. If a
      // matching radio exists but isn't selected, click it first; if none
      // matches, bail with a clear reason rather than ship to whatever
      // Amazon defaulted to.
      if (allowedAddressPrefixes.length > 0) {
        const pick = await selectAllowedAddressRadio(page, allowedAddressPrefixes);
        if (!pick.ok) {
          // Capture the picker we couldn't parse — saved addresses can
          // render in new layouts Amazon rolls out without warning, and a
          // screenshot is the fastest way to see what we saw.
          const shotPath = await captureDebugShot(page, debugDir, 'address_picker');
          if (shotPath) {
            logger.warn(
              'step.checkout.address.picker.screenshot',
              { path: shotPath, currentUrl: page.url() },
            );
          }
          return { ok: false, reason: `address picker: ${pick.reason}` };
        }
      }

      // Click via the same DOM walk so we hit the visible "Deliver to this
      // address" element (avoids the id collision with the modal's Use button).
      const clicked = await page
        .evaluate(() => {
          const all = Array.from(
            document.querySelectorAll<HTMLElement>('span, button, input, a'),
          );
          const btn = all.find((el) => {
            if (el.offsetParent === null) return false;
            const label = (
              (el as HTMLInputElement).value ||
              el.getAttribute('aria-label') ||
              el.textContent ||
              ''
            ).trim();
            return /^deliver to this address$/i.test(label);
          });
          if (!btn) return false;
          btn.click();
          return true;
        })
        .catch(() => false);

      if (!clicked) {
        // Couldn't click for some reason — short pause and retry.
        await page.waitForTimeout(500);
        continue;
      }
      deliverClickedTimes += 1;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(1_000);
      continue;
    }

    if (state.kind === 'updates') {
      const clicked = await page
        .evaluate(() => {
          // Prefer a submit-input labeled "Continue" (yellow primary
          // button); fall back to any visible element whose label/value
          // is exactly "Continue".
          const submit = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input[type="submit"], button[type="submit"]',
            ),
          ).find((el) => {
            if (el.offsetParent === null) return false;
            const label = (el.value || el.getAttribute('aria-label') || el.textContent || '').trim();
            return /^continue$/i.test(label);
          });
          if (submit) {
            submit.click();
            return true;
          }
          const fallback = Array.from(
            document.querySelectorAll<HTMLElement>('span, button, input, a'),
          ).find((el) => {
            if (el.offsetParent === null) return false;
            const label = (
              (el as HTMLInputElement).value ||
              el.getAttribute('aria-label') ||
              el.textContent ||
              ''
            ).trim();
            return /^continue$/i.test(label);
          });
          if (!fallback) return false;
          fallback.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) {
        await page.waitForTimeout(500);
        continue;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(1_000);
      continue;
    }

    await page.waitForTimeout(500);
  }
  return { ok: false, reason: 'Place Order button never appeared in 30s' };
}

/**
 * On the Buy-Now address picker (`/checkout/.../address`), inspect every
 * destination radio. If the currently checked one already matches an
 * allowed prefix, do nothing. Otherwise pick the first radio whose street
 * starts with an allowed prefix and click it. If none match, fail loudly —
 * we'd rather abort than ship to an unintended address.
 */
async function selectAllowedAddressRadio(
  page: Page,
  allowedPrefixes: string[],
): Promise<{ ok: true; selected: string } | { ok: false; reason: string }> {
  const result = await page
    .evaluate((prefixes) => {
      const norm = (s: string) =>
        s.replace(/[\s,]+/g, ' ').trim().toLowerCase();
      const matches = (street: string) =>
        prefixes.some((p) => norm(street).startsWith(p.toLowerCase()));

      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name="destinationSubmissionUrl"]',
        ),
      );
      if (radios.length === 0) return { kind: 'no-radios' as const };

      const rows = radios.map((r) => {
        const li = r.closest('li, [class*="address-row"], [class*="address"]');
        const text = ((li as HTMLElement | null)?.innerText || '').replace(
          /\s+/g,
          ' ',
        );
        // Pull the first chunk of digits we see — Amazon's row text starts
        // with the recipient name then "<housenum> <street>, <city>, ...".
        const m = text.match(/(\d{2,6}[^,]*),/);
        const street = ((m && m[1]) || text).trim();
        return { radio: r, street, checked: r.checked };
      });

      const checkedMatch = rows.find((r) => r.checked && matches(r.street));
      if (checkedMatch) {
        return { kind: 'ok' as const, selected: checkedMatch.street, action: 'kept' as const };
      }

      const target = rows.find((r) => matches(r.street));
      if (!target) {
        return {
          kind: 'no-match' as const,
          observed: rows.map((r) => r.street).slice(0, 5),
        };
      }
      target.radio.click();
      return { kind: 'ok' as const, selected: target.street, action: 'clicked' as const };
    }, allowedPrefixes)
    .catch((err: unknown) => ({
      kind: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
    }));

  if (result.kind === 'ok') {
    if (result.action === 'clicked') {
      // Amazon needs a beat for the radio click to register before the
      // submit URL on the form is updated.
      await page.waitForTimeout(500);
    }
    return { ok: true, selected: result.selected };
  }
  if (result.kind === 'no-radios') {
    return { ok: false, reason: 'no destination radios on /address page' };
  }
  if (result.kind === 'no-match') {
    return {
      ok: false,
      reason: `no saved address starts with an allowed prefix (saw: ${result.observed.join(' | ') || 'nothing'})`,
    };
  }
  return { ok: false, reason: result.message };
}

type PriceCheckResult =
  | { ok: true; priceText: string; price: number }
  | { ok: false; priceText: string | null; price: number | null; reason: string; detail?: string };

async function verifyCheckoutPrice(page: Page, cap: number): Promise<PriceCheckResult> {
  // Per-item price lives in `.lineitem-container` on the standard /spc
  // layout; Amazon also uses a legacy "subtotals" panel and a newer
  // `[data-feature-id*="line-item"]` template on some A/B branches. Wait
  // briefly for ANY of these to render, then probe each.
  await page
    .waitForSelector(
      '.lineitem-container, [data-feature-id*="line-item"], #subtotals, .order-summary-line-item, #order-summary',
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const result = await page
    .evaluate(() => {
      // Collect candidate price strings from each known layout.
      const candidates: { source: string; text: string }[] = [];

      const pushFromContainers = (containerSel: string, source: string) => {
        const containers = Array.from(document.querySelectorAll(containerSel));
        for (const c of containers) {
          const inner = (c.querySelector('.lineitem-price-text') ??
            c.querySelector('.a-price .a-offscreen') ??
            c.querySelector('.a-color-price') ??
            c.querySelector('.a-price')) as HTMLElement | null;
          const t = inner ? (inner.textContent ?? '').trim() : '';
          if (t) candidates.push({ source, text: t });
        }
      };

      pushFromContainers('.lineitem-container', 'lineitem-container');
      pushFromContainers('[data-feature-id*="line-item"]', 'line-item-feature');
      pushFromContainers('.order-summary-line-item', 'order-summary-line-item');

      // Fallback: scan all visible .a-price .a-offscreen anywhere in the
      // checkout main column (#order-summary / .a-section). This catches
      // layouts where line items render without our exact container class.
      if (candidates.length === 0) {
        const main = document.querySelector('#subtotals, #order-summary, main, .a-section');
        if (main) {
          const offs = Array.from(main.querySelectorAll<HTMLElement>('.a-price .a-offscreen'));
          for (const o of offs) {
            const t = (o.textContent ?? '').trim();
            if (t) candidates.push({ source: 'fallback-a-offscreen', text: t });
          }
        }
      }

      const parsed = candidates
        .map((c) => {
          const m = c.text.replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
          return m ? { raw: c.text, source: c.source, n: parseFloat(m[0]) } : null;
        })
        .filter(
          (p): p is { raw: string; source: string; n: number } =>
            !!p && Number.isFinite(p.n) && p.n > 0,
        );
      // Pick the max — same as AutoG (conservative cap check).
      parsed.sort((a, b) => b.n - a.n);
      return {
        candidatesSeen: candidates.length,
        sources: Array.from(new Set(parsed.map((p) => p.source))),
        chosen: parsed[0] ?? null,
      };
    })
    .catch(() => ({
      candidatesSeen: 0,
      sources: [] as string[],
      chosen: null as null,
    }));

  if (!result.chosen) {
    return {
      ok: false,
      priceText: null,
      price: null,
      reason: `could not read item price on /spc (no price candidates found across known layouts)`,
      detail: `candidates seen: ${result.candidatesSeen}`,
    };
  }
  const price = result.chosen.n;
  if (price > cap) {
    return {
      ok: false,
      priceText: result.chosen.raw,
      price,
      reason: `checkout price $${price.toFixed(2)} exceeds retail cap $${cap.toFixed(2)}`,
    };
  }
  return { ok: true, priceText: result.chosen.raw, price };
}

type AddrResult =
  | { ok: true; current: string; prefix: string }
  | { ok: false; reason: string; detail?: string };

async function ensureAddress(
  page: Page,
  allowedPrefixes: string[],
  emit: { step: StepEmitter; warn: StepEmitter },
): Promise<AddrResult> {
  const matcher = new RegExp('\\b(' + allowedPrefixes.join('|') + ')\\s+[A-Za-z0-9]');

  // Fast path: if the current /spc address's house number already matches
  // one of the allowed prefixes, we're done.
  const current = await readCurrentAddress(page);
  emit.step('step.checkout.address.check', { current, allowedHouseNumbers: allowedPrefixes });
  const match = current.match(matcher);
  if (match) {
    return { ok: true, current, prefix: match[1] ?? '' };
  }

  // Slow path: open the address picker, submit the matching saved address.
  emit.warn('step.checkout.address.change', { current, allowedHouseNumbers: allowedPrefixes });
  const openedHref = await page
    .evaluate(() => {
      const link =
        document.querySelector('a.expand-panel-button[href*="/address"]') ??
        document.querySelector('#change-delivery-link');
      const href = link?.getAttribute('href');
      if (!href) return null;
      const abs = new URL(href, location.origin).toString();
      // Navigate explicitly — .click() is intercepted by the collapsed-panel
      // handler on some Amazon layouts.
      location.href = abs;
      return abs;
    })
    .catch(() => null);
  if (!openedHref) {
    return { ok: false, reason: 'change-address link not found on /spc' };
  }
  try {
    await page.waitForURL(/\/checkout\/p\/[^/]+\/address/i, { timeout: 15_000 });
  } catch {
    return {
      ok: false,
      reason: 'address picker did not load',
      detail: `stuck at ${page.url()}`,
    };
  }

  const picked = await page
    .evaluate(async (prefixes) => {
      const matchRe = new RegExp('\\b(' + prefixes.join('|') + ')\\s+[A-Za-z0-9]');
      let radios: HTMLInputElement[] = [];
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        radios = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="radio"][name="destinationSubmissionUrl"]',
          ),
        );
        if (radios.length > 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (radios.length === 0) {
        return { ok: false as const, reason: 'picker_list_not_loaded' };
      }
      for (const r of radios) {
        const form = r.closest('form');
        const card =
          r.closest('.a-radio.a-radio-fancy') ?? (r.parentElement as Element | null);
        const text = ((card as HTMLElement)?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const m = text.match(matchRe);
        if (m) {
          if (!form) {
            return {
              ok: false as const,
              reason: 'matched_but_no_form',
              text: text.slice(0, 150),
            };
          }
          form.submit();
          return {
            ok: true as const,
            text: text.slice(0, 150),
            prefix: m[1],
            checked: r.checked,
          };
        }
      }
      return {
        ok: false as const,
        reason: 'no_matching_address_in_list',
        candidates: radios.map((r) => {
          const card =
            r.closest('.a-radio.a-radio-fancy') ?? (r.parentElement as Element | null);
          return ((card as HTMLElement)?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 150);
        }),
      };
    }, allowedPrefixes)
    .catch((err) => ({ ok: false as const, reason: 'picker_eval_error', detail: String(err) }));

  if (!picked.ok) {
    const reasonMap: Record<string, string> = {
      picker_list_not_loaded: 'address picker opened but no saved-address radios rendered',
      no_matching_address_in_list: `no saved address starts with [${allowedPrefixes.join(', ')}]`,
      matched_but_no_form: 'matched an address card but could not find its <form>',
    };
    const detail =
      'candidates' in picked && picked.candidates
        ? ` — candidates: ${picked.candidates.join(' | ')}`
        : '';
    return {
      ok: false,
      reason: reasonMap[picked.reason] ?? `address error (${picked.reason})`,
      ...(detail ? { detail: detail.trim() } : {}),
    };
  }

  // Wait for redirect back to /spc.
  try {
    await page.waitForURL(/\/gp\/buy\/spc|\/checkout\/p\/[^/]+\/spc/i, { timeout: 20_000 });
  } catch {
    return {
      ok: false,
      reason: 'address submitted but did not redirect back to /spc',
      detail: `stuck at ${page.url()}`,
    };
  }
  // Wait for /spc UI to re-render (Place Order button).
  const ready = await waitForCheckout(page);
  if (!ready.ok) {
    return { ok: false, reason: 'after address change, /spc did not re-render' };
  }

  // Re-read address to verify the change actually took effect.
  const after = await readCurrentAddress(page);
  const afterMatch = after.match(matcher);
  if (!afterMatch) {
    return {
      ok: false,
      reason: 'address submitted but /spc still shows a different address',
      detail: after,
    };
  }
  return { ok: true, current: after, prefix: afterMatch[1] ?? '' };
}

async function readCurrentAddress(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el = document.querySelector(
        '#deliver-to-address-text, #checkout-delivery-address-panel',
      );
      return ((el as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim();
    })
    .catch(() => '');
}

async function readCashbackOnPage(page: Page): Promise<number | null> {
  const html = await page.content();
  const doc = new JSDOM(html).window.document;
  return findCashbackPct(doc);
}

type ToggleResult =
  | { ok: true; cashbackPct: number | null; from: string; to: string }
  | { ok: false; reason: string; detail?: string };

async function toggleBGNameAndRetry(
  page: Page,
  allowedPrefixes: string[],
  emit: { step: StepEmitter; warn: StepEmitter },
): Promise<ToggleResult> {
  if (allowedPrefixes.length === 0) {
    return { ok: false, reason: 'no allowed prefixes configured — cannot locate address to edit' };
  }

  // 1. Reopen the address picker from /spc.
  const reopened = await page
    .evaluate(() => {
      const link =
        document.querySelector('a.expand-panel-button[href*="/address"]') ??
        document.querySelector('#change-delivery-link');
      const href = link?.getAttribute('href');
      if (!href) return false;
      location.href = new URL(href, location.origin).toString();
      return true;
    })
    .catch(() => false);
  if (!reopened) {
    return { ok: false, reason: "couldn't reopen address picker for name toggle" };
  }
  try {
    await page.waitForURL(/\/checkout\/p\/[^/]+\/address/i, { timeout: 15_000 });
  } catch {
    return { ok: false, reason: 'address picker did not reopen' };
  }

  // 2. Find the matching radio index, click its "Edit" link.
  const opened = await page
    .evaluate(async (prefixes) => {
      const matchRe = new RegExp('\\b(' + prefixes.join('|') + ')\\s+[A-Za-z0-9]');
      let radios: HTMLInputElement[] = [];
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        radios = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[type="radio"][name="destinationSubmissionUrl"]',
          ),
        );
        if (radios.length > 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      let idx = -1;
      radios.forEach((r, i) => {
        if (idx >= 0) return;
        const card =
          r.closest('.a-radio.a-radio-fancy') ?? (r.parentElement as Element | null);
        const text = ((card as HTMLElement)?.innerText ?? '').replace(/\s+/g, ' ');
        if (matchRe.test(text)) idx = i;
      });
      if (idx < 0) return { ok: false as const, reason: 'no_matching_address_for_edit' };
      const editLink = document.querySelector<HTMLElement>(
        '#edit-address-desktop-tango-sasp-' + idx,
      );
      if (!editLink) return { ok: false as const, reason: 'no_edit_link', index: idx };
      editLink.click();
      return { ok: true as const, index: idx };
    }, allowedPrefixes)
    .catch((err) => ({ ok: false as const, reason: 'edit_eval_error', detail: String(err) }));
  if (!opened.ok) {
    return { ok: false, reason: `name-toggle: ${opened.reason}` };
  }
  emit.step('step.buy.cashback.toggle.edit', { index: opened.index });

  // 3. Wait for the edit modal and toggle (BG1) ↔ (BG2).
  const toggled = await page
    .evaluate(async () => {
      const d = Date.now() + 8_000;
      let input: HTMLInputElement | null = null;
      while (Date.now() < d) {
        input = document.querySelector<HTMLInputElement>(
          '#address-ui-widgets-enterAddressFullName',
        );
        if (input && input.offsetParent !== null) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!input) return { ok: false as const, reason: 'name_input_not_visible' };

      const current = input.value ?? '';
      let next: string;
      if (/\(BG2\)/.test(current)) next = current.replace(/\(BG2\)/, '(BG1)');
      else if (/\(BG1\)/.test(current)) next = current.replace(/\(BG1\)/, '(BG2)');
      else return { ok: false as const, reason: 'no_bg_suffix', current };

      // Find the modal/popover that contains the input. Amazon reuses the
      // SAME id `checkout-primary-continue-button-id` for both the modal's
      // "Use this address" button AND the picker's "Deliver to this address"
      // button outside the modal. We must scope our click to the modal,
      // otherwise we'd hit the wrong button and submit the picker without
      // ever saving the edit.
      const modal =
        input.closest('.a-popover, [role="dialog"], [id^="a-popover"]') ??
        input.closest('[id*="modal" i]');

      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // Don't .blur() — Amazon may treat blur as "user finished editing"
      // and close the modal before we can click "Use this address".
      await new Promise((r) => setTimeout(r, 1_000));

      const clickUse = (): boolean => {
        // Prefer the modal-scoped lookup. Falls back to a text search for
        // any visible element labeled "Use this address" (NOT "Deliver to
        // this address").
        let btn: HTMLElement | null = null;
        if (modal) {
          btn = modal.querySelector<HTMLElement>(
            '#checkout-primary-continue-button-id, #checkout-primary-continue-button-id-announce',
          );
        }
        if (!btn) {
          const all = Array.from(document.querySelectorAll<HTMLElement>('span, button, input'));
          btn =
            all.find((el) => {
              if (el.offsetParent === null) return false;
              const label = (
                (el as HTMLInputElement).value ||
                el.textContent ||
                ''
              ).trim();
              return /^use this address$/i.test(label);
            }) ?? null;
        }
        if (!btn) return false;
        btn.click();
        return true;
      };

      if (!clickUse()) {
        return { ok: false as const, reason: 'no_use_button', from: current, to: next };
      }

      // Poll for the modal's button to disappear (= edit committed).
      // First-click sometimes triggers a "Review your address — we couldn't
      // verify…" warning; we click "Use this address" again on detection.
      // Matches old AutoG's reconfirm loop.
      const isBtnGone = (): boolean => {
        if (modal) {
          const b = modal.querySelector<HTMLElement>('#checkout-primary-continue-button-id');
          if (b && b.offsetParent !== null) return false;
        }
        // Fallback: any visible "Use this address" element still on the page
        const all = Array.from(document.querySelectorAll<HTMLElement>('span, button, input'));
        const stillThere = all.some((el) => {
          if (el.offsetParent === null) return false;
          const label = ((el as HTMLInputElement).value || el.textContent || '').trim();
          return /^use this address$/i.test(label);
        });
        return !stillThere;
      };

      let reconfirmed = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        if (isBtnGone()) break;
        const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
        if (
          !reconfirmed &&
          /Review your address|couldn.?t verify your address|verify your address/i.test(bodyText)
        ) {
          reconfirmed = true;
          clickUse();
        }
      }
      if (!isBtnGone()) {
        return {
          ok: false as const,
          reason: 'use_button_never_disappeared',
          from: current,
          to: next,
          reconfirmed,
        };
      }
      return { ok: true as const, from: current, to: next, reconfirmed };
    })
    .catch((err) => ({ ok: false as const, reason: 'toggle_eval_error', detail: String(err) }));
  if (!toggled.ok) {
    return { ok: false, reason: `name-toggle: ${toggled.reason}` };
  }
  emit.step('step.buy.cashback.toggle.submit', {
    from: toggled.from,
    to: toggled.to,
    reconfirmed: toggled.reconfirmed,
  });

  // 4. Wait for redirect back to /spc.
  try {
    await page.waitForURL(/\/gp\/buy\/spc|\/checkout\/p\/[^/]+\/spc/i, { timeout: 20_000 });
  } catch {
    return {
      ok: false,
      reason: 'name-toggle: submitted but did not return to /spc',
      detail: `stuck at ${page.url()}`,
    };
  }
  const ready = await waitForCheckout(page);
  if (!ready.ok) {
    return { ok: false, reason: 'name-toggle: /spc did not re-render after toggle' };
  }

  // 5. Re-read cashback.
  const cashbackPct = await readCashbackOnPage(page);
  return { ok: true, cashbackPct, from: toggled.from, to: toggled.to };
}

/**
 * After clicking Place Order, wait for either the confirmation page OR
 * Amazon's "This is a pending order" duplicate-order interstitial. On the
 * pending page, click "Place your order" again (up to 3 times) to confirm.
 *
 * Returns ok when we land on a confirmation URL, fail otherwise.
 */
async function waitForConfirmationOrPending(
  page: Page,
  step: StepEmitter,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + 60_000;
  let pendingClicks = 0;
  const MAX_PENDING_CLICKS = 3;

  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        const url = location.href;
        if (
          /thankyou|orderconfirm|order-confirmation|\/gp\/buy\/spc\/handlers\/display|\/gp\/css\/order-details/i.test(
            url,
          )
        ) {
          return { kind: 'confirmation' as const, url };
        }
        const body = (
          (document.body && document.body.innerText) ||
          ''
        ).replace(/\s+/g, ' ');
        const isPending = /this is a pending order/i.test(body);
        if (isPending) {
          // Try multiple ways to find the "Place your order" button on the
          // pending page. Order matters: id-based selectors first, text
          // match last (since "Cancel this pending order" must NOT match).
          const idCandidates = [
            'input[name="placeYourOrder1"]',
            '#placeYourOrder1 input[type="submit"]',
            '#submitOrderButtonId input',
            '#submitOrderButtonId button',
            'input[data-testid="place-order-button"]',
          ];
          for (const sel of idCandidates) {
            const el = document.querySelector<HTMLElement>(sel);
            if (el && el.offsetParent !== null) {
              return { kind: 'pending' as const, viaSelector: sel, found: true };
            }
          }
          // Text fallback: find a visible element labeled exactly "Place
          // your order" (NOT "Cancel this pending order").
          const all = Array.from(
            document.querySelectorAll<HTMLElement>('span, button, input, a'),
          );
          const placeBtn = all.find((el) => {
            if (el.offsetParent === null) return false;
            const label = (
              (el as HTMLInputElement).value ||
              el.textContent ||
              ''
            ).trim();
            return /^place your order$/i.test(label);
          });
          return { kind: 'pending' as const, viaText: !!placeBtn, found: !!placeBtn };
        }
        return { kind: 'none' as const, url };
      })
      .catch(() => ({ kind: 'none' as const, url: '' }));

    if (state.kind === 'confirmation') {
      return { ok: true };
    }

    if (state.kind === 'pending') {
      if (!state.found) {
        return {
          ok: false,
          reason: 'pending order page shown but no Place your order button found',
        };
      }
      if (pendingClicks >= MAX_PENDING_CLICKS) {
        return {
          ok: false,
          reason: `pending order page persisted after ${MAX_PENDING_CLICKS} re-click attempts`,
        };
      }
      step('step.buy.pending.confirm', {
        attempt: pendingClicks + 1,
        via: 'viaSelector' in state ? state.viaSelector : 'text-match',
      });
      const clicked = await page
        .evaluate(() => {
          const idCandidates = [
            'input[name="placeYourOrder1"]',
            '#placeYourOrder1 input[type="submit"]',
            '#submitOrderButtonId input',
            '#submitOrderButtonId button',
            'input[data-testid="place-order-button"]',
          ];
          for (const sel of idCandidates) {
            const el = document.querySelector<HTMLElement>(sel);
            if (el && el.offsetParent !== null) {
              el.click();
              return true;
            }
          }
          const all = Array.from(
            document.querySelectorAll<HTMLElement>('span, button, input, a'),
          );
          const btn = all.find((el) => {
            if (el.offsetParent === null) return false;
            const label = (
              (el as HTMLInputElement).value ||
              el.textContent ||
              ''
            ).trim();
            return /^place your order$/i.test(label);
          });
          if (!btn) return false;
          btn.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) {
        return { ok: false, reason: 'pending order page: failed to click Place your order' };
      }
      pendingClicks += 1;
      // Generous wait — Amazon sometimes takes a few seconds before the
      // page navigates to the confirmation URL after the second click.
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(2_500);
      continue;
    }

    await page.waitForTimeout(500);
  }
  return { ok: false, reason: 'confirmation URL never loaded' };
}

/**
 * Find #quantity dropdown, pick the highest concrete numeric option (skip
 * "N+" entries which are "show custom-input field"), set it, fire change.
 * Returns ok with the selected value, or a skip reason. Errors are
 * non-fatal — caller should log + continue.
 */
async function setMaxQuantity(
  page: Page,
): Promise<
  | { ok: true; selected: number; allOptions: string[] }
  | { ok: false; reason: string; allOptions?: string[] }
> {
  return page
    .evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>('select#quantity');
      if (!sel) return { ok: false as const, reason: 'no #quantity dropdown' };

      const options = Array.from(sel.options).map((o) => ({
        value: o.value,
        text: (o.textContent ?? '').trim(),
      }));
      const numeric = options
        .filter((o) => !o.text.includes('+'))
        .map((o) => ({ value: o.value, n: parseInt(o.text, 10) }))
        .filter((o) => Number.isFinite(o.n) && o.n > 0);

      if (numeric.length === 0) {
        return {
          ok: false as const,
          reason: 'no numeric options',
          allOptions: options.map((o) => o.text),
        };
      }

      const best = numeric.reduce((m, o) => (o.n > m.n ? o : m));
      // No-op if already on the highest option.
      if (sel.value === best.value) {
        return {
          ok: true as const,
          selected: best.n,
          allOptions: options.map((o) => o.text),
        };
      }
      sel.value = best.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true as const,
        selected: best.n,
        allOptions: options.map((o) => o.text),
      };
    })
    .catch((err) => ({ ok: false as const, reason: `eval error: ${String(err)}` }));
}

async function findPlaceOrderLocator(page: Page) {
  for (const sel of CHECKOUT_PLACE_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

/**
 * Scan non-address / non-payment radio groups on /spc, find the option
 * whose label mentions the highest "N% back" (minimum = `minCashbackPct`),
 * and click it when it's better than the currently selected option.
 * Mirrors old AutoG's checkout[1.5].
 */
async function pickBestCashbackDelivery(
  page: Page,
  minCashbackPct: number,
): Promise<{ changes: { picked: string; pct: number }[] }> {
  return page
    .evaluate(async (minPct) => {
      const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .filter((r) => !/destinationSubmissionUrl|paymentMethodForUrl|paymentMethod/i.test(r.name || ''));
      const byName = new Map<
        string,
        Array<{ radio: HTMLInputElement; text: string; pct: number; checked: boolean }>
      >();
      for (const r of radios) {
        const key = r.name || '(anon)';
        if (!byName.has(key)) byName.set(key, []);
        const card = r.closest('label, .a-radio') ?? (r.parentElement as Element | null);
        const text = ((card as HTMLElement)?.innerText ?? '').replace(/\s+/g, ' ').trim();
        const m = text.match(/(\d{1,2})%\s*back/i);
        byName.get(key)!.push({
          radio: r,
          text,
          pct: m ? parseInt(m[1]!, 10) : 0,
          checked: r.checked,
        });
      }
      const changes: { picked: string; pct: number }[] = [];
      for (const [, opts] of byName.entries()) {
        if (opts.length < 2) continue;
        const best = opts.reduce((a, b) => (b.pct > a.pct ? b : a));
        const current = opts.find((o) => o.checked);
        if (best.pct >= minPct && (!current || best.pct > current.pct)) {
          best.radio.click();
          changes.push({ picked: best.text.slice(0, 120), pct: best.pct });
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      return { changes };
    }, minCashbackPct)
    .catch(() => ({ changes: [] as { picked: string; pct: number }[] }));
}

/**
 * Navigate to Amazon Your Orders and extract the most recent order #. Used
 * as a fallback when the confirmation page itself doesn't expose the id
 * (Amazon has several confirmation templates; some hide the id).
 */
async function fetchOrderIdFromHistory(page: Page): Promise<string | null> {
  await page.goto(
    'https://www.amazon.com/gp/css/order-history?ref_=nav_AccountFlyout_orders',
    { waitUntil: 'domcontentloaded', timeout: 15_000 },
  );
  return page
    .evaluate(() => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      const m = body.match(/(?:Order\s*#\s*|ORDER\s*#\s*)(\d{3}-\d{7}-\d{7})/i);
      return m?.[1] ?? null;
    })
    .catch(() => null);
}

function fail(
  stage: Extract<BuyResult, { ok: false }>['stage'],
  reason: string,
  detail?: string,
): BuyResult {
  return { ok: false, stage, reason, ...(detail ? { detail } : {}) };
}
