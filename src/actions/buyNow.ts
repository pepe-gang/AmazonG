import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../shared/logger.js';
import { findCashbackPct } from '../parsers/amazonProduct.js';
import {
  DELIVERY_OPTIONS_CHANGED_SELECTOR,
  computeCashbackRadioPlans,
  isVerifyCardChallenge,
  parseOrderConfirmation,
} from '../parsers/amazonCheckout.js';
import { effectivePriceTolerance } from '../parsers/productConstraints.js';
import type { BuyResult } from '../shared/types.js';
import { evaluateCashbackGate } from '../shared/cashbackGate.js';
import { clearCart, type ClearCartResult } from './clearCart.js';
import { addFillerViaHttp } from './buyWithFillers.js';
import { parseAsinFromUrl } from '../shared/sanitize.js';
import { SPC_ENTRY_URL, SPC_URL_MATCH } from './amazonHttp.js';

type BuyOptions = {
  dryRun: boolean;
  minCashbackPct: number;
  /** Per-account toggle (default true). When false, the cashback gate
   *  is skipped entirely and a missing on-page reading defaults to
   *  DEFAULT_MISSING_CASHBACK_PCT (5%). See shared/cashbackGate.ts. */
  requireMinCashback: boolean;
  maxPrice: number | null;
  allowedAddressPrefixes: string[];
  correlationId?: string;
  /** Directory for debug screenshots captured on silent checkout failures. */
  debugDir?: string;
  /**
   * Called immediately before the Place Order click ('placing') and
   * after Amazon's confirmation page parses (null). The worker uses
   * this to flag the narrow critical window where a stop / crash
   * can't be safely auto-retried (the click may or may not have been
   * accepted). Optional — tests and other callers can omit it.
   */
  onStage?: (stage: 'placing' | null) => void | Promise<void>;
  /**
   * Pre-flight clearCart result. See buyWithFillers.preflightCleared
   * for the full rationale — this is the same plumbing for single-buy
   * mode. When set and resolved ok, we skip the internal clearCart
   * call. When resolved failed (or undefined), we fall through to the
   * existing clearCart sequence.
   */
  preflightCleared?: Promise<ClearCartResult>;
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
  'input[aria-labelledby*="placeOrder" i]',
  '#placeYourOrder1 input[type="submit"]',
  'input[data-testid="place-order-button"]',
  'button[data-testid*="place-order" i]',
  'span#bottomSubmitOrderButtonId input',
];

/**
 * Regex used as a fallback when every selector above misses. Matches the
 * visible label on Amazon's Chewbacca Place Order button across locales
 * and layout variants: "Place order", "Place your order", "Place your
 * order and pay".
 */
