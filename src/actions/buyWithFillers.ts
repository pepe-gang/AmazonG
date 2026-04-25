import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { logger } from '../shared/logger.js';
import { cancelFillerOrder } from './cancelFillerOrder.js';
import { clearCart } from './clearCart.js';
import { scrapeProduct } from './scrapeProduct.js';
import {
  ensureAddress,
  findPlaceOrderLocator,
  pickBestCashbackDelivery,
  setMaxQuantity,
  toggleBGNameAndRetry,
  waitForCheckout,
  waitForConfirmationOrPending,
} from './buyNow.js';
import {
  DEFAULT_CONSTRAINTS,
  effectivePriceTolerance,
  verifyProductDetailed,
} from '../parsers/productConstraints.js';
import { DEFAULT_MISSING_CASHBACK_PCT } from '../shared/cashbackGate.js';
import {
  BYG_BUTTON_SELECTOR,
  BYG_HEADER_SELECTOR,
  parseOrderConfirmation,
  readTargetCashbackFromDom,
  buildTitlePrefix,
  type CashbackDiag,
} from '../parsers/amazonCheckout.js';
import { isTargetInActiveCart } from '../parsers/amazonCart.js';
import { parsePrice } from '../parsers/amazonProduct.js';
import { parseAsinFromUrl } from '../shared/sanitize.js';
import type { ProductInfo } from '../shared/types.js';

type BuyWithFillersOptions = {
  productUrl: string;
  maxPrice: number | null;
  /**
   * House-number prefixes passed through to the shared `waitForCheckout`
   * helper. Used if Amazon parks us at a "Deliver to this address"
   * interstitial — the helper picks the radio whose street matches one
   * of these prefixes before clicking Deliver.
   */
  allowedAddressPrefixes: string[];
  /**
   * Minimum cashback % required on the target line item (not the page
   * max — fillers can surface unrelated offers that would falsely pass
   * a page-wide check). When the target shows below this threshold the
   * orchestrator falls through to the BG1/BG2 address-name toggle
   * retry (coming in a later slice).
   */
  minCashbackPct: number;
  /**
   * Per-account toggle (default true). When false, the cashback gate
   * is skipped entirely — buy proceeds regardless of the target's
   * /spc cashback line, and a missing reading defaults to
   * DEFAULT_MISSING_CASHBACK_PCT (5%) so the recorded value isn't
   * null. See shared/cashbackGate.ts.
   */
  requireMinCashback: boolean;
  /**
   * When true, stop immediately before the final "Place Order" click.
   * All other mutations (cart edits, address swap, BG name toggle) still
   * run — they're intentional — but we skip the one irreversible step
   * so the user can verify the pipeline without spending money.
   */
  dryRun: boolean;
  /**
   * Parallel tabs inside this single buy for cart-add fan-out.
   * Default 4 (historical). 1 = sequential. Clamped 1..6 inside
   * `addFillerItems` to keep a hand-edited settings.json from
   * spawning 100 tabs.
   */
  fillerParallelTabs?: number;
  correlationId?: string;
  /**
   * Called immediately before the Place Order click ('placing') and
   * after Amazon's confirmation page parses (null). Used by the
   * worker to flag the narrow critical window where a stop / crash
   * can't be safely auto-retried.
   */
  onStage?: (stage: 'placing' | null) => void | Promise<void>;
};

/**
 * One Amazon order that came out of our Place Order click. Amazon can
 * split a single placement into multiple orders by warehouse or seller,
 * so we return an array of these — Phase 2 (cancelFillerItems) walks
 * each one.
 *
 * `matchedAsins` tells us which items in this specific order came from
 * our cart, so the caller can tell "target's order" (has targetAsin)
 * from "filler-only orders" (doesn't).
 */
export type OrderMatch = {
  orderId: string;
  matchedAsins: string[];
};

type BuyWithFillersSuccessBase = {
  ok: true;
  targetAsin: string | null;
  productInfo: ProductInfo;
  fillersAdded: number;
  fillersRequested: number;
  /** Which Place-Order selector `waitForCheckout` matched. Useful for
   *  logs — tells us which layout Amazon served this run. */
  placeOrderSelector: string;
  /** Cashback % read off the target line item specifically. Null if
   *  we skipped the check (no ASIN parseable from productUrl). */
  targetCashbackPct: number | null;
  /** Quantity read from the target's /spc line-item qty widget. Null
   *  when we couldn't parse it (unrecognized layout) or when there's
   *  no target ASIN to scope to. Source of truth for what Amazon will
   *  order — more reliable than the confirmation-page badge which is
   *  hidden for qty=1. */
  placedQuantity: number | null;
};

export type BuyWithFillersResult =
  | (BuyWithFillersSuccessBase & {
      /** Dry-run short-circuit: every check and mutation ran EXCEPT the
       *  final Place Order click. Safe outcome — treat as a validation
       *  pass, not a placed order. */
      stage: 'dry_run_success';
    })
  | (BuyWithFillersSuccessBase & {
      /** Order placed — Place Order was clicked AND the confirmation
       *  page (or its follow-up "you placed a similar order" interstitial)
       *  resolved. `orderId` is the order containing the target ASIN
       *  (what BG tracks); `orderIds` is every order that came out of
       *  this placement so the verify-side cleanup can touch each one
       *  (Amazon often splits 11-item carts into 2+ orders). */
      stage: 'placed';
      orderId: string | null;
      orderIds: OrderMatch[];
      /**
       * Every filler-only orderId that came out of this buy (orders
       * that do NOT contain the target ASIN). We try to cancel each
       * immediately as a best-effort sweep, but the caller should
       * persist the whole list and re-check + re-cancel in the verify
       * phase — Amazon sometimes silently rejects the pre-ship cancel
       * or takes a while to process it, so a delayed re-check is how
       * we make sure nothing slips through and ships.
       */
      fillerOrderIds: string[];
      finalPrice: number | null;
      finalPriceText: string | null;
    })
  | {
      ok: false;
      stage:
        | 'clear_cart'
        | 'product_verify'
        | 'buy_now_click'
        | 'buy_now_nav'
        | 'cart_verify'
        | 'proceed_checkout'
        | 'spc_wait'
        | 'spc_ready'
        | 'item_unavailable'
        | 'checkout_price'
        | 'checkout_address'
        | 'cashback_gate'
        | 'place_order'
        | 'confirm_parse';
      reason: string;
      detail?: string;
    };

const BUY_NOW_URL_MATCH = /\/gp\/buy\/|\/checkout\/|\/spc\//i;
const SPC_URL_MATCH = /\/gp\/buy\/|\/checkout\/p\/|\/spc\//i;
const CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

const FILLER_COUNT = 12;
const FILLER_MIN_PRICE = 30;
const FILLER_MAX_PRICE = 100;
// Parallel tabs inside the account's BrowserContext. Tabs share cookies +
// cart server-side, so all adds land in the same order. The historical
// default 4 gets a clean ~4× speedup without hammering Amazon hard
// enough to trigger rate limits. Now user-configurable via
// Settings.fillerParallelTabs; bounds enforced here so a hand-edited
// settings.json can't ask for 100.
const DEFAULT_FILLER_WORKERS = 4;
const MIN_FILLER_WORKERS = 1;
const MAX_FILLER_WORKERS = 6;

// Low-risk impulse-item search terms borrowed from AutoG. Shuffled on each
// run so we don't always hit the same items first (helps avoid rate-limit
// throttling on a given search URL).
const FILLER_SEARCH_TERMS: readonly string[] = [
  'kitchen gadgets', 'office supplies', 'desk accessories', 'phone accessories',
  'notebook journal', 'cable organizer', 'water bottle', 'sticky notes',
  'led lights', 'usb hub', 'mouse pad', 'phone stand', 'hand cream',
  'lip balm', 'sunscreen', 'pen set', 'playing cards', 'puzzle',
  'measuring tape', 'candle', 'picture frame', 'wall art', 'mug',
  'reusable bag', 'storage box', 'cleaning brush', 'sponge set',
  'book', 'card game', 'yoga mat', 'resistance band', 'jump rope',
  'face mask', 'hair clip', 'scrunchie', 'sunglasses', 'socks',
];

