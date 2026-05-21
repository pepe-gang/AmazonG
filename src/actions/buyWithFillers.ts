import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { htmlToDocument } from '../shared/jsdom.js';
import { logger as loggerImport } from '../shared/logger.js';
// Top-level alias so existing call sites in helper functions that don't
// shadow the import (most of the file) keep working — and so `buyWithFillers`
// + tracked helpers can shadow this single binding with a context-bound
// version (see makeBoundLogger).
const logger = loggerImport;
import { cancelFillerOrder } from './cancelFillerOrder.js';
import { clearCart, removeCartItemsByAsin, type ClearCartResult } from './clearCart.js';
import { appendResearchEvent } from '../shared/researchLog.js';
import { recordPlacedOrderEvent } from '../main/placedOrderLedger.js';
import { captureGhostForensic } from '../main/ghostForensics.js';
import { scrapeProduct } from './scrapeProduct.js';
import {
  captureDebugSnapshot,
  detectOrderLikelyPlaced,
  ensureAddress,
  findPlaceOrderLocator,
  pickBestCashbackDelivery,
  probePageDiag,
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
import { resolvePlacedQuantity } from '../shared/quantityResolver.js';
import type { FillerPool } from '../shared/ipc.js';
import {
  BYG_BUTTON_SELECTOR,
  BYG_HEADER_SELECTOR,
  parseOrderConfirmation,
  buildTitlePrefix,
  type CashbackDiag,
} from '../parsers/amazonCheckout.js';
import { isTargetInActiveCart } from '../parsers/amazonCart.js';
import { parsePrice } from '../parsers/amazonProduct.js';
import { parseAsinFromUrl } from '../shared/sanitize.js';
import type { ProductInfo, BGAddress, PaymentCardFill } from '../shared/types.js';
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
   * The account's BG receiving address. When checkout parks on the
   * "Add delivery address" state and this is set, waitForCheckout
   * auto-adds it instead of failing as action_required. Null when the
   * account has no configured BG address.
   */
  bgAddress?: BGAddress | null;
  /**
   * The payment card assigned to this account. When checkout parks on
   * the "Add a credit or debit card" state and this is set,
   * waitForCheckout auto-adds it. Null when no card is assigned.
   */
  paymentCard?: PaymentCardFill | null;
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
   * Per-job override: when true, skip the target-row price-cap check
   * at /spc. The target-existence check still fires (we still refuse
   * to place without the target in cart), but `maxPrice` is treated
   * as POSITIVE_INFINITY for the cap comparison. Surfaced on the BG
   * Trigger panel as "Bypass price check". Default false.
   */
  bypassPriceCheck?: boolean;
  /**
   * Per-job override for the PDP Prime-badge gate. When true,
   * `verifyProductDetailed` is called with `requirePrime: false` —
   * useful when a deal IS Prime-eligible on Amazon but the static
   * parser misreads the badge. Surfaced on the BG Trigger panel as
   * "Bypass Prime check". Default false (the badge is enforced).
   */
  bypassPrimeCheck?: boolean;
  /**
   * Resolver for Amazon's PMTS "Verify your card" challenge — given a
   * card's last 4 digits, returns the full number from the encrypted
   * local vault (or null). Threaded into waitForCheckout so the
   * filler-buy flow auto-handles the challenge too. Omitted = the buy
   * fails with reason "Verify your card" (legacy action_required).
   */
  resolveCardNumber?: (last4: string) => Promise<string | null>;
  /**
   * When true, stop immediately before the final "Place Order" click.
   * All other mutations (cart edits, address swap, BG name toggle) still
   * run — they're intentional — but we skip the one irreversible step
   * so the user can verify the pipeline without spending money.
   */
  dryRun: boolean;
  /**
   * Filler-search-term pool. 'eero' / 'amazon-basics' use narrow
   * brand-specific term lists; 'general' (default) uses the broad
   * impulse mix. Prime + $20–$100 rules unchanged across pools.
   * Undefined / 'general' falls through to the legacy term generator.
   */
  fillerPool?: FillerPool;
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
   * Routing context the disk-log sink uses to land step.fillerBuy.*
   * events on the right per-attempt jsonl file. Without these fields
   * the sink at `main/index.ts:798-815` drops every event silently —
   * see BuyOptions.jobId in buyNow.ts for the long-form rationale.
   * Optional only because tests + standalone scripts can omit them;
   * in production both are always set.
   */
  jobId?: string;
  profile?: string;
  /**
   * Experimental: when true, on a B1 cashback failure (target's
   * shipping group has no "% back" radios at all), run a surgical
   * recovery flow inline:
   *   Phase A — HTTP-delete the non-target items in the bad group,
   *     recreate /spc, re-check cashback. Up to 5 iterations.
   *   Phase B — if Phase A exhausts, HTTP-add a fresh batch of
   *     fillers (not previously seen in any bad group), recreate
   *     /spc, re-check.
   * On exhaustion the buy returns `cashback_gate` failure as today.
   *
   * The CALLER (pollAndScrape) is responsible for skipping the outer
   * 3-attempt retry when this flag is on — when surgical fails here,
   * the buy fails entirely.
   *
   * Research-only data is recorded to
   * `research-logs/cashback-experiments.jsonl` only when
   * `process.env.NODE_ENV === 'development'`. Fire-and-forget; the
   * recording never blocks or affects buy outcome.
   */
  surgicalCashbackRecovery?: boolean;
  /**
   * Order ids the caller already knows are pre-existing on this
   * amazon account (e.g. recently-completed prior buys whose orders
   * may not have propagated to /gp/css/order-history yet). Merged
   * into the pre-buy snapshot set so the post-buy diff filters them
   * out correctly even when Amazon's order-history index hasn't
   * caught up with the most recent prior buy.
   *
   * Fixes the propagation-race bug discovered 2026-05-12: buy A
   * finishes, buy B starts ~5-30s later on the same account, B's
   * pre-snapshot misses A's order (not yet indexed), B's post-snapshot
   * sees it (now indexed), diff falsely attributes A's order to B's
   * filler fan-out. Caller (pollAndScrape) fetches these from the
   * local attempts store via `JobAttemptStore.recentOrderIdsForEmail`.
   */
  recentOrderIds?: string[];
  /**
   * Called immediately before the Place Order click ('placing') and
   * after Amazon's confirmation page parses (null). Used by the
   * worker to flag the narrow critical window where a stop / crash
   * can't be safely auto-retried.
   */
  onStage?: (stage: 'placing' | null) => void | Promise<void>;
  /** Optional debug-snapshot directory. Plumbed through to inner
   *  helpers (notably toggleBGNameAndRetry) so DOM-drift failures can
   *  dump HTML + screenshot + selector probes to disk for offline
   *  inspection. */
  debugDir?: string;
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
      /**
       * Full cart ASIN list at Place Order time (target + all
       * committed fillers). Persisted on the JobAttempt so the verify
       * phase can re-scan order history with the full list and catch
       * filler-only orders that hadn't propagated yet during the
       * buy-time scan. INC-2026-05-10 motivation in JobAttempt's
       * `cartAsins` doc.
       */
      cartAsins: string[];
      /**
       * Pre-buy order-history snapshot — every order id visible on
       * /gp/css/order-history BEFORE this buy's Place Order click. The
       * worker persists this on the JobAttempt so the verify-phase
       * rescan (10 min later) can use snapshot-diff to identify
       * filler-only orders, avoiding the prev-order-bleed bug where
       * the ASIN-walker would falsely match an old order whose target
       * ASIN happened to coincide with one of today's filler ASINs.
       */
      preBuyOrderIds: string[];
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
        | 'checkout_payment'
        | 'cashback_gate'
        | 'place_order'
        | 'confirm_parse'
        // Filler-search rate-limit — every term across the configured
        // pool + fallback pool hit Amazon's meta-refresh stub, so there
        // are no fillers to cart. Mirrors the `filler_search` member of
        // BuyResult.stage in shared/types.ts.
        | 'filler_search';
      reason: string;
      detail?: string;
    };

const BUY_NOW_URL_MATCH = /\/gp\/buy\/|\/checkout\/|\/spc\//i;
const CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

const FILLER_COUNT = 8;
const FILLER_MIN_PRICE = 20;
const FILLER_MAX_PRICE = 100;
// Eero accessories (wall mounts, power adapters, cables) cluster at
// $15–$30. Other pools keep $20 to skip near-$0 filler junk.
const EERO_FILLER_MIN_PRICE = 15;

function priceBandForPool(pool: FillerPool | undefined): { min: number; max: number } {
  return {
    min: pool === 'eero' ? EERO_FILLER_MIN_PRICE : FILLER_MIN_PRICE,
    max: FILLER_MAX_PRICE,
  };
}

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
// Eero (Amazon-owned mesh-WiFi brand). User-curated 2026-05-10 to
// generation-anchored queries — keeps the surface explicitly eero
// (no Echo leakage) while spanning both current product lines.
const EERO_SEARCH_TERMS: readonly string[] = [
  'amazon eero 6',
  'amazon eero 7',
];

// Amazon Basics (house-brand commodities). Single broad term per user
// request. Expand here for more variety if needed.
const AMAZON_BASICS_SEARCH_TERMS: readonly string[] = [
  'amazon basics',
];

/** Resolve the search-term pool for a given fillerPool setting. */
function termsForPool(pool: FillerPool | undefined): readonly string[] | null {
  if (pool === 'eero') return EERO_SEARCH_TERMS;
  if (pool === 'amazon-basics') return AMAZON_BASICS_SEARCH_TERMS;
  // 'general' / undefined → null tells caller to fall through to the
  // existing broad-mix term generator (no pool override).
  return null;
}

/**
 * Global title blocklist — applies regardless of fillerPool. These
 * specific products always cause user pain (returns hassle, attention
 * from Amazon's anti-bot heuristics, etc.) and should never end up in
 * the cart as fillers. Add new entries here; the per-pool list below
 * is for narrower per-context exclusions.
 */
const GLOBAL_FILLER_TITLE_BLOCKLIST: readonly RegExp[] = [
  // 2026-05-10: All Amazon Echo products kept showing up as fillers
  // (Pop, Dot, Show, Studio, Spot, Hub, Auto, etc.). Anchored to
  // "amazon echo" so we catch every Echo line/generation/color
  // without blocking unrelated "echo" products (e.g., echo
  // cancellation microphones). Allows the items through ONLY when
  // they are the explicit buy target — see addFillerItems where
  // targetAsin is pre-seeded into the seen set BEFORE the blocklist
  // runs, so a user buying an Echo deal can still place the order.
  /\bamazon\s+echo\b/i,
  // 2026-05-10 (user request): hard-anchor on the specific Echo
  // product names so cards that drop the "Amazon" brand chip in
  // their title (Layout B variants we've seen in the wild) can't
  // slip through. The brand-chip concat in extractSearchResultCandidates
  // usually produces "Amazon Echo Dot…" which the rule above
  // catches, but Amazon occasionally renders a card without the chip
  // — those titles would read just "Echo Dot…" and bypass the
  // `amazon\s+echo` anchor. These belt-and-suspenders rules close
  // the loop on the two most-leaked variants.
  /\becho\s+dot\b/i,
  /\becho\s+pop\b/i,
];

/**
 * Per-pool title blocklist. Returns true when a candidate's title
 * disqualifies it from the active pool. Amazon's search is loose:
 * "amazon eero" surfaces Echo speakers, Fire TVs, and other
 * Amazon-brand items; we filter those out so the cart only contains
 * actual Eero gear.
 *
 * Always-block rules live in GLOBAL_FILLER_TITLE_BLOCKLIST and are
 * checked first.
 */
function isBlockedByPool(
  pool: FillerPool | undefined,
  title: string | null,
): boolean {
  if (!title) return false;
  // Global block first — applies regardless of pool.
  for (const re of GLOBAL_FILLER_TITLE_BLOCKLIST) {
    if (re.test(title)) return true;
  }
  if (pool === 'eero') {
    // Amazon's loose match for "amazon eero mesh" surfaces non-eero
    // mesh brands (TP-Link, NETGEAR, Tenda, Linksys, etc.). A positive
    // "eero or skip" allowlist handles them in one rule.
    if (!/\beero\b/i.test(title)) return true;
    // Per user request 2026-05-11: exclude eero-branded ethernet
    // cables. They're cheap accessory SKUs that surface in the same
    // search as the routers, but as fillers they don't carry the
    // cart-shape we want (router-priced gear ~$100+).
    if (/\bethernet\s+cable/i.test(title)) return true;
    return false;
  }
  if (pool === 'amazon-basics') {
    // Per user request 2026-05-13: exclude "Amazon Basics Multipurpose
    // Copy Printer Paper" — bulky/heavy item that complicates returns
    // when it ends up bundled in a target order's cancellation chain.
    // Pattern is broad enough to catch other paper variants (Copy
    // Paper / Printer Paper) since they share the same shipping shape.
    if (/\b(?:copy|printer)\s+paper\b/i.test(title)) return true;
    return false;
  }
  return false;
}

// Eero pool yields ~10 candidates per term under the current filters;
// 5 fills cleanly with margin.
const EERO_FILLER_COUNT = 5;

/**
 * Wrap the shared logger so every call auto-merges a context bundle
 * (`jobId`, `profile`) into the data argument. The disk-log sink at
 * `main/index.ts:798-815` routes events to per-attempt jsonl files
 * by these fields; without them the sink drops events silently.
 *
 * Used by `buyWithFillers` and its helpers to shadow the imported
 * `logger` symbol — keeping the existing 50+ `logger.info(msg, data,
 * cid)` call sites unchanged.
 */
