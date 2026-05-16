import type { Page } from 'playwright';
import { htmlToDocument } from '../shared/jsdom.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../shared/logger.js';
import {
  DELIVERY_OPTIONS_CHANGED_SELECTOR,
  isVerifyCardChallenge,
  parseOrderConfirmation,
} from '../parsers/amazonCheckout.js';
import { effectivePriceTolerance } from '../parsers/productConstraints.js';
import type { BuyResult, BGAddress, PaymentCardFill } from '../shared/types.js';
import { evaluateCashbackGate } from '../shared/cashbackGate.js';
import { clearCart, type ClearCartResult } from './clearCart.js';
import { addFillerViaHttp, waitForDeliverySettle } from './buyWithFillers.js';
import { parseAsinFromUrl } from '../shared/sanitize.js';
import { HTTP_BROWSERY_HEADERS, SPC_ENTRY_URL, SPC_URL_MATCH } from './amazonHttp.js';
import { resolvePlacedQuantity } from '../shared/quantityResolver.js';
import { recordPlacedOrderEvent } from '../main/placedOrderLedger.js';

type BuyOptions = {
  dryRun: boolean;
  minCashbackPct: number;
  /** Per-account toggle (default true). When false, the cashback gate
   *  is skipped entirely and a missing on-page reading defaults to
   *  DEFAULT_MISSING_CASHBACK_PCT (5%). See shared/cashbackGate.ts. */
  requireMinCashback: boolean;
  /** Per-job override that skips the `verifyCheckoutPrice` gate at /spc.
   *  Set on the BG manual Trigger panel as "Bypass price check". Default
   *  false (enforce the cap). Independent of requireMinCashback. */
  bypassPriceCheck?: boolean;
  maxPrice: number | null;
  allowedAddressPrefixes: string[];
  /** The account's BG receiving address. When checkout lands on the
   *  "Add delivery address" state and this is set, waitForCheckout
   *  auto-adds it instead of failing as action_required. Null when the
   *  account has no configured BG address. */
  bgAddress?: BGAddress | null;
  /** The payment card assigned to this account. When checkout lands
   *  on the "Add a credit or debit card" state and this is set,
   *  waitForCheckout auto-adds it. Null when no card is assigned. */
  paymentCard?: PaymentCardFill | null;
  correlationId?: string;
  /**
   * Routing context the disk-log sink uses to land step.buy.* events on
   * the right per-attempt jsonl file. Without these fields the sink at
   * `main/index.ts:798-815` drops every event silently — the production
   * 52s gap between scrape.ok and profile.placed used to have ZERO
   * step-level detail because of this. Optional only because tests +
   * standalone scripts can omit them; in production both are always set.
   */
  jobId?: string;
  profile?: string;
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
  /**
   * Resolver for Amazon's PMTS "Verify your card" checkout challenge.
   * Given the card's last 4 digits (read from the challenge's
   * placeholder hint), returns the full card number from AmazonG's
   * encrypted local vault, or null when no saved card matches. When
   * supplied, the challenge is auto-handled; when omitted the buy
   * fails to action_required with reason "Verify your card" (legacy).
   */
  resolveCardNumber?: (last4: string) => Promise<string | null>;
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

/**
 * True only when running unpackaged — `npm run dev` / electron-vite
 * dev, not the built .app. Uses Electron's `app.isPackaged`, the
 * ground-truth signal.
 *
 * NOT `process.env.NODE_ENV`: this electron-vite main-process build
 * leaves NODE_ENV as 'production' even under `npm run dev`, which
 * silently disabled debug capture in dev (the v0.13.x "we never
 * captured the HTML" surprise). Lazy electron import so importing
 * this module stays safe in non-Electron contexts (vitest).
 */
async function isUnpackagedRun(): Promise<boolean> {
  try {
    const electron = await import('electron');
    const app = (electron as { app?: { isPackaged?: boolean } }).app;
    return app?.isPackaged === false;
  } catch {
    return false;
  }
}

/**
 * Like captureDebugShot but ALSO drops a full HTML snapshot alongside
 * the PNG. Use at points where we want both visual context (screenshot)
 * AND the actual DOM for offline analysis (e.g., DOM-drift bugs that
 * are hard to reproduce). Same best-effort contract — returns null if
 * debugDir is unset or either capture fails. Tag is timestamp-prefixed
 * so multiple captures per attempt don't overwrite.
 *
 * DEV-RUN ONLY. Captures whenever running unpackaged (`npm run dev`)
 * and is a no-op in the packaged build — gated on `app.isPackaged`
 * via isUnpackagedRun(). The lighter captureDebugShot (PNG only)
 * stays always-on for real-user diagnostics; this heavier
 * HTML-capture path is for dev runs.
 */
export async function captureDebugSnapshot(
  page: Page,
  debugDir: string | undefined,
  tag: string,
): Promise<{ pngPath: string; htmlPath: string } | null> {
  if (!debugDir) return null;
  if (!(await isUnpackagedRun())) return null;
  try {
    await mkdir(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pngPath = join(debugDir, `${ts}_${tag}.png`);
    const htmlPath = join(debugDir, `${ts}_${tag}.html`);
    await Promise.all([
      page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined),
      page
        .content()
        .then((html) => writeFile(htmlPath, html, 'utf8'))
        .catch(() => undefined),
    ]);
    return { pngPath, htmlPath };
  } catch {
    return null;
  }
}

/**
 * In-page probe that gathers diagnostic context for a failure point.
 * Given a map of named selectors, returns counts and a small text
 * sample for each — useful when an expected selector misses and we
 * want to know what the page DOES contain. Always-on (single
 * page.evaluate, cheap) so the failure log carries enough context to
 * narrow DOM drift without a follow-up reproduction.
 *
 * Returns an empty object on evaluate failure — never throws.
 */
export async function probePageDiag(
  page: Page,
  selectors: Record<string, string>,
): Promise<{
  url: string;
  title: string;
  selectors: Record<string, { count: number; sample: string | null }>;
}> {
  return page
    .evaluate((sels) => {
      const out: Record<string, { count: number; sample: string | null }> = {};
      for (const [name, sel] of Object.entries(sels)) {
        try {
          const els = document.querySelectorAll(sel);
          const first = els[0] as HTMLElement | undefined;
          const text = first
            ? (first.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
            : '';
          const href = first?.getAttribute('href') ?? '';
          const sample = first
            ? `${first.tagName}${href ? ' href=' + href.slice(0, 80) : ''}${text ? ' "' + text + '"' : ''}`.slice(0, 200)
            : null;
          out[name] = { count: els.length, sample };
        } catch {
          out[name] = { count: 0, sample: null };
        }
      }
      return {
        url: location.href,
        title: document.title.slice(0, 120),
        selectors: out,
      };
    }, selectors)
    .catch(() => ({ url: '', title: '', selectors: {} }));
}

/**
 * After a `waitForConfirmationOrPending` timeout, decide whether the
 * Place Order click was in fact accepted — i.e. the order is most
 * likely already live on Amazon even though we never saw the
 * thank-you page. Failing the attempt as `confirm_parse` when this is
 * true discards a real, placed order — the ghost-order bug. Callers
 * use a true result to fall through to order-id recovery instead.
 *
 * Signals (any one is sufficient):
 *  - URL is the thank-you handler or carries a `purchaseId` — Amazon
 *    routes there only post-placement.
 *  - URL is the `/spc/place-order` post-click processing page AND no
 *    Place Order button remains — the button is removed from the DOM
 *    the instant the click is accepted.
 *
 * Conservative on ambiguity: anything else (including an evaluate
 * failure on the button probe) returns likelyPlaced=false so the
 * caller still fails the attempt rather than reporting a phantom.
 */
export async function detectOrderLikelyPlaced(
  page: Page,
): Promise<{ likelyPlaced: boolean; reason: string }> {
  const url = page.url();
  if (/\/buy\/thankyou\//.test(url) || /[?&]purchaseId=/.test(url)) {
    return { likelyPlaced: true, reason: 'thankyou/purchaseId URL' };
  }
  if (/\/spc\/place-order/.test(url)) {
    const placeOrderVisible = await page
      .evaluate(
        () =>
          !!document.querySelector(
            'input[name="placeYourOrder1"], #submitOrderButtonId',
          ),
      )
      .catch(() => true);
    if (!placeOrderVisible) {
      return {
        likelyPlaced: true,
        reason: '/spc/place-order processing page, Place Order button gone',
      };
    }
    return {
      likelyPlaced: false,
      reason: '/spc/place-order but Place Order button still present',
    };
  }
  return { likelyPlaced: false, reason: `no placement signal (url=${url})` };
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
  // Merge routing fields into every emitted event so the disk-log sink
  // (main/index.ts:798-815) lands them on the right per-attempt jsonl.
  // Without this the sink drops every step.buy.* event silently — see
  // BuyOptions.jobId docstring above.
  const ctx: Record<string, unknown> = {};
  if (opts.jobId) ctx.jobId = opts.jobId;
  if (opts.profile) ctx.profile = opts.profile;
  const step: StepEmitter = (message, data) =>
    logger.info(message, { ...ctx, ...(data ?? {}) }, cid);
  const warn: StepEmitter = (message, data) =>
    logger.warn(message, { ...ctx, ...(data ?? {}) }, cid);

  // Capture deal ASIN from the PDP url at start. Used downstream by
  // verifyOrderContainsAsin to defend against the cross-deal orderId
  // contamination bug (2026-05-07: 6 BG purchases on cpnnick@gmail.com
  // all stamped with the same Amazon orderId across 5 different deals;
  // the post-place thank-you DOM rendered a stale latestOrderId on
  // rapid-fire same-account buys). The PDP url is reliable here — the
  // workflow hands buyNow an already-loaded product page.
  const dealAsin = parseAsinFromUrl(page.url());

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
      // Buy-now-click bypasses the cart entirely, so any inflight
      // preflightCleared from pollAndScrape is unused. Drain its
      // promise so a rejection (rare — bot challenge, csrf rotation)
      // doesn't surface as an unhandled rejection. pollAndScrape now
      // gates preflight on useFillers, so this is normally a no-op
      // belt-and-suspenders for any future caller that passes one.
      if (opts.preflightCleared) {
        void opts.preflightCleared.catch(() => undefined);
      }
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
            // 'commit' = ~50ms vs ~300ms for DCL. Next op (page.url() check)
            // works at commit; downstream waitForCheckout polls for the
            // Place Order button.
            await page.goto(SPC_ENTRY_URL, { waitUntil: 'commit', timeout: 30_000 });
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
      undefined,
      {
        onDeliveryOptionsChanged: async () => {
          const re = await pickBestCashbackDelivery(page, opts.minCashbackPct);
          step('step.buy.spc.delivery_options_changed.repicked', { changes: re.changes });
        },
        targetAsin: dealAsin,
        resolveCardNumber: opts.resolveCardNumber,
        bgAddress: opts.bgAddress,
        paymentCard: opts.paymentCard,
      },
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
      // Account has no delivery address — checkout can't proceed until
      // the user adds one. Surface as checkout_address; the worker maps
      // the "Add delivery address" reason to action_required.
      if (checkoutPage.kind === 'no_address') {
        warn('step.buy.no_address', { reason: checkoutPage.reason });
        return fail('checkout_address', checkoutPage.reason);
      }
      // No payment method and no assigned card to auto-add (or the
      // add failed). Surface as checkout_payment; the worker maps the
      // "Add payment method" reason to action_required.
      if (checkoutPage.kind === 'no_payment') {
        warn('step.buy.no_payment', { reason: checkoutPage.reason });
        return fail('checkout_payment', checkoutPage.reason);
      }
      return fail('checkout_wait', checkoutPage.reason, checkoutPage.detail);
    }
    step('step.buy.checkout', { detected: checkoutPage.detected });
    // QLA capped the target row: Amazon reduced our request to M >= 1.
    // Use M downstream so the qty reported to BG matches what shipped.
    if (typeof checkoutPage.adjustedQty === 'number' && checkoutPage.adjustedQty > 0 && checkoutPage.adjustedQty !== placedQuantity) {
      warn('step.buy.qla.adjusted', { from: placedQuantity, to: checkoutPage.adjustedQty });
      placedQuantity = checkoutPage.adjustedQty;
    }

    // 4. Checkout[0]: re-verify item price on /spc (catches taxes/shipping
    //    that push the total past the retail cap).
    //
    // Bypass: when the BG manual Trigger panel sets `bypassPriceCheck`,
    // skip the gate entirely. The user has already accepted that this
    // specific job may pay over cap, so we proceed to Place Order. The
    // bypass is logged so downstream forensics can spot it.
    if (opts.maxPrice !== null && opts.bypassPriceCheck === true) {
      step('step.checkout.price.bypass', {
        max: opts.maxPrice,
        reason: 'user_opt_in',
      });
    } else if (opts.maxPrice !== null) {
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
      // Wait for the eligibleshipoption XHR + 200ms post-settle (covers
      // the 6%→5% strip race). Replaces a blind 1500ms wait — typical
      // XHR ~1s, saving ~300ms.
      await waitForDeliverySettle(page);
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
      const toggled = await toggleBGNameAndRetry(
        page,
        opts.allowedAddressPrefixes,
        { step, warn },
        opts.debugDir,
      );
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
      debugDir: opts.debugDir,
    });
    let recoveredFromConfirmTimeout = false;
    if (!confirmWait.ok) {
      // The confirmation page never loaded — but that does NOT mean the
      // order wasn't placed. If the Place Order click was accepted,
      // failing as confirm_parse here discards a real order (the
      // ghost-order bug). Check the page state first.
      const placed = await detectOrderLikelyPlaced(page);
      if (!placed.likelyPlaced) {
        // Genuine failure — capture what's on screen. Often Amazon
        // stalled the redirect or showed an unrecognized interstitial.
        const shotPath = await captureDebugShot(page, opts.debugDir, 'confirm_parse');
        if (shotPath) {
          warn('step.buy.confirm.screenshot', { path: shotPath, currentUrl: page.url() });
        }
        // Always-on probe + dev-only HTML snapshot. Mirrors the other
        // failure sites — the probe log line tells us which known
        // landmarks ARE on the timed-out confirmation page (place-order
        // still visible, error 500, BYG continue, pending-order page).
        const probe = await probePageDiag(page, {
          placeOrderInput: 'input[name="placeYourOrder1"]',
          placeOrderById: '#submitOrderButtonId',
          thankyouMarker: '#widget-purchase-confirmation, [data-feature-name="thankYou"]',
          errors500Marker: 'h1, h2',
          bygContinueButton: 'input[name="proceedToRetailCheckout"]',
          pendingOrderText: 'body',
        }).catch(() => null);
        warn('step.buy.confirm.probe', { url: page.url(), probe });
        const snap = await captureDebugSnapshot(page, opts.debugDir, 'confirm_parse');
        if (snap) {
          step('step.buy.confirm.snapshot', { png: snap.pngPath, html: snap.htmlPath });
        }
        return fail('confirm_parse', confirmWait.reason);
      }
      // Order was almost certainly placed despite the timeout — the
      // Place Order click was accepted. Fall through to the order-id
      // recovery path below instead of discarding a real order.
      recoveredFromConfirmTimeout = true;
      warn('step.buy.confirm.timeout.recovering', {
        reason: confirmWait.reason,
        url: page.url(),
        signal: placed.reason,
      });
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

    // DURABLE LEDGER. Confirmation page reached (or recovered from a
    // confirmation timeout) — a real order IS placed on Amazon. Append
    // synchronously NOW, before orderId capture or reporting, so the
    // placement survives every downstream failure mode. See
    // placedOrderLedger.ts.
    recordPlacedOrderEvent({
      event: 'order_confirmed',
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      url: page.url(),
      amazonPurchaseId,
      ...(recoveredFromConfirmTimeout
        ? { detail: 'recovered after confirmation-URL timeout' }
        : {}),
    });
    // Optional: parse the confirmation page for the final price (the
    // orderId pulled from it is unreliable — recommendation sections and
    // "items you may like" carousels can contain stale order ids that
    // would false-match our regex). Order id comes from Your Orders below.
    const confirmationHtml = await page.content();
    const confirmation = parseOrderConfirmation(
      htmlToDocument(confirmationHtml),
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
      step('step.buy.orderid.fetch', { url: 'https://www.amazon.com/gp/css/order-history', dealAsin });
      orderId = await fetchOrderIdFromHistory(page, dealAsin).catch(() => null);
      if (!orderId) {
        warn('step.buy.orderid.notfound', {
          note: 'neither thank-you DOM nor order-history page revealed a parseable order id',
        });
      }
    }

    // Sanity-check: the captured orderId's order-details page must
    // contain a link to our deal's ASIN. Defends against the cross-deal
    // contamination bug (see dealAsin docstring above). On mismatch we
    // null the orderId rather than report a misattributed value — BG's
    // dashboard then shows the row as "no orderId" instead of pointing
    // at someone else's order. Skipped silently when ASIN couldn't be
    // parsed (non-PDP buy pathway) or when the order-details fetch
    // itself fails (transient HTTP — don't punish good captures).
    if (orderId && dealAsin) {
      const trust = await verifyOrderContainsAsin(page, orderId, dealAsin);
      if (trust.trusted) {
        step('step.buy.orderid.verified', {
          orderId,
          asin: dealAsin,
          reason: trust.reason,
        });
      } else {
        warn('step.buy.orderid.untrusted', {
          orderId,
          asin: dealAsin,
          reason: trust.reason,
        });
        orderId = null;
      }
    }

    // Durable ledger: record the capture outcome so the ledger line
    // can be diffed against job-attempts.json / BG to localize a ghost.
    recordPlacedOrderEvent({
      event: orderId ? 'orderid_captured' : 'orderid_missing',
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      url: page.url(),
      orderId,
      amazonPurchaseId,
    });

    step('step.buy.placed', {
      orderId,
      amazonPurchaseId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
    });

    // Resolve final qty via the shared resolver. In single-buy mode we
    // don't have a separate /spc-DOM read so we just feed cart-add intent.
    // Verify phase re-reads from order-details and submits
    // `correctPurchasedCount` to BG if it differs.
    const qtyResolution = resolvePlacedQuantity({
      fromSpcDom: null,
      fromCartAddTarget: placedQuantity,
    });
    return {
      ok: true,
      dryRun: false,
      orderId,
      amazonPurchaseId,
      finalPrice: confirmation.finalPrice,
      finalPriceText: confirmation.finalPriceText,
      cashbackPct,
      quantity: qtyResolution.quantity,
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

  // 'commit' = ~50ms vs ~300ms for DCL. Next op is a Playwright
  // locator click which polls for visibility internally. Goto error
  // tolerated — Amazon's Chewbacca pipeline can ERR_ABORT this nav by
  // redirecting before commit fires. Verify by final URL instead.
  await page
    .goto(ATC_CART_URL, { waitUntil: 'commit', timeout: 30_000 })
    .catch(() => undefined);
  {
    const landed = page.url();
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)?amazon\.com\//i.test(landed)) {
      return {
        ok: false,
        reason: 'failed to load cart page',
        detail: `landed on ${landed || '(blank)'}`,
      };
    }
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
  | {
      ok: true;
      detected: string;
      /** When Amazon capped the target row on the "Make updates to your
       *  items" page (QLA banner with qty reduced from N to M), this
       *  holds M — the qty Amazon will actually place. Buy code uses it
       *  to correct the cart-add target value on the way to BG, so the
       *  dashboard shows M rather than N. Absent when no QLA gate fired. */
      adjustedQty?: number;
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
      kind?:
        | 'unavailable'
        | 'quantity_limit'
        | 'timeout'
        | 'no_address'
        | 'no_payment';
    };

const CART_URL = 'https://www.amazon.com/gp/cart/view.html';
const ADD_ADDRESS_URL =
  'https://www.amazon.com/a/addresses/add?ref=ya_address_book_add_button';

/**
 * Add a delivery address to the Amazon account from a saved BG
 * address. Called by waitForCheckout when checkout parks on the
 * "Add delivery address" state and the account has a bgAddress.
 *
 * Navigates OFF the checkout to the dedicated address-book add page
 * (/a/addresses/add) — more reliable than the in-checkout modal — and
 * the caller re-enters checkout afterwards via reenterCheckout().
 *
 * Recipe verified live 2026-05-16:
 *   1. goto /a/addresses/add.
 *   2. Fill the stable `address-ui-widgets-*` fields (Country defaults
 *      to United States — left as-is).
 *   3. Tick "Use as my default address".
 *   4. Click "Add address" — up to twice: Amazon's verifier shows a
 *      "couldn't verify" warning on the first click for addresses it
 *      can't verify; the second click accepts it as entered. The form
 *      page going away is the accepted signal.
 *
 * Returns true when the address was accepted, false on any failure.
 * Never throws.
 */
async function addDeliveryAddress(
  page: Page,
  addr: BGAddress,
  emit?: { step: StepEmitter; warn: StepEmitter },
): Promise<boolean> {
  const FORM = '#address-ui-widgets-enterAddressFullName';
  const SUBMIT =
    'input[aria-labelledby="address-ui-widgets-form-submit-button-announce"]';
  try {
    await page.goto(ADD_ADDRESS_URL);
    await page.waitForSelector(FORM, { timeout: 15_000 });

    await page.fill(FORM, addr.fullName);
    await page.fill('#address-ui-widgets-enterAddressPhoneNumber', addr.phone);
    await page.fill('#address-ui-widgets-enterAddressLine1', addr.street1);
    if (addr.street2) {
      await page.fill('#address-ui-widgets-enterAddressLine2', addr.street2);
    }
    await page.fill('#address-ui-widgets-enterAddressCity', addr.city);
    // State <select> options are keyed by the 2-letter code (value
    // "OR" / label "Oregon") — selectOption matches either.
    await page
      .locator(
        '#address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId',
      )
      .selectOption(addr.state)
      .catch(() => undefined);
    await page.fill('#address-ui-widgets-enterAddressPostalCode', addr.zip);

    // "Use as my default address" — tick if not already.
    const def = page.locator('#address-ui-widgets-use-as-my-default');
    if (!(await def.isChecked().catch(() => true))) {
      await def.click().catch(() => undefined);
    }

    // "Add address" — up to 2 clicks. The first can land on a
    // "couldn't verify" warning (form stays); the second accepts the
    // address as entered. The form field going away (Amazon navigates
    // to the address book) is the accepted signal.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.locator(SUBMIT).first().click();
      await page.waitForTimeout(2_500);
      const stillOnForm = await page.locator(FORM).count().catch(() => 1);
      if (stillOnForm === 0) {
        emit?.step('step.waitForCheckout.address.added', { clicks: attempt });
        return true;
      }
    }
    emit?.warn('step.waitForCheckout.address.addFailed', {
      note: 'form still showing after 2 "Add address" clicks',
    });
    return false;
  } catch (err) {
    emit?.warn('step.waitForCheckout.address.error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Re-enter checkout after the address detour navigated off the
 * checkout pipeline. Goes cart → "Proceed to checkout". The cart
 * still holds the target + fillers, so this skips re-adding them.
 * Never throws.
 */
async function reenterCheckout(
  page: Page,
  emit?: { step: StepEmitter; warn: StepEmitter },
): Promise<void> {
  try {
    await page.goto(CART_URL);
    await page
      .locator('input[name="proceedToRetailCheckout"]')
      .first()
      .click();
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    emit?.step('step.waitForCheckout.reentered', { url: page.url() });
  } catch (err) {
    emit?.warn('step.waitForCheckout.reenter.error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const WALLET_URL =
  'https://www.amazon.com/cpe/yourpayments/wallet?ref_=ya_d_c_pmt_mpo';

/**
 * Add a payment card to the Amazon account from a saved card.
 * Called by waitForCheckout when checkout parks on the no-payment
 * state and the account has a card assigned.
 *
 * Navigates OFF the checkout to the Wallet page and drives the
 * add-card flow there (more reliable than the in-checkout iframe);
 * the caller re-enters checkout afterwards via reenterCheckout().
 *
 * Recipe verified live 2026-05-16:
 *   1. goto Wallet → "Add a payment method" → "Add a credit or debit
 *      card".
 *   2. Card fields render in a cross-origin PCI iframe
 *      (apx-security.amazon.com) — stable `name` attributes. Fill +
 *      "Add your card".
 *   3. Billing step: "Change" → "Add an address" → fill the card's
 *      billing address (ppw-* fields) → "Use this address". Amazon's
 *      address verifier may show a correction — accept the suggested
 *      one. Skipped entirely when the card has no billing address.
 *   4. Tick "Set as default payment method" → "Save".
 *
 * Returns false (never throws) when the card lacks an expiry or CVV
 * — Amazon's form requires both — or on any failure. The caller then
 * falls through to the action_required path.
 */
async function addPaymentCard(
  page: Page,
  card: PaymentCardFill,
  emit?: { step: StepEmitter; warn: StepEmitter },
): Promise<boolean> {
  if (!card.expiry || !card.cvv) {
    emit?.warn('step.waitForCheckout.payment.skip', {
      reason: 'assigned card has no expiry or CVV — Amazon requires both',
    });
    return false;
  }
  const m = card.expiry.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
  if (!m || !m[1] || !m[2]) {
    emit?.warn('step.waitForCheckout.payment.skip', {
      reason: `unparseable expiry "${card.expiry}"`,
    });
    return false;
  }
  // The month <select> values are unpadded ("1".."12"); the year
  // <select> values are 4-digit ("2026"+).
  const month = String(Number(m[1]));
  const year = `20${m[2].slice(-2)}`;
  try {
    await page.goto(WALLET_URL);
    await page
      .locator('a.apx-wallet-add-link[aria-label="Add a payment method"]')
      .first()
      .click();
    await page
      .locator('span.apx-secure-registration-content-trigger-js')
      .filter({ hasText: 'Add a credit or debit card' })
      .first()
      .click();

    // Card form — inside the cross-origin apx-secure iframe.
    const frame = page.frameLocator('iframe.apx-secure-iframe');
    const numberField = frame.locator('input[name="addCreditCardNumber"]');
    await numberField.waitFor({ state: 'visible', timeout: 20_000 });
    await numberField.fill(card.number);
    await frame
      .locator('input[name="ppw-accountHolderName"]')
      .fill(card.cardholderName);
    await frame
      .locator('select[name="ppw-expirationDate_month"]')
      .selectOption(month);
    await frame
      .locator('select[name="ppw-expirationDate_year"]')
      .selectOption(year);
    await frame
      .locator('input[name="addCreditCardVerificationNumber"]')
      .fill(card.cvv);
    await frame
      .locator('input[name="ppw-widgetEvent:AddCreditCardEvent"]')
      .click();

    // Billing step. When the card has its own billing address, switch
    // the billing address off the default (shipping) one and enter it.
    const ba = card.billingAddress;
    if (ba) {
      // "Change" / "Save" are apx widget submits — target by the
      // stable ppw-widgetEvent name. (Their visible label lives in a
      // sibling span, so the <input> itself has no accessible name —
      // getByRole({name}) misses it.)
      await frame
        .locator('input[name="ppw-widgetEvent:ChangeBillingAddressEvent"]')
        .click({ timeout: 20_000 });
      await frame
        .getByRole('button', { name: 'Add an address' })
        .click({ timeout: 15_000 });
      const fullName = frame.locator('input[name="ppw-fullName"]');
      await fullName.waitFor({ state: 'visible', timeout: 15_000 });
      await fullName.fill(ba.fullName);
      await frame.locator('input[name="ppw-line1"]').fill(ba.line1);
      if (ba.line2) {
        await frame.locator('input[name="ppw-line2"]').fill(ba.line2);
      }
      await frame.locator('input[name="ppw-city"]').fill(ba.city);
      await frame
        .locator('input[name="ppw-stateOrRegion"]')
        .fill(ba.state);
      await frame.locator('input[name="ppw-postalCode"]').fill(ba.zip);
      await frame
        .locator('select[name="ppw-countryCode"]')
        .selectOption(ba.country || 'US')
        .catch(() => undefined);
      await frame.locator('input[name="ppw-phoneNumber"]').fill(ba.phone);
      await frame
        .locator('input[name="ppw-widgetEvent:AddAddressEvent"]')
        .click();
      // Amazon's address verifier may show a "we suggest a correction"
      // modal — accept the suggested address (the first "Use this
      // address"). Absent when the address verified cleanly.
      await page.waitForTimeout(2_500);
      const useSuggested = frame
        .getByRole('button', { name: 'Use this address' })
        .first();
      if (await useSuggested.count().catch(() => 0)) {
        await useSuggested.click().catch(() => undefined);
      }
    }

    // Tick "Set as default payment method" and Save.
    await page.waitForTimeout(1_500);
    const defaultCb = frame.getByRole('checkbox', {
      name: /set as default payment method/i,
    });
    if (!(await defaultCb.isChecked().catch(() => true))) {
      await defaultCb.click().catch(() => undefined);
    }
    await frame
      .locator('input[name="ppw-widgetEvent:SavePaymentMethodDetailsEvent"]')
      .click({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    emit?.step('step.waitForCheckout.payment.submitted', {
      last4: card.number.replace(/\D/g, '').slice(-4),
    });
    return true;
  } catch (err) {
    emit?.warn('step.waitForCheckout.payment.error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function waitForCheckout(
  page: Page,
  allowedAddressPrefixes: string[] = [],
  debugDir?: string,
  emit?: { step: StepEmitter; warn: StepEmitter },
  opts: {
    onDeliveryOptionsChanged?: () => Promise<void>;
    /** Target ASIN — used to gate the quantity_limit failure on whether
     *  the target row was reduced to qty=0 (true QLA, can't continue) or
     *  to qty>=1 (Amazon adjusted, click Continue and proceed). */
    targetAsin?: string | null;
    /** Target title prefix — fallback when /dp/<asin> link is absent on
     *  the "Make updates to your items" page (live observed
     *  2026-05-11 — no /dp/ links at all on this page variant). */
    targetTitle?: string | null;
    /** Resolver for the PMTS "Verify your card" challenge: given the
     *  card's last 4 digits, returns the full number from the encrypted
     *  local vault (or null when none matches). When supplied, the
     *  challenge is auto-handled instead of failing to action_required.
     *  Omitted = legacy behavior (fail with reason "Verify your card"). */
    resolveCardNumber?: (last4: string) => Promise<string | null>;
    /** Internal recursion guard — set true after one verify-card
     *  attempt so a re-challenge can't loop. Callers never pass this. */
    _verifyCardAttempted?: boolean;
    /** The account's BG receiving address. When set and checkout
     *  lands on the "Add delivery address" state, the address is
     *  auto-added (once) instead of failing as action_required. */
    bgAddress?: BGAddress | null;
    /** The payment card assigned to the account. When set and
     *  checkout lands on the "Add a credit or debit card" state, the
     *  card is auto-added (once) instead of failing. */
    paymentCard?: PaymentCardFill | null;
  } = {},
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
  // `let` because the address auto-add detour navigates away from the
  // checkout and back — the deadline is reset once after it so the
  // re-entered checkout gets a fresh poll budget.
  let deadline = Date.now() + 30_000;
  let deliverClickedTimes = 0;
  // 5 rather than 3: a worst-case flow can chain several interstitials
  // (address → billing → payment → /spc), each adding one click.
  const MAX_DELIVER_CLICKS = 5;
  let iteration = 0;
  // One-shot guards: the address / payment auto-adds each run at most
  // once per waitForCheckout call, so a failed add can't loop.
  let addressAddAttempted = false;
  let paymentAddAttempted = false;
  // Captured on the QLA gate fall-through (when Amazon caps the target
  // row from N to M >= 1). Reported back to the caller so BG sees the
  // corrected qty instead of the cart-add target.
  let qlaAdjustedQty: number | null = null;
  // Amazon's checkout farm sometimes 500s for several seconds before
  // recovering. Up to 2 recovery attempts: first via the SPC entry
  // shortcut (fast), second via the /cart → Proceed-to-Checkout click
  // (more thorough session reset). Backoff between attempts gives the
  // farm time to settle. Bail after 2 so a genuinely-down checkout
  // doesn't burn the 30s budget.
  let amazon500Attempts = 0;
  const MAX_AMAZON500_RECOVERIES = 2;

  while (Date.now() < deadline) {
    iteration += 1;
    if (/\/errors\//i.test(page.url())) {
      if (amazon500Attempts >= MAX_AMAZON500_RECOVERIES) {
        return {
          ok: false,
          reason: `amazon /errors/500 persisted after ${MAX_AMAZON500_RECOVERIES} recovery attempts`,
          detail: `url=${page.url()}`,
        };
      }
      amazon500Attempts += 1;
      const attempt = amazon500Attempts;
      const backoffMs = 2_000 * attempt; // 2s, 4s
      emit?.warn('step.waitForCheckout.amazon500', {
        iteration,
        attempt,
        stuck: page.url(),
        action: attempt === 1 ? 'SPC_ENTRY_URL after backoff' : 'cart→PtC click after backoff',
        backoffMs,
      });
      await page.waitForTimeout(backoffMs);
      try {
        if (attempt === 1) {
          await page.goto(SPC_ENTRY_URL, { waitUntil: 'commit', timeout: 30_000 });
        } else {
          // Second attempt: full path through /cart so Amazon rebuilds
          // the checkout session from scratch. SPC entry shortcut
          // sometimes re-uses the poisoned session; cart→PtC click
          // forces a fresh purchaseId.
          await page.goto('https://www.amazon.com/gp/cart/view.html', { waitUntil: 'commit', timeout: 30_000 });
          await page.locator('input[name="proceedToRetailCheckout"]').click({ timeout: 10_000 });
        }
      } catch (err) {
        return {
          ok: false,
          reason: `amazon /errors/500 recovery attempt ${attempt} threw`,
          detail: String(err).slice(0, 200),
        };
      }
      continue;
    }
    const state = await page
      .evaluate(({ placeSelectors, placeLabelPattern, targetAsin, targetTitle }) => {
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
        //     `stage: 'cashback_gate'` and triggering the configured
        //     filler-attempt retry loop in pollAndScrape — exactly the
        //     wasted-time scenario this catch is here to prevent).
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
        const limitMessage = limitEl
          ? (limitEl.textContent ?? '').replace(/\s+/g, ' ').trim()
          : PURCHASE_LIMIT_RE.test(body)
            ? (body.match(/sorry,?\s+you['’]ve\s+reached[^.]*\.?/i)?.[0] ?? '').trim()
            : null;
        if (limitMessage !== null) {
          // Anchor strategy for the capped row's container:
          //  1. The QLA banner element itself sits inside the row's
          //     `line-item-group-display-*` container — most robust;
          //     works without targetAsin or targetTitle (the bot's
          //     scrapeProduct sometimes returns title=null, and some
          //     page variants strip /dp/ links).
          //  2. /dp/<asin> link fallback.
          //  3. Title-prefix text-node fallback.
          // eslint-disable-next-line @typescript-eslint/no-shadow
          const adjustedQty: number = (() => {
            let group: Element | null =
              limitEl?.closest('[id^="line-item-group-display-"]') ?? null;
            if (!group) {
              let anchor: Element | null = null;
              if (targetAsin) {
                anchor =
                  document.querySelector<HTMLAnchorElement>(`a[href*="/dp/${targetAsin}"]`) ??
                  document.querySelector<HTMLAnchorElement>(`a[href*="/gp/product/${targetAsin}"]`);
              }
              if (!anchor && targetTitle && targetTitle.length > 5) {
                const needle = targetTitle.toLowerCase();
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                  const txt = ((n as Text).textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
                  if (txt.length > 5 && txt.startsWith(needle)) {
                    anchor = n.parentElement;
                    break;
                  }
                }
              }
              group = anchor?.closest('[id^="line-item-group-display-"]') ?? null;
            }
            if (!group) return 0;
            const live = group.querySelector('.a-stepper-value-live');
            if (live) {
              const n = parseInt((live.textContent ?? '').trim(), 10);
              if (Number.isFinite(n) && n >= 0 && n < 100) return n;
            }
            const input = group.querySelector<HTMLInputElement>('input[type="number"], input[type="text"]');
            if (input && /^\d{1,2}$/.test(input.value || '')) return parseInt(input.value, 10);
            return 0;
          })();
          if (adjustedQty < 1) {
            return {
              kind: 'quantity_limit' as const,
              adjustedQty,
              message:
                limitMessage ||
                "Sorry, you've reached the purchase limit for this item. Please remove the item to continue.",
            };
          }
          // Target still cart-able at reduced qty. Surface the adjusted
          // qty so the outer loop can pass it back to the caller, then
          // fall through to let 'updates'/'place' detection handle the
          // page transition normally.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          (window as unknown as { __qlaAdjustedQty?: number }).__qlaAdjustedQty = adjustedQty;
        }

        // 1. Place Order — terminal success state. Try selector list
        //    first (fast path); if none match, fall back to a text scan
        //    across visible buttons/inputs so new Amazon layouts that
        //    ship with different ids/attributes still resolve.
        //    Skip disabled placeholders — Amazon renders a disabled
        //    blocker (#review-order-continue-blocker-tooltip-trigger)
        //    next to the real button whenever the order isn't
        //    submittable. Returning kind='place' for it would burn
        //    retries on a click-dead button.
        const isLivePlace = (el: HTMLElement): boolean =>
          el.offsetParent !== null && !(el as HTMLInputElement).disabled;
        for (const s of placeSelectors) {
          if (Array.from(document.querySelectorAll<HTMLElement>(s)).some(isLivePlace)) {
            return { kind: 'place' as const, sel: s };
          }
        }
        // 1a. Banner-driven block. Amazon hides the real Place Order
        //     button when a shipping group lost its selection. Surface
        //     this so the caller can re-pick instead of waiting 30s.
        if (document.querySelector('[data-messageid="selectDeliveryOptionMessage"]')) {
          return { kind: 'delivery_options_changed' as const };
        }
        // 1b. The Amazon account has NO delivery address. Amazon parks
        //     checkout on an "Add delivery address" panel — no delivery
        //     options, no payable total, and no Place Order button will
        //     ever render. The page still shows a (dead) secondary
        //     "Deliver to this address" button, so this MUST be checked
        //     before the deliver block below, or it misclassifies as
        //     deliver_pending and spins out the full 30s timeout.
        //     Needs the user to add an address to the account.
        if (/enter your address to see delivery options/i.test(body)) {
          return { kind: 'no_address' as const };
        }
        // 1c. No usable payment method. Amazon's /pay step always
        //     offers an "Add a credit or debit card" trigger; the
        //     distinguishing signal for "no card on file" is that no
        //     payment-instrument radio is checked. Checked before the
        //     deliver block — /pay's continue button shares the
        //     Chewbacca shape (though it's disabled here anyway).
        if (
          document.querySelector('a.pmts-add-cc-default-trigger-link') &&
          !document.querySelector(
            'input[name="ppw-instrumentRowSelection"]:checked',
          )
        ) {
          return { kind: 'no_payment' as const };
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
      }, {
        placeSelectors: CHECKOUT_PLACE_SELECTORS,
        placeLabelPattern: PLACE_ORDER_LABEL_RE.source,
        targetAsin: opts.targetAsin ?? null,
        targetTitle: opts.targetTitle ?? null,
      })
      .catch(() => ({ kind: 'none' as const }));

    // Capture the QLA-adjusted qty from the in-page side-channel.
    // Set by the QLA fall-through branch when Amazon caps the target;
    // hangs around on the window until next navigation, but harmless to
    // read multiple times. Last value wins (later QLA hits would
    // overwrite — Amazon's caps don't change mid-flow).
    qlaAdjustedQty = await page
      .evaluate(() => (window as unknown as { __qlaAdjustedQty?: number }).__qlaAdjustedQty ?? null)
      .catch(() => qlaAdjustedQty);

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

    if (state.kind === 'no_address') {
      // Account has no delivery address. If the account has a saved BG
      // address, auto-add it (once) on the address-book page, re-enter
      // checkout, and re-poll. Otherwise fail fast: the caller maps
      // this to stage 'checkout_address' and the worker surfaces it as
      // action_required ("Add delivery address").
      if (opts.bgAddress && !addressAddAttempted) {
        addressAddAttempted = true;
        emit?.step('step.waitForCheckout.address.adding', {});
        const added = await addDeliveryAddress(page, opts.bgAddress, emit);
        if (added) {
          // The add navigated off-checkout — re-enter via the cart
          // (target + fillers are still in it) and reset the poll
          // budget for the fresh checkout pipeline.
          await reenterCheckout(page, emit);
          deadline = Date.now() + 30_000;
          await page.waitForTimeout(1_500);
          continue;
        }
      }
      return { ok: false, kind: 'no_address', reason: 'Add delivery address' };
    }

    if (state.kind === 'no_payment') {
      // No payment method on the account. If a card is assigned,
      // auto-add it (once) and re-poll — the state clears once the
      // card lands. Otherwise fail: the caller maps this to stage
      // 'checkout_payment' and the worker surfaces it as
      // action_required ("Add payment method").
      if (opts.paymentCard && !paymentAddAttempted) {
        paymentAddAttempted = true;
        emit?.step('step.waitForCheckout.payment.adding', {});
        const added = await addPaymentCard(page, opts.paymentCard, emit);
        if (added) {
          // The add navigated off-checkout (Wallet page) — re-enter
          // via the cart and reset the poll budget for the fresh
          // checkout pipeline.
          await reenterCheckout(page, emit);
          deadline = Date.now() + 30_000;
          await page.waitForTimeout(1_500);
          continue;
        }
      }
      return { ok: false, kind: 'no_payment', reason: 'Add payment method' };
    }

    if (state.kind === 'deliver_pending') {
      // Primary submit is in flight — longer settle interval before the
      // next poll so we don't burn iterations while Amazon processes.
      await page.waitForTimeout(1_500);
      continue;
    }

    if (state.kind === 'place') {
      return {
        ok: true,
        detected: state.sel,
        ...(qlaAdjustedQty !== null ? { adjustedQty: qlaAdjustedQty } : {}),
      };
    }

    if (state.kind === 'delivery_options_changed') {
      emit?.step('step.waitForCheckout.delivery_options_changed', { iteration });
      try {
        await opts.onDeliveryOptionsChanged?.();
      } catch (err) {
        return {
          ok: false,
          reason: `delivery-options-changed recovery failed: ${String(err).slice(0, 120)}`,
        };
      }
      // Let Amazon re-render the place button after the radio click.
      await page.waitForTimeout(opts.onDeliveryOptionsChanged ? 1_500 : 500);
      continue;
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
          // Always-on probe + dev-only HTML snapshot. Counts of the
          // selectors we DO know about so we can spot a new picker
          // layout without needing to open the screenshot.
          const probe = await probePageDiag(page, {
            address_radios: 'input[type="radio"][name*="address" i]',
            address_radios_any: 'input[type="radio"]',
            deliver_to_button: 'input[name="shipToThisAddress"]',
            use_this_address_button: 'input[name="useThisAddress"]',
            change_link: 'a[href*="/address" i]',
            saved_address_cards: '[data-testid*="address" i]',
            address_book_heading: 'h1, h2',
          }).catch(() => null);
          logger.warn(
            'step.checkout.address.picker.probe',
            { url: page.url(), probe },
          );
          const snap = await captureDebugSnapshot(page, debugDir, 'address_picker');
          if (snap) {
            logger.info(
              'step.checkout.address.picker.snapshot',
              { png: snap.pngPath, html: snap.htmlPath },
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
      // Identify the Continue button via aria-labelledby resolution
      // (Chewbacca's input has no value/aria-label/textContent of its
      // own — only a pointer to a separate <span>Continue</span>).
      // Tag it with a unique data attribute so Playwright's native
      // locator click finds it. Native click dispatches a real mouse
      // sequence (scroll-into-view, focus, mousedown, mouseup) — more
      // realistic than evaluate().click() for Amazon's bot-detection
      // heuristics on the cart-item-select submit.
      const tagged = await page
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
          const isContinue = (el: HTMLElement): boolean =>
            el.offsetParent !== null && /^continue$/i.test(readLabel(el));
          const target = Array.from(
            document.querySelectorAll<HTMLElement>(
              'input[type="submit"], button[type="submit"], input[type="button"], button:not([type])',
            ),
          ).find(isContinue)
            ?? Array.from(
              document.querySelectorAll<HTMLElement>('span, button, input, a'),
            ).find(isContinue);
          if (!target) return false;
          target.setAttribute('data-amazong-continue', '1');
          return true;
        })
        .catch(() => false);
      if (!tagged) {
        await page.waitForTimeout(500);
        continue;
      }
      try {
        await page.locator('[data-amazong-continue="1"]').click({ timeout: 5_000 });
      } catch {
        // Native click failed (element detached, etc.) — fall back to
        // JS click so we don't get stuck on a flaky page.
        await page
          .evaluate(() => {
            const el = document.querySelector<HTMLElement>('[data-amazong-continue="1"]');
            el?.click();
          })
          .catch(() => undefined);
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
    const doc = htmlToDocument(html);
    if (isVerifyCardChallenge(doc)) {
      // Auto-handle when a card resolver is wired AND we haven't
      // already tried once this call. The resolver looks up the full
      // card number from the encrypted local vault by the challenge's
      // "ending in NNNN" hint. On success Amazon re-renders the Place
      // Order button, so we re-run the wait once (guarded so a
      // re-challenge can't recurse forever).
      if (opts.resolveCardNumber && !opts._verifyCardAttempted) {
        const handled = await handleVerifyCardChallenge(
          page,
          opts.resolveCardNumber,
          emit?.step,
        );
        if (handled.ok) {
          emit?.step?.('step.buy.verifyCard.handled', {});
          return waitForCheckout(page, allowedAddressPrefixes, debugDir, emit, {
            ...opts,
            _verifyCardAttempted: true,
          });
        }
        return { ok: false, reason: `Verify your card — ${handled.reason}` };
      }
      return { ok: false, reason: 'Verify your card' };
    }
  } catch {
    // ignore — fall through to the generic message
  }
  // Generic 30s timeout — NOT a recognized interstitial. We have no
  // idea where the page parked: /errors/500, a delivery-options-
  // changed banner, a stuck Chewbacca interstitial, a signin
  // redirect, captcha, or back on /cart. Probe the likely landmarks
  // (always on) + drop a dev-only HTML/PNG snapshot so the next
  // occurrence is diagnosable. captureDebugSnapshot: dev runs only.
  const timeoutProbe = await probePageDiag(page, {
    place_order_input: 'input[name="placeYourOrder1"]',
    place_order_by_id: '#submitOrderButtonId',
    page_headings: 'h1, h2',
    delivery_options_changed:
      '[id*="delivery-options-changed" i], [class*="delivery-options-changed" i]',
    signin_form: 'form#ap_signin_form, input#ap_email',
    captcha: 'form[action*="validateCaptcha"], #captchacharacters',
    cart_proceed: 'input[name="proceedToRetailCheckout"]',
  }).catch(() => null);
  emit?.warn?.('step.buy.placeOrder.notAppeared.probe', {
    url: page.url(),
    probe: timeoutProbe,
  });
  const timeoutSnap = await captureDebugSnapshot(
    page,
    debugDir,
    'place_order_never_appeared',
  );
  if (timeoutSnap) {
    emit?.step?.('step.buy.placeOrder.notAppeared.snapshot', {
      png: timeoutSnap.pngPath,
      html: timeoutSnap.htmlPath,
    });
  }
  return { ok: false, reason: 'Place Order button never appeared in 30s' };
}

/**
 * Resolve Amazon's PMTS "Verify your card" checkout challenge.
 *
 * The challenge renders one input — `name` ending `_addCreditCardNumber`
 * — with a placeholder like "ending in 5088", plus a "Verify card"
 * button. We read the last-4 from the placeholder, look up the full
 * card number via `resolveCardNumber` (encrypted local vault), fill it,
 * and submit. On success Amazon clears the `.pmts-cc-address-challenge-form`
 * and re-renders the Place Order button.
 *
 * Returns ok:false (with a human reason) when there's no last-4 hint,
 * no matching saved card, or the number is rejected — the caller then
 * falls back to the existing `action_required` "Verify your card" path.
 */
export async function handleVerifyCardChallenge(
  page: Page,
  resolveCardNumber: (last4: string) => Promise<string | null>,
  step?: StepEmitter,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const numberInput = page.locator('input[name$="_addCreditCardNumber"]').first();
  const placeholder = await numberInput.getAttribute('placeholder').catch(() => null);
  // Placeholder reads e.g. "ending in 5088" — pull the trailing 4 digits.
  const last4 = placeholder?.match(/(\d{4})\s*$/)?.[1] ?? null;
  if (!last4) {
    return { ok: false, reason: 'could not read the card last-4 from the challenge' };
  }
  const fullNumber = await resolveCardNumber(last4);
  if (!fullNumber) {
    step?.('step.buy.verifyCard.noMatch', { last4 });
    return { ok: false, reason: `no saved card ending in ${last4}` };
  }
  step?.('step.buy.verifyCard.filling', { last4 });
  try {
    await numberInput.fill(fullNumber, { timeout: 8_000 });
  } catch (err) {
    return {
      ok: false,
      reason: `failed to fill card number: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Tag the "Verify card" button, then click it via a real Playwright
  // locator (force:true — the PMTS form sometimes overlays its own
  // spinner). Mirrors the continue-button tagging used above.
  const tagged = await page
    .evaluate(() => {
      const form = document.querySelector('.pmts-cc-address-challenge-form');
      if (!form) return false;
      const els = Array.from(form.querySelectorAll<HTMLElement>('input, button, span, a'));
      const hit = els.find((el) => {
        if (el.offsetParent === null) return false;
        const label = ((el as HTMLInputElement).value || el.textContent || '').trim();
        return /^verify card$/i.test(label);
      });
      if (!hit) return false;
      const clickable = (hit.closest('.a-button, button') as HTMLElement | null) ?? hit;
      clickable.setAttribute('data-amazong-verify-card', '1');
      return true;
    })
    .catch(() => false);
  if (!tagged) {
    return { ok: false, reason: 'Verify card button not found' };
  }
  try {
    await page
      .locator('[data-amazong-verify-card="1"]')
      .click({ timeout: 8_000, force: true });
  } catch (err) {
    return {
      ok: false,
      reason: `failed to click Verify card: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Amazon validates the number server-side then re-renders /spc. Wait
  // for the challenge wrapper to drop out of the DOM.
  try {
    await page
      .locator('.pmts-cc-address-challenge-form')
      .first()
      .waitFor({ state: 'detached', timeout: 20_000 });
  } catch {
    const stillThere = await page
      .locator('.pmts-cc-address-challenge-form')
      .count()
      .catch(() => 1);
    if (stillThere > 0) {
      return {
        ok: false,
        reason: 'challenge still present after Verify card (number rejected?)',
      };
    }
  }
  step?.('step.buy.verifyCard.cleared', { last4 });
  return { ok: true };
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
  opts: { allowAmazon500Recovery?: boolean } = {},
): Promise<AddrResult> {
  const allowRecovery = opts.allowAmazon500Recovery ?? true;
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
    const stuckUrl = page.url();
    // Amazon's transient HTTP 500 page during checkout. Observed live
    // 2026-05-10 on a real DL-05260034 buy: address-picker form.submit()
    // landed the browser at /errors/500?ref=chk_web_sry instead of /spc.
    // The checkout session is poisoned after the 500, but recreating it
    // via /checkout/entry/cart?proceedToCheckout=1 typically gives us a
    // fresh purchaseId — and the address change often committed
    // server-side already (Amazon's address-set is independent of the
    // /spc render that 500'd). Recurse once with recovery disabled so we
    // can't infinite-loop if Amazon's checkout farm is genuinely down.
    if (allowRecovery && /\/errors\//i.test(stuckUrl)) {
      emit.warn('step.checkout.address.amazon500', {
        stuck: stuckUrl,
        action: 'recreating /spc via SPC_ENTRY_URL and retrying ensureAddress once',
      });
      try {
        await page.goto(SPC_ENTRY_URL, { waitUntil: 'commit', timeout: 30_000 });
      } catch (err) {
        return {
          ok: false,
          reason: 'amazon returned http 500 during address change; spc recreate failed',
          detail: `stuck=${stuckUrl}; err=${String(err)}`,
        };
      }
      if (!SPC_URL_MATCH.test(page.url())) {
        return {
          ok: false,
          reason: 'amazon returned http 500 during address change; spc recreate did not land on /spc',
          detail: `stuck=${stuckUrl}; landed=${page.url()}`,
        };
      }
      return ensureAddress(page, allowedPrefixes, emit, { allowAmazon500Recovery: false });
    }
    return {
      ok: false,
      reason: 'address submitted but did not redirect back to /spc',
      detail: `stuck at ${stuckUrl}`,
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
  // Run the cashback-% scan inline in the browser instead of pulling the
  // whole /spc HTML over CDP and re-parsing via JSDOM. The CDP serialize
  // round-trip is the dominant cost (~80-150ms on a 318KB /spc); browser-
  // native DOM is faster than JSDOM for the same query. Logic mirrors the
  // pure parser at parsers/amazonProduct.ts:74 (`findCashbackPct`) — kept
  // as an export there so fixture tests keep passing. Update both if the
  // detection rules ever change.
  return page
    .evaluate(() => {
      const candidates: string[] = [];
      document
        .querySelectorAll(
          '[id*="cashback" i], [class*="cashback" i], [data-feature-name*="cashback" i]',
        )
        .forEach((n) => {
          const t = (n.textContent ?? '').trim();
          if (t) candidates.push(t);
        });
      candidates.push(document.body?.textContent ?? '');
      let best: number | null = null;
      for (const c of candidates) {
        const re = /(\d{1,2})\s*%\s*back/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(c)) !== null) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && (best === null || n > best)) best = n;
        }
        if (best !== null) break;
      }
      return best;
    })
    .catch(() => null);
}

export type ToggleResult =
  | { ok: true; cashbackPct: number | null; from: string; to: string }
  | { ok: false; reason: string; detail?: string };

export async function toggleBGNameAndRetry(
  page: Page,
  allowedPrefixes: string[],
  emit: { step: StepEmitter; warn: StepEmitter },
  /** Optional debug-snapshot directory. When provided, failure
   *  branches dump HTML + screenshot + selector probe to disk so
   *  DOM-drift bugs can be inspected offline. Best-effort. */
  debugDir?: string,
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
    // The "Change" link wasn't on the page. This typically means we're
    // not actually on /spc (Amazon redirected us — most often to
    // /errors/500 after the cashback radio click — see commit 00e7d94
    // for the force:true mitigation). Probe what IS on the page and
    // dump HTML so we can confirm the root cause without re-running
    // the buy.
    const diag = await probePageDiag(page, {
      expandPanelAddress: 'a.expand-panel-button[href*="/address"]',
      changeDeliveryLink: '#change-delivery-link',
      anyAddressLink: 'a[href*="/address"]',
      anyChangeButton: 'a.expand-panel-button',
      bodyTextSnippet: 'body',
    });
    const snap = await captureDebugSnapshot(
      page,
      debugDir,
      'name-toggle-reopen-fail',
    );
    emit.warn('step.checkout.cashback.name-toggle.reopen-fail', {
      url: diag.url,
      title: diag.title,
      selectors: diag.selectors,
      ...(snap ? { htmlPath: snap.htmlPath, pngPath: snap.pngPath } : {}),
    });
    return {
      ok: false,
      reason: "couldn't reopen address picker for name toggle",
      detail: `url=${diag.url}; title=${diag.title}; selectors=${JSON.stringify(diag.selectors)}`,
    };
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
    /** Dev-only HTML+PNG capture on the 60s confirmation timeout. The
     *  function already emits a `confirmation.timeout.diag` log line
     *  with url+title+h1s+h2s; this adds a saved DOM snapshot for
     *  offline analysis. Plumbed from BuyOptions.debugDir. */
    debugDir?: string;
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
        // Accept only post-Place-Order URLs as "confirmation". Two
        // foot-guns to avoid:
        //   - `/gp/buy/spc/handlers/display` is the SPC review URL
        //     BEFORE Place Order (removed in v0.13.34).
        //   - `/gp/your-account/order-details` is the user's account
        //     "View Order" page accessed from the flyout — NOT a
        //     post-place URL (added by mistake in v0.13.34, removed
        //     here). If a user manually clicks View Order on an old
        //     order while a buy is in-flight, including this here
        //     would let the regex say "confirmed" off an unrelated
        //     order's page and the orderId reader would grab a stale
        //     latestOrderId. Same root cause as the May-7 cross-deal
        //     contamination incident.
        // Confirmation detector — three layers in order:
        //
        //   1. URL substrings — broadened 2026-05-10 to also match
        //      Chewbacca's post-Place-Order paths.
        //        thankyou                      legacy /gp/buy/thankyou/...
        //        orderconfirm[ation]           /spc/orderconfirmation/...
        //        order-confirmation            hyphenated variant
        //        /gp/css/order-details         post-buy view-order
        //        /checkout/p/X/(thanks|        Chewbacca thank-you /
        //          confirm[ation]|finished)    confirmation variants
        //        /gp/buy/confirm/              older confirmation
        //
        //   2. document.title fallback — Amazon's confirmation page
        //      starts the <title> with one of a few well-known phrases.
        //      Anchored to .startsWith so chrome strings like
        //      "Place your order — Amazon" can't false-positive.
        //
        //   3. Visible heading fallback — large h1/h2 on the page
        //      saying "Thank you" / "Order placed". Only used when
        //      neither URL nor title matched, since heading text can
        //      drift between Amazon's redesigns. Anchored to short
        //      text so it can't false-match recommendation copy.
        //
        // INC-2026-05-10: AmazonG saw a successful place-order but
        // returned stage:'confirm_parse' because the new layout's
        // URL didn't contain any pre-2026-05 substring → bot looped
        // until the 60s deadline → no orderId capture, no verify.
        if (
          /thankyou|orderconfirm|order-confirmation|\/gp\/css\/order-details|\/checkout\/p\/[^/]+\/(?:thanks|thanksforyourpurchase|confirm|confirmation|finished)|\/gp\/buy\/confirm\//i.test(
            url,
          )
        ) {
          return { kind: 'confirmation' as const, url };
        }
        const title = (document.title || '').toLowerCase().trim();
        if (
          title.startsWith('order placed') ||
          title.startsWith('thank you') ||
          title.startsWith('your order has been placed') ||
          title.startsWith('thanks for your order')
        ) {
          return { kind: 'confirmation' as const, url };
        }
        // Heading fallback — find a short, prominent h1/h2 saying
        // "Thank you" or "Order placed". `innerText.length < 80`
        // filters out long marketing copy that contains the phrase
        // as a fragment.
        const headings = Array.from(
          document.querySelectorAll<HTMLElement>('h1, h2'),
        );
        for (const h of headings) {
          const text = (h.innerText || '').replace(/\s+/g, ' ').trim();
          if (text.length === 0 || text.length > 80) continue;
          if (
            /^(?:thank you|thanks)[!,.\s]/i.test(text) ||
            /^order placed[!,.\s]?/i.test(text) ||
            /^your order (?:has been placed|is confirmed)/i.test(text)
          ) {
            return { kind: 'confirmation' as const, url };
          }
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
  // Diagnostic dump on timeout — if a future Amazon layout change
  // slips past all three detectors, the next failure will at least
  // record the URL + title + visible headings so the regex can be
  // fixed surgically instead of by guessing. INC-2026-05-10
  // motivated this: the bot lost the order id because the new
  // confirmation URL didn't contain any pre-2026-05 substring and
  // we had no captured evidence of what URL it actually landed on.
  const diag = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      h1s: Array.from(document.querySelectorAll('h1'))
        .map((h) => ((h as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length < 200)
        .slice(0, 3),
      h2s: Array.from(document.querySelectorAll('h2'))
        .map((h) => ((h as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0 && t.length < 200)
        .slice(0, 3),
    }))
    .catch(() => ({ url: '', title: '', h1s: [], h2s: [] }));
  step('step.buy.place.confirmation.timeout.diag', diag);
  // Dev-only HTML + PNG capture (gated inside captureDebugSnapshot
  // on NODE_ENV). Lets the developer collect data across a batch
  // of jobs without having to reproduce each one interactively.
  // Run a probe alongside the existing url+title+h1+h2 logging so
  // the JSON log line also tells us if known landmarks (place order
  // button, BYG continue, /errors/500 marker, delivery-options-
  // changed banner) are present on the page that timed out.
  const probe = await probePageDiag(page, {
    placeOrderInput: 'input[name="placeYourOrder1"]',
    placeOrderById: '#submitOrderButtonId',
    pendingOrderText: 'body',
    errors500Marker: 'h1, h2',
    deliveryOptionsChangedBanner: '[id*="delivery-options-changed" i], [class*="delivery-options-changed" i]',
    bygContinueButton: 'input[name="proceedToRetailCheckout"]',
  });
  const snap = await captureDebugSnapshot(
    page,
    opts.debugDir,
    'confirm-url-never-loaded',
  );
  step('step.buy.place.confirmation.timeout.capture', {
    selectors: probe.selectors,
    ...(snap ? { htmlPath: snap.htmlPath, pngPath: snap.pngPath } : {}),
  });
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
  // Walk every CSS selector in one browser-side evaluate instead of
  // 9 sequential `await loc.count()` calls (each is a CDP round-trip
  // costing ~5-15ms; cumulatively ~50-150ms before this consolidation).
  // Browser-side `document.querySelector` resolves identically to
  // Playwright's locator-count check for these selectors.
  const matchedIdx = await page
    .evaluate(
      (selectors) => {
        for (let i = 0; i < selectors.length; i++) {
          if (document.querySelector(selectors[i])) return i;
        }
        return -1;
      },
      CHECKOUT_PLACE_SELECTORS as unknown as string[],
    )
    .catch(() => -1);
  if (matchedIdx >= 0) {
    const sel = CHECKOUT_PLACE_SELECTORS[matchedIdx];
    if (sel) return page.locator(sel).first();
  }
  // Text fallback — mirrors waitForCheckout's detector. Picks any
  // visible interactive element whose label matches "Place your order".
  // Uses Playwright's role+name locator so auto-waiting + actionability
  // checks still apply at click time. These two probes can't be folded
  // into the evaluate above — they use Playwright's role/text engines,
  // not raw document.querySelector.
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
    // Compute plans inline in the browser instead of pulling /spc HTML
    // over CDP and re-parsing it with JSDOM each iteration. ~80-150ms
    // saved per iteration on a 318KB /spc; typical 1-3 iters per buy.
    // Mirrors the pure parser at parsers/amazonCheckout.ts:309
    // (`computeCashbackRadioPlans`) — kept exported so fixture tests
    // continue to cover it. Update both if the radio-grouping rules
    // ever change.
    //
    // Note: syncCheckedAttribute is no longer needed here because we
    // read live `:checked` properties directly (browser DOM, not JSDOM
    // serialized HTML). The exported pure parser still relies on the
    // attribute being synced — its callers handle that themselves.
    const plans = await page
      .evaluate((minPct: number) => {
        const SKIP_NAME_RE =
          /destinationSubmissionUrl|paymentMethodForUrl|paymentMethod|ship-to-this|addressRadio/i;
        const radios = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        ).filter((r) => !SKIP_NAME_RE.test(r.name || r.id || ''));
        type Opt = { value: string; label: string; pct: number; checked: boolean };
        const byName = new Map<string, Opt[]>();
        for (const r of radios) {
          if (!r.name) continue;
          const card =
            r.closest('label, .a-radio, [role="radio"]') ??
            (r.parentElement as Element | null);
          // Browser-native innerText handles script/style stripping +
          // whitespace normalization for free — no treewalker needed.
          const label = card
            ? ((card as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
            : '';
          const m = label.match(/(\d{1,2})\s*%\s*back/i);
          const pct = m ? Number(m[1]) : 0;
          const opts = byName.get(r.name) ?? [];
          opts.push({ value: r.value, label, pct, checked: r.checked });
          byName.set(r.name, opts);
        }
        const out: {
          name: string;
          value: string;
          label: string;
          pickedPct: number;
        }[] = [];
        for (const [name, opts] of byName.entries()) {
          const best = opts.reduce((a, b) => (b.pct > a.pct ? b : a));
          const current = opts.find((o) => o.checked);
          // Group with no selection — Amazon wiped the prior choice (the
          // "Please select a new delivery option" recovery case).
          // Pick the highest-cashback option, or any if all 0%.
          if (!current) {
            out.push({
              name,
              value: best.value,
              label: best.label.slice(0, 120),
              pickedPct: best.pct,
            });
            continue;
          }
          // Existing behavior: swap to a higher-cashback option only.
          if (opts.length < 2) continue;
          if (best.pct >= minPct && best.pct > current.pct) {
            out.push({
              name,
              value: best.value,
              label: best.label.slice(0, 120),
              pickedPct: best.pct,
            });
          }
        }
        return out;
      }, minCashbackPct)
      .catch(() => [] as { name: string; value: string; label: string; pickedPct: number }[]);
    const plan = plans.find((p) => !clicked.has(`${p.name}::${p.value}`));
    if (!plan) break;
    clicked.add(`${plan.name}::${plan.value}`);
    const sel = `input[type="radio"][name="${escCssAttr(plan.name)}"][value="${escCssAttr(plan.value)}"]`;
    // Playwright locator click with `force: true`. Chewbacca /spc
    // wraps each shipping option in
    // `<div class="a-box eligible-delivery-group-option-box standard">`,
    // which makes Playwright's default actionability hit-test fail
    // ("intercepts pointer events"). The v0.13.45 workaround used
    // `page.evaluate(() => input.click())` which DID toggle the
    // radio locally — but Amazon's `/eligibleshipoption` POST
    // handler then served `/errors/500?ref=chk_web_sry` because
    // the JS-dispatched click doesn't carry the mousedown/mouseup/
    // pointer-event session signals Amazon's bot detector uses to
    // authenticate the change. See memory
    // project_amazon_500_native_click.md.
    //
    // `{ force: true }` is the fix: it tells Playwright to SKIP the
    // actionability check (no hit-test, no "covered by wrapper"
    // error) but to STILL dispatch a full real mouse-event sequence
    // (mousemove → mousedown → mouseup → click) at the input's
    // bounding-rect center. Amazon's backend sees the same signal a
    // user click produces and accepts the POST. Combined fix for
    // both the Chewbacca wrapper + the 500 we saw on cuong.ngoxxxxxx
    // 2026-05-14T01:20:25Z.
    let ok = false;
    try {
      await page.locator(sel).first().click({ force: true, timeout: 5_000 });
      ok = true;
    } catch (err) {
      // Defensive last-resort: if `force:true` also fails (unlikely;
      // it skips actionability), fall through to the JS click. May
      // still 500 on Amazon's side but at least preserves the
      // chance of selecting the radio when no other option exists.
      logger.warn(
        'step.spc.cashback.radioClick.forceFallback',
        { sel: sel.slice(0, 80), error: String(err).slice(0, 120) },
      );
      ok = await page
        .evaluate((s) => {
          const r = document.querySelector(s) as HTMLInputElement | null;
          if (!r) return false;
          r.click();
          return r.checked;
        }, sel)
        .catch(() => false);
    }
    if (!ok) break;
    changes.push({ picked: plan.label, pct: plan.pickedPct });
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
 * Confirm `orderId`'s order-details page actually contains a link to
 * `asin`. Defense against cross-deal contamination where the captured
 * orderId belongs to a DIFFERENT order than the one we just attempted
 * (observed 2026-05-07: rapid-fire buys on the same Amazon account
 * stamped 6 BG purchases for 5 different deals with one shared orderId
 * pointing at an unrelated MacBook order).
 *
 * Returns { trusted: true } when ANY of:
 *   - the order-details fetch fails (transient HTTP — fall back to trust)
 *   - the response doesn't look like an order page (Amazon may have
 *     redirected to login/captcha — don't penalize the capture)
 *   - the ASIN appears in a /dp/<asin> or /gp/product/<asin> href
 *
 * Returns { trusted: false } only when we got a real order page but the
 * ASIN is absent. Caller nulls the orderId on the buy report.
 */
async function verifyOrderContainsAsin(
  page: Page,
  orderId: string,
  asin: string,
): Promise<{ trusted: boolean; reason: string }> {
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(
    orderId,
  )}`;
  let html: string;
  try {
    const res = await page.context().request.get(url, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 10_000,
    });
    if (!res.ok()) {
      return { trusted: true, reason: `fetch HTTP ${res.status()} — skipped` };
    }
    html = await res.text();
  } catch (err) {
    return { trusted: true, reason: `fetch threw — skipped: ${String(err).slice(0, 80)}` };
  }
  if (!html.includes(orderId)) {
    return { trusted: true, reason: 'order-details page did not echo orderId — skipped' };
  }
  const hrefRe = new RegExp(`/(?:dp|gp/product)/${asin}\\b`, 'i');
  if (hrefRe.test(html)) {
    return { trusted: true, reason: 'asin matched in order-details href' };
  }
  return {
    trusted: false,
    reason: `asin ${asin} not in order ${orderId} (cross-deal contamination)`,
  };
}

/**
 * Navigate to Amazon Your Orders and extract the order id for `dealAsin`.
 * Used as a fallback when the confirmation page itself doesn't expose
 * the id (Amazon has several confirmation templates; some hide it).
 *
 * Two readiness gates before scanning (INC-2026-05-10, cpnhuy@gmail.com,
 * single-buy lost orderId because pre-Siege body-grep ran 3s after
 * Place Order and matched a STALE order from a prior buy — guard then
 * correctly nulled it as cross-deal contamination):
 *
 *   (a) `csd-encrypted-sensitive` count == 0  → every visible card
 *       finished Siege client-side decryption. Without this, the
 *       grep would only match cards that decrypted first.
 *
 *   (b) `<a href="/dp/{dealAsin}">` exists inside an `.order-card` →
 *       the just-placed order has propagated to the listing. Without
 *       this, the grep matches the TOP card (most recent in
 *       history), which is a stale order from before this buy.
 *
 * Then we ASIN-scope the scan: walk only the `.order-card` elements,
 * find the one containing a `/dp/{dealAsin}` link, return its
 * orderId. Returns null on (a) timeout / (b) timeout / no scoped
 * match — caller's existing cross-deal-contamination guard runs the
 * same kind of verification, but doing it here avoids the wasted
 * orderId-untrusted log + null round-trip on a brand-new order that
 * just hasn't propagated yet.
 *
 * Pre-fix used `waitUntil: 'domcontentloaded'` + a regex against
 * `document.body.innerText` for `Order # {pattern}`. That returned
 * the topmost order regardless of whose ASIN it contained.
 */
async function fetchOrderIdFromHistory(
  page: Page,
  dealAsin: string | null,
): Promise<string | null> {
  await page
    .goto(
      'https://www.amazon.com/gp/css/order-history?ref_=nav_AccountFlyout_orders',
      { waitUntil: 'commit', timeout: 15_000 },
    )
    .catch(() => undefined);

  // Combined readiness wait — Siege done AND target order propagated.
  // 15s budget; falls through on timeout so the regex scan still
  // gets a chance against whatever decrypted.
  await page
    .waitForFunction(
      (asin) => {
        if (document.querySelectorAll('.csd-encrypted-sensitive').length !== 0) {
          return false;
        }
        if (!asin) return true;
        const orderCards = document.querySelectorAll('.order-card.js-order-card');
        for (const card of Array.from(orderCards)) {
          if (
            card.querySelector(
              `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`,
            )
          ) {
            return true;
          }
        }
        return false;
      },
      dealAsin,
      { timeout: 15_000, polling: 500 },
    )
    .catch(() => undefined);

  return page
    .evaluate(
      ({ asin }) => {
        // ASIN-scoped scan: prefer the order card that actually
        // contains our deal's /dp/<asin> link. Falls back to the
        // topmost card only when asin is null (single-buy without a
        // parseable ASIN — rare).
        if (asin) {
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>('.order-card.js-order-card'),
          );
          for (const card of cards) {
            if (
              !card.querySelector(
                `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`,
              )
            ) {
              continue;
            }
            const text = (card.innerText || '').replace(/\s+/g, ' ');
            const m = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
            if (m) return m[1] ?? null;
          }
          return null;
        }
        const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
        const m = body.match(
          /(?:Order\s*#\s*|ORDER\s*#\s*)(\d{3}-\d{7}-\d{7})/i,
        );
        return m?.[1] ?? null;
      },
      { asin: dealAsin },
    )
    .catch(() => null);
}

function fail(
  stage: Extract<BuyResult, { ok: false }>['stage'],
  reason: string,
  detail?: string,
): BuyResult {
  return { ok: false, stage, reason, ...(detail ? { detail } : {}) };
}