/**
 * Orchestrator for the "Buy with Fillers" checkout flow.
 *
 * We use Buy Now (rather than Add to Cart) as the add-to-cart step: Add
 * to Cart triggers AppleCare/warranty "No thanks" modals on tech items
 * which are brittle to handle. Buy Now's POST commits the item to the
 * real cart as a side effect, so we click Buy Now → wait for /spc →
 * navigate AWAY (item stays parked in cart) → add fillers on top →
 * Proceed to Checkout → SPC tail.
 */
export async function buyWithFillers(
  page: Page,
  opts: BuyWithFillersOptions,
): Promise<BuyWithFillersResult> {
  const cid = opts.correlationId;
  logger.info('step.fillerBuy.start', { productUrl: opts.productUrl }, cid);

  // 1. Cart hygiene. Run unconditionally — clearCart no-ops safely on an
  //    empty cart and returns `wasEmpty: true`.
  const cleared = await clearCart(page, { correlationId: cid });
  if (!cleared.ok) {
    return {
      ok: false,
      stage: 'clear_cart',
      reason: `cart clear failed: ${cleared.reason}`,
      detail: `removed=${cleared.removed}`,
    };
  }
  logger.info(
    'step.fillerBuy.cart.ready',
    { wasEmpty: cleared.wasEmpty, removed: cleared.removed },
    cid,
  );

  // 2. Product page + verification. scrapeProduct loads + hydrates the page
  //    and leaves it on screen for the Buy Now click; verifyProductDetailed
  //    is the same parser the normal Buy Now flow uses, so constraints stay
  //    identical across modes.
  const info = await scrapeProduct(page, opts.productUrl);
  const constraints = { ...DEFAULT_CONSTRAINTS, maxPrice: opts.maxPrice };
  const report = verifyProductDetailed(info, constraints);
  if (!report.ok) {
    const reason = (report.reason ?? 'verification failed').trim();
    const detail = (report.detail ?? '').replace(/\.\s*$/, '').trim();
    return {
      ok: false,
      stage: 'product_verify',
      reason,
      ...(detail ? { detail } : {}),
    };
  }
  logger.info('step.fillerBuy.verify.ok', { title: info.title }, cid);

  // 2.5. Select the max quantity from the product page's #quantity
  //      dropdown BEFORE clicking Buy Now — otherwise Amazon adds
  //      qty=1 regardless of what BG asked for. Best-effort: products
  //      without a quantity dropdown or with "+10" open-ended options
  //      just fall through with qty=1 (logged, not a failure).
  const qty = await setMaxQuantity(page);
  if (qty.ok) {
    logger.info(
      'step.fillerBuy.quantity.set',
      { selected: qty.selected, allOptions: qty.allOptions },
      cid,
    );
  } else {
    logger.info(
      'step.fillerBuy.quantity.skip',
      { reason: qty.reason, allOptions: qty.allOptions ?? [] },
      cid,
    );
  }

  // 3. Click Buy Now. We do NOT drive the subsequent checkout — we just
  //    need Amazon's Buy Now POST to commit so the item lands in the
  //    main cart. Once we see a /gp/buy/ or /spc URL we know the POST
  //    is done and it's safe to navigate away without losing the item.
  try {
    await page
      .locator('#buy-now-button')
      .first()
      .click({ timeout: 10_000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'buy_now_click',
      reason: 'failed to click Buy Now',
      detail: String(err),
    };
  }
  logger.info('step.fillerBuy.buyNow.clicked', {}, cid);

  // Wait for the URL to leave the product page and reach a buy/spc page —
  // that's our signal the Buy Now POST committed and the item is in cart.
  try {
    await page.waitForURL(BUY_NOW_URL_MATCH, { timeout: 20_000 });
  } catch {
    return {
      ok: false,
      stage: 'buy_now_nav',
      reason: 'Buy Now did not reach /spc within 20s',
      detail: `url=${page.url()}`,
    };
  }
  const spcUrl = page.url();
  logger.info('step.fillerBuy.buyNow.onSpc', { url: spcUrl }, cid);

  // 4. Verify the item actually landed in the shared cart (not just an
  //    ephemeral buy-now session). We navigate away from /spc — the item
  //    stays parked in cart as a side effect of the Buy Now POST.
  const targetAsin = parseAsinFromUrl(opts.productUrl);
  try {
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'cart_verify',
      reason: 'failed to load cart page',
      detail: String(err),
    };
  }

  const inCart = await hasTargetInCart(page, targetAsin);
  if (!inCart) {
    return {
      ok: false,
      stage: 'cart_verify',
      reason: 'target item did not land in cart after Buy Now',
      detail: `asin=${targetAsin ?? '(unknown)'}`,
    };
  }
  logger.info('step.fillerBuy.cart.hasTarget', { targetAsin }, cid);

  // 5. Add filler items one-at-a-time on the same tab. Playwright tabs in
  //    the shared BrowserContext all write to the same Amazon cart, so a
  //    plain sequential loop here is enough — no side-windows needed.
  //    Proceed with whatever count we got: even a partial set (say 8/12)
  //    still provides camouflage. Refusing to buy because of a flaky
  //    search is worse than a slightly smaller cover.
  const fillersResult = await addFillerItems(page, targetAsin, cid, opts.fillerParallelTabs);
  const fillersAdded = fillersResult.added;
  const fillerAsins = fillersResult.asins;
  if (fillersAdded < FILLER_COUNT) {
    logger.warn(
      'step.fillerBuy.fillers.partial',
      { fillersAdded, fillersRequested: FILLER_COUNT },
      cid,
    );
  } else {
    logger.info(
      'step.fillerBuy.fillers.ok',
      { fillersAdded, fillersRequested: FILLER_COUNT },
      cid,
    );
  }

  // With FILLER_WORKERS parallel workers each firing Add to Cart POSTs, Amazon's
  // server-side commit lags the click by several seconds: workers
  // report "click succeeded" as soon as domcontentloaded fires, but
  // the actual cart-row insert happens on the server after that. A
  // fixed sleep is brittle (3s was not enough on a recent test — only
  // 9/11 rows had committed). Instead, poll the cart page until the
  // active-cart row count either hits expected OR stabilizes across
  // two consecutive reads. Best-effort: if we give up early, we still
  // proceed with whatever rows committed (camouflage doesn't require
  // an exact count).
  await page.waitForTimeout(2_000);

  // 6. Proceed to checkout from the cart view. Load the cart fresh so the
  //    Proceed-to-checkout button state reflects the full 10 + target cart.
  try {
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'proceed_checkout',
      reason: 'failed to reload cart before checkout',
      detail: String(err),
    };
  }

  const expectedRows = FILLER_COUNT + 1;
  const pollStart = Date.now();
  const pollDeadline = pollStart + 20_000;
  let lastCount = -1;
  let stableReads = 0;
  let actualCartRows = await page
    .locator('[data-name="Active Cart"] [data-asin]')
    .count()
    .catch(() => -1);
  while (Date.now() < pollDeadline) {
    if (actualCartRows >= expectedRows) break;
    if (actualCartRows === lastCount) {
      stableReads += 1;
      if (stableReads >= 2) break;
    } else {
      stableReads = 0;
    }
    lastCount = actualCartRows;
    await page.waitForTimeout(2_000);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    actualCartRows = await page
      .locator('[data-name="Active Cart"] [data-asin]')
      .count()
      .catch(() => -1);
  }
  logger.info(
    'step.fillerBuy.cart.preCheckoutCount',
    {
      actualCartRows,
      expected: expectedRows,
      fillersReportedAdded: fillersAdded,
      pollMs: Date.now() - pollStart,
      hitExpected: actualCartRows >= expectedRows,
    },
    cid,
  );

  const clicked = await clickProceedToCheckout(page);
  if (!clicked) {
    return {
      ok: false,
      stage: 'proceed_checkout',
      reason: 'Proceed to Checkout button not found',
      detail: `url=${page.url()}`,
    };
  }

  const transition = await waitForSpcOrHandleByg(page, cid);
  if (!transition.ok) {
    return {
      ok: false,
      stage: 'spc_wait',
      reason: transition.reason,
      detail: `url=${page.url()}`,
    };
  }
  logger.info('step.fillerBuy.spc.reached', { url: page.url() }, cid);

  // 7. Wait for SPC to finish rendering — we have the /spc URL but the
  //    Place Order button may still be hydrating. Reuse the same helper
  //    the normal Buy Now flow uses so filler and non-filler checkouts
  //    share one hardened path through the interstitial/unavailable/
  //    update-your-items states. Cart-flow SPC usually goes straight to
  //    Place Order, but if Amazon parks us at an address interstitial
  //    the helper picks the matching-prefix radio and clicks Deliver.
  const ready = await waitForCheckout(
    page,
    opts.allowedAddressPrefixes,
    undefined,
    {
      step: (m, d) => logger.info(m, d, cid),
      warn: (m, d) => logger.warn(m, d, cid),
    },
  );
  if (!ready.ok) {
    if (ready.kind === 'unavailable') {
      return {
        ok: false,
        stage: 'item_unavailable',
        reason: ready.reason,
        ...(ready.detail ? { detail: ready.detail } : {}),
      };
    }
    return {
      ok: false,
      stage: 'spc_ready',
      reason: ready.reason,
      ...(ready.detail ? { detail: ready.detail } : {}),
    };
  }
  logger.info(
    'step.fillerBuy.spc.ready',
    { detected: ready.detected, fillersAdded },
    cid,
  );

  // 8. Verify the TARGET line item's price on /spc — not the cart max,
  //    because with 12 fillers ≤ $100 a cheap target could be dwarfed by
  //    a pricey filler and falsely trip the cap. We locate the target's
  //    row by its product link (/dp/<ASIN>) and read the price from that
  //    row specifically. Skipped when we can't identify the target or
  //    the deal has no cap — the product-page verify already ran.
  if (opts.maxPrice !== null && targetAsin) {
    const priceCheck = await verifyTargetLineItemPrice(
      page,
      targetAsin,
      info.title,
      opts.maxPrice,
    );
    if (!priceCheck.ok) {
      logger.warn(
        'step.fillerBuy.spc.price.fail',
        { targetAsin, cap: opts.maxPrice, reason: priceCheck.reason },
        cid,
      );
      return {
        ok: false,
        stage: 'checkout_price',
        reason: priceCheck.reason,
        ...(priceCheck.detail ? { detail: priceCheck.detail } : {}),
      };
    }
    logger.info(
      'step.fillerBuy.spc.price.ok',
      { targetAsin, priceText: priceCheck.priceText, price: priceCheck.price },
      cid,
    );
  } else {
    logger.info(
      'step.fillerBuy.spc.price.skip',
      {
        targetAsin,
        cap: opts.maxPrice,
        reason: !targetAsin ? 'no_target_asin' : 'no_price_cap',
      },
      cid,
    );
  }

  // 9. Ensure the /spc delivery address matches one of the allowed
  //    house-number prefixes (e.g. BG's warehouse streets). Reuses the
  //    same helper as normal Buy Now — fast path when the current
  //    address already matches; otherwise opens the picker and submits
  //    the matching saved address. No-op when no prefixes are configured.
  //
  // NOTE: Chewbacca's /spc hydrates panels asynchronously after
  // waitForCheckout says "Place Order visible" — the address panel may
  // not expose `#deliver-to-address-text` or `#change-delivery-link`
  // for another second or two. Settle briefly so readCurrentAddress's
  // selectors land on live DOM instead of the skeleton.
  if (opts.allowedAddressPrefixes.length > 0) {
    await page.waitForTimeout(2_000);
    const addr = await ensureAddress(page, opts.allowedAddressPrefixes, {
      step: (m, d) => logger.info(m, d, cid),
      warn: (m, d) => logger.warn(m, d, cid),
    });
    if (!addr.ok) {
      return {
        ok: false,
        stage: 'checkout_address',
        reason: addr.reason,
        ...(addr.detail ? { detail: addr.detail } : {}),
      };
    }
    logger.info(
      'step.fillerBuy.spc.address.ok',
      { matchedPrefix: addr.prefix, current: addr.current },
      cid,
    );
  } else {
    logger.info('step.fillerBuy.spc.address.skip', { reason: 'no_prefixes' }, cid);
  }

  // 9.5. Pick the best-cashback delivery option on every radio group.
  //      When Chewbacca ships 3 radios like [Standard, Fewer trips (6%
  //      back), Standard Thursday] and defaults to a no-cashback one,
  //      the target's row reads the WRONG pct and our gate fails even
  //      though a 6% option is one click away. This walks every non-
  //      address/non-payment radio group and clicks the highest "N%
  //      back" option (≥ minCashbackPct) when it's better than the
  //      currently-selected one.
  const delivery = await pickBestCashbackDelivery(page, opts.minCashbackPct);
  if (delivery.changes.length > 0) {
    logger.info(
      'step.fillerBuy.spc.delivery.picked',
      { changes: delivery.changes },
      cid,
    );
    // Let the page settle — Amazon re-renders totals + cashback banner
    // after a delivery radio click.
    await page.waitForTimeout(1_500);
  } else {
    logger.info(
      'step.fillerBuy.spc.delivery.nochange',
      { note: 'default delivery already optimal (or no options found)' },
      cid,
    );
  }

  // 10. Verify the TARGET line item's cashback — not the page-wide max,
  //     because fillers can surface unrelated "N% back" offers (and the
  //     credit-card promo banner often reads as 5% across the whole
  //     page). We read "N% back" text only from the target's row. If
  //     no target ASIN is parseable, skip — the deal must be configured
  //     without cashback enforcement in that case.
  let targetCashbackPct: number | null = null;
  if (!targetAsin) {
    // Fail-closed: without a target ASIN we can't scope the cashback
    // check to the target's shipping group, and a page-wide scan would
    // happily pass on a filler's 6% while the target sits at 0%.
    // Better to abort the buy than place at unknown cashback.
    return {
      ok: false,
      stage: 'cashback_gate',
      reason: 'cannot verify target cashback: productUrl has no parseable ASIN',
      detail: `productUrl=${opts.productUrl}`,
    };
  }
  {
    // Below: targetAsin is narrowed to string (non-null) by the early return above.
    let cb = await verifyTargetCashback(page, targetAsin, info.title, opts.minCashbackPct);
    if (!cb.ok && !opts.requireMinCashback) {
      // Permissive account: skip the cashback gate entirely. Record the
      // observed pct (or 5% default when /spc didn't show a line) and
      // proceed to Place Order. No BG1/BG2 toggle, no failure.
      const substituted = cb.pct ?? DEFAULT_MISSING_CASHBACK_PCT;
      logger.info(
        'step.fillerBuy.spc.cashback.permissive',
        {
          targetAsin,
          pageReadingPct: cb.pct,
          substitutedPct: substituted,
          fellBackToDefault: cb.pct === null,
          reason: cb.reason,
          minRequired: opts.minCashbackPct,
        },
        cid,
      );
      targetCashbackPct = substituted;
    } else if (!cb.ok) {
      // 11. BG1/BG2 name-toggle retry. Some BG warehouse addresses
      //     unlock higher cashback when the delivery name alternates
      //     between "(BG1)" and "(BG2)" suffixes — Amazon re-evaluates
      //     promo eligibility on the new name. We only run the toggle
      //     when the target's cashback came up short; if allowedPrefixes
      //     is empty we can't locate the address card to edit, so we
      //     skip and surface the original failure.
      const initialPct = cb.pct;
      logger.warn(
        'step.fillerBuy.spc.cashback.fail',
        {
          targetAsin,
          observedPct: initialPct,
          minRequired: opts.minCashbackPct,
          reason: cb.reason,
          detail: cb.detail,
          diag: 'diag' in cb ? cb.diag : undefined,
        },
        cid,
      );

      if (opts.allowedAddressPrefixes.length === 0) {
        return {
          ok: false,
          stage: 'cashback_gate',
          reason: cb.reason,
          ...(cb.detail ? { detail: cb.detail } : {}),
        };
      }

      logger.info(
        'step.fillerBuy.spc.cashback.retry',
        { targetAsin, via: 'bg-name-toggle', observedPct: initialPct },
        cid,
      );
      const toggled = await toggleBGNameAndRetry(
        page,
        opts.allowedAddressPrefixes,
        {
          step: (m, d) => logger.info(m, d, cid),
          warn: (m, d) => logger.warn(m, d, cid),
        },
      );
      if (!toggled.ok) {
        return {
          ok: false,
          stage: 'cashback_gate',
          reason: `name-toggle failed: ${toggled.reason}`,
          ...(toggled.detail ? { detail: toggled.detail } : {}),
        };
      }
      logger.info(
        'step.fillerBuy.spc.cashback.toggle.ok',
        { from: toggled.from, to: toggled.to },
        cid,
      );

      // After the toggle, /spc re-renders from scratch — the delivery
      // radios we picked at step 9.5 are reset to Amazon's defaults,
      // which often means "Standard (no cashback)" instead of "Fewer
      // trips (6%)". Re-run the delivery picker on the new page
      // before we re-check cashback, otherwise we'd fail even when a
      // 6% option is one click away.
      const redelivery = await pickBestCashbackDelivery(page, opts.minCashbackPct);
      if (redelivery.changes.length > 0) {
        logger.info(
          'step.fillerBuy.spc.delivery.picked.afterToggle',
          { changes: redelivery.changes },
          cid,
        );
        await page.waitForTimeout(1_500);
      }

      // Re-verify target cashback on the newly-rendered /spc. We ignore
      // toggled.cashbackPct because it's a page-wide read — we want
      // target-specific.
      cb = await verifyTargetCashback(page, targetAsin, info.title, opts.minCashbackPct);
      if (!cb.ok) {
        // TODO(cashback-fallback): if you capture a real checkout where
        // the target is still < minCashbackPct after the BG1/BG2 toggle,
        // add the next fallback strategy here (e.g. pick a slower
        // delivery radio on the target row, or toggle to a third name
        // suffix). Until we have a fixture, failing cleanly is safer
        // than a second round of guesswork.
        logger.warn(
          'step.fillerBuy.spc.cashback.retry.fail',
          {
            targetAsin,
            observedBefore: initialPct,
            observedAfter: cb.pct,
            minRequired: opts.minCashbackPct,
            reason: cb.reason,
            detail: cb.detail,
            diag: 'diag' in cb ? cb.diag : undefined,
          },
          cid,
        );
        return {
          ok: false,
          stage: 'cashback_gate',
          reason: cb.reason,
          ...(cb.detail ? { detail: cb.detail } : {}),
        };
      }
      targetCashbackPct = cb.pct;
      logger.info(
        'step.fillerBuy.spc.cashback.retry.ok',
        {
          targetAsin,
          from: initialPct,
          to: cb.pct,
          minRequired: opts.minCashbackPct,
          diag: cb.diag,
        },
        cid,
      );
    } else {
      targetCashbackPct = cb.pct;
      logger.info(
        'step.fillerBuy.spc.cashback.ok',
        {
          targetAsin,
          pct: cb.pct,
          minRequired: opts.minCashbackPct,
          diag: cb.diag,
        },
        cid,
      );
    }
  }

  // 11.5. Read the target's /spc line-item quantity. Source of truth
  //       for what Amazon will order — more reliable than the
  //       confirmation-page qty badge (hidden for qty=1). Best-effort:
  //       on unrecognized layouts we log and proceed with null.
  const placedQuantity =
    targetAsin !== null
      ? await readTargetQuantity(page, targetAsin, info.title)
      : null;
  logger.info(
    'step.fillerBuy.spc.qty.read',
    { targetAsin, placedQuantity },
    cid,
  );

  const successBase = {
    targetAsin,
    productInfo: info,
    fillersAdded,
    fillersRequested: FILLER_COUNT,
    placeOrderSelector: ready.detected,
    targetCashbackPct,
    placedQuantity,
  };

  // 12. Dry-run gate. Every mutation above this line is intentional —
  //     cart edits, address selection, BG name toggle are part of the
  //     workflow we want to validate. The ONLY thing dry-run skips is
  //     the irreversible Place Order click.
  if (opts.dryRun) {
    logger.info(
      'step.fillerBuy.dryrun.success',
      {
        targetCashbackPct,
        fillersAdded,
        message:
          `✓ Dry run successful — order would have been placed ` +
          `(cashback ${targetCashbackPct ?? 'n/a'}%, ${fillersAdded}/${FILLER_COUNT} fillers). ` +
          `Skipped Place Order click.`,
      },
      cid,
    );
    return {
      ok: true,
      stage: 'dry_run_success',
      ...successBase,
    };
  }

  // 13. Click Place Order. Mirrors buyNow's checkout[9]-[10]: a 1s
  //     pre-settle so Amazon's re-render after the last mutation (name
  //     toggle, delivery change) commits before the click, then locate
  //     the Place Order control across Amazon's layout variants.
  logger.info('step.fillerBuy.place.settle', { waitMs: 1_000 }, cid);
  await page.waitForTimeout(1_000);

  const placeLocator = await findPlaceOrderLocator(page);
  if (!placeLocator) {
    return {
      ok: false,
      stage: 'place_order',
      reason: 'no Place Order button selector matched on /spc',
      detail: `url=${page.url()}`,
    };
  }
  // Mark the attempt `stage: 'placing'` across the click → confirmation
  // window. A stop / crash inside this window is an unknown-outcome
  // case (Amazon may or may not have accepted the click) and the
  // recovery sweep routes those rows to manual review instead of
  // retrying automatically.
  await opts.onStage?.('placing');
  try {
    await placeLocator.click({ timeout: 10_000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'place_order',
      reason: 'failed to click Place Order',
      detail: String(err),
    };
  }
  logger.info('step.fillerBuy.place.clicked', {}, cid);

  // 14. Wait for the confirmation page. Reuses the shared helper that
  //     also handles Amazon's "This is a pending order — place again?"
  //     interstitial AND the "Your delivery options have changed…"
  //     banner (which wipes our radio pick; the callback re-picks
  //     before the helper re-clicks Place Order, 1 attempt).
  //     60s overall deadline inside the helper.
  const confirmWait = await waitForConfirmationOrPending(
    page,
    (m, d) => logger.info(m, d, cid),
    {
      onDeliveryOptionsChanged: async () => {
        const re = await pickBestCashbackDelivery(page, opts.minCashbackPct);
        logger.info(
          'step.fillerBuy.place.delivery_options_changed.repicked',
          { changes: re.changes },
          cid,
        );
        await page.waitForTimeout(1_000);
      },
    },
  );
  if (!confirmWait.ok) {
    return {
      ok: false,
      stage: 'confirm_parse',
      reason: confirmWait.reason,
      detail: `url=${page.url()}`,
    };
  }
  await opts.onStage?.(null);

  // Parse the confirmation page for `finalPrice` + `finalPriceText`.
  // NOTE: we intentionally ignore the orderId parsed here — Amazon's
  // confirmation body can contain stale ids in "Recommended for you"
  // sections that false-match our regex. The canonical order id comes
  // from /gp/css/order-history in Step 15 (next slice).
  const confirmationHtml = await page.content().catch(() => '');
  const parsed = confirmationHtml
    ? parseOrderConfirmation(
        new JSDOM(confirmationHtml).window.document,
        page.url(),
      )
    : { orderId: null, finalPrice: null, finalPriceText: null, quantity: null };

  // 15. Fetch ALL order IDs that came out of this buy. Amazon fans a
  //     single Place Order click into multiple orders (split by
  //     warehouse / seller / shipping group), so we scan
  //     /gp/css/order-history against every ASIN we put in the cart
  //     (target + fillers). Each returned OrderMatch carries which of
  //     our ASINs ended up in that specific order — Phase 2's
  //     cancelFillerItems walks this list to surgically cancel fillers
  //     while leaving the target intact.
  const cartAsins = targetAsin ? [targetAsin, ...fillerAsins] : fillerAsins;
  const orderMatches: OrderMatch[] =
    cartAsins.length > 0
      ? await fetchOrderIdsForAsins(page, cartAsins, targetAsin)
      : [];
  const orderId =
    targetAsin !== null
      ? orderMatches.find((m) => m.matchedAsins.includes(targetAsin))?.orderId ??
        null
      : orderMatches[0]?.orderId ?? null;

  if (orderMatches.length === 0) {
    logger.warn(
      'step.fillerBuy.placed.orderid.notfound',
      {
        targetAsin,
        cartAsinsCount: cartAsins.length,
        note: 'no orders matched any of our cart ASINs within the history lookup window',
      },
      cid,
    );
  }

  // 16. Immediately cancel any filler-only orders (best-effort sweep).
  //     Amazon fans 11-item carts into 2+ orders by shipping group; any
  //     order that doesn't contain the target is pure noise we want
  //     gone before it ships. Target's order stays — verify-side Phase
  //     2 will surgically cancel just the fillers within it.
  //
  //     We try cancel immediately + once more on failure, but we always
  //     return the FULL list of filler orderIds regardless of the
  //     outcome. The caller (verify phase) re-checks each one: Amazon
  //     sometimes silently rejects pre-ship cancels or takes a while
  //     to process, so a delayed re-check is our safety net to make
  //     sure nothing ships.
  const fillerOrderIds = targetAsin
    ? orderMatches
        .filter((m) => !m.matchedAsins.includes(targetAsin))
        .map((m) => m.orderId)
    : [];
  let sweepCancelled = 0;
  let sweepFailed = 0;
  const MAX_CANCEL_TRIES = 3;
  // Reasons that are terminal — Amazon won't let us cancel no matter
  // how many times we ask. Skip retry budget on these.
  const isTerminal = (reason: string): boolean =>
    /unable to cancel/i.test(reason) ||
    /not on cancel-items page/i.test(reason);
  for (const fillerOrderId of fillerOrderIds) {
    let cancelled = false;
    for (let tryN = 1; tryN <= MAX_CANCEL_TRIES; tryN++) {
      const r = await cancelFillerOrder(page, fillerOrderId, {
        correlationId: cid,
      });
      if (r.ok) {
        cancelled = true;
        logger.info(
          'step.fillerBuy.fillerOrder.cancelled',
          { orderId: fillerOrderId, itemsChecked: r.itemsChecked, attempt: tryN },
          cid,
        );
        break;
      }
      logger.warn(
        'step.fillerBuy.fillerOrder.cancel.attempt',
        { orderId: fillerOrderId, attempt: tryN, reason: r.reason, detail: r.detail },
        cid,
      );
      if (isTerminal(r.reason)) break;
      // Longer inter-attempt backoff — Amazon's cancel endpoint is
      // eventually-consistent: a "no confirmation detected" result
      // often means the cancellation IS processing server-side but
      // the page hasn't caught up. Give it real time to settle
      // before re-submitting or the retry races the same pending
      // request and fails the same way.
      if (tryN < MAX_CANCEL_TRIES) await page.waitForTimeout(8_000);
    }
    if (cancelled) sweepCancelled++;
    else sweepFailed++;
  }
  if (fillerOrderIds.length > 0) {
    logger.info(
      'step.fillerBuy.fillerOrder.sweep',
      {
        total: fillerOrderIds.length,
        cancelled: sweepCancelled,
        failed: sweepFailed,
        note: 'all filler orderIds persist for verify-phase re-check regardless of sweep outcome',
      },
      cid,
    );
    // Safety-net buffer: even after waitForCancelOutcome resolves,
    // Amazon's cancel pipeline (server-side state propagation,
    // tracking beacons, etc.) can lag a few seconds behind the
    // visible confirmation banner. Sit on the page for a beat before
    // returning so the caller in pollAndScrape's `finally` doesn't
    // race ahead and close the browser context while a cancel is
    // still settling. Cheap (3s on a path that already took 30+s)
    // and observed to fix "click cancel → page closed → cancel never
    // registered" in user reports.
    await page.waitForTimeout(3_000);
  }

  logger.info(
    'step.fillerBuy.placed',
    {
      url: page.url(),
      orderId,
      orderIds: orderMatches,
      fillerOrderIds,
      finalPrice: parsed.finalPrice,
      finalPriceText: parsed.finalPriceText,
      targetCashbackPct,
      placedQuantity,
      fillersAdded,
    },
    cid,
  );

  return {
    ok: true,
    stage: 'placed',
    ...successBase,
    orderId,
    orderIds: orderMatches,
    fillerOrderIds,
    finalPrice: parsed.finalPrice,
    finalPriceText: parsed.finalPriceText,
  };
}