type BaseLogger = typeof loggerImport;
function makeBoundLogger(
  base: BaseLogger,
  ctx: Record<string, unknown>,
): BaseLogger {
  const merge = (d?: Record<string, unknown>): Record<string, unknown> => ({
    ...ctx,
    ...(d ?? {}),
  });
  return {
    info: (m, d, cid) => base.info(m, merge(d), cid),
    warn: (m, d, cid) => base.warn(m, merge(d), cid),
    error: (m, d, cid) => base.error(m, merge(d), cid),
    debug: (m, d, cid) => base.debug(m, merge(d), cid),
  };
}

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
  // Routing context for the disk-log sink (main/index.ts:798-815). Without
  // these fields the sink drops every step.fillerBuy.* event silently.
  // Shadow the imported logger with a context-bound version so all 50+
  // existing call sites in this function get the merge for free — no
  // per-site rewrites needed.
  const logCtx: Record<string, unknown> = {};
  if (opts.jobId) logCtx.jobId = opts.jobId;
  if (opts.profile) logCtx.profile = opts.profile;
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const logger = makeBoundLogger(loggerImport, logCtx);
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
  // Bypass: PDP-level price gate runs before /spc. Mirror the worker's
  // outer PDP-verify in pollAndScrape — when the user opted in, null
  // out the cap so verifyProductDetailed skips the price step.
  const fillerEffectiveMaxPrice =
    opts.bypassPriceCheck === true ? null : opts.maxPrice;
  if (opts.bypassPriceCheck === true && opts.maxPrice !== null) {
    logger.info(
      'step.fillerBuy.verify.price.bypass',
      { cap: opts.maxPrice, reason: 'user_opt_in' },
      cid,
    );
  }
  // Bypass: PDP Prime-badge gate. When the user opted in via the BG
  // Trigger panel's "Bypass Prime check", flip requirePrime off so
  // verifyProductDetailed treats `info.isPrime !== true` as a pass.
  // Independent of the price bypass.
  if (opts.bypassPrimeCheck === true) {
    logger.info(
      'step.fillerBuy.verify.prime.bypass',
      { reason: 'user_opt_in' },
      cid,
    );
  }
  const constraints = {
    ...DEFAULT_CONSTRAINTS,
    maxPrice: fillerEffectiveMaxPrice,
    ...(opts.bypassPrimeCheck === true ? { requirePrime: false } : {}),
  };
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
    //
    // Amazon's Chewbacca checkout pipeline (live 2026-05-10+) does
    // aggressive same-domain redirects from /gp/cart/view.html →
    // /checkout/p/… that can fire fast enough to ERR_ABORT even a
    // `waitUntil: 'commit'` goto. Tolerate that by catching the goto
    // error and checking the final URL — anywhere on amazon.com is
    // good enough for the downstream `hasTargetInCart` selector probe
    // to do its work. Only fail when the page didn't navigate at all
    // (still on about:blank or hopped off-domain entirely).
    await page
      .goto(CART_URL, { waitUntil: 'commit', timeout: 30_000 })
      .catch(() => undefined);
    const landed = page.url();
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)?amazon\.com\//i.test(landed)) {
      return {
        ok: false,
        stage: 'cart_verify',
        reason: 'failed to load cart page',
        detail: `landed on ${landed || '(blank)'}`,
      };
    }
    const inCart = await hasTargetInCart(page, targetAsin);
    if (!inCart) {
      // Always-on probe + dev-only HTML snapshot. We landed on
      // amazon.com but `hasTargetInCart` couldn't find the target —
      // could be Amazon dropped the item silently (oos, region-block,
      // qty cap), redirected us to a checkout/spc step, or showed a
      // captcha/signin wall. The probe counts cover all of these.
      const probe = await probePageDiag(page, {
        active_cart: '[data-name="Active Cart"]',
        target_href: `a[href*="/dp/${targetAsin ?? '__none__'}"]`,
        cart_count: '#nav-cart-count, .nav-cart-count',
        empty_cart_heading: '#sc-active-cart h2, .sc-cart-page-message',
        signin_form: 'form#ap_signin_form, input#ap_email',
        captcha: 'form[action*="validateCaptcha"], #captchacharacters',
        spc_marker: 'input[name="placeYourOrder1"]',
        page_headings: 'h1, h2',
      }).catch(() => null);
      logger.warn(
        'step.fillerBuy.cart.targetMissing.probe',
        { targetAsin, url: page.url(), probe },
        cid,
      );
      const snap = await captureDebugSnapshot(
        page,
        opts.debugDir,
        'target_not_in_cart',
      );
      if (snap) {
        logger.info(
          'step.fillerBuy.cart.targetMissing.snapshot',
          { png: snap.pngPath, html: snap.htmlPath },
          cid,
        );
      }
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
  // results to the active mode. Eero uses a smaller target (~5)
  // because the search pool only yields ~10 unique items under the
  // current filters; FILLER_COUNT=8 would guarantee 0-filler buys
  // after a retry exhausts attemptedAsins (INC-2026-05-10).
  // amazon-basics + general stay at the historical fixed count since
  // their search pools are wide enough.
  const poolOverride = termsForPool(opts.fillerPool);
  const fillerTerms = poolOverride ?? FILLER_SEARCH_TERMS;
  const useEeroPool = opts.fillerPool === 'eero';
  const fillerTargetCount = useEeroPool ? EERO_FILLER_COUNT : FILLER_COUNT;
  logger.info(
    'step.fillerBuy.fillers.config',
    {
      pool: opts.fillerPool ?? 'general',
      targetCount: fillerTargetCount,
      preExcludedCount: opts.attemptedAsins?.size ?? 0,
    },
    cid,
  );
  let fillersResult = await addFillerItems(page, targetAsin, cid, {
    terms: fillerTerms,
    targetCount: fillerTargetCount,
    attemptedAsins: opts.attemptedAsins,
    pool: opts.fillerPool,
  }, logCtx);
  // In-attempt pool fallback for narrow pools when Amazon rate-limited
  // every search term. Triggers ONLY when:
  //   1. The configured pool has a fallback mapping (currently only
  //      eero → amazon-basics).
  //   2. The first run added 0 fillers.
  //   3. Every term we tried got hit with the meta-refresh interstitial
  //      (metaRefreshHits === termsTried). Confirms the failure was
  //      rate-limit, not "no candidates" — otherwise switching pools
  //      wouldn't help.
  // Distinct from the outer cashback_gate retry-pool-fallback in
  // runFillerBuyWithRetries — that one runs on a fresh attempt
  // ~60-90s later; this one runs RIGHT NOW so we don't ship a naked
  // cart to /spc on attempt 1.
  const IN_ATTEMPT_FALLBACK: Partial<Record<FillerPool, FillerPool>> = {
    eero: 'amazon-basics',
  };
  if (
    fillersResult.added === 0 &&
    opts.fillerPool &&
    IN_ATTEMPT_FALLBACK[opts.fillerPool] &&
    fillersResult.metaRefreshHits > 0 &&
    fillersResult.metaRefreshHits === fillersResult.termsTried
  ) {
    const fallbackPool = IN_ATTEMPT_FALLBACK[opts.fillerPool]!;
    const fallbackTerms = termsForPool(fallbackPool);
    if (fallbackTerms) {
      logger.warn(
        'step.fillerBuy.fillers.inAttemptFallback',
        {
          originalPool: opts.fillerPool,
          fallbackPool,
          metaRefreshHits: fillersResult.metaRefreshHits,
          termsTried: fillersResult.termsTried,
          reason: 'every search term rate-limited; switching pool within this attempt',
        },
        cid,
      );
      fillersResult = await addFillerItems(page, targetAsin, cid, {
        terms: fallbackTerms,
        targetCount: fillerTargetCount,
        attemptedAsins: opts.attemptedAsins,
        pool: fallbackPool,
      }, logCtx);
    }
  }
  const fillersAdded = fillersResult.added;
  const fillerAsins = fillersResult.asins;
  // Fail-fast on zero fillers. The in-attempt pool fallback above was
  // our one and only retry — if even amazon-basics came back empty,
  // every search term in both pools hit Amazon's meta-refresh stub
  // and there's nothing to ship to /spc but the target item. That's
  // both pointless (filler mode exists to bump cashback) and silently
  // wrong (logs say "filler mode", order has no fillers). Surface a
  // recognizable failure here instead of running the full /spc flow
  // and reporting `cashback_gate` downstream. The outer
  // runFillerBuyWithRetries only retries on `cashback_gate` so this
  // also short-circuits the 3× retry loop the user was seeing.
  if (fillersAdded === 0) {
    logger.warn(
      'step.fillerBuy.fillers.zero',
      {
        fillersRequested: fillerTargetCount,
        termsTried: fillersResult.termsTried,
        metaRefreshHits: fillersResult.metaRefreshHits,
      },
      cid,
    );
    return {
      ok: false,
      stage: 'filler_search',
      reason: 'no_filler_candidates — search rate-limited across all pools',
      detail: `termsTried=${fillersResult.termsTried}, metaRefreshHits=${fillersResult.metaRefreshHits}, pool=${opts.fillerPool ?? 'default'}`,
    };
  }
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

  // 5.5. Pre-buy order-history snapshot. Records every order ID
  //      currently visible on /gp/css/order-history. After Place Order,
  //      step 15's post-buy scan diffs against this set and treats
  //      everything not in it as "this buy's orders" — 100% accurate
  //      even when:
  //        - Amazon adds bundle/freebie items in their own order
  //          (zero cart ASINs in the new card, ASIN-walk would miss it)
  //        - A filler ASIN we re-used was also in a previous order
  //          (ASIN-walk's first-occurrence would falsely match the
  //          old order — the prev-order-bleed bug)
  //      Verified live 2026-05-11 against a real fan-out
  //      (purchaseId 106-1251106-4211436): pre snapshot 10 IDs all
  //      111-XXX, post 12 visible (top 2 = 112-XXX new orders),
  //      diff returned exactly {target order, filler order} with no
  //      false matches even though two old orders ALSO contained the
  //      target ASIN from prior MacBook buys.
  //
  //      Returns null on snapshot failure — `fetchOrderIdsForAsins`
  //      falls back to the legacy ASIN-walk scanner when null.
  const preBuyOrderIds = await snapshotOrderHistoryIds(
    page,
    cid,
    logger,
    opts.recentOrderIds ?? [],
  );

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
  // 'commit' = ~50ms vs ~300ms for DCL. Next op (page.url() check)
  // works at commit; downstream waitForCheckout polls for the Place
  // Order button. Swallow the goto error and decide via landed URL —
  // Amazon's Chewbacca pipeline server-redirects /checkout/entry/cart
  // → /checkout/p/.../spc fast enough to race past 'commit' and throw
  // ERR_ABORTED even though the page actually lands on a valid /spc.
  // Same pattern as the CART_URL goto in the fallback path below and
  // in clearCart.ts:78.
  //
  // 5s timeout (was 30s): the shortcut either commits in <2s or it
  // never will — Amazon doesn't sit on the response. Bail fast and let
  // the URL check route us to the click-based fallback instead of
  // burning 25 extra seconds on a shortcut that's already failed.
  await page
    .goto(SPC_ENTRY_URL, { waitUntil: 'commit', timeout: 5_000 })
    .catch(() => undefined);
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
    // Same redirect-tolerance rationale as cart_verify above —
    // catch the goto error and verify by URL instead of throwing.
    await page
      .goto(CART_URL, { waitUntil: 'commit', timeout: 30_000 })
      .catch(() => undefined);
    {
      const landed = page.url();
      if (!/^https?:\/\/(?:[a-z0-9-]+\.)?amazon\.com\//i.test(landed)) {
        return {
          ok: false,
          stage: 'proceed_checkout',
          reason: 'failed to reload cart before checkout (fallback path)',
          detail: `landed on ${landed || '(blank)'}`,
        };
      }
    }
    const clicked = await clickProceedToCheckout(page);
    if (!clicked) {
      // Always-on probe: when our three known PTC selectors all miss
      // (8s timeout each, ~24s total), we have no idea what the cart
      // page actually shows. Probe a handful of likely candidates so
      // the failure log carries enough signal to narrow DOM drift
      // without needing a captured HTML snapshot.
      const probe = await probePageDiag(page, {
        ptc_input_name: 'input[name="proceedToRetailCheckout"]',
        ptc_buy_box: '#sc-buy-box-ptc-button',
        ptc_buy_box_input: '#sc-buy-box-ptc-button input',
        ptc_alt_buy_now: 'input[name="proceedToCheckout"]',
        active_cart: '[data-name="Active Cart"]',
        empty_cart_heading: '#sc-active-cart h2, .sc-cart-page-message',
        signin_form: 'form#ap_signin_form, input#ap_email',
        captcha: 'form[action*="validateCaptcha"], #captchacharacters',
      }).catch(() => null);
      logger.warn(
        'step.fillerBuy.proceed.fail.probe',
        { url: page.url(), probe },
        cid,
      );
      // Dev-only HTML + PNG capture (gated inside captureDebugSnapshot
      // on NODE_ENV). Production users are unaffected. Lets us collect
      // the actual cart page DOM next time this fires in `npm run dev`.
      const snap = await captureDebugSnapshot(
        page,
        opts.debugDir,
        'proceed_checkout_fail',
      );
      if (snap) {
        logger.info(
          'step.fillerBuy.proceed.fail.snapshot',
          { png: snap.pngPath, html: snap.htmlPath },
          cid,
        );
      }
      return {
        ok: false,
        stage: 'proceed_checkout',
        reason: 'Proceed to Checkout button not found (fallback path)',
        detail: `url=${page.url()}`,
      };
    }
    const transition = await waitForSpcOrHandleByg(page, cid, logCtx, opts.debugDir);
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
    // Plumb debugDir so a checkout-stuck failure (e.g. "Place Order
    // button never appeared") drops an HTML/PNG snapshot on dev runs.
    opts.debugDir,
    {
      step: (m, d) => logger.info(m, d, cid),
      warn: (m, d) => logger.warn(m, d, cid),
    },
    {
      onDeliveryOptionsChanged: async () => {
        const re = await pickBestCashbackDelivery(page, opts.minCashbackPct);
        logger.info(
          'step.fillerBuy.spc.delivery_options_changed.repicked',
          { changes: re.changes },
          cid,
        );
      },
      targetAsin,
      targetTitle: info.title,
      resolveCardNumber: opts.resolveCardNumber,
      bgAddress: opts.bgAddress,
      paymentCard: opts.paymentCard,
    },
  );
  // QLA capped the target row: Amazon reduced our request from N to M.
  // Use M as the cart-add target downstream so the qty reported to BG
  // matches the actual placed qty instead of our original intent.
  let effectiveTargetQuantity = targetQuantity;
  if (ready.ok && typeof ready.adjustedQty === 'number' && ready.adjustedQty > 0) {
    logger.warn(
      'step.fillerBuy.spc.qla.adjusted',
      { from: targetQuantity, to: ready.adjustedQty, targetAsin },
      cid,
    );
    effectiveTargetQuantity = ready.adjustedQty;
  }
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
    // Account has no delivery address — the user must add one to the
    // Amazon account. Surface as checkout_address; the worker maps the
    // "Add delivery address" reason to action_required.
    if (ready.kind === 'no_address') {
      return {
        ok: false,
        stage: 'checkout_address',
        reason: ready.reason,
      };
    }
    // No payment method and no assigned card to auto-add (or the add
    // failed). Surface as checkout_payment → action_required.
    if (ready.kind === 'no_payment') {
      return {
        ok: false,
        stage: 'checkout_payment',
        reason: ready.reason,
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

  // 8. Target-in-/spc HARD GUARD + price check.
  //
  //    Hard guard: target ASIN MUST be visible as a line item on /spc
  //    before we click Place Order. If the target dropped out of cart
  //    between ATC and here (Amazon evicted it, a race in the filler
  //    adds, an out-of-stock flip on Amazon's side, /spc dedup edge
  //    case), placing the order would charge the user for fillers
  //    without the actual target — worst-case outcome. Run this
  //    UNCONDITIONALLY (not gated on price cap) and bail with a clear
  //    stage='cart_verify' on miss. User-reported as a defensive ask
  //    after seeing a buy that worried them.
  //
  //    Price check: layered on top — when a maxPrice cap is set we
  //    also verify the target's line-item price is within it. We
  //    locate the target's row by its product link (/dp/<ASIN>) and
  //    read the price from that row specifically (not the cart max,
  //    because with 12 fillers ≤ $100 a cheap target could be dwarfed
  //    by a pricey filler and falsely trip the cap). When no cap is
  //    set we pass Number.POSITIVE_INFINITY so the existence check
  //    still fires but the price comparison can't fail.
  if (targetAsin) {
    // Bypass: when the user opted in on the BG Trigger panel, neutralize
    // the cap so the target-existence guard still fires but the price
    // comparison can't fail. We don't skip the call entirely — we still
    // need the "is target in cart" hard guard, which is the more
    // important half of this check.
    const capForVerify =
      opts.bypassPriceCheck === true
        ? Number.POSITIVE_INFINITY
        : opts.maxPrice ?? Number.POSITIVE_INFINITY;
    if (opts.bypassPriceCheck === true && opts.maxPrice !== null) {
      logger.info(
        'step.fillerBuy.spc.price.bypass',
        { targetAsin, max: opts.maxPrice, reason: 'user_opt_in' },
        cid,
      );
    }
    const priceCheck = await verifyTargetLineItemPrice(
      page,
      targetAsin,
      info.title,
      capForVerify,
    );
    if (!priceCheck.ok) {
      // Split the failure into target-missing vs price-exceeds because
      // they're meaningfully different — missing target is a hard
      // "do not place" signal, price-exceeds is a routine cap miss.
      const missing = /could not locate target .* in \/spc line items/i.test(
        priceCheck.reason,
      );
      const stage: 'cart_verify' | 'checkout_price' = missing
        ? 'cart_verify'
        : 'checkout_price';
      logger.warn(
        missing
          ? 'step.fillerBuy.spc.target.missing'
          : 'step.fillerBuy.spc.price.fail',
        { targetAsin, cap: opts.maxPrice, reason: priceCheck.reason },
        cid,
      );
      // For the target-missing case the /spc HTML is the only way to
      // tell whether (a) Amazon dropped the item silently, (b) the
      // title we searched for differs from what's rendered, or (c)
      // the testids live outside containers and the title walker
      // didn't find a match. Always-on probe to count what the page
      // has; dev-only HTML+PNG so we can inspect the DOM offline.
      if (missing) {
        const probe = await probePageDiag(page, {
          lineitem_containers: '.lineitem-container',
          line_item_feature: '[data-feature-id*="line-item"]',
          all_testid_spans: '[data-testid^="Item_asin_"]',
          target_href: `a[href*="/dp/${targetAsin}"]`,
          empty_cart_heading: '#sc-active-cart h2, .sc-cart-page-message',
          signin_form: 'form#ap_signin_form, input#ap_email',
          captcha: 'form[action*="validateCaptcha"], #captchacharacters',
        }).catch(() => null);
        logger.warn(
          'step.fillerBuy.spc.target.missing.probe',
          { targetAsin, url: page.url(), probe },
          cid,
        );
        const snap = await captureDebugSnapshot(
          page,
          opts.debugDir,
          'target_missing',
        );
        if (snap) {
          logger.info(
            'step.fillerBuy.spc.target.missing.snapshot',
            { png: snap.pngPath, html: snap.htmlPath },
            cid,
          );
        }
      }
      return {
        ok: false,
        stage,
        reason: missing
          ? `target ${targetAsin} not in /spc cart at place-order time — refusing to checkout without the main item`
          : priceCheck.reason,
        ...(priceCheck.detail ? { detail: priceCheck.detail } : {}),
      };
    }
    logger.info(
      'step.fillerBuy.spc.price.ok',
      { targetAsin, priceText: priceCheck.priceText, price: priceCheck.price },
      cid,
    );
  } else {
    // No target ASIN at all — couldn't parse one from the productUrl.
    // That's a malformed deal; we can't safely run the hard guard.
    logger.warn(
      'step.fillerBuy.spc.target.no_asin',
      {
        targetAsin: null,
        note: 'productUrl had no parseable ASIN — skipping target-in-cart guard',
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
    const addr = await ensureAddress(
      page,
      opts.allowedAddressPrefixes,
      {
        step: (m, d) => logger.info(m, d, cid),
        warn: (m, d) => logger.warn(m, d, cid),
      },
      { bgAddress: opts.bgAddress },
    );
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
        opts.debugDir,
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
        // Experimental: surgical recovery. When the
        // experimental.surgicalCashbackRecovery flag is on AND the
        // failure is B1 (target's group has no "% back" radio at all),
        // try removing the items Amazon co-bundled with the target
        // and/or replacing fillers. Replaces the existing 3-attempt
        // outer retry — caller (pollAndScrape) skips that loop when
        // this flag is on.
        // Two surgical-recoverable modes:
        //  - B1: target's group has no "% back" radio at all → remove
        //    bundle-mates (Phase A) and/or replace fillers (Phase B).
        //  - B3: target's group HAS a "% back" radio but a non-cashback
        //    radio is checked → click the cashback radio (Phase R).
        // Anything else (including B2 — 6% in body but not in scope and
        // legacy retry already gave up) falls through to the legacy
        // cashback_gate fail path.
        const hasDiag = 'diag' in cb && cb.diag !== undefined;
        const isB1 = hasDiag && cb.diag!.scopeMatches.length === 0;
        const isB3 =
          hasDiag &&
          cb.diag!.scopeMatches.length > 0 &&
          !/% back/i.test(cb.diag!.selectedLabel ?? '');
        const surgicalMode: SurgicalMode | null = isB1 ? 'b1' : (isB3 ? 'b3' : null);
        if (opts.surgicalCashbackRecovery === true && surgicalMode !== null) {
          logger.info(
            'step.fillerBuy.surgical.start',
            { targetAsin, observedPct: cb.pct, reason: cb.reason, mode: surgicalMode },
            cid,
          );
          const surgical = await runSurgicalCashbackRecovery(
            page,
            opts,
            info,
            targetAsin,
            fillerAsins,
            opts.attemptedAsins ?? new Set<string>(),
            cb,
            surgicalMode,
            cid,
          );
          if (surgical.ok) {
            logger.info(
              'step.fillerBuy.surgical.ok',
              {
                targetAsin,
                method: surgical.method,
                finalPct: surgical.pct,
                ...surgical.finalState,
              },
              cid,
            );
            cb = { ok: true, pct: surgical.pct, diag: surgical.diag };
          } else {
            logger.warn(
              'step.fillerBuy.surgical.exhausted',
              {
                targetAsin,
                reason: surgical.reason,
                ...surgical.finalState,
              },
              cid,
            );
            return {
              ok: false,
              stage: 'cashback_gate',
              reason: surgical.reason,
            };
          }
        } else {
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
  // Durable ghost-order anchor. Append a `place_order_submitted`
  // breadcrumb to the appendFileSync ledger BEFORE the click — so a
  // placed order has a recoverable record even if the run dies, the
  // machine sleeps, or confirmation never resolves. Written before
  // (not after) the click closes the click-crash window entirely: a
  // breadcrumb with no real order is harmless (reconciliation scans,
  // finds nothing), a missing breadcrumb is the ghost. `cartAsins` +
  // `preBuyOrderIds` let the reconciliation pass run an airtight
  // diff-mode order-history scan with no buy-flow state. The terminal
  // events below carry the same `submissionId` so the pass can pair
  // them. See placedOrderLedger.ts + reconcilePlacedOrders.ts.
  // Full cart ASIN list (target + fillers) — shared by the breadcrumb,
  // the forensic capture, and the post-buy order-history scan below.
  const cartAsins = targetAsin ? [targetAsin, ...fillerAsins] : fillerAsins;
  const submissionId = randomUUID();
  recordPlacedOrderEvent({
    event: 'place_order_submitted',
    submissionId,
    profile: opts.profile ?? '(unknown)',
    jobId: opts.jobId ?? null,
    productUrl: opts.productUrl,
    cartAsins,
    preBuyOrderIds: preBuyOrderIds ?? [],
  });
  // Stamp submissionId into the job-log too, so the .jsonl log and the
  // durable ledger share one correlation key when tracing a ghost.
  logger.info('step.fillerBuy.submission', { submissionId, jobId: opts.jobId ?? null }, cid);
  // Playwright's click() can REJECT while the click still registered —
  // a navigation detaches the element mid-click, or the post-click
  // actionability check races. So the order may be placed even though
  // the click "threw". A throw is therefore NOT a hard failure here:
  // we fall through to the order-history scan below (the real source of
  // truth). If the scan finds this buy's orders the click did place and
  // we recover it; an empty scan returns the retryable place_order
  // failure exactly as before. (#2)
  let clickThrew = false;
  let clickThrewDetail = '';
  try {
    await placeLocator.click({ timeout: 10_000 });
    logger.info('step.fillerBuy.place.clicked', {}, cid);
  } catch (err) {
    clickThrew = true;
    clickThrewDetail = String(err);
    logger.warn(
      'step.fillerBuy.place.click.threw',
      { detail: clickThrewDetail, url: page.url() },
      cid,
    );
  }

  // Dev-only forensic snapshot the instant after the Place Order click,
  // BEFORE waitForConfirmationOrPending — which can hang silently and
  // leave a lone breadcrumb (the cpnduy ghost, 2026-05-18). This is the
  // post-click page state an investigator needs when a ghost dies before
  // ever reaching confirmation.
  await captureGhostForensic(page, submissionId, 'post_click', {
    profile: opts.profile ?? '(unknown)',
    jobId: opts.jobId ?? null,
    cartAsins,
  });

  // 14. Wait for the confirmation page. Reuses the shared helper that
  //     also handles Amazon's "This is a pending order — place again?"
  //     interstitial AND the "Your delivery options have changed…"
  //     banner (which wipes our radio pick; the callback re-picks
  //     before the helper re-clicks Place Order, 1 attempt).
  //     60s overall deadline inside the helper.
  // When the click threw, the page state is uncertain — a 60s
  // confirmation wait is pointless. Skip it and go straight to the
  // order-history scan, treating it as "outcome unknown" (the same
  // path as a confirmation timeout with no on-page signal).
  const confirmWait = clickThrew
    ? null
    : await waitForConfirmationOrPending(
        page,
        (m, d) => logger.info(m, d, cid),
        {
          onDeliveryOptionsChanged: async () => {
            const re = await pickBestCashbackDelivery(
              page,
              opts.minCashbackPct,
            );
            logger.info(
              'step.fillerBuy.place.delivery_options_changed.repicked',
              { changes: re.changes },
              cid,
            );
            await page.waitForTimeout(1_000);
          },
        },
      );
  let recoveredFromConfirmTimeout = false;
  // Set when the confirmation page timed out AND detectOrderLikelyPlaced
  // found no place-order signal on the page. We no longer bail as
  // confirm_parse right here — the order-history scan below is the real
  // source of truth. If that scan finds orders carrying our cart ASINs,
  // the order DID place (the detector was wrong), and we recover it so
  // the filler-cancel sweep gets the order IDs it needs. Bailing here
  // instead left the ~8 filler orders live and untracked — the verify
  // phase had no cartAsins/orderIds to cancel them with, so they shipped.
  // An empty scan keeps the old behavior: return confirm_parse.
  let confirmTimedOutNoSignal = false;
  let confirmFailReason: string | null = null;
  if (clickThrew) {
    // Click outcome unknown — let the order-history scan decide.
    recoveredFromConfirmTimeout = true;
    confirmTimedOutNoSignal = true;
    confirmFailReason = `place order click threw: ${clickThrewDetail}`;
  } else if (confirmWait && !confirmWait.ok) {
    confirmFailReason = confirmWait.reason;
    const placed = await detectOrderLikelyPlaced(page);
    recoveredFromConfirmTimeout = true;
    confirmTimedOutNoSignal = !placed.likelyPlaced;
    logger.warn(
      'step.fillerBuy.confirm.timeout.recovering',
      {
        reason: confirmWait.reason,
        url: page.url(),
        signal: placed.reason,
        likelyPlaced: placed.likelyPlaced,
        note: confirmTimedOutNoSignal
          ? 'no place-order signal — order-history scan will confirm or reject'
          : 'place-order signal present',
      },
      cid,
    );
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

  // DURABLE LEDGER. The confirmation page is up — a real order IS
  // placed on Amazon. Append it synchronously NOW, before orderId
  // capture or any reporting, so the placement survives every
  // downstream failure mode (debounce loss, missing attempt row,
  // crash, restart). See placedOrderLedger.ts.
  //
  // Skipped when confirmTimedOutNoSignal — placement is still
  // unconfirmed there. The post-scan block below ledgers it only if
  // the order-history scan actually finds the order.
  if (!confirmTimedOutNoSignal) {
    recordPlacedOrderEvent({
      event: 'order_confirmed',
      submissionId,
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      productUrl: opts.productUrl,
      url: page.url(),
      amazonPurchaseId,
      ...(recoveredFromConfirmTimeout
        ? { detail: 'recovered after confirmation-URL timeout' }
        : {}),
    });
  }

  // Dev-only forensic snapshot of the confirmation / post-place page,
  // keyed by submissionId — the artifact an investigator needs when a
  // ghost is traced back from an order id.
  await captureGhostForensic(
    page,
    submissionId,
    confirmTimedOutNoSignal ? 'confirm_timeout' : 'confirmation',
    {
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      cartAsins,
      amazonPurchaseId,
    },
  );

  // Parse the confirmation page for `finalPrice` + `finalPriceText`.
  // NOTE: we intentionally ignore the orderId parsed here — Amazon's
  // confirmation body can contain stale ids in "Recommended for you"
  // sections that false-match our regex. The canonical order id comes
  // from /gp/css/order-history in Step 15 (next slice).
  const confirmationHtml = await page.content().catch(() => '');
  const parsed = confirmationHtml
    ? parseOrderConfirmation(
        htmlToDocument(confirmationHtml),
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
  let orderMatches: OrderMatch[] =
    cartAsins.length > 0
      ? await fetchOrderIdsForAsins(page, cartAsins, targetAsin, preBuyOrderIds)
      : [];
  // The order IS placed at this point — either confirmWait.ok or the
  // confirmation-timeout recovery above gated us here.
  // An empty scan almost always means Amazon's order-history
  // propagation lagged past fetchOrderIdsForAsins' internal 15s poll
  // budget (not that the order doesn't exist). Shipping orderId=null
  // here is the root of the "ghost order" bug — the placed order
  // becomes untraceable. Give it ONE more full pass after an 8s
  // settle before we accept "unknown".
  if (orderMatches.length === 0 && cartAsins.length > 0) {
    logger.warn(
      'step.fillerBuy.placed.orderid.retry',
      {
        targetAsin,
        cartAsinsCount: cartAsins.length,
        note: 'first post-buy scan empty — re-scanning order history after an 8s settle',
      },
      cid,
    );
    await page.waitForTimeout(8_000);
    orderMatches = await fetchOrderIdsForAsins(
      page,
      cartAsins,
      targetAsin,
      preBuyOrderIds,
    );
  }
  const orderId =
    targetAsin !== null
      ? orderMatches.find((m) => m.matchedAsins.includes(targetAsin))?.orderId ??
        null
      : orderMatches[0]?.orderId ?? null;

  // Durable ledger: record the capture outcome so the ledger line can
  // be diffed against job-attempts.json / BG to localize a ghost.
  recordPlacedOrderEvent({
    event: orderId ? 'orderid_captured' : 'orderid_missing',
    submissionId,
    profile: opts.profile ?? '(unknown)',
    jobId: opts.jobId ?? null,
    productUrl: opts.productUrl,
    orderId,
    amazonPurchaseId,
    // CB + price so a ghost-recovery pass (reconcileLedger →
    // /recover-order) can populate the BG purchase row instead of
    // leaving CB/Profit "—".
    placedCashbackPct: targetCashbackPct,
    placedPrice: parsed.finalPriceText ?? null,
    ...(orderMatches.length > 0
      ? { detail: `orderIds=${orderMatches.map((m) => m.orderId).join(',')}` }
      : {}),
  });

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
  } else {
    // Coverage telemetry — INC-2026-05-10 (purchaseId
    // 106-0543366-6065024) had partial coverage (target order matched,
    // filler-only order 114-4485329-7352228 missed) which then meant
    // the filler-only order shipped untouched. Log so future cases are
    // visible in the dashboard before they ship.
    const matchedAsinSet = new Set<string>();
    for (const m of orderMatches) for (const a of m.matchedAsins) matchedAsinSet.add(a);
    const coveredCount = matchedAsinSet.size;
    if (coveredCount < cartAsins.length) {
      logger.warn(
        'step.fillerBuy.placed.orderid.partial',
        {
          targetAsin,
          cartAsinsCount: cartAsins.length,
          coveredCount,
          missingAsins: cartAsins.filter((a) => !matchedAsinSet.has(a)),
          orderIdsFound: orderMatches.map((m) => m.orderId),
          note: 'verify-side rescan should fill the gap',
        },
        cid,
      );
    } else {
      logger.info(
        'step.fillerBuy.placed.orderid.full',
        {
          targetAsin,
          cartAsinsCount: cartAsins.length,
          orderIdsFound: orderMatches.map((m) => m.orderId),
        },
        cid,
      );
    }
  }

  // Outcome was unknown (confirmation timed out with no on-page signal,
  // OR the click threw) AND the order-history scan matched none of our
  // cart ASINs — the order genuinely did not place. Return the failure
  // we deferred above. (When the scan DID find orders we fall through:
  // the order placed despite the uncertainty, and the filler-cancel
  // sweep below now has the order IDs it needs.)
  //   - click threw  → place_order (retryable — a fresh attempt may click cleanly)
  //   - confirm timeout → confirm_parse (non-retryable — a retry risks a dup)
  if (confirmTimedOutNoSignal && orderMatches.length === 0) {
    logger.warn(
      clickThrew
        ? 'step.fillerBuy.place.click.threw.not_placed'
        : 'step.fillerBuy.confirm.timeout.not_placed',
      { reason: confirmFailReason, url: page.url() },
      cid,
    );
    // Reconcile the place_order_submitted breadcrumb as abandoned. The
    // outcome was unknown AND the order-history scan (with retry) matched
    // none of our cart ASINs — the order positively did not place. Write
    // a terminal reconcile_abandoned so the breadcrumb pairs off; without
    // it the breadcrumb stays unreconciled forever and the reconciliation
    // pass keeps flagging it as a ghost candidate — a false ghost.
    recordPlacedOrderEvent({
      event: 'reconcile_abandoned',
      submissionId,
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      detail: clickThrew
        ? 'click threw + order-history scan empty — order did not place'
        : 'confirmation timeout + order-history scan empty — order did not place',
    });
    return {
      ok: false,
      stage: clickThrew ? 'place_order' : 'confirm_parse',
      reason:
        confirmFailReason ??
        (clickThrew
          ? 'Place Order click threw and no order was placed'
          : 'confirmation page never loaded'),
      detail: `url=${page.url()}`,
    };
  }
  if (confirmTimedOutNoSignal) {
    // Scan found orders despite the uncertain outcome — the order
    // placed and the detector / click-throw masked it. Ledger the
    // placement now (the synchronous write above was skipped while it
    // was still unconfirmed).
    logger.warn(
      'step.fillerBuy.confirm.timeout.recovered_by_scan',
      {
        url: page.url(),
        via: clickThrew ? 'click_threw' : 'confirm_timeout',
        orderIdsFound: orderMatches.map((m) => m.orderId),
      },
      cid,
    );
    recordPlacedOrderEvent({
      event: 'order_confirmed',
      submissionId,
      profile: opts.profile ?? '(unknown)',
      jobId: opts.jobId ?? null,
      productUrl: opts.productUrl,
      url: page.url(),
      amazonPurchaseId,
      placedCashbackPct: targetCashbackPct,
      placedPrice: parsed.finalPriceText ?? null,
      detail: clickThrew
        ? 'recovered via order-history scan after the Place Order click threw'
        : 'recovered via order-history scan after confirmation-URL timeout (no on-page signal)',
    });
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
  // Sanity check: if the post-buy result has implausibly many "non-
  // target" orders, the pre-buy snapshot probably failed to capture
  // the historical baseline and the diff is treating everything as
  // new. Refuse to claim those as fillers — better to miss a real
  // filler (verify-time rescan picks it up) than to cancel a
  // historical customer order. Threshold is cartAsins.length + 2:
  // Amazon's worst-case fan-out is 1 order per cart item + ~1
  // freebie order; anything beyond that means the diff is wrong.
  //
  // Logged incident 2026-05-11 (cmp1ng5p60004pl746onbynhv,
  // amycpnguyen2): snapshot.empty fired → diff returned 10 "new"
  // orders → 8 false-positive fillers entered the cancel queue,
  // some real customer orders got cancel-summary URLs returned. The
  // snapshot.empty bug is fixed at the source above (the wait
  // predicate now requires `.order-card` to be present), but this
  // sanity net catches any future pre-set corruption regardless.
  const candidateFillerIds = targetAsin
    ? orderMatches
        .filter((m) => !m.matchedAsins.includes(targetAsin))
        .map((m) => m.orderId)
    : [];
  const SANITY_FILLER_MAX = cartAsins.length + 2;
  let fillerOrderIds: string[];
  if (candidateFillerIds.length > SANITY_FILLER_MAX) {
    logger.warn(
      'step.fillerBuy.placed.orderid.sanity_failed',
      {
        targetAsin,
        cartAsinsCount: cartAsins.length,
        candidateCount: candidateFillerIds.length,
        threshold: SANITY_FILLER_MAX,
        preBuySnapshotLen: preBuyOrderIds?.length ?? null,
        discardedOrderIds: candidateFillerIds,
        note:
          'too many non-target orders for this cart size — pre-snapshot ' +
          'likely failed to capture historical baseline. Dropping filler ' +
          'claims; verify-time rescan will recover any real misses.',
      },
      cid,
    );
    fillerOrderIds = [];
  } else {
    fillerOrderIds = candidateFillerIds;
  }
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

  // Resolve buy-time qty. Best-effort — verify phase re-reads from
  // order-details and submits `correctPurchasedCount` if it differs.
  // Confirmation-page badge dropped 2026-05-11 (was returning a
  // shipping-group's item count, not the target's qty).
  const qtyResolution = resolvePlacedQuantity({
    fromSpcDom: placedQuantity,
    fromCartAddTarget: effectiveTargetQuantity,
  });
  const finalPlacedQuantity = qtyResolution.quantity;
  if (qtyResolution.warn === 'spc_disagrees') {
    logger.warn(
      'step.fillerBuy.qty.mismatch',
      {
        fromSpc: placedQuantity,
        targetQuantity,
        note: 'using /spc DOM read; verify phase will correct if order-details disagrees',
      },
      cid,
    );
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
      placedQuantity: finalPlacedQuantity,
      placedQuantityFromSpc: placedQuantity,
      fillersAdded,
    },
    cid,
  );

  return {
    ok: true,
    stage: 'placed',
    ...successBase,
    placedQuantity: finalPlacedQuantity, // ← override successBase's /spc value
    amazonPurchaseId,
    orderId,
    orderIds: orderMatches,
    fillerOrderIds,
    cartAsins,
    // Snapshot from step 5.5 — empty array fallback if snapshot
    // capture returned null (still safe; verify rescan will see []
    // and fall back to the ASIN-walker the same as today).
    preBuyOrderIds: preBuyOrderIds ?? [],
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
 *
 * After the primary ASIN appears we POLL FOR FULL COVERAGE: Amazon's
 * fanout often commits the target order ~1-3s before any filler-only
 * orders propagate. Without this loop, we scan once after the target
 * lands, miss the still-propagating filler-only orders, and report
 * incomplete `fillerOrderIds` to BG — which means no `FillerCancelTask`
 * is ever created for those orders, and they ship untouched.
 *
 * INC-2026-05-10 (purchaseId 106-0543366-6065024): Amazon cancelled the
 * target on order 114-8746903-8263417, but a separate filler-only order
 * 114-4485329-7352228 was missing from buy-time `fillerOrderIds`
 * because our scan ran before that order propagated. Verify-side
 * `cancelFillerOrdersOnly` then ran against an empty list and the
 * fillers shipped.
 *
 * The polling reloads the history page (Amazon SSRs the order list,
 * so client-side polling alone won't see new orders) every ~800ms
 * until either every cart ASIN is matched OR the budget expires.
 * Best-coverage result wins across iterations so a flaky reload
 * doesn't regress earlier matches.
 */
/**
 * Snapshot every order ID currently visible on /gp/css/order-history.
 * Captured BEFORE Place Order so that step 15's post-buy scan can
 * compute `post - pre = this buy's fan-out` with 100% accuracy —
 * regardless of whether Amazon strips/swaps cart items, adds bundle
 * freebies, or whether a filler ASIN we re-used appears in a previous
 * order.
 *
 * Validated live 2026-05-11 against a real fan-out (purchaseId
 * 106-1251106-4211436): pre snapshot = 10 IDs all 111-XXX. After Place
 * Order, post = 12 distinct IDs visible (top 2 = 112-XXX new orders,
 * 10 old, 2 fell off the page). Diff returned exactly
 * `{112-8592597-3848244 (target), 112-8275660-6027465 (filler)}` even
 * though two old orders in post ALSO contained the target's ASIN from
 * prior MacBook buys — those were correctly filtered out by being
 * present in pre.
 *
 * Returns null on navigation failure or empty page. Caller falls back
 * to the legacy ASIN-walker; degraded behavior but doesn't fail the
 * buy.
 */
async function snapshotOrderHistoryIds(
  page: Page,
  cid: string | undefined,
  logger: ReturnType<typeof makeBoundLogger>,
  recentOrderIds: readonly string[] = [],
): Promise<string[] | null> {
  try {
    await page.goto(
      'https://www.amazon.com/gp/css/order-history?ref_=nav_AccountFlyout_orders',
      { waitUntil: 'commit', timeout: 30_000 },
    );
  } catch (err) {
    logger.warn(
      'step.fillerBuy.preBuy.snapshot.nav.failed',
      { error: String(err) },
      cid,
    );
    return null;
  }
  // CRITICAL: the previous wait fired the moment the FIRST card
  // rendered (count > 0 + no encrypted ones). On a slow page paint
  // we'd snapshot just that 1 card before the other 9 had painted —
  // baseline of 1 ID, post-buy diff treats every other order as new,
  // sanity check fires and drops ALL filler claims (or worse, if it
  // doesn't fire, false-positive cancel attempts on historical
  // real-customer orders). User-reported: cpnnick's snapshot
  // returned just 114-4284636-9153864 on multiple buys today.
  //
  // New gate: require card count STABILITY. Wait for the count to
  // stop changing for 2s before accepting. Adapts to whatever the
  // account has — a brand-new account with 0 orders still finishes
  // the 10s wait empty (the existing `ids.length === 0 → null` path
  // below handles that); an established account waits patiently
  // until all visible cards have painted. Polling at 300ms × 2s
  // stability = ~7 consecutive same-count checks.
  //
  // Logged incident 2026-05-11 attempt cmp1ng5p60004pl746onbynhv on
  // amycpnguyen2: original snapshot.empty fired, post-buy scan
  // returned 10 orders, 8 false-positive fillers entered the cancel
  // queue. The non-empty-but-too-short failure mode (1 ID instead of
  // 10) on cpnnick today is the same problem one layer deeper.
  await page
    .waitForFunction(
      () => {
        const cards = document.querySelectorAll('.order-card.js-order-card').length;
        const encrypted = document.querySelectorAll('.csd-encrypted-sensitive').length;
        if (encrypted !== 0) return false;
        if (cards === 0) return false;
        // Stash count + first-stable timestamp on window so consecutive
        // polls can see whether the count has settled. Cleared on each
        // navigation (window is recreated).
        const w = window as Window & {
          __agSnapLast?: number;
          __agSnapSince?: number;
        };
        const now = Date.now();
        if (w.__agSnapLast !== cards) {
          w.__agSnapLast = cards;
          w.__agSnapSince = now;
          return false;
        }
        return now - (w.__agSnapSince ?? now) >= 2_000;
      },
      undefined,
      { timeout: 10_000, polling: 300 },
    )
    .catch(() => undefined);

  const ids = await page
    .evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>('.order-card.js-order-card'),
      );
      const out: string[] = [];
      const seen = new Set<string>();
      for (const card of cards) {
        const m = (card.textContent ?? '').match(/\b(\d{3}-\d{7}-\d{7})\b/);
        const id = m?.[1];
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      return out;
    })
    .catch(() => null);

  if (ids === null) {
    logger.warn('step.fillerBuy.preBuy.snapshot.eval.failed', {}, cid);
    return null;
  }
  if (ids.length === 0) {
    // After the wait above, 0 IDs means either (a) genuine brand-new
    // account with no order history, or (b) the page rendered
    // something unexpected (sign-in redirect, captcha, error). Either
    // way return null — refuse to use diff mode. Legacy ASIN-walker
    // is safer than risking a "diff = all of post" cancel storm.
    logger.warn('step.fillerBuy.preBuy.snapshot.empty', {}, cid);
    return null;
  }
  // Union scanned IDs with locally-known recent orderIds. The seed
  // covers Amazon's order-history propagation lag: a buy that just
  // finished may not yet be in the rendered list, but its orderId
  // lives in the local attempts store and we want it in the pre-set
  // so the post-buy diff doesn't false-attribute it. See the
  // recentOrderIds docstring in BuyWithFillersOptions for the race.
  const seedAdded = recentOrderIds.filter((rid) => !ids.includes(rid));
  if (seedAdded.length > 0) {
    ids.push(...seedAdded);
    logger.info(
      'step.fillerBuy.preBuy.snapshot.seed_added',
      { seedAddedLen: seedAdded.length, sample: seedAdded.slice(0, 3) },
      cid,
    );
  }
  logger.info(
    'step.fillerBuy.preBuy.snapshot.ok',
    { idsLen: ids.length, sample: ids.slice(0, 3) },
    cid,
  );
  return ids;
}

async function fetchOrderIdsForAsins(
  page: Page,
  asins: string[],
  primaryAsin: string | null,
  preBuyOrderIds: string[] | null,
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

  // Wait until the order-history page has decrypted EVERY visible
  // order card AND the just-placed order has propagated. Two
  // independent waits combined into one predicate:
  //
  //   (a) `csd-encrypted-sensitive` count = 0  → Siege fully done.
  //       Catches the "mid-decrypt, only top card decrypted" race
  //       (INC-2026-05-10, DL-05260034, lost 114-3440494-2197804).
  //
  //   (b) An `a[href*="/dp/<primaryAsin>"]` exists inside an actual
  //       order card → the target order has propagated. Catches
  //       the "Siege done but new order isn't even rendered yet"
  //       race observed 2026-05-10 19:39 in a real buy log:
  //         "step.fillerBuy.placed.orderid.notfound"
  //         "cartAsinsCount":1  "fillerOrderIds":[]
  //       Cause: Place Order had just finished → /spc → goto
  //       /gp/css/order-history fired BEFORE Amazon's order-history
  //       page rendered the brand-new order, so Siege completed on
  //       N stale cards while the new one was missing entirely.
  //       The /dp link is scoped to ".order-card" elements (not
  //       page-chrome carousels like "Buy it again", which would
  //       false-positive otherwise).
  //
  // When primaryAsin is null (rare; only on single-buy fallbacks),
  // skip the (b) clause — the (a) clause alone is the legacy
  // behavior. Bounded at 15s total either way; the inner
  // reload-poll loop downstream has its own retry budget.
  await page
    .waitForFunction(
      (asin) => {
        if (document.querySelectorAll('.csd-encrypted-sensitive').length !== 0) {
          return false;
        }
        if (!asin) return true;
        // Scope the /dp/ check to .order-card to avoid matching the
        // right-rail "Buy it again" carousel — those /dp/<asin>
        // links exist in static page chrome and would satisfy the
        // wait before any order had actually propagated.
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
      primaryAsin,
      { timeout: 15_000, polling: 500 },
    )
    .catch(() => undefined);

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
    .evaluate(scanOrderHistoryDOMFn, { asinList: asins, preBuyOrderIds })
    .catch(() => [] as OrderMatch[]);

  // Poll for fuller coverage. The initial scan often catches only the
  // target order (which propagates first); filler-only orders may still
  // be settling on Amazon's side. Reload + re-scan every ~800ms until
  // good enough OR budget expires (~5s). Best-result wins across
  // iterations so a flaky reload doesn't regress earlier matches.
  //
  // "Good enough" depends on mode:
  //   - DIFF mode (preBuyOrderIds provided): keep polling until we've
  //     seen at least `asins.length` new orders OR all cart ASINs are
  //     accounted for. Typical case: cart has N items, fan-out is 1-N
  //     orders; once we've found N new orders the diff is settled.
  //   - LEGACY mode: keep polling until every cart ASIN is matched.
  const countCovered = (matches: OrderMatch[]): number => {
    if (preBuyOrderIds !== null) {
      // Diff mode: each entry is a distinct new order. Coverage is the
      // count of new orders found. Once we hit asins.length new orders
      // (one per item, the most fanned-out case), stop polling.
      return matches.length;
    }
    // Legacy mode: coverage = number of distinct cart ASINs matched.
    const seen = new Set<string>();
    for (const m of matches) for (const a of m.matchedAsins) seen.add(a);
    return seen.size;
  };
  let best = raw;
  let bestCovered = countCovered(best);
  const COVERAGE_BUDGET_MS = 5_000;
  const POLL_INTERVAL_MS = 800;
  const deadline = Date.now() + COVERAGE_BUDGET_MS;
  while (bestCovered < asins.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      await page.reload({ waitUntil: 'commit', timeout: 15_000 });
    } catch {
      // Reload flake — try the next iteration with the same DOM.
    }
    // Wait for Siege done AND target's /dp/ link present inside an
    // order card. Same combined predicate as the initial wait —
    // see comment above for the two races this catches. Tighter
    // 3s budget per iteration since the outer poll loop already
    // has 5s total.
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
        primaryAsin,
        { timeout: 3_000, polling: 300 },
      )
      .catch(() => undefined);
    const next = await page
      .evaluate(scanOrderHistoryDOMFn, { asinList: asins, preBuyOrderIds })
      .catch(() => [] as OrderMatch[]);
    const nextCovered = countCovered(next);
    if (nextCovered > bestCovered) {
      best = next;
      bestCovered = nextCovered;
    }
  }
  return best;
}

/**
 * Document-walker eval extracted as a named function so the polling
 * loop in fetchOrderIdsForAsins can re-run it on each reload without
 * duplicating the body.
 *
 * Two modes:
 *
 *   DIFF MODE (preBuyOrderIds !== null): walk `.order-card.js-order-card`
 *     elements, return any card whose order ID is NOT in the pre-buy
 *     snapshot. Those are guaranteed to be this buy's fan-out. For each
 *     new card, also return the intersection of its /dp/ links with
 *     the cart ASIN list so the caller can identify target vs filler.
 *     Mathematically clean — no false positives from previous orders
 *     even when filler ASINs were re-used. This is the normal path.
 *
 *   LEGACY MODE (preBuyOrderIds === null): document-order walker with
 *     first-occurrence-per-ASIN. Used as a safety net by
 *     `rescanFillerOrderIds` (verify-time, no snapshot available) and
 *     as a fallback when the pre-buy snapshot navigation failed.
 *     Same algorithm as the inlined version above — see that comment
 *     block for the why.
 */
const scanOrderHistoryDOMFn = ({
  asinList,
  preBuyOrderIds,
}: {
  asinList: string[];
  preBuyOrderIds: string[] | null;
}) => {
  if (preBuyOrderIds !== null) {
    const preSet = new Set(preBuyOrderIds);
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('.order-card.js-order-card'),
    );
    const out: { orderId: string; matchedAsins: string[] }[] = [];
    for (const card of cards) {
      const m = (card.textContent ?? '').match(/\b(\d{3}-\d{7}-\d{7})\b/);
      const orderId = m?.[1];
      if (!orderId || preSet.has(orderId)) continue;
      const cardAsins = new Set<string>();
      const links = card.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      );
      for (const a of Array.from(links)) {
        const am = (a.getAttribute('href') ?? '').match(
          /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
        );
        const asin = am?.[1];
        if (asin && asinList.includes(asin)) cardAsins.add(asin);
      }
      out.push({ orderId, matchedAsins: Array.from(cardAsins) });
    }
    return out;
  }

  // Legacy ASIN-walker fallback.
  type Event = { kind: 'id'; id: string } | { kind: 'link'; asin: string };
  const events: Event[] = [];

  const linkNodes = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/dp/"], a[href*="/gp/product/"]',
    ),
  );
  const linkAsin = (href: string): string | null => {
    const m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m?.[1] ?? null;
  };
  const linkToAsin = new Map<HTMLAnchorElement, string>();
  for (const a of linkNodes) {
    const asin = linkAsin(a.getAttribute('href') || '');
    if (asin) linkToAsin.set(a, asin);
  }

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
  n = walker.nextNode();
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent ?? '').trim();
      if (text) {
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

  const matchedByOrder = new Map<string, Set<string>>();
  for (const [asin, orderId] of asinToFirstOrder) {
    if (!matchedByOrder.has(orderId)) matchedByOrder.set(orderId, new Set<string>());
    matchedByOrder.get(orderId)!.add(asin);
  }

  // Capture top-of-history order IDs the ASIN-walk missed. When Amazon
  // adds bundle/freebie items in their own shipment, the resulting
  // filler-only order contains zero cartAsins and falls out of the
  // ASIN-walk results (real case 2026-05-11 on cpnnhu, purchaseId
  // 106-8052632-4781854: target order 114-3299436-7172244 captured,
  // separate filler order 114-2185017-2556240 missed because its items
  // weren't in our cart). Order-history is reverse-chronological and
  // the bot reached it within seconds of clicking Place Order, so this
  // buy's fan-out is the cluster at positions 0..maxMatchedIdx.
  // Anything UNMATCHED inside that cluster is a freebie/bundle order
  // that belongs to this buy. Cards below maxMatchedIdx are older —
  // never grab those (would falsely cancel historical orders).
  //
  // Only runs when we have >=2 ASINs in cartAsins (i.e., we actually
  // added fillers). Pure single-buy has no fan-out and a single ASIN
  // can't be split into multiple cards, so historical "Buy it again"
  // would slip in otherwise.
  if (asinList.length >= 2) {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('.order-card.js-order-card'),
    );
    const cardOrderId = (card: HTMLElement): string | null => {
      const m = (card.textContent ?? '').match(/\b(\d{3}-\d{7}-\d{7})\b/);
      return m?.[1] ?? null;
    };
    let maxMatchedIdx = -1;
    for (let i = 0; i < cards.length; i++) {
      const id = cardOrderId(cards[i]!);
      if (id && matchedByOrder.has(id)) maxMatchedIdx = i;
    }
    if (maxMatchedIdx >= 0) {
      // +1 buffer below the deepest match — Amazon's order-history sort
      // for orders placed in the same millisecond isn't strictly
      // chronological, so a freebie order from this buy can land just
      // below the matched ones. Risk is bounded: at most one
      // non-fan-out card slips in, the existing cancelFillerOrder logic
      // is best-effort and returns terminal if it can't cancel.
      const endIdx = Math.min(maxMatchedIdx + 1, cards.length - 1);
      for (let i = 0; i <= endIdx; i++) {
        const id = cardOrderId(cards[i]!);
        if (!id || matchedByOrder.has(id)) continue;
        matchedByOrder.set(id, new Set<string>());
      }
    }
  }

  const out: { orderId: string; matchedAsins: string[] }[] = [];
  for (const [orderId, asinSet] of matchedByOrder) {
    out.push({ orderId, matchedAsins: Array.from(asinSet) });
  }
  return out;
};

/**
 * Verify-time safety net for INC-2026-05-10: re-scans order history
 * with the persisted full cart ASIN list and returns the orderIds that
 * are NOT the target. By verify time (~10 min after buy), Amazon's
 * fanout has fully propagated, so any filler-only orders missed at
 * buy time will now show up. Caller diffs against the buy-time
 * `fillerOrderIds` to identify newly-found orders.
 *
 * Reuses `scanOrderHistoryDOMFn`. No polling here — it's been long
 * enough that one scan is sufficient. Returns empty on navigation /
 * eval failures (best-effort safety net; verify still completes).
 */
export async function rescanFillerOrderIds(
  page: Page,
  cartAsins: string[],
  targetOrderId: string,
  _cid: string,
  /**
   * Pre-buy order-history snapshot from buy time, persisted on the
   * JobAttempt. When provided (non-null and non-empty), the scanner
   * uses snapshot-diff: only orders that appear in order-history NOW
   * but were NOT in the pre-buy snapshot count as this buy's orders.
   * Defeats the prev-order-bleed bug — a 2-day-old order with one of
   * today's filler ASINs WAS in the pre-buy snapshot, so it's
   * filtered out as not-from-this-buy. When null/empty, the scanner
   * falls back to the legacy ASIN-walker (which has the bleed risk).
   * Default null so older callers that don't pass it stay
   * backwards-compatible.
   */
  preBuyOrderIds: string[] | null = null,
): Promise<string[]> {
  if (cartAsins.length === 0) return [];
  try {
    await page.goto(
      'https://www.amazon.com/gp/css/order-history?ref_=nav_AccountFlyout_orders',
      { waitUntil: 'commit', timeout: 30_000 },
    );
  } catch {
    return [];
  }
  // Wait for Siege to decrypt every visible card before scanning
  // (zero `csd-encrypted-sensitive` divs remaining) AND for the card
  // count to stabilize. Same stability gate as snapshotOrderHistoryIds —
  // a snapshot that fires when only 1 card has painted is just as
  // wrong here as it was at buy time.
  await page
    .waitForFunction(
      () => {
        const cards = document.querySelectorAll('.order-card.js-order-card').length;
        const encrypted = document.querySelectorAll('.csd-encrypted-sensitive').length;
        if (encrypted !== 0) return false;
        if (cards === 0) return false;
        const w = window as Window & {
          __agRescanLast?: number;
          __agRescanSince?: number;
        };
        const now = Date.now();
        if (w.__agRescanLast !== cards) {
          w.__agRescanLast = cards;
          w.__agRescanSince = now;
          return false;
        }
        return now - (w.__agRescanSince ?? now) >= 2_000;
      },
      undefined,
      { timeout: 10_000, polling: 300 },
    )
    .catch(() => undefined);
  // Snapshot coherence validation (audit #4). If the persisted
  // preBuyOrderIds is non-empty but MUCH smaller than the currently
  // visible card count, the snapshot was taken before the page
  // fully rendered — using it as a diff baseline would falsely
  // attribute every "missing" card as a new filler. Reject the
  // snapshot in that case and fall back to ASIN-walker (which has
  // some prev-order-bleed risk but is safer than diffing against a
  // known-bad baseline).
  let effectivePreBuy = preBuyOrderIds;
  if (preBuyOrderIds && preBuyOrderIds.length > 0) {
    const currentCardCount = await page
      .evaluate(
        () => document.querySelectorAll('.order-card.js-order-card').length,
      )
      .catch(() => 0);
    // Threshold: snapshot size must be at least half of current
    // count. 10 cards visible + snapshot of 5 = OK; 10 cards + 1
    // snapshot = broken baseline, reject.
    if (currentCardCount > 0 && preBuyOrderIds.length * 2 < currentCardCount) {
      effectivePreBuy = null;
    }
  }
  // Use snapshot-diff when we have the pre-buy IDs (defeats cross-deal
  // contamination — see the doc above). Falls back to ASIN-walker
  // when the snapshot is missing (pre-feature attempts in the local
  // store, or capture failed at buy time).
  const matches = await page
    .evaluate(scanOrderHistoryDOMFn, {
      asinList: cartAsins,
      preBuyOrderIds:
        effectivePreBuy && effectivePreBuy.length > 0 ? effectivePreBuy : null,
    })
    .catch(() => [] as OrderMatch[]);
  // Verify-time strictness: require an actual ASIN match in the order
  // card. Diff-mode at buy time can accept matchedAsins=[] entries
  // (freebie/bundle window — anything new since the pre-buy snapshot
  // is plausibly ours), but at verify time 10+ minutes have passed
  // and parallel buys on the same account create unrelated orders
  // that ALSO show up in the diff. User-reported: 6 unrelated 111-XXX
  // orders attributed to a buy on cpnhuy because other buys ran
  // between this buy's snapshot and its verify pass. Filtering to
  // matchedAsins > 0 trades "miss a rare Amazon-bundle freebie at
  // verify" for "never falsely attribute another buy's orders".
  return matches
    .filter((m) => m.matchedAsins.length > 0)
    .map((m) => m.orderId)
    .filter((id) => id !== targetOrderId);
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

  // Run the target-cashback walk inline in the browser instead of pulling
  // /spc HTML over CDP and re-parsing via JSDOM. The CDP serialize round-
  // trip is the dominant cost (~80-150ms on a 318KB /spc); the pure
  // parser at parsers/amazonCheckout.ts:369 (`readTargetCashbackFromDom`)
  // stays exported so its fixture tests keep passing — this evaluate
  // mirrors the same logic 1:1 with two browser-only optimizations:
  //   1) Live `r.checked` property reads, no syncCheckedAttribute step
  //      needed (the property is the source of truth in a real browser;
  //      JSDOM-only callers still need the sync). Saves ~30ms.
  //   2) Browser-native `el.innerText` instead of the visibleText
  //      tree-walker helper (same whitespace-normalized output, faster).
  // Update both this evaluate AND the pure parser if the detection rules
  // ever change.
  const titlePrefix = buildTitlePrefix(targetTitle);
  const hit = await page
    .evaluate(
      ({ asin, titlePrefix: prefix }) => {
        const SKIP_NAME_RE =
          /destinationSubmissionUrl|paymentMethodForUrl|paymentMethod|ship-to-this|addressRadio/i;
        const visibleText = (el: Element): string =>
          ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();

        // Step 1: locate by ASIN href.
        let anchor: Element | null = document.querySelector(`a[href*="${asin}"]`);

        // Step 1.5: hidden testid pin. Chewbacca /spc renders
        // <span data-testid="Item_asin_N_N_N" class="aok-hidden">ASIN</span>
        // inside each line-item. Most reliable anchor when /dp/<asin>
        // hrefs are stripped by the checkout shell.
        if (!anchor) {
          const spans = document.querySelectorAll<HTMLElement>(
            '[data-testid^="Item_asin_"]',
          );
          for (const s of spans) {
            if ((s.textContent ?? '').trim() === asin) {
              anchor = s;
              break;
            }
          }
        }

        // Step 1b: title-prefix fallback (bidirectional shared prefix).
        if (!anchor && prefix && prefix.length > 5) {
          const needle = prefix.toLowerCase();
          const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */, null);
          let n: Node | null;
          while ((n = walker.nextNode()) !== null) {
            const txt = ((n as Text).textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (txt.length < 6) continue;
            const k = Math.min(needle.length, txt.length);
            if (k >= 6 && txt.slice(0, k) === needle.slice(0, k)) {
              anchor = (n as Text).parentElement;
              break;
            }
          }
        }

        if (!anchor) {
          const bodyText = visibleText(document.body);
          return {
            found: false as const,
            diag: {
              totalLinks: document.querySelectorAll('a').length,
              asinInBody: bodyText.includes(asin),
              titleSearched: prefix ?? null,
              titleInBody: prefix ? bodyText.toLowerCase().includes(prefix.toLowerCase()) : false,
              url: location.href,
            },
          };
        }

        // Step 2: walk up to the INNERMOST shipping group containing the
        // target. A shipping group is the smallest ancestor containing
        // BOTH "Arriving …" text AND at least one delivery radio. STOP
        // there — never expand outward looking for "% back", which
        // would swallow sibling shipping groups whose radios belong to
        // OTHER items (INC-2026-05-05).
        const MAX_SCOPE_CHARS = 200_000;
        let group: Element | null = null;
        let el: Element | null = anchor.parentElement;
        let depth = 0;
        while (el && el !== document.body && depth < 20) {
          const text = visibleText(el);
          if (text.length > MAX_SCOPE_CHARS) break;
          if (text.length > 200) {
            const hasArriving = /\bArriving\b/i.test(text);
            const hasRadio = el.querySelector('input[type="radio"]') !== null;
            if (hasArriving && hasRadio) {
              group = el;
              break;
            }
          }
          el = el.parentElement;
          depth++;
        }
        const scope: Element =
          group ?? (anchor.parentElement as Element | null) ?? anchor;

        // Step 3: read "% back" from the CHECKED radio's label only.
        // Reading any "% back" in scope was too loose (INC-2026-05-05).
        const checkedRadios = Array.from(
          scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        );
        const relevantChecked = checkedRadios
          .filter((r) => r.checked)
          .filter((r) => !SKIP_NAME_RE.test(r.name || r.id || ''));
        let selectedPct: number | null = null;
        let selectedLabel: string | null = null;
        for (const r of relevantChecked) {
          const card =
            r.closest('label, .a-radio, [role="radio"]') ??
            (r.parentElement as Element | null);
          const label = card ? visibleText(card) : '';
          const m = label.match(/(\d{1,2})\s*%\s*back/i);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n >= 0 && n <= 99) {
              if (selectedPct === null || n > selectedPct) {
                selectedPct = n;
                selectedLabel = label.slice(0, 120);
              }
            }
          } else if (selectedLabel === null) {
            selectedLabel = label.slice(0, 120);
          }
        }

        // Step 4: diagnostics.
        const text = visibleText(scope);
        const bodyText = visibleText(document.body);
        const bodyMatches = bodyText.match(/\d{1,2}\s*%\s*back/gi) ?? [];
        const scopeMatches = text.match(/\d{1,2}\s*%\s*back/gi) ?? [];

        // Step 5: enumerate ASINs inside the scope. Mirrors the pure
        // parser at parsers/amazonCheckout.ts. Used by the experimental
        // surgical-cashback-recovery flow to know which items share
        // the target's shipping group.
        const asinSet = new Set<string>();
        scope.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') ?? '';
          const am = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/i);
          if (am && am[1]) asinSet.add(am[1]);
        });
        scope.querySelectorAll('[data-asin]').forEach((el) => {
          const a = (el.getAttribute('data-asin') ?? '').trim();
          if (/^[A-Z0-9]{10}$/i.test(a)) asinSet.add(a);
        });
        scope.querySelectorAll('[data-testid^="Item_asin_"]').forEach((s) => {
          const a = (s.textContent ?? '').trim();
          if (/^[A-Z0-9]{10}$/i.test(a)) asinSet.add(a);
        });

        return {
          found: true as const,
          pct: selectedPct,
          selectedLabel,
          checkedRadioCount: relevantChecked.length,
          groupFound: group !== null,
          walkDepth: depth,
          scopeChars: text.length,
          bodyMatches: bodyMatches.slice(0, 8),
          scopeMatches: scopeMatches.slice(0, 8),
          scopeStart: text.slice(0, 200),
          scopeEnd: text.slice(Math.max(0, text.length - 200)),
          groupAsins: [...asinSet],
        };
      },
      { asin: targetAsin, titlePrefix },
    )
    .catch(() => ({
      found: false as const,
      diag: {
        totalLinks: 0,
        asinInBody: false,
        titleSearched: null as string | null,
        titleInBody: false,
        url: page.url(),
      },
    }));

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

