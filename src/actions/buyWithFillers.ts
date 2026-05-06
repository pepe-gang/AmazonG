import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { logger } from '../shared/logger.js';
import { cancelFillerOrder } from './cancelFillerOrder.js';
import { clearCart, type ClearCartResult } from './clearCart.js';
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
import {
  CART_ADD_CLIENT_NAME,
  CART_ADD_URL,
  HTTP_BROWSERY_HEADERS,
  SEARCH_CART_ADD_CLIENT_NAME,
  SPC_ENTRY_URL,
  SPC_URL_MATCH,
  asinsCommittedInResponse,
  buildBatchCartAddBody,
  extractCartAddTokens,
  extractSearchResultCandidates,
  looksLikeCartResponse,
  type SearchResultCandidate,
} from './amazonHttp.js';

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
   * When true, the filler picker uses a whey-protein search-term pool
   * instead of the general impulse mix and randomises the count to
   * 6–8 (vs the fixed 8 for the general pool). Prime + $20–$100
   * rules unchanged.
   */
  wheyProteinFillerOnly?: boolean;
  /**
   * Set of ASINs the picker must NOT add to cart. Pre-seeded into the
   * dedup state, then mutated by the picker as it goes — callers
   * running a retry loop should pass the SAME Set across attempts so
   * each retry lands on a different shipping-group fan-out (avoiding
   * the items they already tried, which is the whole point of
   * retrying on a cashback_gate miss).
   *
   * Pass undefined for a fresh-start picker.
   */
  attemptedAsins?: Set<string>;
  /**
   * Pre-scraped product info from the caller's verify phase. When set
   * AND the page is still on the matching PDP, we reuse it instead of
   * running scrapeProduct a second time. Saves ~2-4s of redundant
   * page.goto + buy-box hydration per filler buy.
   *
   * Falls through to a fresh scrapeProduct when:
   *   - the field is omitted (caller didn't scrape, or this is a retry)
   *   - the page navigated away (clearCart click-loop fallback hit /cart)
   *   - the URL's ASIN no longer matches `productUrl`'s ASIN (e.g.
   *     Amazon redirected to a variant)
   */
  prescrapedInfo?: ProductInfo;
  /**
   * Pre-flight clearCart result. When the caller (pollAndScrape) fires
   * `clearCartHttpOnly` concurrently with `scrapeProduct` to save ~1.5s
   * of sequential time, the resulting promise is passed here so the
   * buy action can skip its internal clearCart call.
   *
   * Three states:
   *   - undefined  — caller didn't pre-flight; run the full clearCart.
   *   - { ok: true } resolved → cart already empty, skip internal call.
   *   - { ok: false } resolved → HTTP path failed. Run the full
   *     clearCart sequentially (HTTP retry + click-loop fallback).
   *     The page is on the PDP from `scrapeProduct`; the click-loop's
   *     page.goto('/cart') is the only nav happening so there's no race.
   */
  preflightCleared?: Promise<ClearCartResult>;
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
  /**
   * Amazon's checkout-session ID from the thank-you URL (`?purchaseId=`).
   * Distinct from any orderId — Amazon's number-spaces don't overlap.
   * One per Place Order click; persists across the cart fan-out (every
   * fan-out orderId in `orderIds` shares this same purchaseId). Audit-
   * only field — Amazon does NOT expose a purchaseId↔orderId mapping
   * endpoint, so AmazonG must capture this at the time of the click or
   * it's permanently lost. See `docs/research/amazon-pipeline.md`.
   * Null on dry-run (no Place Order click happened).
   */
  amazonPurchaseId: string | null;
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
const CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

const FILLER_COUNT = 8;
const FILLER_MIN_PRICE = 20;
const FILLER_MAX_PRICE = 100;

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

// Whey-protein-only pool. Used when the user opts in via Settings →
// Buy with Fillers → "Whey Protein Filler only". Same Prime + $20–$100
// gating as the general pool; just a narrower term list so the cart
// looks like a sports/nutrition shop instead of a general-merch run.
// Brand + flavour variants are intentional — Amazon's search rankings
// for "whey protein" alone tend to surface the same handful of bestsellers
// every time, which would defeat the no-duplicates-on-retry rule.
const WHEY_PROTEIN_SEARCH_TERMS: readonly string[] = [
  'whey protein', 'whey protein powder', 'whey isolate', 'whey concentrate',
  'whey protein vanilla', 'whey protein chocolate', 'whey protein strawberry',
  'optimum nutrition whey', 'dymatize iso100', 'muscle milk powder',
  'body fortress whey', 'six star whey', 'cellucor whey',
  'isopure protein', 'naked whey', 'muscletech whey',
  'gnc whey', 'gold standard whey', 'pure protein whey',
];