/**
 * Multi-ASIN order-id lookup. Navigates to the order-history page and
 * scans the top N most-recent order cards for links to any of our
 * `asins`. Returns one OrderMatch per distinct orderId, with the list
 * of our ASINs that appear inside that order.
 *
 * Amazon's Place Order often fans a single cart into 2+ orders (per
 * warehouse / seller / shipping group), so a naive "first order id on
 * the page" read loses whichever orders we didn't grab. Walking from
 * the target ASIN works for the target's order but tells us nothing
 * about the filler-only orders.
 *
 * Retries via `waitForFunction` for 15s because new orders take a few
 * seconds to propagate. Returns an empty array on timeout or navigation
 * failure; the caller treats empty as "order ids unknown" and logs.
 *
 * `primaryAsin` (typically the target) is used only to short-circuit
 * the initial wait: we keep polling the history page until we see that
 * specific ASIN, then grab the full match set. Prevents racing a
 * half-propagated order list where only one of several split orders
 * has landed yet.
 */
async function fetchOrderIdsForAsins(
  page: Page,
  asins: string[],
  primaryAsin: string | null,
): Promise<OrderMatch[]> {
  if (asins.length === 0) return [];
  try {
    await page.goto(
      'https://www.amazon.com/gp/css/order-history?ref_=nav_AccountFlyout_orders',
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
  } catch {
    return [];
  }

  // Wait until at least the primary (target) ASIN appears on the page
  // so we don't read the history mid-propagation.
  if (primaryAsin) {
    await page
      .waitForFunction(
        (asin) =>
          document.querySelector(
            `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`,
          ) !== null,
        primaryAsin,
        { timeout: 15_000, polling: 1_000 },
      )
      .catch(() => undefined);
  }

  // Read once, non-retrying — we've already waited above.
  //
  // Algorithm (document-order, nesting-agnostic):
  //   1. Walk the full DOM in document order. For each element,
  //      record whether its text introduces an order-id and whether
  //      it's an /dp/ product link.
  //   2. Stream through the two interleaved streams. Every /dp/
  //      link is attributed to the most recently SEEN order-id.
  //
  // This avoids all the ancestor-walker pitfalls of the prior
  // implementation: Amazon's order-history page nests multiple order
  // cards under shared containers, and any "walk up until the
  // ancestor has a /dp/ link" strategy can cross-pollute ASIN matches
  // across sibling cards — causing filler-only orders to be tagged
  // with the target ASIN (from a sibling card's link) and therefore
  // excluded from the cancellation sweep. The fix is to use linear
  // document order: a link belongs to whichever order id it most
  // recently appeared AFTER.
  const raw = await page
    .evaluate(
      ({ asinList, maxCards }) => {
        const ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

        // Walk every element + text node in document order, collecting
        // "order-id encountered at position N" and "dp link with ASIN
        // encountered at position N" events into a single stream.
        type Event =
          | { kind: 'id'; id: string }
          | { kind: 'link'; asin: string };
        const events: Event[] = [];

        // Collect /dp/ links with their ASINs, in document order.
        const linkNodes = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href*="/dp/"], a[href*="/gp/product/"]'),
        );
        const linkAsin = (href: string): string | null => {
          const m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
          return m?.[1] ?? null;
        };
        // Build a map from link → asin for quick lookup during the walk.
        const linkToAsin = new Map<HTMLAnchorElement, string>();
        for (const a of linkNodes) {
          const asin = linkAsin(a.getAttribute('href') || '');
          if (asin) linkToAsin.set(a, asin);
        }

        // Single walk over text + element nodes in document order. We
        // use a TreeWalker that shows both types so the ordering is
        // preserved across the DOM tree (each text node appears in
        // its correct position relative to siblings).
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        const seenIds = new Set<string>();
        let n: Node | null = walker.currentNode;
        // Advance past document.body itself — currentNode starts at root.
        n = walker.nextNode();
        while (n) {
          if (n.nodeType === Node.TEXT_NODE) {
            const text = (n.textContent ?? '').trim();
            if (text) {
              // Scan for ALL id occurrences in this single text node
              // (rare but possible — e.g. an <a> with the id as text).
              const allRe = /\b(\d{3}-\d{7}-\d{7})\b/g;
              let mm: RegExpExecArray | null;
              while ((mm = allRe.exec(text)) !== null) {
                const id = mm[1]!;
                if (!seenIds.has(id) && seenIds.size < maxCards) {
                  seenIds.add(id);
                  events.push({ kind: 'id', id });
                }
              }
            }
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            const asin = linkToAsin.get(n as HTMLAnchorElement);
            if (asin) events.push({ kind: 'link', asin });
          }
          n = walker.nextNode();
        }

        // Attribute each /dp/ link to the most recently seen order-id.
        // Links that appear BEFORE any order-id (unusual — page
        // header carousels) are ignored.
        const matchedByOrder = new Map<string, Set<string>>();
        let currentId: string | null = null;
        for (const ev of events) {
          if (ev.kind === 'id') {
            currentId = ev.id;
            if (!matchedByOrder.has(currentId)) {
              matchedByOrder.set(currentId, new Set<string>());
            }
          } else if (currentId && asinList.includes(ev.asin)) {
            matchedByOrder.get(currentId)!.add(ev.asin);
          }
        }

        const out: { orderId: string; matchedAsins: string[] }[] = [];
        for (const id of seenIds) {
          const asins = Array.from(matchedByOrder.get(id) ?? []);
          out.push({ orderId: id, matchedAsins: asins });
        }
        return out;
      },
      { asinList: asins, maxCards: 15 },
    )
    .catch(() => [] as OrderMatch[]);

  // Surface empty-match orders as a warning so "filler order showed up
  // in history but got zero ASIN matches" is diagnosable.
  for (const r of raw) {
    if (r.matchedAsins.length === 0) {
      logger.warn('step.fillerBuy.history.order.no_asins', {
        orderId: r.orderId,
        note: 'order id found in history but no cart ASINs attributed — may indicate DOM layout Amazon changed',
      });
    }
  }

  // Return only orders with at least one ASIN match (the caller uses
  // matchedAsins to classify target vs filler orders).
  return raw.filter((r) => r.matchedAsins.length > 0);
}