/**
 * Experimental: surgical recovery from a B1 cashback failure (target's
 * shipping group has no "% back" radios at all).
 *
 * Phase A — linear remove. For up to MAX_REMOVE_ITERS (5):
 *   1. Identify non-target ASINs in the target's bad shipping group
 *      (from the failed verifyTargetCashback hit's groupAsins).
 *   2. HTTP-delete those ASINs from the active cart.
 *   3. Recreate /spc via SPC_ENTRY_URL (purchaseId rotates with cart
 *      contents — old /spc URL is invalid after delete).
 *   4. Re-run pickBestCashbackDelivery + verifyTargetCashback.
 *   5. If 6%+ achieved → return success. If still B1 → continue.
 *   6. If target's group is now empty (only target left) → break.
 *
 * Phase B — replacement. If Phase A exhausts:
 *   1. HTTP-add a fresh batch of fillers (skipping every ASIN seen so
 *      far in `attemptedAsins`, including the ones we just removed).
 *   2. Recreate /spc.
 *   3. Re-check cashback once.
 *
 * On success the buy continues with the new cashback pct. On
 * exhaustion the caller fails the buy with cashback_gate (NO outer
 * 3-attempt retry — that's the whole point of the flag).
 *
 * Research events are emitted at every step (Phase A iterations,
 * Phase B add) when `process.env.NODE_ENV === 'development'`. See
 * `shared/researchLog.ts`.
 */