const PLACE_ORDER_LABEL_RE = /^place\s+(your\s+)?order(\s+and\s+pay)?$/i;

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

    // 1. Quantity: read the max numeric option from the PDP's #quantity
    //    dropdown so the HTTP cart-add commits the right quantity in
    //    one shot. Mirrors old AutoG — BG always wants the cap units
    //    per order. Best-effort: products with no dropdown skip and
    //    we fall through with the default 1.
    const qty = await setMaxQuantity(page);
    let placedQuantity = 1;
    if (qty.ok) {
      placedQuantity = qty.selected;
      step('step.buy.quantity.set', {
        selected: qty.selected,
        options: qty.allOptions,
      });
    } else {
      step('step.buy.quantity.skip', { reason: qty.reason });
    }

    // 2. Path selection. Buy Now click is the fast path for single-buy:
    //    one click → 302 to /spc, no cart involved at all (Buy Now creates
    //    its own checkout session straight from the PDP's offer-listing).
    //    The HTTP cart-add + /spc shortcut is a fallback for products that
    //    only render Add to Cart (digital goods, low-stock items, some
    //    third-party listings).
    //
    //    Why Buy Now first:
    //      - Buy Now is ~2-5s end-to-end vs ~5-10s for clearCart + HTTP-add
    //        + /spc shortcut. Saves 3-5s per buy.
    //      - Buy Now bypasses the cart entirely, so it doesn't need
    //        clearCart hygiene or care about leftover items.
    //      - Higher reliability — Buy Now is Amazon's own JS-driven path
    //        and works wherever the button is rendered. The HTTP path
    //        depends on extracting offerListingId tokens from SSR HTML,
    //        which can fail on some PDP variants.
    //
    //    Filler mode is unaffected — it correctly takes the HTTP cart-add
    //    path because it needs to bundle 8+ filler items alongside the
    //    target.
    //
    //    Path priority:
    //      1. Buy Now click (when button visible)        → /spc directly
    //      2. HTTP cart-add + /spc shortcut              → fallback for
    //         add-to-cart-only products
    //      3. addToCartThenCheckout (legacy click flow)  → final fallback
    const path = await detectBuyPath(page);
    if (path === 'none') {
      return fail('buy_click', 'neither buy-now nor add-to-cart button appeared');
    }
    step('step.buy.path', { path });

    if (path === 'buy-now') {
      step('step.buy.click', { button: 'buy-now' });
      try {
        await page.locator('#buy-now-button').first().click({ timeout: 10_000 });
      } catch (err) {
        return fail('buy_click', 'failed to click Buy Now', String(err));
      }
    } else {
      // Add-to-Cart-only product. Try the HTTP cart-add + /spc shortcut
      // first (fast: ~5-7s), fall back to addToCartThenCheckout's click
      // flow if the HTTP path can't extract tokens or the shortcut doesn't
      // redirect to /spc.
      let usedHttpPath = false;
      const targetAsin = parseAsinFromUrl(page.url()) ?? '';
      if (targetAsin) {
        // Cart hygiene — preflight from pollAndScrape if available,
        // otherwise run the full clearCart sequence. See
        // buyWithFillers.preflightCleared docstring for rationale.
        let cleared: ClearCartResult;
        if (opts.preflightCleared) {
          const pre = await opts.preflightCleared;
          if (pre.ok) {
            step('step.buy.cart.preflight.skipped', { wasEmpty: pre.wasEmpty, removed: pre.removed });
            cleared = pre;
          } else {
            step('step.buy.cart.preflight.fallback', { reason: pre.reason });
            cleared = await clearCart(page, { correlationId: cid });
          }
        } else {
          cleared = await clearCart(page, { correlationId: cid });
        }
        if (cleared.ok) {
          step('step.buy.cart.ready', { wasEmpty: cleared.wasEmpty, removed: cleared.removed });
        } else {
          warn('step.buy.cart.clear.fail', { reason: cleared.reason, removed: cleared.removed });
        }

        const targetHtml = await page.content().catch(() => '');
        const httpAdd = await addFillerViaHttp(page, targetAsin, {
          prefetchedHtml: targetHtml,
          quantity: placedQuantity,
        });
        if (httpAdd.kind === 'committed') {
          step('step.buy.target.http.ok', {
            targetAsin,
            status: httpAdd.status,
            tookMs: httpAdd.tookMs,
            quantity: placedQuantity,
          });
          try {
            await page.goto(SPC_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          } catch (err) {
            warn('step.buy.spc.shortcut.gotoErr', { error: String(err).slice(0, 120) });
          }
          if (SPC_URL_MATCH.test(page.url())) {
            usedHttpPath = true;
            step('step.buy.spc.shortcut.ok', { url: page.url() });
          } else {
            warn('step.buy.spc.shortcut.fallback', {
              landedUrl: page.url(),
              note: 'entry-cart shortcut did not redirect to /spc; falling through to click-based flow',
            });
          }
        } else {
          step('step.buy.target.http.fallback', {
            targetAsin,
            reason: httpAdd.reason,
            ...(httpAdd.status != null ? { status: httpAdd.status } : {}),
          });
        }
      }

      if (!usedHttpPath) {
        step('step.buy.click', { button: 'add-to-cart' });
        const cartFallback = await addToCartThenCheckout(page, step, warn);
        if (!cartFallback.ok) {
          return fail('buy_click', cartFallback.reason, cartFallback.detail);
        }
      }
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
      // Per-item quantity cap (e.g. Amazon Echo Dot purchase limit). The
      // "Make updates to your items" page is unrecoverable for the bot —
      // Continue is a no-op until the user removes the item — so surface
      // as item_unavailable with Amazon's own message for the row.
      if (checkoutPage.kind === 'quantity_limit') {
        warn('step.buy.quantity_limit', { reason: checkoutPage.reason });
        return fail('item_unavailable', checkoutPage.reason);
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

    // 7. Checkout[2]: cashback gate.
    //    Strict accounts (requireMinCashback=true): if below minimum,
    //    run the BG1/BG2 name-toggle workaround once and re-evaluate.
    //    Permissive accounts (requireMinCashback=false): skip the gate
    //    and default a null reading to DEFAULT_MISSING_CASHBACK_PCT
    //    so the recorded cashbackPct isn't null. See cashbackGate.ts.
    const pageCashbackPct = await readCashbackOnPage(page);
    let gate = evaluateCashbackGate({
      pageCashbackPct,
      requireMinCashback: opts.requireMinCashback,
      minCashbackPct: opts.minCashbackPct,
    });
    step('step.buy.cashback', {
      pct: pageCashbackPct,
      effectivePct: gate.cashbackPct,
      minRequired: opts.minCashbackPct,
      requireMinCashback: opts.requireMinCashback,
      fellBackToDefault: gate.kind === 'pass' && gate.fellBackToDefault,
      pass: gate.kind === 'pass',
    });
    if (gate.kind === 'fail') {
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
      gate = evaluateCashbackGate({
        pageCashbackPct: toggled.cashbackPct,
        requireMinCashback: opts.requireMinCashback,
        minCashbackPct: opts.minCashbackPct,
      });
      step('step.buy.cashback.retry.ok', {
        pct: toggled.cashbackPct,
        effectivePct: gate.cashbackPct,
        minRequired: opts.minCashbackPct,
      });
      if (gate.kind === 'fail') {
        return fail('cashback_gate', gate.reason);
      }
    }
    let cashbackPct: number | null = gate.cashbackPct;

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
        amazonPurchaseId: null,
        finalPrice: null,
        finalPriceText: null,
        cashbackPct,
        quantity: placedQuantity,
      };
    }

    // 9. Pre-place stability. Amazon can flag orders submitted mid-render
    //    after a delivery/address update; we want the Place Order button
    //    to be visible/stable before clicking. Was previously a blind 1s
    //    waitForTimeout — replaced with a bounded selector wait (same 1s
    //    upper bound) so the typical case exits in <100ms once the button
    //    has hydrated, while pathological re-rendering cases still get
    //    the same protection.
    // 10. Click Place Order. Mark the attempt `stage: 'placing'` just
    //     before the click so a stop / crash across this boundary is
    //     flagged as "unknown outcome" (the click may or may not have
    //     been accepted by Amazon). Cleared back to null once the
    //     confirmation page parses below.
    const placeLocator = await findPlaceOrderLocator(page);
    if (!placeLocator) {
      return fail('place_order', 'no Place Order button selector matched');
    }
    await placeLocator
      .waitFor({ state: 'visible', timeout: 1_000 })
      .catch(() => undefined);
    step('step.buy.place.settle', { mode: 'visible_wait', cap: 1_000 });
    await opts.onStage?.('placing');
    try {
      await placeLocator.click({ timeout: 10_000 });
    } catch (err) {
      return fail('place_order', 'failed to click Place Order', String(err));
    }
    step('step.buy.place', { clicked: true });

    // 11. Wait for confirmation. Amazon may show a "This is a pending
    //     order — you placed an order for these items recently. Do you want
    //     to place the same order again?" interstitial first; if so, click
    //     "Place your order" once to confirm. Amazon may ALSO re-render
    //     /spc with "Your delivery options have changed…" and wipe our
    //     radio pick — the callback re-picks the highest-% delivery radio
    //     before the helper re-clicks Place Order (1 recovery attempt).
    const confirmWait = await waitForConfirmationOrPending(page, step, {
      onDeliveryOptionsChanged: async () => {
        const re = await pickBestCashbackDelivery(page, opts.minCashbackPct);
        step('step.buy.place.delivery_options_changed.repicked', {
          changes: re.changes,
        });
        await page.waitForTimeout(1_000);
      },
    });
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
    await opts.onStage?.(null);
    // Capture Amazon's checkout-session purchaseId BEFORE any subsequent
    // navigation or page refresh. The thank-you URL is
    // /gp/buy/thankyou/handlers/display.html?purchaseId=106-...; the
    // value is distinct from the actual orderId (different number-space)
    // and is not exposed on any post-checkout endpoint, so this is the
    // only chance to record it. Audit-only field. See
    // docs/research/amazon-pipeline.md.
    const amazonPurchaseId =
      page.url().match(/[?&]purchaseId=(\d{3}-\d{7}-\d{7})/)?.[1] ?? null;
    if (amazonPurchaseId) {
      step('step.buy.purchaseId.captured', { amazonPurchaseId });
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

    // 12. orderId capture. Fast-path first: Amazon renders the canonical
    //     fulfillment orderId as <input name="latestOrderId"> on the
    //     thank-you page (verified live 2026-05-04). Saves ~15s vs the
    //     order-history nav for the common single-fulfillment case.
    //
    //     Fallback: the existing /gp/css/order-history grep when the
    //     hidden input is missing (older Amazon templates, edge cases).
    let orderId: string | null = null;
    const fastOrderId = await readLatestOrderIdFromDom(page);
    if (fastOrderId) {
      orderId = fastOrderId;
      step('step.buy.orderid.fast', { source: 'thankyou_dom', orderId });
    } else {
      step('step.buy.orderid.fetch', { url: 'https://www.amazon.com/gp/css/order-history' });
      orderId = await fetchOrderIdFromHistory(page).catch(() => null);
      if (!orderId) {
        warn('step.buy.orderid.notfound', {
          note: 'neither thank-you DOM nor order-history page revealed a parseable order id',
        });
      }
    }

    step('step.buy.placed', {
      orderId,
      amazonPurchaseId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
    });

    return {
      ok: true,
      dryRun: false,
      orderId,
      amazonPurchaseId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
      cashbackPct,
      quantity: confirmation.quantity ?? placedQuantity,
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

/**
 * Decide whether to use Buy Now or fall back to Add to Cart on the
 * currently-loaded PDP. Polls up to 10s — Amazon hydrates the buy box
 * asynchronously, so a brief wait avoids racing the parser. Returns
 * `'buy-now'` when both are available (one-click path is preferred),
 * `'add-to-cart'` when only the cart button is clickable, `'none'`
 * when neither shows up in time.
 */
async function detectBuyPath(page: Page): Promise<'buy-now' | 'add-to-cart' | 'none'> {
  // Race a Buy Now visible-wait against an Add-to-Cart visible-wait.
  // Whichever resolves first wins; both rejecting → 'none'.
  const buy = page
    .waitForSelector('#buy-now-button', { state: 'visible', timeout: 10_000 })
    .then(() => 'buy-now' as const)
    .catch(() => null);
  const cart = page
    .waitForSelector(
      '#add-to-cart-button, input[name="submit.add-to-cart"]',
      { state: 'visible', timeout: 10_000 },
    )
    .then(() => 'add-to-cart' as const)
    .catch(() => null);
  const winner = await Promise.race([buy, cart]);
  if (winner) return winner;
  // Race lost — settle both to surface the slower of the two if it
  // arrives just after the race resolved with null.
  const [b, c] = await Promise.all([buy, cart]);
  return b ?? c ?? 'none';
}

const ATC_CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

const ATC_PROCEED_SELECTORS = [
  'input[name="proceedToRetailCheckout"]',
  '#sc-buy-box-ptc-button input',
  '#sc-buy-box-ptc-button span input',
];

/**
 * Add-to-Cart fallback for PDPs that hide Buy Now (Echo Dot et al.).
 * Click ATC → dismiss any AppleCare/warranty modal → navigate to the
 * cart page → click Proceed to Checkout. Caller's existing
 * `waitForCheckout()` then handles the /spc landing exactly the same
 * as the Buy Now path, so the rest of the flow (price/address/cashback/
 * place-order) is unchanged.
 *
 * Failures are surfaced through the `fail('buy_click', ...)` channel
 * since this whole step substitutes for the Buy Now click.
 */
async function addToCartThenCheckout(
  page: Page,
  step: StepEmitter,
  warn: StepEmitter,
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
  try {
    await page
      .locator('#add-to-cart-button, input[name="submit.add-to-cart"]')
      .first()
      .click({ timeout: 10_000 });
  } catch (err) {
    return { ok: false, reason: 'failed to click Add to Cart', detail: String(err) };
  }

  // AppleCare / protection-plan modal — common on tech items. Same
  // selectors the buyWithFillers loop uses. 2s window: if no modal
  // appears we assume the add committed without one.
  await page
    .locator('#attachSiNoCoverage input.a-button-input, .warranty-twister-no-thanks-text')
    .first()
    .click({ timeout: 2_000 })
    .catch(() => undefined);

  // Let Amazon's POST settle so the cart navigation doesn't race the
  // in-flight add. Same 8s cap buyWithFillers uses.
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined);

  try {
    await page.goto(ATC_CART_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    return { ok: false, reason: 'failed to load cart page', detail: String(err) };
  }

  let clicked = false;
  for (const sel of ATC_PROCEED_SELECTORS) {
    const ok = await page
      .locator(sel)
      .first()
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      clicked = true;
      step('step.buy.atc.proceed', { selector: sel });
      break;
    }
  }
  if (!clicked) {
    warn('step.buy.atc.proceed.notfound', { url: page.url() });
    return { ok: false, reason: 'Proceed to Checkout button not found on cart page' };
  }
  return { ok: true };
}

export type CheckoutReadyResult =
  | { ok: true; detected: string }
  | { ok: false; reason: string; detail?: string; kind?: 'unavailable' | 'quantity_limit' | 'timeout' };

export async function waitForCheckout(
  page: Page,
  allowedAddressPrefixes: string[] = [],
  debugDir?: string,
  emit?: { step: StepEmitter; warn: StepEmitter },
): Promise<CheckoutReadyResult> {
  // Poll for either a Place Order button (success — we're on /spc), a
  // Chewbacca interstitial continue button (Amazon parked us at an
  // address / billing-address / payment-method picker after Buy Now),
  // or Amazon's "This item is currently unavailable" error page
  // (terminal — bail fast). When we see an address picker we first
  // select the radio whose street matches our allowed prefixes (so
  // Amazon doesn't ship to whatever default it preselected), then
  // click the continue button. Mirrors old AutoG with the prefix gate
  // pulled forward into the early Buy Now → /spc transition.
  //
  // The interstitial label varies depending on which picker Amazon
  // routes us to; all share the same DOM shape (primary + secondary
  // submit, aria-labelledby points to the visible text). Rare flow:
  // /pay?referrer=pay with a "Use this payment method" CTA — still
  // the same primary-continue-button that we click, loop, and recheck
  // for Place Order.
  const deadline = Date.now() + 30_000;
  let deliverClickedTimes = 0;
  // 5 rather than 3: a worst-case flow can chain several interstitials
  // (address → billing → payment → /spc), each adding one click.
  const MAX_DELIVER_CLICKS = 5;
  let iteration = 0;

  while (Date.now() < deadline) {
    iteration += 1;
    const state = await page
      .evaluate(({ placeSelectors, placeLabelPattern }) => {
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

        // 0b. Per-item quantity-cap rejection on the "Make updates to your
        //     items" page. Fires when Amazon enforces a purchase limit the
        //     account has hit (Echo Dot bulk caps, etc.). The Continue
        //     button is a no-op here — clicking advances nothing — so we
        //     must catch this BEFORE the 'place' / 'updates' handlers
        //     route us into a retry loop that times out into "unexpected
        //     error in buyNow flow", or — worse for filler mode — into
        //     the cashback gate (which then fails because the limit page
        //     has no "N% back" panel for the target row, surfacing as
        //     `stage: 'cashback_gate'` and triggering the FILLER_MAX_ATTEMPTS
        //     retry loop in pollAndScrape — exactly the wasted-time
        //     scenario this catch is here to prevent).
        //
        // Two-pronged detection:
        //   (a) Stable Amazon selector `[data-messageId*="Limit" i]`
        //       (covers QuantityLimitsCVMessage and any sibling rename).
        //   (b) Body-text fallback for the user-visible string. Amazon
        //       sometimes ships the message without that data attribute
        //       (or with a Place Order button still visible elsewhere),
        //       in which case (a) misses and we'd fall through to the
        //       wasted retry path described above. The regex matches the
        //       canonical "you've reached the purchase limit" wording
        //       across `'`/`'` apostrophe variants.
        const limitEl = document.querySelector(
          '[data-messageId*="Limit" i], [data-messageid*="Limit" i]',
        ) as HTMLElement | null;
        const PURCHASE_LIMIT_RE =
          /you['’]ve\s+reached\s+the\s+purchase\s+limit\s+for\s+this\s+item/i;
        if (limitEl) {
          const text = (limitEl.textContent ?? '').replace(/\s+/g, ' ').trim();
          return {
            kind: 'quantity_limit' as const,
            message:
              text ||
              "Sorry, you've reached the purchase limit for this item. Please remove the item to continue.",
          };
        }
        if (PURCHASE_LIMIT_RE.test(body)) {
          const m = body.match(/sorry,?\s+you['’]ve\s+reached[^.]*\.?/i);
          return {
            kind: 'quantity_limit' as const,
            message:
              m?.[0]?.trim() ||
              "Sorry, you've reached the purchase limit for this item. Please remove the item to continue.",
          };
        }

        // 1. Place Order — terminal success state. Try selector list
        //    first (fast path); if none match, fall back to a text scan
        //    across visible buttons/inputs so new Amazon layouts that
        //    ship with different ids/attributes still resolve.
        for (const s of placeSelectors) {
          const el = document.querySelector(s) as HTMLElement | null;
          if (el && el.offsetParent !== null) {
            return { kind: 'place' as const, sel: s };
          }
        }
        // Label resolver that also follows aria-labelledby references.
        // Amazon's Chewbacca pipeline commonly ships inputs with no value
        // and no textContent — the visible label lives in a separate
        // <span> referenced by aria-labelledby (e.g.
        //   <input type="submit" aria-labelledby="…-continue-button-id-announce">
        //   <span id="…-continue-button-id-announce">Deliver to this address</span>
        // ). The old "value || aria-label || textContent" chain returned
        // empty for those inputs, so text-based detection missed the real
        // button. Resolve the referenced ids + concatenate their text.
        const readLabel = (el: HTMLElement): string => {
          const direct = (
            (el as HTMLInputElement).value ||
            el.getAttribute('aria-label') ||
            el.textContent ||
            ''
          ).trim();
          if (direct) return direct;
          const ref = el.getAttribute('aria-labelledby');
          if (!ref) return '';
          return ref
            .split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter((n): n is HTMLElement => n !== null)
            .map((n) => (n.textContent || '').trim())
            .filter(Boolean)
            .join(' ')
            .trim();
        };

        const labelRe = new RegExp(placeLabelPattern, 'i');
        const placeCandidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, input[type="submit"], input[type="button"], a[role="button"], .a-button-input',
          ),
        );
        for (const el of placeCandidates) {
          if (el.offsetParent === null) continue;
          if ((el as HTMLButtonElement).disabled) continue;
          if (labelRe.test(readLabel(el))) {
            return { kind: 'place' as const, sel: '__text_match__' };
          }
        }
        // 2. Look for a Chewbacca interstitial continue INTERACTIVE
        //    element. Three known labels share the same DOM shape:
        //      - "Deliver to this address" (address picker)
        //      - "Use this address"        (billing-address picker)
        //      - "Use this payment method" (payment picker — rare)
        //    Restricted to buttons/inputs/role="button" — NOT <span>,
        //    because the /spc review page carries static <span> labels
        //    with matching text above the address/payment summaries,
        //    and loosening the selector caused us to falsely re-detect
        //    the interstitial on every iteration after a successful
        //    click. Amazon's real button is always an <input type=
        //    "submit"> (inside its a-button wrapper) or a plain
        //    <button>, never a standalone <span>.
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, input[type="submit"], input[type="button"], a[role="button"], .a-button-input',
          ),
        );
        // Chewbacca ships both a "primary" continue submit (yellow CTA
        // the user sees) and a "secondary" continue submit (sticky /
        // duplicate) whose click is a no-op — only the primary's click
        // handler actually submits the form. DOM order is NOT reliable:
        // the secondary usually appears first, so a naive .find() picks
        // the dead button and clicks it three times in a row. Sort
        // matches so any element with `primary-continue-button` in its
        // aria-labelledby wins over a `secondary-continue-button` match.
        const continueLabelRe =
          /^(deliver to this address|use this address|use this payment method)$/i;
        const deliverHits: HTMLElement[] = [];
        for (const el of candidates) {
          if (el.offsetParent === null) continue;
          if ((el as HTMLButtonElement).disabled) continue;
          const label = readLabel(el);
          if (continueLabelRe.test(label)) {
            deliverHits.push(el);
          }
        }
        if (deliverHits.length > 0) {
          // Only treat the PRIMARY Chewbacca Deliver button as actionable.
          // The secondary submit (sticky/duplicate) is a no-op — clicking
          // it advances nothing and just burns our retry counter. Once we
          // click the primary, it disappears while the submit is in
          // flight; during that window only the secondary is visible, so
          // we want to fall through to state 'none' and keep polling.
          const primary = deliverHits.find((el) => {
            const aria = (el.getAttribute('aria-labelledby') || '').toLowerCase();
            return aria.includes('primary-continue-button');
          });
          if (primary) {
            return {
              kind: 'deliver' as const,
              label: readLabel(primary),
              ariaLabelledby: primary.getAttribute('aria-labelledby') || null,
              tag: primary.tagName.toLowerCase(),
              elementId: primary.id || null,
              matchCount: deliverHits.length,
            };
          }
          // Primary absent (likely mid-submit) — don't touch the secondary
          // button; just log the wait-state so the trace is legible.
          const secondary = deliverHits[0] as HTMLElement;
          return {
            kind: 'deliver_pending' as const,
            label: readLabel(secondary),
            ariaLabelledby: secondary.getAttribute('aria-labelledby') || null,
            matchCount: deliverHits.length,
          };
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
      }, { placeSelectors: CHECKOUT_PLACE_SELECTORS, placeLabelPattern: PLACE_ORDER_LABEL_RE.source })
      .catch(() => ({ kind: 'none' as const }));

    // Per-iteration trace. Lets us see, e.g., "iter 1 kind=deliver …; iter
    // 2 kind=deliver (same aria-labelledby) …" — makes a persisted Deliver
    // button vs a real second interstitial click trivially distinguishable.
    if (emit) {
      const url = page.url();
      if (state.kind === 'deliver') {
        emit.step('step.waitForCheckout.iter', {
          iteration,
          kind: state.kind,
          url,
          label: state.label,
          ariaLabelledby: state.ariaLabelledby,
          elementId: state.elementId,
          tag: state.tag,
          deliverClickedTimes,
        });
      } else if (state.kind === 'deliver_pending') {
        emit.step('step.waitForCheckout.iter', {
          iteration,
          kind: state.kind,
          url,
          ariaLabelledby: state.ariaLabelledby,
          deliverClickedTimes,
        });
      } else {
        emit.step('step.waitForCheckout.iter', {
          iteration,
          kind: state.kind,
          url,
          deliverClickedTimes,
        });
      }
    }

    if (state.kind === 'deliver_pending') {
      // Primary submit is in flight — longer settle interval before the
      // next poll so we don't burn iterations while Amazon processes.
      await page.waitForTimeout(1_500);
      continue;
    }

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

    if (state.kind === 'quantity_limit') {
      return {
        ok: false,
        kind: 'quantity_limit',
        reason: state.message,
      };
    }

    if (state.kind === 'deliver') {
      if (deliverClickedTimes >= MAX_DELIVER_CLICKS) {
        return {
          ok: false,
          reason: `Interstitial continue button persisted after ${MAX_DELIVER_CLICKS} clicks`,
        };
      }

      // Address-prefix gate: only meaningful on the shipping-address
      // picker ("Deliver to this address"). The billing-address picker
      // ("Use this address") and payment picker ("Use this payment
      // method") don't route items, so enforcing a house-number prefix
      // there would false-fail on legitimate billing / card selections.
      const isShippingPicker = /^deliver to this address$/i.test(state.label ?? '');
      if (isShippingPicker && allowedAddressPrefixes.length > 0) {
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

      // Click via the same DOM walk so we hit the visible interstitial
      // continue button. Mirror the tightened selector from the state
      // detector above — excludes <span> so we don't no-op on a static
      // label element Amazon ships on the post-interstitial review page.
      const clicked = await page
        .evaluate(() => {
          const readLabel = (el: HTMLElement): string => {
            const direct = (
              (el as HTMLInputElement).value ||
              el.getAttribute('aria-label') ||
              el.textContent ||
              ''
            ).trim();
            if (direct) return direct;
            const ref = el.getAttribute('aria-labelledby');
            if (!ref) return '';
            return ref
              .split(/\s+/)
              .map((id) => document.getElementById(id))
              .filter((n): n is HTMLElement => n !== null)
              .map((n) => (n.textContent || '').trim())
              .filter(Boolean)
              .join(' ')
              .trim();
          };
          const all = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, input[type="submit"], input[type="button"], a[role="button"], .a-button-input',
            ),
          );
          const continueLabelRe =
            /^(deliver to this address|use this address|use this payment method)$/i;
          const matches = all.filter((el) => {
            if (el.offsetParent === null) return false;
            if ((el as HTMLButtonElement).disabled) return false;
            return continueLabelRe.test(readLabel(el));
          });
          if (matches.length === 0) return false;
          // Prefer the primary-continue submit. DOM order is unreliable
          // (secondary often comes first), so sort by aria-labelledby
          // suffix before picking.
          const scoreEl = (el: HTMLElement): number => {
            const aria = (el.getAttribute('aria-labelledby') || '').toLowerCase();
            if (aria.includes('primary-continue-button')) return 2;
            if (aria.includes('secondary-continue-button')) return 0;
            return 1;
          };
          matches.sort((a, b) => scoreEl(b) - scoreEl(a));
          const btn = matches[0] as HTMLElement;
          btn.click();
          return true;
        })
        .catch(() => false);

      if (!clicked) {
        // Couldn't click for some reason — short pause and retry.
        if (emit) {
          emit.warn('step.waitForCheckout.deliver.click.miss', {
            iteration,
            url: page.url(),
          });
        }
        await page.waitForTimeout(500);
        continue;
      }
      deliverClickedTimes += 1;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      // Longer settle after a primary click — Chewbacca does the address
      // submit over XHR, URL may stay on /address for several seconds
      // while it processes, and the primary button disappears during that
      // window. A 1s wait previously caused us to re-poll mid-submit and
      // mis-detect state. 3s gives the handler a chance to finish.
      await page.waitForTimeout(3_000);
      if (emit) {
        emit.step('step.waitForCheckout.deliver.clicked', {
          iteration,
          deliverClickedTimes,
          urlAfter: page.url(),
        });
      }
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
  // Timeout fall-through. Before returning the generic "never appeared"
  // message, snapshot the current page once and run pure detectors against
  // it — surfaces a better diagnostic when /spc parked us on a known-bad
  // interstitial (e.g. PMTS "Verify your card" card-address-challenge,
  // which renders in place of the Place Order button when an address
  // change tripped a payment-side fraud check). The 30s timeout remains
  // the catch-all for genuinely unrelated failures.
  try {
    const html = await page.content();
    const doc = new JSDOM(html).window.document;
    if (isVerifyCardChallenge(doc)) {
      return { ok: false, reason: 'Verify your card' };
    }
  } catch {
    // ignore — fall through to the generic message
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
        // Amazon ships several layouts for the Chewbacca address picker:
        //   (a) <li> containing recipient + address (older),
        //   (b) <label> directly wrapping the radio + address (2026 new
        //       redesign — no <li>, no address-row class),
        //   (c) generic "address" class wrappers on intermediate divs.
        // Try each in order until we find one with real text. Use
        // `textContent` (not `innerText`) — innerText requires live layout
        // and returns "" under headless Chromium, which was the root cause
        // of the "no saved address starts with an allowed prefix (saw: |
        // | )" failures.
        const candidates: (Element | null)[] = [
          r.closest('label'),
          r.closest('[class*="a-radio-fancy"]'),
          r.closest('li, [class*="address-row"], [class*="address"]'),
        ];
        const host = candidates.find(
          (el) => el && (el.textContent || '').trim().length > 0,
        ) as HTMLElement | null;
        const text = (host?.textContent || '').replace(/\s+/g, ' ');
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
  const tol = effectivePriceTolerance(cap);
  if (price > cap + tol) {
    return {
      ok: false,
      priceText: result.chosen.raw,
      price,
      reason:
        tol > 0
          ? `checkout price $${price.toFixed(2)} exceeds retail cap $${cap.toFixed(2)} (+$${tol.toFixed(2)} tolerance)`
          : `checkout price $${price.toFixed(2)} exceeds retail cap $${cap.toFixed(2)}`,
    };
  }
  return { ok: true, priceText: result.chosen.raw, price };
}

export type AddrResult =
  | { ok: true; current: string; prefix: string }
  | { ok: false; reason: string; detail?: string };

export async function ensureAddress(
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

export type ToggleResult =
  | { ok: true; cashbackPct: number | null; from: string; to: string }
  | { ok: false; reason: string; detail?: string };

export async function toggleBGNameAndRetry(
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

  // 3. Wait for the edit modal and toggle (BG1) ↔ (BG2). If the saved
  //    address name has neither suffix yet, append " (BG1)" to make
  //    this a BG1/BG2-eligible address — first-time setup. The
  //    allowedAddressPrefixes gate above already filtered to BG
  //    warehouse addresses, so we're not mutating random saved
  //    addresses. Subsequent runs flip (BG1)↔(BG2) normally.
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
      let action: 'flip' | 'add';
      if (/\(BG2\)/.test(current)) {
        next = current.replace(/\(BG2\)/, '(BG1)');
        action = 'flip';
      } else if (/\(BG1\)/.test(current)) {
        next = current.replace(/\(BG1\)/, '(BG2)');
        action = 'flip';
      } else {
        // First-time setup: append " (BG1)". Trim trailing whitespace
        // to avoid double-spacing on names like "John Doe " → "John
        // Doe (BG1)" (not "John Doe  (BG1)").
        const trimmed = current.replace(/\s+$/, '');
        next = trimmed.length > 0 ? `${trimmed} (BG1)` : '(BG1)';
        action = 'add';
      }

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
          action,
        };
      }
      return { ok: true as const, from: current, to: next, reconfirmed, action };
    })
    .catch((err) => ({ ok: false as const, reason: 'toggle_eval_error', detail: String(err) }));
  if (!toggled.ok) {
    return { ok: false, reason: `name-toggle: ${toggled.reason}` };
  }
  emit.step('step.buy.cashback.toggle.submit', {
    from: toggled.from,
    to: toggled.to,
    action: toggled.action,
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
 * Also handles the rare "Your delivery options have changed due to your
 * updated purchase options. Please select a new delivery option to
 * proceed." banner that Amazon shows on /spc after Place Order when it
 * silently wiped the previously-selected delivery radio. If the caller
 * provides `onDeliveryOptionsChanged`, the helper invokes it to re-pick
 * the radio and re-clicks Place Order (1 attempt by default) — without a
 * callback, the banner is returned as a typed failure reason.
 *
 * Returns ok when we land on a confirmation URL, fail otherwise.
 */
export async function waitForConfirmationOrPending(
  page: Page,
  step: StepEmitter,
  opts: {
    /** Called when the delivery-options-changed banner appears. Should
     *  re-pick the cashback delivery radio(s). The helper then clicks
     *  Place Order again. */
    onDeliveryOptionsChanged?: () => Promise<void>;
    /** Hard cap on delivery-options-changed recoveries per call. */
    maxDeliveryRecoveryAttempts?: number;
  } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + 60_000;
  let pendingClicks = 0;
  const MAX_PENDING_CLICKS = 3;
  let deliveryRecoveries = 0;
  const MAX_DELIVERY_RECOVERIES = opts.maxDeliveryRecoveryAttempts ?? 1;

  while (Date.now() < deadline) {
    const state = await page
      .evaluate((bannerSel: string) => {
        const url = location.href;
        if (
          /thankyou|orderconfirm|order-confirmation|\/gp\/buy\/spc\/handlers\/display|\/gp\/css\/order-details/i.test(
            url,
          )
        ) {
          return { kind: 'confirmation' as const, url };
        }
        // Delivery-options-changed banner: Amazon re-rendered /spc, wiped
        // the radio we picked, surfaced a purchase-level error. Check
        // BEFORE the pending-order branch — the body text may also
        // mention "order" in unrelated places and we want the more
        // specific signal to win.
        if (document.querySelector(bannerSel)) {
          return { kind: 'delivery_options_changed' as const, url };
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
      }, DELIVERY_OPTIONS_CHANGED_SELECTOR)
      .catch(() => ({ kind: 'none' as const, url: '' }));

    if (state.kind === 'confirmation') {
      return { ok: true };
    }

    if (state.kind === 'delivery_options_changed') {
      if (deliveryRecoveries >= MAX_DELIVERY_RECOVERIES) {
        return {
          ok: false,
          reason: `delivery-options-changed banner persisted after ${MAX_DELIVERY_RECOVERIES} recovery attempt(s)`,
        };
      }
      step('step.buy.place.delivery_options_changed', {
        attempt: deliveryRecoveries + 1,
      });
      if (opts.onDeliveryOptionsChanged) {
        try {
          await opts.onDeliveryOptionsChanged();
        } catch (err) {
          return {
            ok: false,
            reason: `delivery-options-changed recovery failed: ${String(err)}`,
          };
        }
      } else {
        return { ok: false, reason: 'delivery-options-changed banner (no recovery callback)' };
      }
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
        return {
          ok: false,
          reason: 'delivery-options-changed: failed to re-click Place your order',
        };
      }
      deliveryRecoveries += 1;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(2_500);
      continue;
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
export async function setMaxQuantity(
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

export async function findPlaceOrderLocator(page: Page) {
  for (const sel of CHECKOUT_PLACE_SELECTORS) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  // Text fallback — mirrors waitForCheckout's detector. Picks any
  // visible interactive element whose label matches "Place your order".
  // Uses Playwright's role+name locator so auto-waiting + actionability
  // checks still apply at click time.
  const roleLoc = page.getByRole('button', { name: PLACE_ORDER_LABEL_RE }).first();
  if ((await roleLoc.count()) > 0) return roleLoc;
  const inputLoc = page
    .locator('input[type="submit"], input[type="button"]')
    .filter({ hasText: PLACE_ORDER_LABEL_RE })
    .first();
  if ((await inputLoc.count()) > 0) return inputLoc;
  return null;
}

/** Escape a string for use as the RHS of a CSS attribute selector with
 *  double-quoted value. Only `\` and `"` need escaping inside the string. */
function escCssAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Sync each form control's live `.checked` PROPERTY into the `[checked]`
 *  HTML attribute. `page.content()` serializes attributes, not properties —
 *  without this, a radio that was clicked via JS would not show up as
 *  :checked when the HTML is parsed by JSDOM. */
async function syncCheckedAttribute(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document
        .querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')
        .forEach((el) => {
          if (el.checked) el.setAttribute('checked', '');
          else el.removeAttribute('checked');
        });
    })
    .catch(() => undefined);
}

/**
 * Scan non-address / non-payment radio groups on /spc, find the option
 * whose label mentions the highest "N% back" (minimum = `minCashbackPct`),
 * and click it when it's better than the currently selected option.
 * Mirrors old AutoG's checkout[1.5].
 *
 * Implementation: iterative re-plan. Each iteration syncs .checked to
 * [checked], snapshots HTML, computes plans via the pure parser, and
 * clicks ONE radio via a Playwright locator (which re-queries the DOM,
 * so stale refs from Amazon's re-render between clicks don't silently
 * no-op). A set of already-clicked (name,value) pairs avoids infinite
 * loops when a click doesn't stick.
 */
export async function pickBestCashbackDelivery(
  page: Page,
  minCashbackPct: number,
): Promise<{ changes: { picked: string; pct: number }[] }> {
  const MAX_ITERATIONS = 6;
  const changes: { picked: string; pct: number }[] = [];
  const clicked = new Set<string>();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    await syncCheckedAttribute(page);
    const html = await page.content().catch(() => '');
    if (!html) break;
    const plans = computeCashbackRadioPlans(
      new JSDOM(html).window.document,
      minCashbackPct,
    );
    const plan = plans.find((p) => !clicked.has(`${p.name}::${p.value}`));
    if (!plan) break;
    clicked.add(`${plan.name}::${plan.value}`);
    const sel = `input[type="radio"][name="${escCssAttr(plan.name)}"][value="${escCssAttr(plan.value)}"]`;
    try {
      await page.locator(sel).first().click({ timeout: 5_000 });
      changes.push({ picked: plan.label, pct: plan.pickedPct });
      // Settle: Amazon re-renders totals + cashback banner after each
      // radio click. 500ms is generous but keeps us under the
      // downstream cashback_gate's budget.
      await page.waitForTimeout(500);
    } catch {
      // A single-radio failure isn't fatal — the cashback gate will
      // catch it downstream. Break out so we don't spin on a
      // radio we can't locate.
      break;
    }
  }
  return { changes };
}

/**
 * Fast-path: read the just-placed orderId from the thank-you page's
 * hidden form inputs. Amazon renders the canonical fulfillment orderId
 * as `<input type="hidden" name="latestOrderId" value="112-XXX-XXXXXXX">`
 * on the thank-you page (and survives the post-thank-you auto-refresh
 * to recommendations — the inputs are duplicated into multiple hidden
 * forms across the page).
 *
 * Verified live 2026-05-04 with two real Place Order tests:
 *   - Single-fulfillment whey buy: latestOrderId matched the actual
 *     orderId on order-details. Cancelled cleanly.
 *   - Multi-fulfillment fan-out (MacBook + Jackery, 2 orders): the
 *     thank-you page rendered ONLY ONE latestOrderId (the canonical
 *     order's). The second fan-out order's id was not on the page.
 *
 * Implication: this fast-path is reliable for SINGLE-fulfillment buys
 * (which is the common case for buy-now mode). For fan-out cases, it
 * captures only the canonical order — same coverage limit as the
 * existing fetchOrderIdFromHistory body-text regex (which also only
 * returns one orderId).
 *
 * Filler mode does NOT use this fast-path — `fetchOrderIdsForAsins` is
 * still required there for the full ASIN→order mapping that drives
 * the filler-cancel sweep. The DOM read would only give us the target's
 * order; the filler-only orders' ids still need the order-history walk.
 *
 * Saves ~15s vs the order-history nav. Returns null on miss; caller
 * falls through to the existing nav.
 *
 * See `docs/research/amazon-pipeline.md` for the full empirical
 * research behind this field.
 */
async function readLatestOrderIdFromDom(page: Page): Promise<string | null> {
  const value = await page
    .locator('input[name="latestOrderId"]')
    .first()
    .getAttribute('value', { timeout: 1_000 })
    .catch(() => null);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{3}-\d{7}-\d{7}$/.test(trimmed) ? trimmed : null;
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