/**
 * Scroll the target's /dp/ link into view so Chewbacca's virtualized
 * list renders the row before we probe it. Best-effort — the caller
 * tolerates a failure (subsequent locators do their own search).
 */
async function scrollTargetIntoView(
  page: Page,
  targetAsin: string,
  timeoutMs: number,
): Promise<void> {
  await page
    .locator(`a[href*="${targetAsin}"]`)
    .first()
    .scrollIntoViewIfNeeded({ timeout: timeoutMs })
    .catch(() => undefined);
}

/**
 * Read the target ASIN's quantity from its /spc line item. Tries several
 * layouts in order of reliability:
 *
 *   1. Visible dropdown-prompt span (old quantity-select layout).
 *   2. Hidden `input[name*="quantity"]` (form payload — authoritative
 *      when present).
 *   3. Stepper widget — scan any numeric text near an "Increase/Decrease
 *      quantity" button.
 *
 * Returns null when none of the strategies matches (unrecognized layout
 * or target row not present). Never throws — caller treats null as
 * "quantity unknown" and proceeds.
 */
async function readTargetQuantity(
  page: Page,
  targetAsin: string,
  targetTitle: string | null,
): Promise<number | null> {
  const titlePrefix = buildTitlePrefix(targetTitle);
  await scrollTargetIntoView(page, targetAsin, 2_000);
  return page
    .evaluate(
      ({ asin, title }) => {
        // Step 1: try ASIN-based locators (classic /spc).
        let target: Element | null =
          document.querySelector(`a[href*="${asin}"]`)?.closest(
            '.lineitem-container, [data-feature-id*="line-item"], .order-summary-line-item',
          ) ?? null;

        // Step 2: Chewbacca fallback — match the product title text node
        // and walk up to the enclosing line-item container.
        if (!target && title && title.length > 5) {
          const needle = title.toLowerCase();
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
          );
          let n: Node | null;
          // eslint-disable-next-line no-cond-assign
          while ((n = walker.nextNode())) {
            const txt = ((n as Text).textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            if (txt.length > 5 && txt.startsWith(needle)) {
              // Walk up a few levels to hit the row wrapper that
              // contains the qty stepper (not just the title text node).
              let el: Element | null = n.parentElement;
              let depth = 0;
              while (el && depth < 10) {
                // Row wrapper has a qty control somewhere inside it.
                if (
                  el.querySelector(
                    '[aria-label*="Increase" i], [aria-label*="Decrease" i], [aria-label*="Quantity" i], input[name*="quantity" i]',
                  )
                ) {
                  target = el;
                  break;
                }
                el = el.parentElement;
                depth++;
              }
              if (target) break;
            }
          }
        }

        if (!target) return null;

        const parseNum = (s: string | null | undefined): number | null => {
          if (!s) return null;
          const m = s.match(/\b(\d{1,3})\b/);
          if (!m) return null;
          const n = parseInt(m[1] as string, 10);
          return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
        };

        // Strategy 1: visible dropdown-prompt span.
        const dd = target.querySelector<HTMLElement>(
          '.a-dropdown-prompt, .dropdown_selectedTOption',
        );
        const fromDd = parseNum(dd?.innerText ?? dd?.textContent ?? null);
        if (fromDd !== null) return fromDd;

        // Strategy 2: hidden/visible quantity input.
        const input = target.querySelector<HTMLInputElement>(
          'input[name="quantity"], input[name*="quantity" i]',
        );
        if (input && input.value) {
          const n = parseNum(input.value);
          if (n !== null) return n;
        }

        // Strategy 3: stepper widget — look for the numeric sibling
        // between the +/- buttons (per the [- N +] layout).
        const stepper =
          target.querySelector<HTMLElement>(
            '[aria-label*="Increase" i], [aria-label*="Decrease" i], [aria-label*="Quantity" i]',
          );
        if (stepper) {
          // Walk up one level so we catch sibling numeric spans.
          const scope = stepper.closest(
            '.a-button-stack, .a-quantity, [data-csa-c-content-id*="quantity" i], span, div',
          ) ?? stepper.parentElement;
          if (scope) {
            const fromStepper = parseNum(
              (scope as HTMLElement).innerText ?? scope.textContent ?? null,
            );
            if (fromStepper !== null) return fromStepper;
          }
        }
        return null;
      },
      { asin: targetAsin, title: titlePrefix },
    )
    .catch(() => null);
}