const MAX_SURGICAL_REMOVE_ITERS = 5;
const SURGICAL_REPLACEMENT_COUNT = 3;

type SurgicalRecoveryResult =
  | { ok: true; pct: number; diag: CashbackDiag; method: 'remove' | 'replace' | 'radio'; finalState: SurgicalFinalState }
  | { ok: false; reason: string; finalState: SurgicalFinalState };

type SurgicalMode = 'b1' | 'b3';

type SurgicalFinalState = {
  removalIterations: number;
  removedAsinsAcrossIters: string[];
  replacementAsinsAdded: string[];
  totalElapsedMs: number;
};

async function runSurgicalCashbackRecovery(
  page: Page,
  opts: BuyWithFillersOptions,
  info: ProductInfo,
  targetAsin: string,
  initialFillerAsins: string[],
  attemptedAsins: Set<string>,
  initialFailHit: TargetCashbackResult,
  mode: SurgicalMode,
  cid: string | undefined,
): Promise<SurgicalRecoveryResult> {
  const tStart = Date.now();
  const removedAcrossIters: string[] = [];
  let lastFailHit: TargetCashbackResult = initialFailHit;
  let iter = 0;

  // Snapshot initial state for the research event.
  const initialDiag =
    initialFailHit.ok === false && initialFailHit.diag !== undefined
      ? initialFailHit.diag
      : null;
  void appendResearchEvent('cashback-experiments', {
    schemaVersion: 1,
    kind: 'experiment.surgical.start',
    targetAsin,
    targetTitle: info.title?.slice(0, 80) ?? null,
    targetPriceUsd: info.price,
    initialFillerAsins,
    initialFillerCount: initialFillerAsins.length,
    minCashbackPct: opts.minCashbackPct,
    initialPct: initialFailHit.ok ? initialFailHit.pct : null,
    initialScopeMatches: initialDiag?.scopeMatches ?? null,
    initialBodyMatches: initialDiag?.bodyMatches ?? null,
    initialGroupFound: initialDiag?.groupFound ?? null,
    initialReason: initialFailHit.ok ? null : initialFailHit.reason,
    mode,
    initialSelectedLabel: initialDiag?.selectedLabel ?? null,
  });

  // Phase R — focused radio click. Fires when the failure is B3
  // (target's group HAS a "% back" radio but a non-cashback radio is
  // checked). Skip Phase A removal and Phase B replacement entirely —
  // the cashback exists, we just need to land the right radio. Done
  // directly via page.evaluate so an Amazon-side default snap-back
  // can't swallow the click.
  if (mode === 'b3') {
    const clickResult = await page
      .evaluate((asin: string) => {
        // Walk to the target's innermost Arriving+radio ancestor — same
        // walk readTargetCashbackFromDom uses. Then pick the cashback-
        // bearing radio in that scope and click it directly.
        let anchor: Element | null = document.querySelector(`a[href*="${asin}"]`);
        if (!anchor) {
          const spans = document.querySelectorAll<HTMLElement>(
            '[data-testid^="Item_asin_"]',
          );
          for (const s of spans) {
            if ((s.textContent ?? '').trim() === asin) {
              anchor = s;
              break;
            }
          }
        }
        if (!anchor) return { ok: false, reason: 'anchor_not_found' };
        let group: Element | null = null;
        let el: Element | null = anchor.parentElement;
        let depth = 0;
        while (el && el !== document.body && depth < 20) {
          const txt = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ');
          if (txt.length > 200_000) break;
          if (txt.length > 200) {
            const hasArriving = /\bArriving\b/i.test(txt);
            const hasRadio = el.querySelector('input[type="radio"]') !== null;
            if (hasArriving && hasRadio) {
              group = el;
              break;
            }
          }
          el = el.parentElement;
          depth++;
        }
        const scope = group ?? anchor.parentElement ?? anchor;
        const radios = Array.from(
          scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
        );
        type Hit = { radio: HTMLInputElement; pct: number; label: string };
        const hits: Hit[] = [];
        for (const r of radios) {
          const card =
            r.closest('label, .a-radio, [role="radio"]') ??
            (r.parentElement as Element | null);
          const label = card
            ? ((card as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
            : '';
          const m = label.match(/(\d{1,2})\s*%\s*back/i);
          if (m) hits.push({ radio: r, pct: Number(m[1]), label: label.slice(0, 120) });
        }
        if (hits.length === 0) return { ok: false, reason: 'no_cashback_radio_in_scope' };
        const best = hits.reduce((a, b) => (b.pct > a.pct ? b : a));
        if (best.radio.checked) {
          return { ok: true, alreadyChecked: true, label: best.label, pct: best.pct };
        }
        // Return the radio's identifiers (name + value) instead of
        // clicking inside the evaluate. The caller does a Playwright
        // locator click with force:true outside this block — same fix
        // shape as pickBestCashbackDelivery in buyNow.ts. DOM-level
        // .click() here used to trigger Amazon's /eligibleshipoption
        // bot detector → /errors/500. force:true Playwright click
        // skips the actionability hit-test (so Chewbacca's boxed
        // wrapper doesn't block) but still dispatches real mouse
        // events that Amazon's backend accepts.
        return {
          ok: true,
          alreadyChecked: false,
          label: best.label,
          pct: best.pct,
          radioName: best.radio.name,
          radioValue: best.radio.value,
        };
      }, targetAsin)
      .catch((err) => ({ ok: false as const, reason: `evaluate_failed: ${String(err).slice(0, 80)}` }));
    if (clickResult.ok && !clickResult.alreadyChecked && 'radioName' in clickResult) {
      const radioName = clickResult.radioName as string;
      const radioValue = clickResult.radioValue as string;
      const sel = `input[type="radio"][name="${radioName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"][value="${radioValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      await page
        .locator(sel)
        .first()
        .click({ force: true, timeout: 5_000 })
        .catch(() => undefined);
    }

    // Wait for Amazon's eligibleshipoption XHR to settle so we don't
    // reverify against a stale page.
    await page
      .waitForResponse(/eligibleshipoption/i, { timeout: 8_000 })
      .catch(() => undefined);
    await waitForDeliverySettle(page);

    const cb = await verifyTargetCashback(
      page,
      targetAsin,
      info.title,
      opts.minCashbackPct,
    );
    const cbDiag = !cb.ok && cb.diag !== undefined ? cb.diag : (cb.ok ? cb.diag : null);
    void appendResearchEvent('cashback-experiments', {
      schemaVersion: 1,
      kind: 'experiment.surgical.radio',
      targetAsin,
      clickResult,
      pctAfter: cb.ok ? cb.pct : (cb.pct ?? null),
      scopeMatchesAfter: cbDiag?.scopeMatches ?? null,
      selectedLabelAfter: cbDiag?.selectedLabel ?? null,
      outcome: cb.ok ? 'success' : 'still_failed',
    });
    if (cb.ok) {
      logger.info(
        'step.fillerBuy.surgical.phaseR.ok',
        { targetAsin, pctAchieved: cb.pct, clickResult },
        cid,
      );
      return {
        ok: true,
        pct: cb.pct,
        diag: cb.diag,
        method: 'radio',
        finalState: {
          removalIterations: 0,
          removedAsinsAcrossIters: [],
          replacementAsinsAdded: [],
          totalElapsedMs: Date.now() - tStart,
        },
      };
    }
    logger.warn(
      'step.fillerBuy.surgical.phaseR.failed',
      {
        targetAsin,
        clickResult,
        scopeMatchesAfter: cbDiag?.scopeMatches ?? null,
        selectedLabelAfter: cbDiag?.selectedLabel ?? null,
      },
      cid,
    );
    return {
      ok: false,
      reason: `surgical: phase R failed — radio click did not land cashback (selected="${cbDiag?.selectedLabel ?? 'n/a'}")`,
      finalState: {
        removalIterations: 0,
        removedAsinsAcrossIters: [],
        replacementAsinsAdded: [],
        totalElapsedMs: Date.now() - tStart,
      },
    };
  }

  // Phase A — linear remove.
  for (iter = 1; iter <= MAX_SURGICAL_REMOVE_ITERS; iter++) {
    const lastDiag =
      !lastFailHit.ok && lastFailHit.diag !== undefined ? lastFailHit.diag : null;
    // The diag fields don't carry groupAsins — we threaded that on the
    // CashbackHit but `verifyTargetCashback` reshapes into TargetCashbackResult.
    // Pull groupAsins by re-running the in-page enumerate against the live DOM
    // for THIS iteration. (Simpler than threading groupAsins through 3 layers.)
    const groupAsins = await page
      .evaluate((asin) => {
        // Walk to the target's innermost Arriving+radio ancestor (mirrors
        // readTargetCashbackFromDom step 2). Inline because we only need
        // ASIN enumeration here, not the cashback walk.
        let anchor: Element | null = document.querySelector(`a[href*="${asin}"]`);
        if (!anchor) {
          const spans = document.querySelectorAll<HTMLElement>(
            '[data-testid^="Item_asin_"]',
          );
          for (const s of spans) {
            if ((s.textContent ?? '').trim() === asin) {
              anchor = s;
              break;
            }
          }
        }
        if (!anchor) return [] as string[];
        let group: Element | null = null;
        let el: Element | null = anchor.parentElement;
        let depth = 0;
        while (el && el !== document.body && depth < 20) {
          const txt = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ');
          if (txt.length > 200_000) break;
          if (txt.length > 200) {
            const hasArriving = /\bArriving\b/i.test(txt);
            const hasRadio = el.querySelector('input[type="radio"]') !== null;
            if (hasArriving && hasRadio) {
              group = el;
              break;
            }
          }
          el = el.parentElement;
          depth++;
        }
        const scope = group ?? anchor.parentElement ?? anchor;
        const set = new Set<string>();
        scope.querySelectorAll('a[href]').forEach((a) => {
          const m = (a.getAttribute('href') ?? '').match(
            /\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/i,
          );
          if (m && m[1]) set.add(m[1].toUpperCase());
        });
        scope.querySelectorAll('[data-asin]').forEach((el2) => {
          const a = (el2.getAttribute('data-asin') ?? '').trim();
          if (/^[A-Z0-9]{10}$/i.test(a)) set.add(a.toUpperCase());
        });
        scope.querySelectorAll('[data-testid^="Item_asin_"]').forEach((s) => {
          const a = (s.textContent ?? '').trim();
          if (/^[A-Z0-9]{10}$/i.test(a)) set.add(a.toUpperCase());
        });
        return [...set];
      }, targetAsin)
      .catch(() => [] as string[]);

    // Linear remove: pick ONE bundle-mate per iteration, reverify, then
    // decide whether to keep removing. Skip ASINs we've already removed
    // in earlier iterations so a stale groupAsins read doesn't loop.
    const candidates = groupAsins.filter(
      (a) =>
        a.toUpperCase() !== targetAsin.toUpperCase() &&
        !removedAcrossIters.includes(a.toUpperCase()),
    );
    if (candidates.length === 0) {
      // Target is alone in its group (or every bundle-mate already
      // removed) — Phase A can't help. Move to Phase B.
      logger.info(
        'step.fillerBuy.surgical.phaseA.noBundleMates',
        { iter, targetAsin },
        cid,
      );
      void appendResearchEvent('cashback-experiments', {
        schemaVersion: 1,
        kind: 'experiment.surgical.removal',
        iter,
        targetAsin,
        outcome: 'no_bundle_mates',
        groupAsins,
        scopeMatchesBefore: lastDiag?.scopeMatches ?? null,
      });
      break;
    }

    const oneAsin = candidates[0]!;
    const removeRes = await removeCartItemsByAsin(page, [oneAsin]);
    if (!removeRes.ok) {
      logger.warn(
        'step.fillerBuy.surgical.phaseA.removeFail',
        { iter, reason: removeRes.reason, status: removeRes.status },
        cid,
      );
      void appendResearchEvent('cashback-experiments', {
        schemaVersion: 1,
        kind: 'experiment.surgical.removal',
        iter,
        targetAsin,
        outcome: 'remove_failed',
        reason: removeRes.reason,
      });
      break;
    }
    removedAcrossIters.push(...removeRes.removedAsins);
    // Mark removed ASINs as attempted so Phase B doesn't pick them again.
    for (const a of removeRes.removedAsins) attemptedAsins.add(a);

    // Recreate /spc — purchaseId rotates with cart contents. Use
    // domcontentloaded (not 'commit') so the URL check below isn't
    // racing Amazon's redirect chain. /spc-entry can bounce
    // through one or two interstitials before settling.
    try {
      await page.goto(SPC_ENTRY_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page
        .waitForURL(SPC_URL_MATCH, { timeout: 10_000 })
        .catch(() => undefined);
    } catch (err) {
      logger.warn(
        'step.fillerBuy.surgical.phaseA.spcGotoFail',
        { iter, error: String(err).slice(0, 120) },
        cid,
      );
      break;
    }
    if (!SPC_URL_MATCH.test(page.url())) {
      logger.warn(
        'step.fillerBuy.surgical.phaseA.notSpc',
        { iter, url: page.url() },
        cid,
      );
      break;
    }

    // Re-run delivery picker + cashback verify on the fresh /spc.
    await pickBestCashbackDelivery(page, opts.minCashbackPct);
    await waitForDeliverySettle(page);
    const cb = await verifyTargetCashback(
      page,
      targetAsin,
      info.title,
      opts.minCashbackPct,
    );

    const iterDiag =
      !cb.ok && cb.diag !== undefined ? cb.diag : (cb.ok ? cb.diag : null);
    void appendResearchEvent('cashback-experiments', {
      schemaVersion: 1,
      kind: 'experiment.surgical.removal',
      iter,
      targetAsin,
      removedAsinsThisIter: removeRes.removedAsins,
      missingAsinsThisIter: removeRes.missingAsins,
      pctAfter: cb.ok ? cb.pct : (cb.pct ?? null),
      scopeMatchesAfter: iterDiag?.scopeMatches ?? null,
      bodyMatchesAfter: iterDiag?.bodyMatches ?? null,
      checkedRadioCountAfter: iterDiag?.checkedRadioCount ?? null,
      outcome: cb.ok ? 'success' : 'still_b1',
    });

    if (cb.ok) {
      logger.info(
        'step.fillerBuy.surgical.phaseA.ok',
        {
          iter,
          targetAsin,
          pctAchieved: cb.pct,
          removedCount: removedAcrossIters.length,
        },
        cid,
      );
      return {
        ok: true,
        pct: cb.pct,
        diag: cb.diag,
        method: 'remove',
        finalState: {
          removalIterations: iter,
          removedAsinsAcrossIters: removedAcrossIters,
          replacementAsinsAdded: [],
          totalElapsedMs: Date.now() - tStart,
        },
      };
    }
    lastFailHit = cb;
  }

  // Phase B — replacement. Add SURGICAL_REPLACEMENT_COUNT fresh fillers
  // (skipping everything we've already attempted, including the just-
  // removed items).
  logger.info(
    'step.fillerBuy.surgical.phaseB.start',
    { removedCount: removedAcrossIters.length },
    cid,
  );
  const replacementResult = await addFillerItems(
    page,
    targetAsin,
    cid,
    {
      terms: termsForPool(opts.fillerPool) ?? FILLER_SEARCH_TERMS,
      targetCount: SURGICAL_REPLACEMENT_COUNT,
      attemptedAsins,
      pool: opts.fillerPool,
    },
    { jobId: opts.jobId, profile: opts.profile },
  );

  if (replacementResult.added === 0) {
    void appendResearchEvent('cashback-experiments', {
      schemaVersion: 1,
      kind: 'experiment.surgical.replacement',
      targetAsin,
      replacementsRequested: SURGICAL_REPLACEMENT_COUNT,
      replacementsAdded: 0,
      outcome: 'no_replacements_added',
    });
    return {
      ok: false,
      reason: 'surgical: phase A exhausted, phase B failed to add replacement fillers',
      finalState: {
        removalIterations: iter,
        removedAsinsAcrossIters: removedAcrossIters,
        replacementAsinsAdded: [],
        totalElapsedMs: Date.now() - tStart,
      },
    };
  }
  for (const a of replacementResult.asins) attemptedAsins.add(a);

  // Same race as Phase A's /spc recreate — use domcontentloaded + a
  // bounded waitForURL so the URL check below isn't racing the
  // /spc-entry redirect chain.
  try {
    await page.goto(SPC_ENTRY_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page
      .waitForURL(SPC_URL_MATCH, { timeout: 10_000 })
      .catch(() => undefined);
  } catch {
    return {
      ok: false,
      reason: 'surgical: phase B /spc recreate failed',
      finalState: {
        removalIterations: iter,
        removedAsinsAcrossIters: removedAcrossIters,
        replacementAsinsAdded: replacementResult.asins,
        totalElapsedMs: Date.now() - tStart,
      },
    };
  }
  if (!SPC_URL_MATCH.test(page.url())) {
    return {
      ok: false,
      reason: 'surgical: phase B /spc shortcut did not land on /spc',
      finalState: {
        removalIterations: iter,
        removedAsinsAcrossIters: removedAcrossIters,
        replacementAsinsAdded: replacementResult.asins,
        totalElapsedMs: Date.now() - tStart,
      },
    };
  }

  await pickBestCashbackDelivery(page, opts.minCashbackPct);
  await waitForDeliverySettle(page);
  const finalCb = await verifyTargetCashback(
    page,
    targetAsin,
    info.title,
    opts.minCashbackPct,
  );
  const finalDiag =
    !finalCb.ok && finalCb.diag !== undefined ? finalCb.diag : (finalCb.ok ? finalCb.diag : null);
  void appendResearchEvent('cashback-experiments', {
    schemaVersion: 1,
    kind: 'experiment.surgical.replacement',
    targetAsin,
    replacementsRequested: SURGICAL_REPLACEMENT_COUNT,
    replacementsAdded: replacementResult.added,
    replacementAsins: replacementResult.asins,
    pctAfter: finalCb.ok ? finalCb.pct : (finalCb.pct ?? null),
    scopeMatchesAfter: finalDiag?.scopeMatches ?? null,
    outcome: finalCb.ok ? 'success' : 'still_failed',
  });

  if (finalCb.ok) {
    logger.info(
      'step.fillerBuy.surgical.phaseB.ok',
      {
        targetAsin,
        pctAchieved: finalCb.pct,
        replacementsAdded: replacementResult.asins,
      },
      cid,
    );
    return {
      ok: true,
      pct: finalCb.pct,
      diag: finalCb.diag,
      method: 'replace',
      finalState: {
        removalIterations: iter,
        removedAsinsAcrossIters: removedAcrossIters,
        replacementAsinsAdded: replacementResult.asins,
        totalElapsedMs: Date.now() - tStart,
      },
    };
  }

  return {
    ok: false,
    reason: `surgical: exhausted (removed ${removedAcrossIters.length}, replaced ${replacementResult.added}, still ${finalCb.reason})`,
    finalState: {
      removalIterations: iter,
      removedAsinsAcrossIters: removedAcrossIters,
      replacementAsinsAdded: replacementResult.asins,
      totalElapsedMs: Date.now() - tStart,
    },
  };
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
        const containerSel =
          '.lineitem-container, [data-feature-id*="line-item"], .order-summary-line-item';

        // Each candidate strategy proposes an anchor; we only accept
        // the anchor when it lives inside a line-item container.
        // Anchors found in the order-summary mini-widget (which sits
        // outside the cards on Chewbacca SPC) would otherwise pass a
        // generic "any ancestor with a price element" fallback and
        // make us read THE FIRST line item's price — i.e. the wrong
        // row entirely, which silently passes the cap by coincidence
        // when the wrong row is cheap and silently fails when it's
        // expensive. We saw both modes on Echo Dot @ qty 2: same
        // deal, intermittent results depending on Amazon's A/B variant.
        const attemptToTarget = (el: Element | null): Element | null => {
          if (!el) return null;
          return el.closest(containerSel) as Element | null;
        };

        // Step 0: CSA item-id attribute. Chewbacca tags every deal-target
        // line item with
        //   <span data-csa-c-type="item" data-csa-c-item-type="asin"
        //         data-csa-c-item-id="amzn1.asin.<ASIN>:amzn1.deal.<dealId>" …>
        // INSIDE the .lineitem-container itself. Strongest anchor we have
        // on the current layout — the attribute carries the literal ASIN
        // string so wrong-row attribution is impossible. Validated against
        // a captured /spc snapshot where Echo Dot's PDP scrape returned a
        // null title and Steps 1/2 both missed: this Step 0 found the
        // right container directly.
        //
        // Only present on items Amazon flags as a deal — fillers don't
        // carry it. Since we're locating the TARGET only, that limitation
        // is fine; falls through to Steps 1-3 when absent.
        let target: Element | null = attemptToTarget(
          document.querySelector(
            `[data-csa-c-item-id^="amzn1.asin.${asin}"]`,
          ),
        );

        // Step 1: ASIN-based href locators. Older /spc layouts wrap
        // each line item's title in an <a href="/dp/<ASIN>">. On
        // Chewbacca SPC these hrefs are stripped, so step often misses.
        if (!target) {
          target = attemptToTarget(
            document.querySelector(
              `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"], a[href*="${asin}"]`,
            ),
          );
        }

        // Step 2: testid pin with container ancestor. Chewbacca
        // typically renders hidden <span data-testid="Item_asin_N_N_N">ASIN</span>
        // elements in the order-summary widget — OUTSIDE
        // .lineitem-container. attemptToTarget rejects those (closest
        // returns null), so this step only succeeds on layouts where
        // the testid pin happens to live inside the card itself.
        // Almost never on current Chewbacca; kept for safety on older
        // layouts.
        if (!target) {
          const spans = document.querySelectorAll<HTMLElement>(
            '[data-testid^="Item_asin_"]',
          );
          for (const s of Array.from(spans)) {
            if ((s.textContent ?? '').trim() === asin) {
              const t = attemptToTarget(s);
              if (t) {
                target = t;
                break;
              }
            }
          }
        }

        // Step 2.5: testid ordinal mapping. When Step 2's container-
        // ancestor lookup misses because the testid pins live in the
        // order-summary widget (Chewbacca's default), the DOM order
        // of the testid spans still matches the DOM order of the
        // line-item cards (Amazon renders them from the same data,
        // identical sort). Find the target's index in the testid
        // list, then return the lineitem-container at the same index.
        //
        // Validated against five captured target_missing snapshots
        // (Echo Dot, MacBook Pro M5, AirPods 4, across 3 accounts):
        // index mapping picks the correct container in every case.
        //
        // Hard guard: only accept the mapping when testidCount ===
        // lineitemCount. If they differ (e.g., "saved for later" items
        // contributing a testid without a card, or an inverse case)
        // we'd risk a wrong-row pick — fall through to Step 3 instead.
        if (!target) {
          const spans = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid^="Item_asin_"]'),
          );
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>('.lineitem-container'),
          );
          if (spans.length > 0 && spans.length === cards.length) {
            const idx = spans.findIndex(
              (s) => (s.textContent ?? '').trim() === asin,
            );
            if (idx >= 0 && idx < cards.length) {
              target = cards[idx] ?? null;
            }
          }
        }

        // Step 3: title text walker. Chewbacca's actual line-item
        // cards DO contain the product title text node inside the
        // .lineitem-container, so walking text nodes and finding the
        // first one that starts with the title prefix reliably lands
        // us inside the right card. Verified on a real Chewbacca SPC
        // snapshot — exactly 1 hit for the target title, inside the
        // correct .lineitem-container.
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
              const t = attemptToTarget(n.parentElement);
              if (t) {
                target = t;
                break;
              }
            }
          }
        }

        if (!target) return { found: false as const };

        const priceEl =
          (target.querySelector('.lineitem-price-text') as HTMLElement | null) ??
          (target.querySelector('.a-price .a-offscreen') as HTMLElement | null) ??
          (target.querySelector('.a-color-price') as HTMLElement | null) ??
          (target.querySelector('.a-price') as HTMLElement | null);
        const text = priceEl ? (priceEl.textContent ?? '').trim() : '';

        // Read the qty from the same line-item container. The /spc page
        // shows the LINE TOTAL (qty × unit) in the price element for
        // qty>1, so without dividing we'd falsely fail the cap (e.g.
        // Echo Dot at $39.99 unit × qty 2 = $79.98 displayed > $39.99
        // cap). Mirrors readTargetQuantity's three strategies.
        const parseNum = (s: string | null | undefined): number | null => {
          if (!s) return null;
          const m = s.match(/\b(\d{1,3})\b/);
          if (!m) return null;
          const v = parseInt(m[1] as string, 10);
          return Number.isFinite(v) && v > 0 && v < 1000 ? v : null;
        };
        let qty: number | null = null;
        const dd = target.querySelector<HTMLElement>(
          '.a-dropdown-prompt, .dropdown_selectedTOption',
        );
        qty = parseNum(dd?.innerText ?? dd?.textContent ?? null);
        if (qty === null) {
          const input = target.querySelector<HTMLInputElement>(
            'input[name="quantity"], input[name*="quantity" i]',
          );
          if (input && input.value) qty = parseNum(input.value);
        }
        if (qty === null) {
          const stepper = target.querySelector<HTMLElement>(
            '[aria-label*="Increase" i], [aria-label*="Decrease" i], [aria-label*="Quantity" i]',
          );
          if (stepper) {
            const scope =
              stepper.closest(
                '.a-button-stack, .a-quantity, [data-csa-c-content-id*="quantity" i], span, div',
              ) ?? stepper.parentElement;
            if (scope) {
              qty = parseNum(
                (scope as HTMLElement).innerText ?? scope.textContent ?? null,
              );
            }
          }
        }

        return { found: true as const, text, qty };
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

  const linePrice = parsePrice(hit.text);
  if (linePrice === null || linePrice <= 0) {
    return {
      ok: false,
      reason: `could not parse target price from "${hit.text}"`,
    };
  }
  // /spc shows the line total = unit × qty. Divide by the qty we
  // read from the same line container so we compare like-for-like
  // against the per-unit cap from BG. qty=null (parse miss) falls
  // back to 1 — matches pre-fix behavior so single-qty deals are
  // unaffected even if the qty reader regresses on a future layout.
  const lineQty = hit.qty && hit.qty > 0 ? hit.qty : 1;
  const unitPrice = linePrice / lineQty;
  const tol = effectivePriceTolerance(cap);
  if (unitPrice > cap + tol) {
    const qtySuffix = lineQty > 1 ? ` (line total $${linePrice.toFixed(2)} ÷ qty ${lineQty})` : '';
    return {
      ok: false,
      reason:
        tol > 0
          ? `target price $${unitPrice.toFixed(2)} exceeds cap $${cap.toFixed(2)} (+$${tol.toFixed(2)} tolerance)${qtySuffix}`
          : `target price $${unitPrice.toFixed(2)} exceeds cap $${cap.toFixed(2)}${qtySuffix}`,
      detail: hit.text,
    };
  }
  return { ok: true, priceText: hit.text, price: unitPrice };
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