// When wheyProteinFillerOnly is on, the count is randomised in this
// inclusive range — adds a touch of variation per buy on top of the
// shuffled term order so two consecutive whey-mode buys aren't
// fingerprintably identical. Range scaled proportionally with the
// general FILLER_COUNT drop from 12 → 8.
const WHEY_FILLER_MIN_COUNT = 6;
const WHEY_FILLER_MAX_COUNT = 8;

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

  // Step ordering (changed 2026-05-05 to eliminate the PDP→/cart→PDP
  // round-trip on clearCart's click-loop fallback):
  //
  //   1. Reuse caller's prescraped product info, OR scrapeProduct as a
  //      fallback. Page is on the PDP from pollAndScrape's verify scrape.
  //   2. setMaxQuantity — reads the qty dropdown from the live PDP DOM.
  //   3. Capture page.content() into prefetchedHtml — locks in the PDP
  //      HTML for addFillerViaHttp's token extraction.
  //   4. clearCart — HTTP fast path: no nav. Click-loop fallback navs to
  //      /cart, but we no longer care because every PDP-DOM read is
  //      already done.
  //   5. addFillerViaHttp(target) using the captured prefetchedHtml.
  //   6. addFillerItems batch — pure HTTP.
  //   7. /spc shortcut.
  //
  // Net visible navs in the happy path: PDP → /spc.
  // On clearCart click-loop fallback: PDP → /cart → /spc (no return-to-PDP).
  const expectedAsin = parseAsinFromUrl(opts.productUrl);
  const currentAsin = parseAsinFromUrl(page.url());
  let info: ProductInfo;
  if (
    opts.prescrapedInfo &&
    expectedAsin !== null &&
    currentAsin === expectedAsin
  ) {
    info = opts.prescrapedInfo;
    logger.info(
      'step.fillerBuy.scrape.reused',
      { asin: expectedAsin, title: info.title },
      cid,
    );
  } else {
    info = await scrapeProduct(page, opts.productUrl);
  }
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

  // 2. Select the max quantity from the product page's #quantity dropdown.
  //    Runs while the page is guaranteed to be on the PDP (before
  //    clearCart can navigate). The qty number is threaded into the
  //    HTTP cart-add POST body — we don't actually need the dropdown's
  //    side-effect (firing 'change'); we just need the max value.
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

  // 3. Capture the PDP HTML before clearCart can navigate the page
  //    away. addFillerViaHttp needs this for token extraction; with
  //    the bug-fix in 94dc242 it falls through to ctx.request.get on
  //    a parse miss, so an empty/wrong capture degrades gracefully.
  const targetHtmlForHttp = await page.content().catch(() => '');

  // 4. Cart hygiene. Two paths:
  //
  //   A. Preflight succeeded: pollAndScrape fired clearCartHttpOnly in
  //      parallel with scrapeProduct and the HTTP path won. Cart is
  //      already empty. Skip the internal clearCart call entirely.
  //
  //   B. Preflight failed (or wasn't fired): run the full clearCart
  //      (HTTP retry + click-loop fallback). The click-loop's page.goto
  //      to /cart is fine here because every PDP-DOM read is already
  //      done above (setMaxQuantity ran, page.content() captured).
  //
  //   No-preflight callers (tests, scripts) get path B.
  let cleared: ClearCartResult;
  if (opts.preflightCleared) {
    const pre = await opts.preflightCleared;
    if (pre.ok) {
      logger.info(
        'step.fillerBuy.cart.preflight.skipped',
        { wasEmpty: pre.wasEmpty, removed: pre.removed },
        cid,
      );
      cleared = pre;
    } else {
      logger.info(
        'step.fillerBuy.cart.preflight.fallback',
        { reason: pre.reason },
        cid,
      );
      cleared = await clearCart(page, { correlationId: cid });
    }
  } else {
    cleared = await clearCart(page, { correlationId: cid });
  }
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

  // 3. Add target to cart. Two-tier path:
  //
  //    1. HTTP-add fast path — same /cart/add-to-cart/ref=... endpoint
  //       used for fillers, with the strengthened ASIN-in-response check
  //       (catches phantom commits where Amazon returns a cart page that
  //       doesn't actually contain our item). The PDP we just loaded
  //       carries the tokens; the POST commits the item to the server-
  //       side cart synchronously. Saves ~7-13s by skipping the Buy Now
  //       click + /spc navigation + separate cart-verify navigation —
  //       the response body itself proves the target landed.
  //
  //    2. Buy Now click fallback — if the HTTP path fails (bot challenge,
  //       missing form, response missing target ASIN), fall through to
  //       the original Buy Now click flow. Worst-case behavior matches
  //       what shipped before this experiment.
  //
  //    The cart navigation that's downstream (just before the Proceed-
  //    to-Checkout click) still runs after fillers are added; it serves
  //    as belt-and-suspenders verification AND is required for the
  //    Proceed form to carry the full cart state.
  const targetAsin = parseAsinFromUrl(opts.productUrl);
  // targetHtmlForHttp was captured BEFORE clearCart (step 3 above) so it
  // holds the PDP HTML even if clearCart's click-loop fallback navigated
  // the page away. addFillerViaHttp's prefetchedHtml fallback (94dc242)
  // re-fetches via ctx.request.get on a parse miss, so an empty capture
  // degrades gracefully without a visible nav.
  //
  // CRITICAL: thread the quantity from setMaxQuantity (above) so the
  // HTTP cart-add commits the right number of units. Without this the
  // body builder defaults to 1 — pre-v0.13.13 filler-mode used Buy Now
  // click which respected the dropdown setMaxQuantity sets, but the
  // HTTP-add path commits via POST body and needs the explicit quantity.
  // Bug surfaced in user telemetry as "all filler buys committing at
  // qty=1 instead of max"; verified against the placedQuantity column
  // in BG dashboard.
  const targetQuantity = qty.ok ? qty.selected : 1;
  const httpTarget = await addFillerViaHttp(
    page,
    targetAsin ?? parseAsinFromUrl(page.url()) ?? '',
    { prefetchedHtml: targetHtmlForHttp, quantity: targetQuantity },
  );
  if (httpTarget.kind === 'committed') {
    logger.info(
      'step.fillerBuy.target.http.ok',
      {
        targetAsin,
        status: httpTarget.status,
        tookMs: httpTarget.tookMs,
      },
      cid,
    );
  } else {
    logger.info(
      'step.fillerBuy.target.http.fallback',
      {
        targetAsin,
        reason: httpTarget.reason,
        ...(httpTarget.status != null ? { status: httpTarget.status } : {}),
      },
      cid,
    );

    // Tier 2 — original Buy Now click flow. Identical to the pre-
    // experiment behavior. Click Buy Now, wait for /spc URL, navigate
    // to /cart, verify target landed.
    try {
      await page
        .locator('#buy-now-button')
        .first()
        .click({ timeout: 10_000 });
    } catch (err) {
      return {
        ok: false,
        stage: 'buy_now_click',
        reason: 'failed to click Buy Now (HTTP add also failed)',
        detail: String(err),
      };
    }
    logger.info('step.fillerBuy.buyNow.clicked', {}, cid);

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
    logger.info('step.fillerBuy.buyNow.onSpc', { url: page.url() }, cid);

    // Cart-verify nav — only needed in fallback path; the HTTP path's
    // ASIN-in-response check already proved the target landed.
    try {
      await page.goto(CART_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
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
  }

  // 5. Add filler items one-at-a-time on the same tab. Playwright tabs in
  //    the shared BrowserContext all write to the same Amazon cart, so a
  //    plain sequential loop here is enough — no side-windows needed.
  //    Proceed with whatever count we got: even a partial set (say 8/12)
  //    still provides camouflage. Refusing to buy because of a flaky
  //    search is worse than a slightly smaller cover.
  //
  // Pool + count picked here so log lines downstream can attribute
  // results to the active mode. Whey-only randomises 10–12 to add a
  // bit of cart-shape variation across runs; general pool stays at the
  // historical fixed 12.
  const useWheyPool = opts.wheyProteinFillerOnly === true;
  const fillerTerms = useWheyPool ? WHEY_PROTEIN_SEARCH_TERMS : FILLER_SEARCH_TERMS;
  const fillerTargetCount = useWheyPool
    ? WHEY_FILLER_MIN_COUNT +
      Math.floor(Math.random() * (WHEY_FILLER_MAX_COUNT - WHEY_FILLER_MIN_COUNT + 1))
    : FILLER_COUNT;
  logger.info(
    'step.fillerBuy.fillers.config',
    {
      pool: useWheyPool ? 'whey' : 'general',
      targetCount: fillerTargetCount,
      preExcludedCount: opts.attemptedAsins?.size ?? 0,
    },
    cid,
  );
  const fillersResult = await addFillerItems(page, targetAsin, cid, {
    terms: fillerTerms,
    targetCount: fillerTargetCount,
    attemptedAsins: opts.attemptedAsins,
  });
  const fillersAdded = fillersResult.added;
  const fillerAsins = fillersResult.asins;
  if (fillersAdded < fillerTargetCount) {
    logger.warn(
      'step.fillerBuy.fillers.partial',
      { fillersAdded, fillersRequested: fillerTargetCount },
      cid,
    );
  } else {
    logger.info(
      'step.fillerBuy.fillers.ok',
      { fillersAdded, fillersRequested: fillerTargetCount },
      cid,
    );
  }

  // 6. Enter checkout directly. /checkout/entry/cart?proceedToCheckout=1
  //    is the URL Amazon's BYG ("Need anything else?") "Continue to
  //    checkout" button points at — a server-side handler that reads
  //    the user's current cart, spins up a fresh checkout session, and
  //    302-redirects to /checkout/p/p-{purchaseId}/spc. Hitting it
  //    directly via page.goto bypasses three navigation-bound steps in
  //    one shot:
  //      - the full cart-page render (page.goto /cart, ~1-3s)
  //      - the Proceed-to-Checkout click (form submit + URL nav, 1-3s)
  //      - the BYG "Need anything else?" interstitial click (1-3s)
  //    Net savings ~3-8s per filler buy.
  //
  //    Verified live 2026-05-04 against a real signed-in account: the
  //    fetch returned /spc HTML in 161-248ms across 5 consecutive runs
  //    (avg ~180ms); page.goto landed the browser at
  //    /checkout/p/p-XXX/spc with all cart items populated, no BYG.
  //    See docs/research/amazon-pipeline.md.
  //
  //    Server-side cart sync: HTTP filler adds returned 200 only after
  //    Amazon committed each item. Amazon's checkout-entry handler
  //    reads from that server-side cart, so the items are guaranteed
  //    to be present without a client-side reload.
  //
  //    Fallback: if the navigation lands somewhere other than /spc
  //    (Amazon shifts the URL pattern, or the entry handler returns
  //    cart/BYG instead), fall through to the click-based flow we
  //    used to ship — full cart-page render, Proceed click,
  //    waitForSpcOrHandleByg. Worst case: same wall-clock as before.
  let usedShortcut = false;
  try {
    // 'commit' = ~50ms vs ~300ms for DCL. Next op (page.url() check)
    // works at commit; downstream waitForCheckout polls for the Place
    // Order button.
    await page.goto(SPC_ENTRY_URL, { waitUntil: 'commit', timeout: 30_000 });
  } catch (err) {
    return {
      ok: false,
      stage: 'proceed_checkout',
      reason: 'failed to enter checkout via shortcut',
      detail: String(err),
    };
  }
  if (SPC_URL_MATCH.test(page.url())) {
    usedShortcut = true;
    logger.info(
      'step.fillerBuy.spc.shortcut.ok',
      {
        url: page.url(),
        fillersReportedAdded: fillersAdded,
        expectedTotal: fillerTargetCount + 1,
      },
      cid,
    );
  } else {
    // Fallback: shortcut didn't land on /spc (unexpected Amazon response).
    // Use the click-based flow as we did before this optimization.
    logger.warn(
      'step.fillerBuy.spc.shortcut.fallback',
      { landedUrl: page.url(), note: 'entry-cart shortcut did not redirect to /spc; using click-based flow' },
      cid,
    );
    try {
      await page.goto(CART_URL, { waitUntil: 'commit', timeout: 30_000 });
    } catch (err) {
      return {
        ok: false,
        stage: 'proceed_checkout',
        reason: 'failed to reload cart before checkout (fallback path)',
        detail: String(err),
      };
    }
    const clicked = await clickProceedToCheckout(page);
    if (!clicked) {
      return {
        ok: false,
        stage: 'proceed_checkout',
        reason: 'Proceed to Checkout button not found (fallback path)',
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
    logger.info('step.fillerBuy.spc.reached.fallback', { url: page.url() }, cid);
  }
  // Lint silencer — usedShortcut is captured for telemetry/debugging
  // even when the value isn't routed elsewhere.
  void usedShortcut;

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
    // Both `unavailable` and `quantity_limit` are terminal — the item
    // can't be bought from this account right now. Mirror buyNow.ts's
    // mapping so they surface as `item_unavailable`, which the filler
    // retry loop in pollAndScrape correctly bails on. Without this
    // explicit branch a `quantity_limit` fell through to `spc_ready`,
    // and if Amazon's page also kept a Place Order button visible the
    // detector returned `kind: 'place'` instead — landing in the
    // cashback gate, which then failed with `stage: 'cashback_gate'`
    // and triggered the up-to-3 retry loop. Wasted ~3 minutes per buy
    // on items the account can never purchase more of.
    if (ready.kind === 'unavailable' || ready.kind === 'quantity_limit') {
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
  // for another second or two. Wait for one of those selectors to be
  // visible (bounded at 2s, the historical blind-sleep budget). Exits
  // early on the typical case where the panel hydrates in ~200ms;
  // falls through silently on miss so ensureAddress's own selector
  // logic still runs.
  if (opts.allowedAddressPrefixes.length > 0) {
    await page
      .locator('#deliver-to-address-text, #change-delivery-link')
      .first()
      .waitFor({ state: 'visible', timeout: 2_000 })
      .catch(() => undefined);
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
    // Wait for the eligibleshipoption XHR to complete + 200ms post-
    // settle. Replaces a blind 1500ms wait — typical XHR returns in
    // ~1s, saving ~300ms; cap at 2.5s for slow networks.
    await waitForDeliverySettle(page);
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
      // Permissive account: skip the BG1/BG2 retry, but the floor is
      // non-negotiable. INC-2026-05-05: a permissive account placed an
      // iPad buy at 5% under a 6% floor because this branch
      // unconditionally substituted DEFAULT_MISSING_CASHBACK_PCT (5).
      // 1% on a $1.2k order is real money, so even permissive mode now
      // hard-fails when the substitute would land below floor.
      const substituted = cb.pct ?? DEFAULT_MISSING_CASHBACK_PCT;
      if (substituted < opts.minCashbackPct) {
        logger.warn(
          'step.fillerBuy.spc.cashback.permissive.belowFloor',
          {
            targetAsin,
            pageReadingPct: cb.pct,
            substitutedPct: substituted,
            minRequired: opts.minCashbackPct,
            reason: cb.reason,
          },
          cid,
        );
        return {
          ok: false,
          stage: 'cashback_gate',
          reason: `target cashback ${substituted}% < ${opts.minCashbackPct}% floor (permissive substituted)`,
          ...(cb.detail ? { detail: cb.detail } : {}),
        };
      }
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
        await waitForDeliverySettle(page);
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
    fillersRequested: fillerTargetCount,
    placeOrderSelector: ready.detected,
    targetCashbackPct,
    placedQuantity,
    // Filled in below on the placed path; null on dry-run since Place
    // Order was never clicked.
    amazonPurchaseId: null as string | null,
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
          `(cashback ${targetCashbackPct ?? 'n/a'}%, ${fillersAdded}/${fillerTargetCount} fillers). ` +
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

  // 13. Click Place Order. Mirrors buyNow's checkout[9]-[10]: locate the
  //     Place Order control across Amazon's layout variants, then wait
  //     for it to be visible/stable before clicking. Was previously a
  //     blind 1s waitForTimeout — replaced with a bounded selector wait
  //     (same 1s upper bound) so the typical case exits in <100ms once
  //     the button has hydrated, while pathological "still re-rendering"
  //     cases get the same protection as before.
  const placeLocator = await findPlaceOrderLocator(page);
  if (!placeLocator) {
    return {
      ok: false,
      stage: 'place_order',
      reason: 'no Place Order button selector matched on /spc',
      detail: `url=${page.url()}`,
    };
  }
  await placeLocator
    .waitFor({ state: 'visible', timeout: 1_000 })
    .catch(() => undefined);
  logger.info('step.fillerBuy.place.settle', { mode: 'visible_wait', cap: 1_000 }, cid);
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

  // Capture Amazon's checkout-session purchaseId BEFORE any subsequent
  // navigation. The thank-you URL is /gp/buy/thankyou/handlers/display.html
  // ?purchaseId=106-...; this is distinct from the orderId(s) we map below
  // (different number-space) and is not exposed on any post-checkout
  // endpoint, so this is the only chance to record it. The next
  // navigation in fetchOrderIdsForAsins will move us away from this URL.
  // See docs/research/amazon-pipeline.md.
  const amazonPurchaseId =
    page.url().match(/[?&]purchaseId=(\d{3}-\d{7}-\d{7})/)?.[1] ?? null;
  if (amazonPurchaseId) {
    logger.info('step.fillerBuy.purchaseId.captured', { amazonPurchaseId }, cid);
  }

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
    amazonPurchaseId,
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
      { waitUntil: 'commit', timeout: 30_000 },
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
  // Algorithm (document-order, first-occurrence-per-ASIN):
  //   1. Walk the full DOM in document order, collecting `id` and `link`
  //      events. Skip text inside <script>/<style>/<noscript>/<template>
  //      so JSON-embedded sessionIds + EWC cache keys don't pollute.
  //   2. For each cart ASIN, take ONLY the first occurrence in document
  //      order — by then the page is showing today's just-placed orders
  //      at the top. Older orders that share an ASIN with our cart are
  //      silently skipped. Each cart ASIN maps to exactly one orderId.
  //
  // This fixes two empirical bugs verified live 2026-05-04 against a
  // real signed-in account:
  //
  //   (a) Amazon's order-history page embeds JSON like
  //       `{"sessionId":"147-1303082-4549660"}` inside <script> tags.
  //       The previous walker (no `acceptNode` filter) read those text
  //       nodes, regex'd id-shaped strings, and inserted them into
  //       seenIds BEFORE any visible order. /dp/ links in page-header
  //       carousels then got attributed to the phantom session ID.
  //
  //   (b) The "every link → most-recently-seen orderId" rule cross-
  //       pollinated old orders. If user previously bought ASIN X and
  //       now places another order containing X, the walker would find
  //       X under BOTH orders and report both as containing the new
  //       cart's ASIN. The "filler" classifier then either claimed the
  //       new buy fanned to 2+ orders (it didn't), or attempted to
  //       cancel a historical order (which usually fails terminally
  //       but could in principle succeed and destroy a real prior
  //       purchase). Either way: garbage in BG's audit fields.
  //
  // The fix preserves the original spirit (single document walk, no
  // ancestor magic) while adding two surgical changes: the script-tag
  // text filter and the first-occurrence dedup.
  //
  // See docs/research/amazon-pipeline.md for the live test that
  // produced this fix.
  const raw = await page
    .evaluate(
      ({ asinList }) => {
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

        // Single walk over text + element nodes in document order. The
        // `acceptNode` filter rejects text inside non-rendered elements
        // (<script>/<style>/<noscript>/<template>) so JSON-embedded
        // sessionIds and EWC cache keys (which share the orderId shape
        // \d{3}-\d{7}-\d{7}) can't pollute seenIds.
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
          {
            acceptNode(node) {
              if (node.nodeType === Node.TEXT_NODE) {
                const p = node.parentElement;
                if (p) {
                  const tag = p.tagName;
                  if (
                    tag === 'SCRIPT' ||
                    tag === 'STYLE' ||
                    tag === 'NOSCRIPT' ||
                    tag === 'TEMPLATE'
                  ) {
                    return NodeFilter.FILTER_REJECT;
                  }
                }
              }
              return NodeFilter.FILTER_ACCEPT;
            },
          },
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
                if (!seenIds.has(id)) {
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

        // First-occurrence-per-ASIN attribution. For each cart ASIN,
        // record the orderId most recently seen above its FIRST /dp/
        // link only. The first /dp/<asin> link on the page is the
        // topmost — i.e. inside the most-recently-placed order card.
        // Subsequent /dp/<asin> links in older order cards (same ASIN,
        // historical purchase) are ignored.
        const asinToFirstOrder = new Map<string, string>();
        let currentId: string | null = null;
        for (const ev of events) {
          if (ev.kind === 'id') {
            currentId = ev.id;
          } else if (
            currentId &&
            asinList.includes(ev.asin) &&
            !asinToFirstOrder.has(ev.asin)
          ) {
            asinToFirstOrder.set(ev.asin, currentId);
          }
        }

        // Group: orderId → set of cart ASINs first-seen under it.
        const matchedByOrder = new Map<string, Set<string>>();
        for (const [asin, orderId] of asinToFirstOrder) {
          if (!matchedByOrder.has(orderId)) matchedByOrder.set(orderId, new Set<string>());
          matchedByOrder.get(orderId)!.add(asin);
        }

        const out: { orderId: string; matchedAsins: string[] }[] = [];
        for (const [orderId, asinSet] of matchedByOrder) {
          out.push({ orderId, matchedAsins: Array.from(asinSet) });
        }
        return out;
      },
      { asinList: asins },
    )
    .catch(() => [] as OrderMatch[]);

  // The first-occurrence-per-ASIN algorithm above only emits orderIds
  // that ended up with at least one cart ASIN matched, so no zero-match
  // filtering is needed (and the previous "no_asins" warning is dead
  // code under the new algorithm).
  return raw;
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
        // Step 1: try ASIN-based locators. Chewbacca SPC strips
        // /dp/<ASIN> hrefs on a subset of layouts, so try a broader
        // contains-ASIN match too. ASINs are 10-char base36 strings,
        // unlikely to collide with unrelated URLs.
        let link: Element | null = document.querySelector(
          `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"], a[href*="${asin}"]`,
        );

        // Step 1.5: Chewbacca testid pin. The /spc page renders a
        // hidden <span data-testid="Item_asin_N_N_N">ASIN</span>
        // inside each line-item card. Most reliable anchor when href
        // selectors miss because Amazon strips the link itself on
        // some checkout layouts. Mirrors the cashback reader's
        // strategy in parsers/amazonCheckout.ts:387-396.
        if (!link) {
          const spans = document.querySelectorAll<HTMLElement>(
            '[data-testid^="Item_asin_"]',
          );
          for (const s of Array.from(spans)) {
            if ((s.textContent ?? '').trim() === asin) {
              link = s;
              break;
            }
          }
        }

        // Step 2: Chewbacca title fallback — match the product title
        // as a text node, take its parent as the target anchor. Only
        // fires when href + testid both miss.
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

/**
 * After clicking a delivery-option radio on /spc, wait for Amazon's
 * `eligibleshipoption` XHR to complete + a 200ms post-settle before
 * reading the updated cashback. The XHR refreshes totals + cashback
 * banner; the 200ms post-settle covers the rare "6%→5% strip" case
 * where Amazon briefly shows 6% then re-renders to 5% milliseconds
 * later (INC-2026-05-05 — the iPad-no-Amazon-day fixture).
 *
 * Cap at 2.5s. Typical XHRs return in 800-1200ms; the cap prevents a
 * stuck network from blocking the caller indefinitely. On timeout we
 * still post-settle and return — downstream cashback gate reads
 * whatever rendered, same fallback as the blind 1500ms wait this
 * helper replaced.
 *
 * URL pattern verified stable across saved /spc fixtures (per
 * docs/research/amazon-pipeline.md). Pipeline param distinguishes
 * Chewbacca SPC from legacy SPC; both write to the same path.
 */
export async function waitForDeliverySettle(page: Page): Promise<void> {
  await page
    .waitForResponse(
      (resp) => /eligibleshipoption/i.test(resp.url()) && resp.ok(),
      { timeout: 2_500 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(200);
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
  // Search filters (Amazon's `rh=` syntax, comma-joined):
  //   p_85:2470955011  — Prime-eligible
  //   p_6:ATVPDKIKX0DER — sold by Amazon.com (Amazon's US merchant id);
  //                        restricts to "Ships from and sold by Amazon"
  //                        OR "Ships from Amazon" (FBA where Amazon is
  //                        the seller). 3rd-party-sold listings filtered
  //                        out, which keeps cancellation flow clean —
  //                        Amazon-direct cancels are predictable; 3p
  //                        cancels can stall behind merchant approval.
  //   p_36:low-high     — price in cents
  const minCents = Math.round(FILLER_MIN_PRICE * 100);
  const maxCents = Math.round(FILLER_MAX_PRICE * 100);
  const rh = encodeURIComponent(
    `p_85:2470955011,p_6:ATVPDKIKX0DER,p_36:${minCents}-${maxCents}`,
  );
  return `https://www.amazon.com/s?k=${encodeURIComponent(term)}&rh=${rh}&s=review-rank`;
}

/**
 * Fetch a search-results page and parse it into cart-add-ready
 * candidates. Each candidate already carries `offerListingId` + `csrf`
 * from its search-result `<form>`, so the caller can POST directly to
 * `/cart/add-to-cart` without a per-ASIN PDP fetch.
 *
 * Verified live 2026-05-05: a single search response yields ~50 cards
 * with full token sets. The URL filter (`p_85:2470955011, p_36:...`)
 * already restricts to Prime + price-range; we double-check Prime in
 * `extractSearchResultCandidates` for resilience to layout drift.
 *
 * Returns an empty array on any HTTP / parse failure — caller advances
 * to the next term.
 */
async function searchFillerCandidatesViaHttp(
  page: Page,
  term: string,
): Promise<SearchResultCandidate[]> {
  const url = buildFillerSearchUrl(term);
  let res;
  try {
    res = await page.context().request.get(url, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
  } catch {
    return [];
  }
  if (!res.ok()) return [];
  let html: string;
  try {
    html = await res.text();
  } catch {
    return [];
  }
  const doc = new JSDOM(html).window.document;
  const all = extractSearchResultCandidates(doc);
  // URL-level filter `p_6:ATVPDKIKX0DER` biases the results bin toward
  // Amazon-fulfilled offers; we don't gate on buy-box winner === Amazon
  // here because the per-card merchantId hard gate (commit 2f13ee2)
  // empirically dropped ~73% of candidates per term, often leaving the
  // accumulator below FILLER_COUNT and forcing rebuys to checkout with
  // tiny / empty carts. FBA / Seller Fulfilled Prime items still
  // cancel cleanly via Amazon's pre-ship cancel sweep in the vast
  // majority of cases.
  return all.filter((c) => {
    if (!c.isPrime) return false;
    if (c.price === null) return false;
    if (c.price < FILLER_MIN_PRICE) return false;
    if (c.price > FILLER_MAX_PRICE) return false;
    return true;
  });
}

export type PostAddResult =
  | { kind: 'committed'; status: number; tookMs: number }
  | { kind: 'failed'; reason: string; status?: number };

export type AddViaHttpOptions = {
  /**
   * If the caller already loaded the PDP via Playwright (e.g. the target-add
   * path right after `scrapeProduct`), pass `await page.content()` here to
   * skip the duplicate `ctx.request.get(pdpUrl)` round-trip. The post-
   * hydration DOM still carries the `<form id="addToCart">` and its hidden
   * inputs server-side — verified across saved PDP fixtures. On parse miss
   * we fall through to the same failure path as the network path, and the
   * caller's existing Buy-Now-click fallback kicks in.
   */
  prefetchedHtml?: string;
  /**
   * Quantity to commit. Defaults to 1 — that's right for fillers (one of
   * each random item). Single-buy mode passes the value read from the
   * PDP's `#quantity` dropdown via setMaxQuantity, so multi-unit single
   * buys (BG always wants the cap) commit correctly through the HTTP
   * path. Quantities clamped to [1, 99] in the body builder.
   */
  quantity?: number;
};

/**
 * Fully-HTTP add-to-cart: fetch the PDP via `context.request.get`,
 * JSDOM-parse the addToCart form, then POST via `context.request.post`.
 * No tab, no navigation, no JS execution — just two HTTP calls sharing
 * the BrowserContext's cookies and User-Agent.
 *
 * Probed live: SSR PDP HTML carries the form (43 fields) including the
 * `items[0.base][offerListingId]` (~200 chars) and `anti-csrftoken-a2z`
 * (104 chars). The same iterate-all-inputs body builder used by
 * `postFillerAddToCart` works here too, since JSDOM's DOM API matches
 * the browser's at this surface.
 *
 * Headers: cookies + User-Agent come from the BrowserContext. We add
 * Referer/Origin manually because APIRequestContext doesn't auto-attach
 * them like a real form submit would.
 */
export async function addFillerViaHttp(
  page: Page,
  asin: string,
  opts: AddViaHttpOptions = {},
): Promise<PostAddResult> {
  const { prefetchedHtml, quantity } = opts;
  const ctx = page.context();
  const pdpUrl = `https://www.amazon.com/dp/${asin}`;

  async function fetchPdpHtml(): Promise<
    { ok: true; html: string } | { ok: false; reason: string; status?: number }
  > {
    let res;
    try {
      res = await ctx.request.get(pdpUrl, {
        headers: HTTP_BROWSERY_HEADERS,
        timeout: 15_000,
      });
    } catch (err) {
      return { ok: false, reason: 'pdp_fetch_threw:' + String(err).slice(0, 80) };
    }
    if (!res.ok()) {
      return { ok: false, reason: 'pdp_http_error', status: res.status() };
    }
    try {
      return { ok: true, html: await res.text() };
    } catch {
      return { ok: false, reason: 'pdp_body_read_threw' };
    }
  }

  // 1. Try `prefetchedHtml` first (caller-provided, usually `await page.content()`
  //    after scrapeProduct loaded the PDP). If it parses to a valid #addToCart
  //    form we use it directly. If it doesn't — caller's tab navigated away
  //    between scrape and here, e.g. clearCart's click-loop fallback hit /cart
  //    in single-buy mode — we fall through to a fresh `ctx.request.get(pdpUrl)`
  //    instead of failing the whole HTTP add. This makes prefetchedHtml a true
  //    optimization with graceful degradation.
  let pdpHtml: string | null = null;
  if (prefetchedHtml && prefetchedHtml.length > 0) {
    const prefetchedDoc = new JSDOM(prefetchedHtml).window.document;
    if (extractCartAddTokens(prefetchedDoc)) {
      pdpHtml = prefetchedHtml;
    }
  }
  if (pdpHtml === null) {
    const fresh = await fetchPdpHtml();
    if (!fresh.ok) {
      return fresh.status != null
        ? { kind: 'failed', reason: fresh.reason, status: fresh.status }
        : { kind: 'failed', reason: fresh.reason };
    }
    pdpHtml = fresh.html;
  }

  // 2. Harvest only the fields the modern cart-add endpoint requires.
  //    We DON'T POST to the form's declared action (`/gp/product/handle-
  //    buy-box/...`) — that's a deprecated 404'er. The PDP's <form id=
  //    "addToCart"> still carries the tokens we need, but the endpoint
  //    that actually commits items is the same one Amazon's recommendation
  //    carousels POST to (`/cart/add-to-cart/ref=...`), which only wants
  //    csrf + asin + offerListingId + quantity + clientName. Token
  //    extraction is shared with the unit test in fixtures/product/.
  const doc = new JSDOM(pdpHtml).window.document;
  const tokens = extractCartAddTokens(doc);
  if (!tokens) {
    // Distinguish form-missing vs field-missing for log fidelity.
    return {
      kind: 'failed',
      reason: doc.getElementById('addToCart')
        ? 'missing_required_fields'
        : 'no_form',
    };
  }
  const { csrf, offerListingId, asin: itemAsin } = tokens;

  // Clamp quantity to a sane range. Amazon's PDP dropdowns top out at
  // ~30 for most items; >99 is never user-facing. Default to 1 when
  // the caller didn't pass one (fillers, plus any legacy call site).
  const qty = Math.max(1, Math.min(99, Math.round(quantity ?? 1)));

  const body = new URLSearchParams();
  body.append('anti-csrftoken-a2z', csrf);
  body.append('items[0.base][asin]', itemAsin);
  body.append('items[0.base][offerListingId]', offerListingId);
  body.append('items[0.base][quantity]', String(qty));
  body.append('clientName', CART_ADD_CLIENT_NAME);

  // 3. POST to the modern endpoint.
  const t0 = Date.now();
  let postRes;
  try {
    postRes = await ctx.request.post(CART_ADD_URL, {
      headers: {
        ...HTTP_BROWSERY_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: pdpUrl,
        Origin: 'https://www.amazon.com',
      },
      data: body.toString(),
      timeout: 15_000,
    });
  } catch (err) {
    return {
      kind: 'failed',
      reason: 'post_threw:' + String(err).slice(0, 80),
    };
  }
  const tookMs = Date.now() - t0;
  if (!postRes.ok()) {
    return {
      kind: 'failed',
      reason: 'post_http_error',
      status: postRes.status(),
    };
  }
  let respText: string;
  try {
    respText = await postRes.text();
  } catch {
    respText = '';
  }
  if (!looksLikeCartResponse(respText)) {
    return {
      kind: 'failed',
      reason: 'response_not_cart_shape',
      status: postRes.status(),
    };
  }
  // Phantom-commit guard: a successful add MUST echo our ASIN back in
  // the response cart-page HTML. Verified live: 1-of-3 parallel POSTs
  // returned 200 + cart-shape but the response body did NOT contain the
  // ASIN we sent — and a follow-up cart inspection confirmed the item
  // was NOT in the cart. Without this check we'd treat that as a
  // success, the worker's slot counter would never decrement, and we'd
  // proceed with one fewer filler than expected. With it, the worker
  // bails on this ASIN, releases the slot, and tries another one.
  const escapedAsin = itemAsin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const responseHasAsin = new RegExp(`data-asin=["']${escapedAsin}["']`).test(
    respText,
  );
  if (!responseHasAsin) {
    return {
      kind: 'failed',
      reason: 'response_missing_asin',
      status: postRes.status(),
    };
  }
  return { kind: 'committed', status: postRes.status(), tookMs };
}


type FillerOpts = {
  /** Search-term pool. Defaults to the general impulse-item list. */
  terms?: readonly string[];
  /** How many fillers to add before stopping. Defaults to FILLER_COUNT. */
  targetCount?: number;
  /** See BuyWithFillersOptions.attemptedAsins — same Set, passed
   *  through. Used as both the dedup pre-seed and the accumulator
   *  the caller can read after the call. */
  attemptedAsins?: Set<string>;
};

/**
 * Search a few filler terms for cart-add candidates and commit them all
 * in a single batch POST.
 *
 * Why this is so much simpler than the old parallel-worker flow:
 *
 *  - Each Amazon search-result `<form>` already carries
 *    `anti-csrftoken-a2z` + `items[0.base][offerListingId]` +
 *    `items[0.base][asin]` (verified live 2026-05-05). One search HTTP
 *    fetch yields ~50 ready-to-add candidates — no per-ASIN PDP fetch
 *    is required to harvest tokens.
 *  - The `/cart/add-to-cart/...` endpoint accepts an arbitrary number
 *    of `items[N.base][...]` triplets in one POST. Verified live with
 *    8 items: status 200, all 8 in cart, 1.4s total.
 *
 * Net change vs the prior 4-worker, 17-HTTP-call loop:
 *   - 1–3 HTTP search fetches (we usually only need one — most terms
 *     yield enough fresh candidates after dedup).
 *   - 1 batch POST.
 *   - Total: 2–4 HTTP calls instead of ~17.
 *
 * Preserved invariants:
 *   - `targetAsin` is pre-added to `seen` so the picker never picks the
 *     target as a filler.
 *   - `attemptedAsins` is shared across retries; ASINs we've considered
 *     stay considered.
 *   - Phantom-commit guard: the POST response must echo every requested
 *     ASIN's `data-asin="..."`. We return only the subset that actually
 *     landed.
 *   - Partial counts are acceptable — caller decides whether to proceed
 *     with fewer fillers (existing behavior in `step.fillerBuy.fillers.partial`).
 */
async function addFillerItems(
  mainPage: Page,
  targetAsin: string | null,
  cid: string | undefined,
  fillerOpts: FillerOpts = {},
): Promise<{ added: number; asins: string[] }> {
  const targetCount = fillerOpts.targetCount ?? FILLER_COUNT;
  const terms = shuffle(fillerOpts.terms ?? FILLER_SEARCH_TERMS);
  const seen = fillerOpts.attemptedAsins ?? new Set<string>();
  if (targetAsin) seen.add(targetAsin);

  // 1. Walk through search terms until we have enough fresh candidates.
  //    Most of the time one term is enough (~50 results per page; even
  //    after dedup we usually have 30+ fresh candidates).
  const candidates: SearchResultCandidate[] = [];
  let csrf: string | null = null;
  for (const term of terms) {
    if (candidates.length >= targetCount) break;
    const found = await searchFillerCandidatesViaHttp(mainPage, term);
    if (found.length === 0) {
      logger.info('step.fillerBuy.fillers.searchEmpty', { term }, cid);
      continue;
    }
    let added = 0;
    for (const c of found) {
      if (candidates.length >= targetCount) break;
      if (seen.has(c.asin)) continue;
      seen.add(c.asin);
      candidates.push(c);
      added++;
      if (csrf === null) csrf = c.csrf;
    }
    logger.info(
      'step.fillerBuy.fillers.searchHit',
      { term, fresh: added, totalCandidates: candidates.length, of: targetCount },
      cid,
    );
  }

  if (candidates.length === 0 || csrf === null) {
    logger.warn(
      'step.fillerBuy.fillers.noCandidates',
      { termsTried: terms.length, targetCount },
      cid,
    );
    return { added: 0, asins: [] };
  }

  // 2. Single batch POST. Phantom-commit guard runs against the
  //    response body — we count every ASIN that appears as
  //    `data-asin="..."` in the cart-page HTML Amazon returns.
  const items = candidates.map((c) => ({ asin: c.asin, offerListingId: c.offerListingId }));
  const body = buildBatchCartAddBody(csrf, items, { clientName: SEARCH_CART_ADD_CLIENT_NAME });

  const t0 = Date.now();
  let res;
  try {
    res = await mainPage.context().request.post(CART_ADD_URL, {
      headers: {
        ...HTTP_BROWSERY_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.amazon.com',
        Referer: 'https://www.amazon.com/',
      },
      data: body.toString(),
      timeout: 20_000,
    });
  } catch (err) {
    logger.warn(
      'step.fillerBuy.fillers.batch.threw',
      { error: String(err).slice(0, 120), candidates: items.length },
      cid,
    );
    return { added: 0, asins: [] };
  }
  const tookMs = Date.now() - t0;
  if (!res.ok()) {
    logger.warn(
      'step.fillerBuy.fillers.batch.httpError',
      { status: res.status(), candidates: items.length, tookMs },
      cid,
    );
    return { added: 0, asins: [] };
  }
  const respText = await res.text().catch(() => '');
  if (!looksLikeCartResponse(respText)) {
    logger.warn(
      'step.fillerBuy.fillers.batch.shapeMismatch',
      { status: res.status(), candidates: items.length, tookMs },
      cid,
    );
    return { added: 0, asins: [] };
  }
  const committed = asinsCommittedInResponse(
    respText,
    items.map((i) => i.asin),
  );
  logger.info(
    'step.fillerBuy.fillers.batch.ok',
    {
      requested: items.length,
      committed: committed.length,
      tookMs,
      status: res.status(),
    },
    cid,
  );
  return { added: committed.length, asins: committed };
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