type TargetCashbackResult =
  | { ok: true; pct: number; diag: CashbackDiag }
  | { ok: false; reason: string; detail?: string; pct: number | null; diag?: CashbackDiag };

/**
 * Read "N% back" text scoped to the target ASIN's /spc line item row
 * only. Returns the highest percentage found inside that row and compares
 * it against `minPct`. Anything shown elsewhere on the page (credit-card
 * promo banners, filler items' offers, order-total rewards widgets) is
 * ignored — we care about whether the TARGET qualifies.
 *
 * Returns `pct: null` when the row was found but contained no "N% back"
 * text — treated as a failure because the caller needs an explicit
 * percentage to compare.
 */
async function verifyTargetCashback(
  page: Page,
  targetAsin: string,
  targetTitle: string | null,
  minPct: number,
): Promise<TargetCashbackResult> {
  // Chewbacca /spc virtualizes long item lists — an iPad buried below 12
  // fillers may not be rendered until scrolled into view. Best-effort;
  // we ignore failures and let the in-browser locator below do its own
  // search.
  await scrollTargetIntoView(page, targetAsin, 5_000);
  await page
    .waitForSelector(
      '.lineitem-container, [data-feature-id*="line-item"], .order-summary-line-item',
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  // The DOM reader is a pure function in parsers/amazonCheckout.ts —
  // one source of truth shared with fixture tests. Two steps are done
  // in-browser before handing off to the parser:
  //   1) Sync `.checked` property → `[checked]` attribute. `page.content()`
  //      serializes ATTRIBUTES, not live form-control properties; without
  //      this step a radio clicked by `pickBestCashbackDelivery` would not
  //      show as :checked in the JSDOM copy.
  //   2) `page.content()` returns the current serialized HTML.
  // Then JSDOM reconstructs the document and the pure parser reads it.
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
  const html = await page.content().catch(() => '');
  const hit = html
    ? readTargetCashbackFromDom(new JSDOM(html).window.document, targetAsin, targetTitle)
    : ({ found: false as const, diag: { totalLinks: 0, asinInBody: false, titleSearched: null, titleInBody: false, url: page.url() } });

  if (!hit.found) {
    return {
      ok: false,
      reason: `could not locate target ${targetAsin} in /spc line items to read cashback`,
      pct: null,
      detail: 'diag' in hit ? JSON.stringify(hit.diag).slice(0, 600) : undefined,
    };
  }
  const diag: CashbackDiag = {
    groupFound: hit.groupFound,
    walkDepth: hit.walkDepth,
    scopeChars: hit.scopeChars,
    scopeMatches: hit.scopeMatches,
    bodyMatches: hit.bodyMatches,
    scopeStart: hit.scopeStart,
    checkedRadioCount: hit.checkedRadioCount,
    selectedLabel: hit.selectedLabel,
  };
  const diagSummary =
    `group=${diag.groupFound} · depth=${diag.walkDepth} · ` +
    `scope=${diag.scopeChars}ch · ` +
    `checkedRadios=${diag.checkedRadioCount} · ` +
    `selected="${(diag.selectedLabel ?? '').slice(0, 80)}" · ` +
    `body=[${diag.bodyMatches.join(',')}] · ` +
    `inScope=[${diag.scopeMatches.join(',')}] · ` +
    `head="${diag.scopeStart.slice(0, 80)}"`;
  if (hit.pct === null) {
    return {
      ok: false,
      // Be specific: is there no cashback option at all on this group,
      // or is there one but the default radio (non-cashback) is still
      // selected? The scopeMatches array disambiguates.
      reason:
        hit.scopeMatches.length > 0
          ? `target ${targetAsin}'s selected delivery option has no "% back" label (group offers ${hit.scopeMatches.join(', ')} but a non-cashback radio is checked)`
          : `no "% back" shown on target ${targetAsin}'s shipping group`,
      pct: null,
      detail: diagSummary,
      diag,
    };
  }
  if (hit.pct < minPct) {
    return {
      ok: false,
      reason: `target cashback ${hit.pct}% below threshold ${minPct}% (from selected radio "${diag.selectedLabel ?? '(no label)'}")`,
      pct: hit.pct,
      detail: diagSummary,
      diag,
    };
  }
  return { ok: true, pct: hit.pct, diag };
}

type TargetPriceResult =
  | { ok: true; priceText: string; price: number }
  | { ok: false; reason: string; detail?: string };

/**
 * Find the /spc line item that belongs to `targetAsin` and confirm its
 * unit price is ≤ `cap`. The line item is located by its product link
 * (`a[href*="/dp/<ASIN>"]`) because the link has to point at the product
 * regardless of layout. Falls back to `data-asin` on an ancestor when the
 * link selector misses.
 *
 * Returns `ok: false` when:
 *  - The target row can't be located (cart structure unrecognized).
 *  - The price can't be parsed from the matched row.
 *  - The parsed price exceeds the cap.
 */
async function verifyTargetLineItemPrice(
  page: Page,
  targetAsin: string,
  targetTitle: string | null,
  cap: number,
): Promise<TargetPriceResult> {
  // Scroll the target into view so its line item is in the DOM
  // (Chewbacca virtualizes long lists — target may be lazy-rendered).
  await scrollTargetIntoView(page, targetAsin, 5_000);
  await page
    .waitForSelector(
      '.lineitem-container, [data-feature-id*="line-item"], .order-summary-line-item',
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const titlePrefix = buildTitlePrefix(targetTitle);

  const hit = await page
    .evaluate(
      ({ asin, title }) => {
        // Step 1: try ASIN-based locators (classic /spc).
        let link: Element | null = document.querySelector(
          `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`,
        );

        // Step 2: Chewbacca fallback — match the product title as a
        // text node, take its parent as the target anchor.
        if (!link && title && title.length > 5) {
          const needle = title.toLowerCase();
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
          );
          let n: Node | null;
          // eslint-disable-next-line no-cond-assign
          while ((n = walker.nextNode())) {
            const txt = ((n as Text).textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
            if (txt.length > 5 && txt.startsWith(needle)) {
              link = n.parentElement;
              break;
            }
          }
        }
        if (!link) return { found: false as const };

        // Walk up to the enclosing line-item container — try known
        // classes first, then fall back to nearest ancestor with a
        // price element inside.
        let target: Element | null =
          link.closest(
            '.lineitem-container, [data-feature-id*="line-item"], .order-summary-line-item',
          ) ?? null;
        if (!target) {
          let el: Element | null = link.parentElement;
          let depth = 0;
          while (el && el !== document.body && depth < 10) {
            if (el.querySelector('.a-price, .lineitem-price-text, .a-color-price')) {
              target = el;
              break;
            }
            el = el.parentElement;
            depth++;
          }
        }
        if (!target) return { found: false as const };

        const priceEl =
          (target.querySelector('.lineitem-price-text') as HTMLElement | null) ??
          (target.querySelector('.a-price .a-offscreen') as HTMLElement | null) ??
          (target.querySelector('.a-color-price') as HTMLElement | null) ??
          (target.querySelector('.a-price') as HTMLElement | null);
        const text = priceEl ? (priceEl.textContent ?? '').trim() : '';
        return { found: true as const, text };
      },
      { asin: targetAsin, title: titlePrefix },
    )
    .catch(() => ({ found: false as const }));

  if (!hit.found) {
    return {
      ok: false,
      reason: `could not locate target ${targetAsin} in /spc line items`,
    };
  }
  if (!hit.text) {
    return {
      ok: false,
      reason: `target ${targetAsin} line item has no parseable price text`,
    };
  }

  const n = parsePrice(hit.text);
  if (n === null || n <= 0) {
    return {
      ok: false,
      reason: `could not parse target price from "${hit.text}"`,
    };
  }
  const tol = effectivePriceTolerance(cap);
  if (n > cap + tol) {
    return {
      ok: false,
      reason:
        tol > 0
          ? `target price $${n.toFixed(2)} exceeds cap $${cap.toFixed(2)} (+$${tol.toFixed(2)} tolerance)`
          : `target price $${n.toFixed(2)} exceeds cap $${cap.toFixed(2)}`,
      detail: hit.text,
    };
  }
  return { ok: true, priceText: hit.text, price: n };
}

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const ai = a[i] as T;
    const aj = a[j] as T;
    a[i] = aj;
    a[j] = ai;
  }
  return a;
}