function buildFillerSearchUrl(term: string, pool: FillerPool | undefined): string {
  // Amazon `rh=` syntax, comma-joined:
  //   p_85:2470955011  — Prime-eligible
  //   p_6:ATVPDKIKX0DER — sold by Amazon. Eero pool omits this so FBA-3p
  //                       eero is included; other pools keep it because
  //                       3p cancels stall the verify phase.
  //   p_36:lo-hi       — price in cents (see priceBandForPool).
  // No `s=` sort: review-rank applies a hidden min-reviews filter that
  // collapses sparse categories (eero: 194 results → 6); default
  // Featured sort returns the full surface.
  const { min, max } = priceBandForPool(pool);
  const priceFilter = `p_36:${Math.round(min * 100)}-${Math.round(max * 100)}`;
  const rh = pool === 'eero'
    ? `p_85:2470955011,${priceFilter}`
    : `p_85:2470955011,p_6:ATVPDKIKX0DER,${priceFilter}`;
  return `https://www.amazon.com/s?k=${encodeURIComponent(term)}&rh=${encodeURIComponent(rh)}`;
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
type SearchFillerDiag = {
  /** HTTP status of the search-page fetch. -1 if the request threw. */
  status: number;
  /** Body length in bytes. 0 if the body couldn't be read. */
  bodyLen: number;
  /** Total candidate cards parsed from the page (pre-filter). */
  totalCardsParsed: number;
  /** Whether the page looks like a captcha / robot-check intercept. */
  looksLikeCaptcha: boolean;
  /** True when Amazon returned a meta-refresh interstitial (~2.6KB
   *  stub with `<meta http-equiv="refresh" content="N; URL=...">`) —
   *  Amazon's silent edge rate-limit. INC-2026-05-10 (cpnnick rebuy):
   *  bot fired 7 search terms in <1s, every one came back as a 2.6KB
   *  meta-refresh stub → 0 candidates → 0 fillers → buy placed naked. */
  metaRefresh: boolean;
  /** Whether this result is the OUTCOME of a meta-refresh retry. */
  retried?: boolean;
  /** Per-filter rejection counts when totalCardsParsed > 0 but
   *  candidates ends up 0 — disambiguates "Amazon returned nothing" from
   *  "Amazon returned items but all got filtered out". */
  rejectedByFilter?: {
    notPrime: number;
    noPrice: number;
    priceBelow: number;
    priceAbove: number;
  };
  /** First ~200 chars of body, for triage when results are empty.
   *  Captcha pages return "Type the characters you see in this image"
   *  or "We just need to make sure you're not a robot" so this catches
   *  Amazon's bot-protection responses without needing the full HTML. */
  bodyPreview: string;
};

/**
 * Single-attempt HTTP fetch + parse for a search-results page. The
 * caller (`searchFillerCandidatesViaHttp`) wraps this in retry logic
 * when Amazon's rate-limit interstitial fires.
 */
async function fetchSearchPageOnce(
  page: Page,
  url: string,
): Promise<{
  status: number;
  html: string;
  metaRefreshDelaySec: number | null;
}> {
  let res;
  try {
    res = await page.context().request.get(url, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
  } catch {
    return { status: -1, html: '', metaRefreshDelaySec: null };
  }
  if (!res.ok()) {
    return { status: res.status(), html: '', metaRefreshDelaySec: null };
  }
  let html: string;
  try {
    html = await res.text();
  } catch {
    return { status: res.status(), html: '', metaRefreshDelaySec: null };
  }
  // Detect Amazon's rate-limit meta-refresh stub. Body is ~2.6KB with
  // a `<meta http-equiv="refresh" content="5; URL='/s?k=...'">` and
  // nothing else useful — no search cards. Parse the delay so the
  // caller can wait the recommended interval before retrying. Limited
  // to head/<head> region so an article body that contains the words
  // "http-equiv refresh" can't false-positive.
  const head = html.slice(0, 4_000);
  const refreshMatch = head.match(
    /<meta\s+http-equiv=["']refresh["']\s+content=["'](\d+)\s*;\s*URL=/i,
  );
  return {
    status: res.status(),
    html,
    metaRefreshDelaySec: refreshMatch?.[1] ? parseInt(refreshMatch[1]!, 10) : null,
  };
}

/**
 * Last-resort filler search via a real browser navigation. Use when
 * `searchFillerCandidatesViaHttp` returns the meta-refresh stub on
 * every term in the configured pool (and the in-attempt pool fallback,
 * if any) — Amazon's HTTP-API rate-limit fires on `ctx.request.get`
 * but is much more lenient on full browser navigations (verified live
 * 2026-05-13: parallel burst of 20 fetches from the browser context
 * all returned real results, even though prior HTTP requests from the
 * same account were stub'd).
 *
 * Opens a fresh tab in the same context so the buy-flow's main page
 * isn't disturbed; cookies are shared. Chromium handles the
 * meta-refresh stub natively (waits 5s, follows the redirect), so no
 * retry logic needed here. Cost: ~1.5-3s wall-clock. Returns the same
 * `SearchResultCandidate[]` shape as the HTTP path — the same JSDOM
 * parser (`extractSearchResultCandidates`) runs against the rendered
 * page content.
 *
 * Returns [] (not the diag struct) — caller has already logged its
 * diag from the failed HTTP attempts; the browser path is binary:
 * either we got candidates or we didn't.
 */
async function searchFillerCandidatesViaBrowser(
  mainPage: Page,
  term: string,
  pool: FillerPool | undefined,
): Promise<SearchResultCandidate[]> {
  const url = buildFillerSearchUrl(term, pool);
  const searchPage = await mainPage.context().newPage();
  try {
    await searchPage
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => undefined);
    // Wait for the search-result cards to render. Cap at 8s — if Amazon
    // is STILL serving the meta-refresh stub at this point, the rate-
    // limit is beyond what a browser nav can paper over and we bail
    // with 0 candidates (caller fail-fasts the buy).
    await searchPage
      .waitForSelector('[data-component-type="s-search-result"]', { timeout: 8_000 })
      .catch(() => undefined);
    const html = await searchPage.content().catch(() => '');
    if (!html) return [];
    const doc = htmlToDocument(html);
    const all = extractSearchResultCandidates(doc);
    const { min: minPrice, max: maxPrice } = priceBandForPool(pool);
    return all.filter((c) => {
      if (!c.isPrime) return false;
      if (c.price === null) return false;
      if (c.price < minPrice || c.price > maxPrice) return false;
      return true;
    });
  } finally {
    await searchPage.close().catch(() => undefined);
  }
}

async function searchFillerCandidatesViaHttp(
  page: Page,
  term: string,
  pool: FillerPool | undefined,
): Promise<{ candidates: SearchResultCandidate[]; diag: SearchFillerDiag }> {
  const url = buildFillerSearchUrl(term, pool);
  let { status, html, metaRefreshDelaySec } = await fetchSearchPageOnce(page, url);
  let retryCount = 0;
  // Amazon's rate-limit interstitial: respect the meta-refresh delay
  // and retry. INC-2026-05-10 round 2: even after one 5s retry,
  // Amazon kept serving the stub on cpnduy/cpnhuy's eero searches
  // → 0 fillers → naked cart. Now: up to 2 retries with progressive
  // backoff (1× hint, then 2× hint). If Amazon is STILL throttling
  // after that, the search is genuinely poisoned and the caller's
  // pool-fallback (eero → amazon-basics on cashback_gate failure)
  // OR the in-attempt fallback below is the only escape. Each delay
  // is clamped to [2s, 12s] so a malicious or absurd refresh hint
  // can't stall the buy indefinitely.
  const MAX_RETRIES = 2;
  while (metaRefreshDelaySec !== null && retryCount < MAX_RETRIES) {
    const baseSec = Math.min(Math.max(metaRefreshDelaySec, 2), 12);
    // Progressive backoff: 1x on retry 1, 2x on retry 2.
    const delayMs = baseSec * 1_000 * (retryCount + 1);
    await new Promise((r) => setTimeout(r, delayMs));
    const retry = await fetchSearchPageOnce(page, url);
    status = retry.status;
    html = retry.html;
    metaRefreshDelaySec = retry.metaRefreshDelaySec;
    retryCount += 1;
  }
  const retried = retryCount > 0;
  if (status < 200 || status >= 300 || html.length === 0) {
    return {
      candidates: [],
      diag: {
        status,
        bodyLen: 0,
        totalCardsParsed: 0,
        looksLikeCaptcha: false,
        metaRefresh: metaRefreshDelaySec !== null,
        ...(retried ? { retried: true } : {}),
        bodyPreview: '',
      },
    };
  }
  const looksLikeCaptcha =
    /Type the characters you see in this image|Sorry, we just need to make sure|automated access to our website|api-services-support@amazon\.com/i.test(
      html.slice(0, 8_000),
    );
  const doc = htmlToDocument(html);
  const all = extractSearchResultCandidates(doc);
  let notPrime = 0;
  let noPrice = 0;
  let priceBelow = 0;
  let priceAbove = 0;
  const { min: minPrice, max: maxPrice } = priceBandForPool(pool);
  const candidates = all.filter((c) => {
    if (!c.isPrime) { notPrime++; return false; }
    if (c.price === null) { noPrice++; return false; }
    if (c.price < minPrice) { priceBelow++; return false; }
    if (c.price > maxPrice) { priceAbove++; return false; }
    return true;
  });
  const diag: SearchFillerDiag = {
    status,
    bodyLen: html.length,
    totalCardsParsed: all.length,
    looksLikeCaptcha,
    metaRefresh: metaRefreshDelaySec !== null,
    ...(retried ? { retried: true } : {}),
    bodyPreview: html.replace(/\s+/g, ' ').slice(0, 200),
    ...(all.length > 0 && candidates.length === 0
      ? { rejectedByFilter: { notPrime, noPrice, priceBelow, priceAbove } }
      : {}),
  };
  return { candidates, diag };
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
    const prefetchedDoc = htmlToDocument(prefetchedHtml);
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
  const doc = htmlToDocument(pdpHtml);
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
  /** Active filler pool. Drives the per-pool title blocklist
   *  (`isBlockedByPool`) — e.g. eero pool excludes Echo / Fire TV.
   *  Undefined / 'general' = no blocklist. */
  pool?: FillerPool;
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
  // Appended last so existing call-sites that pass fillerOpts as the
  // trailing object literal still parse cleanly.
  logCtx: Record<string, unknown> = {},
): Promise<{ added: number; asins: string[]; metaRefreshHits: number; termsTried: number }> {
  // Shadow `logger` so the 7 call sites in this function get the disk-log
  // routing fields (jobId+profile) merged in. See makeBoundLogger above.
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const logger = makeBoundLogger(loggerImport, logCtx);
  const targetCount = fillerOpts.targetCount ?? FILLER_COUNT;
  const terms = shuffle(fillerOpts.terms ?? FILLER_SEARCH_TERMS);
  const seen = fillerOpts.attemptedAsins ?? new Set<string>();
  if (targetAsin) seen.add(targetAsin);

  // 1. Walk through search terms until we have enough fresh candidates.
  //    Most of the time one term is enough (~50 results per page; even
  //    after dedup we usually have 30+ fresh candidates).
  //
  //    Pacing — Amazon's edge rate-limiter (INC-2026-05-10) returns a
  //    ~2.6KB meta-refresh stub when search HTTP requests fire in
  //    rapid succession (7 terms in <1s triggered it for cpnnick's
  //    rebuy). Sleeping ~400ms between terms keeps the request rate
  //    under the threshold without meaningfully extending wall-clock
  //    (most buys settle on the first term). The PER-CALL meta-refresh
  //    retry inside `searchFillerCandidatesViaHttp` is the safety net
  //    if pacing isn't enough.
  const INTER_TERM_DELAY_MS = 400;
  const candidates: SearchResultCandidate[] = [];
  let csrf: string | null = null;
  let metaRefreshHits = 0;
  for (let termIdx = 0; termIdx < terms.length; termIdx++) {
    const term = terms[termIdx]!;
    if (candidates.length >= targetCount) break;
    if (termIdx > 0) {
      await new Promise((r) => setTimeout(r, INTER_TERM_DELAY_MS));
    }
    const { candidates: found, diag } = await searchFillerCandidatesViaHttp(
      mainPage,
      term,
      fillerOpts.pool,
    );
    if (diag.metaRefresh) metaRefreshHits++;
    if (found.length === 0) {
      // Enriched diagnostic — disambiguates the empty case:
      //   bodyLen=0 + status=-1 → request threw (network error)
      //   bodyLen<5_000 + status=200 → Amazon returned a near-empty
      //     response (often the lightweight robot-check page)
      //   looksLikeCaptcha=true → caught Amazon's bot challenge
      //   metaRefresh=true → Amazon's rate-limit interstitial (we
      //     retried up to 2× per call already; if still set, this
      //     account is being throttled)
      //   totalCardsParsed>0 + rejectedByFilter → cards parsed but
      //     every one was rejected (Prime/price gate too strict)
      //   totalCardsParsed=0 + bodyLen>50k → parser miss; Amazon
      //     likely shipped a layout we don't recognize
      logger.warn(
        'step.fillerBuy.fillers.searchEmpty',
        { term, ...diag },
        cid,
      );
      continue;
    }
    let added = 0;
    let blocked = 0;
    for (const c of found) {
      if (candidates.length >= targetCount) break;
      if (seen.has(c.asin)) continue;
      seen.add(c.asin);
      // Per-pool title blocklist (e.g. eero pool excludes Echo / Fire
      // TV / Kindle / Ring / Alexa). Tracked separately from `seen`
      // so a future `general`-pool retry could still consider these.
      if (isBlockedByPool(fillerOpts.pool, c.title)) {
        blocked++;
        continue;
      }
      candidates.push(c);
      added++;
      if (csrf === null) csrf = c.csrf;
    }
    logger.info(
      'step.fillerBuy.fillers.searchHit',
      {
        term,
        fresh: added,
        ...(blocked > 0 ? { blockedByPool: blocked } : {}),
        totalCandidates: candidates.length,
        of: targetCount,
      },
      cid,
    );
  }

  // Last-resort browser fallback. Triggers ONLY when every HTTP term
  // hit the meta-refresh rate-limit stub — that's the one failure
  // mode browser nav can paper over (real Chromium nav handles the
  // stub natively; Amazon's anti-bot is HTTP-API-specific). Costs
  // ~1.5-3s; we cap at one attempt with the first term in the pool.
  if (
    (candidates.length === 0 || csrf === null) &&
    metaRefreshHits > 0 &&
    metaRefreshHits === terms.length &&
    terms[0]
  ) {
    logger.warn(
      'step.fillerBuy.fillers.browserFallback',
      { term: terms[0], reason: 'every HTTP term rate-limited; trying browser nav' },
      cid,
    );
    const browserCandidates = await searchFillerCandidatesViaBrowser(
      mainPage,
      terms[0],
      fillerOpts.pool,
    );
    let added = 0;
    let blocked = 0;
    for (const c of browserCandidates) {
      if (candidates.length >= targetCount) break;
      if (seen.has(c.asin)) continue;
      seen.add(c.asin);
      if (isBlockedByPool(fillerOpts.pool, c.title)) {
        blocked++;
        continue;
      }
      candidates.push(c);
      added++;
      if (csrf === null) csrf = c.csrf;
    }
    logger.info(
      'step.fillerBuy.fillers.browserFallback.result',
      {
        fresh: added,
        ...(blocked > 0 ? { blockedByPool: blocked } : {}),
        totalCandidates: candidates.length,
        of: targetCount,
      },
      cid,
    );
  }

  if (candidates.length === 0 || csrf === null) {
    logger.warn(
      'step.fillerBuy.fillers.noCandidates',
      { termsTried: terms.length, targetCount, metaRefreshHits },
      cid,
    );
    return { added: 0, asins: [], metaRefreshHits, termsTried: terms.length };
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
    return { added: 0, asins: [], metaRefreshHits, termsTried: terms.length };
  }
  const tookMs = Date.now() - t0;
  if (!res.ok()) {
    logger.warn(
      'step.fillerBuy.fillers.batch.httpError',
      { status: res.status(), candidates: items.length, tookMs },
      cid,
    );
    return { added: 0, asins: [], metaRefreshHits, termsTried: terms.length };
  }
  const respText = await res.text().catch(() => '');
  if (!looksLikeCartResponse(respText)) {
    logger.warn(
      'step.fillerBuy.fillers.batch.shapeMismatch',
      { status: res.status(), candidates: items.length, tookMs },
      cid,
    );
    return { added: 0, asins: [], metaRefreshHits, termsTried: terms.length };
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
  return { added: committed.length, asins: committed, metaRefreshHits, termsTried: terms.length };
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
  logCtx: Record<string, unknown> = {},
  debugDir?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Shadow `logger` so the 2 call sites in this function get the disk-log
  // routing fields (jobId+profile) merged in. See makeBoundLogger above.
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const logger = makeBoundLogger(loggerImport, logCtx);
  const TOTAL_DEADLINE_MS = 30_000;
  const MAX_BYG_CLICKS = 2;
  const start = Date.now();
  let bygClicks = 0;

  // Proceed-to-Checkout was clicked but the page never landed on /spc.
  // We have no idea where it parked — /errors/500, a BYG loop, a
  // signin redirect, a stalled nav. Probe the likely landmarks (always
  // on) + drop a dev-only HTML/PNG snapshot so the next occurrence is
  // diagnosable. captureDebugSnapshot writes only on dev runs.
  const captureSpcMiss = async (): Promise<{ ok: false; reason: string }> => {
    const probe = await probePageDiag(page, {
      page_headings: 'h1, h2',
      byg_header: BYG_HEADER_SELECTOR,
      byg_button: BYG_BUTTON_SELECTOR,
      signin_form: 'form#ap_signin_form, input#ap_email',
      captcha: 'form[action*="validateCaptcha"], #captchacharacters',
      spc_place_order: 'input[name="placeYourOrder1"]',
      cart_proceed: 'input[name="proceedToRetailCheckout"]',
    }).catch(() => null);
    logger.warn(
      'step.fillerBuy.spc.notReached.probe',
      { url: page.url(), probe },
      cid,
    );
    const snap = await captureDebugSnapshot(page, debugDir, 'spc_not_reached');
    if (snap) {
      logger.info(
        'step.fillerBuy.spc.notReached.snapshot',
        { png: snap.pngPath, html: snap.htmlPath },
        cid,
      );
    }
    return { ok: false, reason: 'did not reach /spc after Proceed to Checkout' };
  };

  while (true) {
    if (SPC_URL_MATCH.test(page.url())) return { ok: true };

    const remaining = TOTAL_DEADLINE_MS - (Date.now() - start);
    if (remaining <= 0) {
      return captureSpcMiss();
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
      return captureSpcMiss();
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
  return isTargetInActiveCart(htmlToDocument(html), asin);
}