function buildFillerSearchUrl(term: string): string {
  // p_85:2470955011 = Prime-eligible; p_36:low-high = price in cents
  const minCents = Math.round(FILLER_MIN_PRICE * 100);
  const maxCents = Math.round(FILLER_MAX_PRICE * 100);
  const rh = encodeURIComponent(`p_85:2470955011,p_36:${minCents}-${maxCents}`);
  return `https://www.amazon.com/s?k=${encodeURIComponent(term)}&rh=${rh}&s=review-rank`;
}

/**
 * Load the search URL and harvest ASINs of Prime-eligible items priced
 * between FILLER_MIN_PRICE and FILLER_MAX_PRICE (inclusive). Runs in-
 * browser because we need the client-rendered Prime badge visibility,
 * not just the static HTML.
 */
async function scrapeFillerAsins(page: Page, term: string): Promise<string[]> {
  try {
    await page.goto(buildFillerSearchUrl(term), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch {
    return [];
  }
  return page
    .evaluate(
      ({ minPrice, maxPrice }) => {
        const out: string[] = [];
        const cards = document.querySelectorAll(
          '[data-asin][data-component-type="s-search-result"]',
        );
        cards.forEach((card) => {
          const asin = card.getAttribute('data-asin');
          if (!asin || asin.trim() === '') return;

          const isPrime =
            card.querySelector('.s-prime') !== null ||
            card.querySelector('[aria-label*="Prime"]') !== null ||
            card.innerHTML.includes('a-icon-prime');
          if (!isPrime) return;

          let price: number | null = null;
          const wholeEl = card.querySelector('.a-price-whole');
          const fracEl = card.querySelector('.a-price-fraction');
          if (wholeEl) {
            const whole =
              parseFloat((wholeEl.textContent || '').replace(/[^0-9]/g, '')) || 0;
            const frac = fracEl
              ? parseFloat('0.' + (fracEl.textContent || '').replace(/[^0-9]/g, ''))
              : 0;
            price = whole + frac;
          }
          if (
            price === null ||
            price < minPrice ||
            price > maxPrice
          )
            return;
          out.push(asin);
        });
        return out;
      },
      { minPrice: FILLER_MIN_PRICE, maxPrice: FILLER_MAX_PRICE },
    )
    .catch(() => []);
}

/**
 * Add one ASIN's product to the cart on `page`. Returns true if the click
 * landed and settled; false on navigation failure or click failure. We
 * trust the click as the per-item signal — using #nav-cart-count instead
 * would be racy with parallel workers incrementing the same counter.
 * Final verification is done at the cart-reload step after the loop.
 */
async function addOneFillerToCart(page: Page, asin: string): Promise<boolean> {
  try {
    await page.goto(`https://www.amazon.com/dp/${asin}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch {
    return false;
  }

  try {
    await page
      .locator('#add-to-cart-button, input[name="submit.add-to-cart"]')
      .first()
      .click({ timeout: 10_000 });
  } catch {
    return false;
  }

  // AppleCare/warranty upsell is rare on ≤$100 items but we handle it
  // defensively. 2s window — if no modal appears we assume the add
  // completed without one.
  try {
    await page
      .locator(
        '#attachSiNoCoverage input.a-button-input, .warranty-twister-no-thanks-text',
      )
      .first()
      .click({ timeout: 2_000 });
  } catch {
    // No modal — normal for non-tech items.
  }

  // Let the POST + redirect settle so the next navigation on this tab
  // doesn't race an in-flight add. 8s cap — Amazon usually returns within
  // 2s; a longer delay usually means we're on a confirmation page that
  // won't "settle" in the networkidle sense.
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
  return true;
}

type FillerState = {
  added: number;
  /** ASINs that successfully landed in the cart (worker click returned
   *  true). Used downstream to look up which Amazon order(s) each ASIN
   *  ended up in — cart items can fan out to multiple order IDs. */
  addedAsins: string[];
  queue: string[];
  termIdx: number;
  seen: Set<string>;
  termsExhausted: boolean;
};

/**
 * Parallel filler loop. Spawns FILLER_WORKERS tabs in the account's
 * shared BrowserContext and runs a worker on each. Workers coordinate
 * through a shared state object; all state mutations happen in synchronous
 * blocks between awaits, so single-threaded JS keeps them atomic (no
 * locks needed).
 *
 * Overshoot prevention: workers reserve a slot by incrementing `added`
 * BEFORE the async add. If the add fails we decrement. This means a
 * worker that sees `added >= FILLER_COUNT` at the top of the loop never
 * enters another add — even if three workers are mid-flight.
 */
async function addFillerItems(
  mainPage: Page,
  targetAsin: string | null,
  cid: string | undefined,
  /** Number of parallel tabs to use. Defaults to the historical 4 if
   *  unspecified; clamped to 1..6. */
  parallelTabs: number = DEFAULT_FILLER_WORKERS,
): Promise<{ added: number; asins: string[] }> {
  const workers = Math.max(
    MIN_FILLER_WORKERS,
    Math.min(MAX_FILLER_WORKERS, Math.round(parallelTabs)),
  );
  const context = mainPage.context();
  const terms = shuffle(FILLER_SEARCH_TERMS);
  const state: FillerState = {
    added: 0,
    addedAsins: [],
    queue: [],
    termIdx: 0,
    seen: new Set<string>(targetAsin ? [targetAsin] : []),
    termsExhausted: false,
  };

  // Main page participates as worker 0. Side tabs are workers 1..N-1.
  const sideTabs: Page[] = [];
  for (let i = 1; i < workers; i++) {
    const p = await context.newPage().catch(() => null);
    if (p) sideTabs.push(p);
  }
  const tabs = [mainPage, ...sideTabs];

  try {
    await Promise.all(
      tabs.map((tab, i) => runFillerWorker(tab, i, state, terms, cid)),
    );
  } finally {
    for (const tab of sideTabs) {
      await tab.close().catch(() => undefined);
    }
  }

  return { added: state.added, asins: state.addedAsins };
}

async function runFillerWorker(
  tab: Page,
  workerId: number,
  state: FillerState,
  terms: readonly string[],
  cid: string | undefined,
): Promise<void> {
  while (true) {
    // Top-of-loop stop conditions — checked synchronously before any await
    // so a worker that sees the counter at FILLER_COUNT returns instantly
    // and can't start another add.
    if (state.added >= FILLER_COUNT) return;

    let asin = state.queue.shift();
    if (!asin) {
      if (state.termsExhausted) return;
      const idx = state.termIdx++;
      const term = terms[idx];
      if (!term) {
        state.termsExhausted = true;
        return;
      }
      const found = await scrapeFillerAsins(tab, term);
      const fresh = found.filter((a) => !state.seen.has(a));
      for (const a of fresh) state.seen.add(a);
      if (fresh.length === 0) {
        logger.info(
          'step.fillerBuy.fillers.searchEmpty',
          { workerId, term, rawCount: found.length },
          cid,
        );
        continue;
      }
      state.queue.push(...fresh);
      logger.info(
        'step.fillerBuy.fillers.searchHit',
        { workerId, term, fresh: fresh.length },
        cid,
      );
      continue;
    }

    // Reserve a slot before the async add so a concurrent worker can't
    // reserve the same last slot. If the add fails we release the slot.
    if (state.added >= FILLER_COUNT) return;
    state.added++;

    const ok = await addOneFillerToCart(tab, asin);
    if (ok) {
      state.addedAsins.push(asin);
      logger.info(
        'step.fillerBuy.fillers.added',
        { workerId, asin, count: state.added, of: FILLER_COUNT },
        cid,
      );
    } else {
      state.added--;
      logger.warn(
        'step.fillerBuy.fillers.addFailed',
        { workerId, asin, count: state.added },
        cid,
      );
    }
  }
}

/**
 * Wait for /spc to load after Proceed to Checkout. Amazon occasionally
 * parks the cart on a "Need anything else?" upsell interstitial (BYG —
 * Before You Go) instead of going straight to /spc. When that happens,
 * click the BYG "Continue to checkout" button and keep waiting.
 *
 * Races two signals each iteration:
 *   1. URL transitions to /spc → done.
 *   2. The BYG header becomes visible → click Continue, loop again.
 * Total deadline is bounded so a stuck page still fails cleanly.
 */
async function waitForSpcOrHandleByg(
  page: Page,
  cid: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const TOTAL_DEADLINE_MS = 30_000;
  const MAX_BYG_CLICKS = 2;
  const start = Date.now();
  let bygClicks = 0;

  while (true) {
    if (SPC_URL_MATCH.test(page.url())) return { ok: true };

    const remaining = TOTAL_DEADLINE_MS - (Date.now() - start);
    if (remaining <= 0) {
      return { ok: false, reason: 'did not reach /spc after Proceed to Checkout' };
    }

    const winner = await Promise.race([
      page
        .waitForURL(SPC_URL_MATCH, { timeout: remaining })
        .then(() => 'spc' as const)
        .catch(() => 'timeout' as const),
      page
        .locator(BYG_HEADER_SELECTOR)
        .first()
        .waitFor({ state: 'visible', timeout: remaining })
        .then(() => 'byg' as const)
        .catch(() => 'timeout' as const),
    ]);

    if (winner === 'spc') return { ok: true };
    if (winner === 'timeout') {
      return { ok: false, reason: 'did not reach /spc after Proceed to Checkout' };
    }

    if (bygClicks >= MAX_BYG_CLICKS) {
      return {
        ok: false,
        reason: 'BYG "Need anything else?" interstitial reappeared after Continue click',
      };
    }
    logger.info(
      'step.fillerBuy.spc.byg.detected',
      { url: page.url(), priorClicks: bygClicks },
      cid,
    );
    const clicked = await page
      .locator(BYG_BUTTON_SELECTOR)
      .first()
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      return {
        ok: false,
        reason: 'BYG interstitial detected but Continue to Checkout click failed',
      };
    }
    bygClicks += 1;
    logger.info('step.fillerBuy.spc.byg.clicked', { clicks: bygClicks }, cid);
  }
}

async function clickProceedToCheckout(page: Page): Promise<boolean> {
  // Amazon exposes the same button under several selectors depending on
  // cart layout; try them in order and fall back to name=proceedToRetailCheckout.
  const selectors = [
    'input[name="proceedToRetailCheckout"]',
    '#sc-buy-box-ptc-button input',
    '#sc-buy-box-ptc-button span input',
  ];
  for (const sel of selectors) {
    try {
      await page.locator(sel).first().click({ timeout: 8_000 });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function hasTargetInCart(page: Page, asin: string | null): Promise<boolean> {
  // Delegate to the pure parser so runtime and fixture tests share the
  // same selectors. `page.content()` captures the Active/Saved split as
  // rendered; the parser scopes strictly to `[data-name="Active Cart"]`.
  const html = await page.content().catch(() => '');
  if (!html) return false;
  return isTargetInActiveCart(new JSDOM(html).window.document, asin);
}
