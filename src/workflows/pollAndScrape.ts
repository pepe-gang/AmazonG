import type { Page } from 'playwright';
import type { BGClient } from '../bg/client.js';
import type { DriverSession } from '../browser/driver.js';
import type { FillerPool } from '../shared/ipc.js';
import { openSession } from '../browser/driver.js';
import { surfaceUnreconciledBreadcrumbs } from './surfaceUnreconciled.js';
import { reconcileLedgerToBG } from './reconcileLedger.js';
import { scrapeProduct } from '../actions/scrapeProduct.js';
import {
  buyNow,
  captureDebugSnapshot,
  isUnpackagedRun,
  probePageDiag,
} from '../actions/buyNow.js';
import { clearCartHttpOnly, type ClearCartResult } from '../actions/clearCart.js';
import {
  buyWithFillers,
  rescanFillerOrderIds,
  type BuyWithFillersResult,
} from '../actions/buyWithFillers.js';
import {
  cancelFillerOrder,
  cancelFillerOrderViaOrderDetails,
} from '../actions/cancelFillerOrder.js';
import { cancelNonTargetItems } from '../actions/cancelNonTargetItems.js';
import {
  selectBuyProfiles,
  selectVerifyTrackingProfile,
} from './profileFilters.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { fetchTracking } from '../actions/fetchTracking.js';
import { DEFAULT_CONSTRAINTS, verifyProductDetailed } from '../parsers/productConstraints.js';
import { runBuyTuple } from './runners.js';
import { buildBuyJobReport } from './jobReport.js';
import { shouldUseFillers } from '../shared/fillerMode.js';
import { logger } from '../shared/logger.js';
import { captureFailureSnapshot, discardTracing, startTracing } from '../browser/snapshot.js';
import { makeAttemptId, parseAsinFromUrl } from '../shared/sanitize.js';
import type {
  AmazonProfile,
  AutoGJob,
  BGAddress,
  BuyResult,
  JobAttempt,
  JobAttemptStatus,
  PaymentCardFill,
  ProductInfo,
} from '../shared/types.js';

export type JobAttemptStore = {
  create(
    partial: Omit<JobAttempt, 'createdAt' | 'updatedAt'>,
  ): Promise<JobAttempt>;
  update(
    attemptId: string,
    patch: Partial<Omit<JobAttempt, 'attemptId' | 'jobId' | 'amazonEmail' | 'createdAt'>>,
    opts?: { forceFlush?: boolean },
  ): Promise<JobAttempt | null>;
  get(attemptId: string): Promise<JobAttempt | null>;
  /**
   * Collect every Amazon order id our prior buys produced on this
   * amazon account within the last `withinMs` ms. Includes both the
   * target `orderId` and every `fillerOrderIds` entry.
   *
   * Used by `buyWithFillers`'s pre-buy snapshot (v0.13.43) to defeat
   * Amazon's order-history propagation race: when buy A finishes and
   * buy B starts shortly after on the same account, the order-history
   * page sometimes hasn't surfaced A's new order by the time B
   * snapshots. Without this seed, B's `post − pre` diff falsely
   * attributes A's order to B's fan-out. With this seed, A's orderIds
   * are pre-added to the pre-set even when the page didn't show them
   * yet — the diff filters them out correctly.
   *
   * Returns an empty array on store-read failure (defensive). Caller
   * treats empty as "no seed available, page snapshot is authoritative."
   */
  recentOrderIdsForEmail(
    amazonEmail: string,
    withinMs: number,
  ): Promise<string[]>;
};

export type Deps = {
  bg: BGClient;
  userDataRoot: string;
  /** Where buyNow drops debug screenshots when checkout silently fails. */
  debugDir: string;
  headless: boolean;
  /**
   * Global "Buy with Fillers" switch — when true EVERY enabled account's
   * buy phase routes through the cart+filler flow (Buy Now as add-to-cart,
   * 10 filler items, Proceed to Checkout, then the shared SPC tail).
   * When true the fan-out concurrency also drops to 1 (one account at a
   * time) so we don't hammer Amazon with parallel filler sessions.
   */
  buyWithFillers: boolean;
  /**
   * Target filler count for non-eero pools. User-configurable in
   * Settings → Accounts → Buy-with-Fillers (default 8). Eero stays
   * hardcoded at 5 — its smaller candidate pool can't reliably
   * produce more.
   */
  fillerCount: number;
  minCashbackPct: number;
  allowedAddressPrefixes: string[];
  /**
   * Whether the cashback-recovery path is allowed to mutate the
   * saved-address name with a (BG1)/(BG2) suffix. False = skip the
   * inline toggle and fail with the original cashback_gate reason.
   * Defaults to true on every plumb-through to preserve legacy
   * behavior for callers (tests, scripts) that don't set it.
   */
  bgNameToggleEnabled: boolean;
  /**
   * Global Prime-badge gate override. When true, every verify call
   * skips the visible ✓prime check (`requirePrime` is forced to
   * false in the constraints). Composes OR-wise with BG's per-job
   * `bypassPrimeCheck`. Defaults to false.
   */
  bypassPrimeCheck: boolean;
  /**
   * Re-read each per-claim from disk so the user can tune Parallel
   * buys in Settings without stopping the worker. Returns the
   * parallel-buy knobs as a struct; we don't pass the whole Settings
   * object so the worker stays decoupled from fields it doesn't care
   * about.
   */
  loadParallelism: () => Promise<{
    maxConcurrentBuys: number;
    /** Per-attempt filler-pool plan — array length is the retry count,
     *  each entry is that attempt's search-term pool. Read every claim
     *  so a Settings change takes effect on the next deal without
     *  restarting the worker. */
    fillerAttempts: FillerPool[];
  }>;
  /** Returns every enabled+loggedIn profile we should fan out the job to. */
  listEligibleProfiles: () => Promise<AmazonProfile[]>;
  /** Mark a profile signed-out and broadcast the change. Called by the
   *  verify/fetch_tracking phases when Amazon redirects an authenticated
   *  request to /ap/signin — the session is dead, the JobsTable's
   *  "Signed out" pill should flip on without waiting for a manual
   *  refresh. Best-effort; never blocks worker progress. */
  markProfileSignedOut?: (email: string) => Promise<void>;
  /** Persistence for the jobs table — created on fan-out, updated as profiles run. */
  jobAttempts: JobAttemptStore;
  /**
   * Optional: look up a session for this profile that lives OUTSIDE
   * the worker's own sessions map — e.g. a "View Order" window the
   * user opened from the Jobs table. Chromium holds a per-profile
   * SingletonLock on the userDataDir, so if such a window exists and
   * we blindly call openSession() we'll fail with "profile in use".
   * Reusing the existing context (new tab inside it) is always safe.
   *
   * Return null when nothing is open for this profile.
   */
  findExistingSession?: (email: string) => DriverSession | null;
  /**
   * Resolver for Amazon's PMTS "Verify your card" checkout challenge.
   * Given a card's last 4 digits it returns the full number from the
   * encrypted local card vault (main-process only), or null when no
   * saved card matches. Threaded into buyNow / buyWithFillers so the
   * challenge is auto-handled instead of failing to action_required.
   * Optional — when absent the worker keeps the legacy fail behavior.
   */
  resolveCardNumber?: (last4: string) => Promise<string | null>;
  /**
   * Resolve a vault card by id — used to auto-add the account's
   * assigned payment card when checkout has no payment method.
   * Optional; when absent the worker fails to action_required.
   */
  resolveCardById?: (cardId: string) => Promise<PaymentCardFill | null>;
};

export type WorkerHandle = {
  stop(): Promise<void>;
  /**
   * If the worker currently holds a live session for `email`, navigate one
   * of its tabs to `url` and return true. Lets the renderer open a profile
   * URL inside the worker's already-launched Chromium instead of racing
   * the userDataDir lock with a second browser process.
   */
  openProfileTab(email: string, url: string): Promise<boolean>;
};

/** Fallback default for the parallel-buy setting if a Settings field
 *  is missing (e.g. upgrading from a version that didn't ship it).
 *  loadSettings itself merges defaults — belt-and-suspenders. The
 *  streaming scheduler clamps to Math.max(1, …) at the call site. */
const DEFAULT_CONCURRENT_BUYS = 3;

/**
 * Filler-buy failure stages that a re-run cannot fix — we stop
 * retrying immediately when we hit one, regardless of how many
 * attempts the user configured in `fillerAttempts`.
 *
 *  - confirm_parse:    the order MAY already be placed (a re-run would
 *                      risk a duplicate order — the ghost-order class
 *                      of bug). Never retry.
 *  - item_unavailable: the product is out of stock / unavailable.
 *  - checkout_price:   price is over cap; it won't change in seconds.
 *  - product_verify:   product-page gate failed (prime, condition…).
 *  - checkout_address: address config problem.
 *
 * Every other stage (cashback_gate, place_order, clear_cart, the /spc
 * waits, etc.) is transient or shuffle-fixable, so the configured
 * attempts run. Cashback_gate in particular benefits: the 6% back
 * eligibility rides Amazon's random shipping-group assignment, which
 * depends on which fillers land in the cart — a fresh filler set
 * often re-rolls the target into a 6%-eligible group.
 */
// Typed against BuyResult's failure-stage union (not bare `string`) so
// a stage rename breaks this set at compile time instead of silently
// turning the guard off — e.g. dropping `confirm_parse` from the guard
// would make a confirmation-timeout failure retry and risk a duplicate
// order, the exact thing this set exists to prevent.
type BuyFailStage = Extract<BuyResult, { ok: false }>['stage'];
const NON_RETRYABLE_BUY_STAGES: ReadonlySet<BuyFailStage> = new Set<
  BuyFailStage
>([
  'confirm_parse',
  'item_unavailable',
  'checkout_price',
  'product_verify',
  'checkout_address',
  'checkout_payment',
]);

/**
 * Verify-phase filler cleanup. Runs after verifyOrder confirms the
 * target order is still active on a viaFiller job. Two tasks:
 *
 *   1. For every filler-only order id we captured at buy time: re-try
 *      cancelling it. Amazon sometimes silently rejects the pre-ship
 *      cancel we attempted right after placement (or we misdetected a
 *      success); the ~10-min delay before verify gives the order more
 *      time to become cancellable.
 *   2. For the target's order: cancel every item EXCEPT the target.
 *      This removes the filler items that got bundled into the same
 *      order as the target (per Amazon's shipping-group fan-out).
 *
 * Up to MAX_CANCEL_TRIES attempts per order. Amazon's "Unable to
 * cancel requested items" is a terminal state (items already locked
 * for shipment) — no amount of retry will help, and we stop retrying
 * for that specific order as soon as we see it.
 *
 * Returns a summary that the caller can log or persist into
 * attempt.error. Never throws.
 */
/**
 * Reasons that mean "stop retrying this order" — something on Amazon's
 * side prevents the cancel from ever succeeding, regardless of how
 * many times we ask.
 *
 *   - "unable to cancel": Amazon's explicit refusal banner (items
 *     locked for fulfillment)
 *   - "not on cancel-items page": order redirected away → already
 *     cancelled or shipped
 *   - "could not identify target item": we can't confidently locate
 *     the target; retrying won't make our locator smarter
 *   - "only target item is cancellable": nothing else to cancel,
 *     effectively done
 */
function isTerminalCancelReason(reason: string): boolean {
  return (
    /unable to cancel/i.test(reason) ||
    /not on cancel-items page/i.test(reason) ||
    /could not identify target item/i.test(reason) ||
    /only target item is cancellable/i.test(reason) ||
    // Amazon accepted the cancel request into async processing (the
    // "Attempting to cancel requested items / We'll email you" banner).
    // Terminal within this verify pass — re-clicking just lands on the
    // same banner. Future verify passes will re-check whether the
    // cancellation actually took effect on Amazon's side.
    /pending_amazon_decision/i.test(reason)
  );
}

/**
 * Filler-only cancel pass. Walks `fillerOrderIds` and tries to cancel
 * each one with up to 3 attempts and an 8s backoff between attempts.
 * Terminal-reason exits (Amazon refuses, redirected away, etc.) skip
 * the rest of the retry budget for that specific order.
 *
 * Used by both:
 *   - `runVerifyFillerCleanup` (verify phase, target order is active)
 *   - the cancelled-target branch in `handleVerifyJob` (Amazon
 *     cancelled the target, but the filler items the buy fan-out
 *     dropped into separate orders may still be live — we cancel
 *     those so the customer isn't on the hook for items they didn't
 *     intend to buy).
 */
async function cancelFillerOrdersOnly(
  page: Page,
  fillerOrderIds: string[],
  cid: string,
  /** Defense-in-depth safety: when provided, filter `targetOrderId`
   *  out of the cancel list before processing. The caller's
   *  classification logic is supposed to keep target out of
   *  fillerOrderIds, but a parsing edge case or future regression
   *  could let it slip through — and a single bad cancel of the
   *  user's real order is catastrophic. Logs a warn if the filter
   *  actually removes anything so the upstream misclassification is
   *  visible in audit. */
  targetOrderId?: string,
): Promise<{
  fillerOrdersCancelled: string[];
  fillerOrdersFailed: string[];
}> {
  if (targetOrderId && fillerOrderIds.includes(targetOrderId)) {
    logger.warn(
      'step.cancelFillerOrdersOnly.target_in_list',
      {
        targetOrderId,
        listSize: fillerOrderIds.length,
        message: `targetOrderId was in fillerOrderIds — filtered out to prevent cancelling the real order. Upstream classification has a bug.`,
      },
      cid,
    );
    fillerOrderIds = fillerOrderIds.filter((id) => id !== targetOrderId);
  }
  const MAX_TRIES = 3;
  const fillerOrdersCancelled: string[] = [];
  const fillerOrdersFailed: string[] = [];
  for (const fillerOrderId of fillerOrderIds) {
    let cancelled = false;
    let terminalRefusal = false;
    let lastReason: string | undefined;
    for (let tryN = 1; tryN <= MAX_TRIES; tryN++) {
      const r = await cancelFillerOrder(page, fillerOrderId, {
        correlationId: cid,
      });
      if (r.ok) {
        cancelled = true;
        logger.info(
          'job.verify.filler.orderCancelled',
          { orderId: fillerOrderId, itemsChecked: r.itemsChecked, attempt: tryN },
          cid,
        );
        break;
      }
      lastReason = r.reason;
      logger.warn(
        'job.verify.filler.orderCancel.attempt',
        { orderId: fillerOrderId, attempt: tryN, reason: r.reason, detail: r.detail },
        cid,
      );
      if (isTerminalCancelReason(r.reason)) {
        terminalRefusal = true;
        break;
      }
      if (tryN < MAX_TRIES) await page.waitForTimeout(8_000);
    }
    if (!cancelled) {
      // Order-details fallback. The primary cancel-items-page approach
      // can fail silently in two ways the existing 3-attempt loop
      // can't recover from on its own:
      //   1. The direct `/progress-tracker/.../cancel-items` URL
      //      redirects away (yields a "not on cancel-items page"
      //      terminal reason) even though the order is still
      //      cancellable from the order-details "Cancel items" link.
      //   2. The cancel-items page is reachable but the form-submit
      //      doesn't land — Amazon shows no banner, our retries see
      //      the same dead state.
      // Try the order-details path once as the very last shot. We
      // want to attempt this even when we hit a terminal refusal,
      // because those terminal reasons are based on what the
      // cancel-items endpoint told us — order-details may disagree
      // and successfully route the cancel through.
      logger.info(
        'job.verify.filler.orderCancel.fallback.start',
        { orderId: fillerOrderId, priorReason: lastReason, terminalRefusal },
        cid,
      );
      const fb = await cancelFillerOrderViaOrderDetails(page, fillerOrderId, {
        correlationId: cid,
      });
      if (fb.ok) {
        cancelled = true;
        logger.info(
          'job.verify.filler.orderCancel.fallback.ok',
          { orderId: fillerOrderId, itemsChecked: fb.itemsChecked },
          cid,
        );
      } else {
        logger.warn(
          'job.verify.filler.orderCancel.fallback.failed',
          { orderId: fillerOrderId, reason: fb.reason, detail: fb.detail },
          cid,
        );
        // Surface the fallback's reason as the most-recent failure
        // signal so the giveup log captures the freshest context.
        lastReason = fb.reason;
      }
    }
    if (cancelled) fillerOrdersCancelled.push(fillerOrderId);
    else {
      fillerOrdersFailed.push(fillerOrderId);
      logger.warn(
        'job.verify.filler.orderCancel.giveup',
        { orderId: fillerOrderId, lastReason, terminalRefusal },
        cid,
      );
    }
  }
  return { fillerOrdersCancelled, fillerOrdersFailed };
}

async function runVerifyFillerCleanup(
  page: Page,
  targetOrderId: string,
  fillerOrderIds: string[],
  target: { asin: string | null; title: string | null },
  cid: string,
): Promise<{
  fillerOrdersCancelled: string[];
  fillerOrdersFailed: string[];
  targetOrderCleaned: boolean;
  targetCleanError: string | null;
  /**
   * True when cancelNonTargetItems returned
   * `code: 'target_absent_from_cancel_page'` on any attempt — i.e. the
   * cancel page renders sibling items but not the target's checkbox.
   * Combined with `outcome.kind === 'active'` upstream, this is the
   * canonical signal that the target was cancelled while sibling
   * fillers remain alive (BG flips status to `target_cancelled`).
   */
  targetAbsentFromCancelPage: boolean;
}> {
  // 2× retry budget per verify pass (was 3). Combined with the
  // "Attempting to cancel" success-detector fix in cancelForm.ts:
  // - happy path lands on attempt 1 (no retries needed)
  // - terminal-failure paths break early via isTerminalCancelReason
  // - transient failures get exactly one retry, then we surface the
  //   "Uncancelled filler orders" warning so the user can click
  //   "Cancel filler" manually instead of the worker burning verify
  //   cycles in a 3-deep loop the user described as "bot keeps
  //   re-trying".
  const MAX_TRIES = 2;

  // 1. Cancel the filler-only orders (orders that do NOT contain the target).
  const { fillerOrdersCancelled, fillerOrdersFailed } =
    await cancelFillerOrdersOnly(page, fillerOrderIds, cid, targetOrderId);

  // 2. Clean the target order — cancel everything except the target.
  let targetOrderCleaned = false;
  let targetCleanError: string | null = null;
  let targetAbsentFromCancelPage = false;
  for (let tryN = 1; tryN <= MAX_TRIES; tryN++) {
    const r = await cancelNonTargetItems(page, targetOrderId, target, {
      correlationId: cid,
    });
    if (r.ok) {
      targetOrderCleaned = true;
      logger.info(
        'job.verify.filler.targetCleaned',
        { orderId: targetOrderId, cancelled: r.cancelled, kept: r.kept, attempt: tryN },
        cid,
      );
      break;
    }
    targetCleanError = r.reason;
    // Surface the structured "target absent from cancel page" signal
    // to the caller — see runVerifyFillerCleanup's return-type comment.
    if (r.code === 'target_absent_from_cancel_page') {
      targetAbsentFromCancelPage = true;
    }
    logger.warn(
      'job.verify.filler.targetClean.attempt',
      { orderId: targetOrderId, attempt: tryN, reason: r.reason, detail: r.detail, code: r.code ?? null },
      cid,
    );
    // "only target cancellable" is a terminal state, but unlike the
    // others it's effectively success — nothing else to cancel means
    // the cleanup achieved its goal.
    if (/only target item is cancellable/i.test(r.reason)) {
      targetOrderCleaned = true;
      break;
    }
    if (isTerminalCancelReason(r.reason)) break;
    if (tryN < MAX_TRIES) await page.waitForTimeout(2_500);
  }

  return {
    fillerOrdersCancelled,
    fillerOrdersFailed,
    targetOrderCleaned,
    targetCleanError,
    targetAbsentFromCancelPage,
  };
}

/**
 * Verify-phase filler cleanup for outcomes where we couldn't read the
 * target's state (`error`, `timeout`). Loads the buy attempt to pull
 * the persisted `fillerOrderIds`, runs `cancelFillerOrdersOnly` against
 * them, and logs the result. Best-effort — swallows its own errors so
 * the calling branch's status writes are unaffected.
 *
 * Distinct from `runVerifyFillerCleanup` (used on `active` outcome,
 * which also runs `cancelNonTargetItems` against the target order).
 * On error/timeout the target's state is unknown, so we ONLY clean up
 * the standalone filler orders — touching the target could cancel the
 * customer's actual purchase if it's secretly still alive.
 *
 * Always-run reason: the original bug (filler order left active when
 * the target was cancelled by Amazon) generalizes — Amazon also
 * occasionally surfaces a transient error/timeout on order-details for
 * orders whose fillers are very-much live and cancellable. Skipping
 * cleanup on those outcomes loses our chance to act before fillers
 * ship.
 */
/**
 * Resolve the buy-attempt row for a verify- or fetch_tracking-phase
 * job and pull the filler context (filler order ids + Amazon's
 * actual product title) that was persisted at buy time. The buy
 * attempt is keyed by `buyJobId + email` so a verify or
 * fetch_tracking job rolling forward against the original buy can
 * find the right row; falls back to `activeAttemptId` when the BG
 * payload doesn't carry a `buyJobId` (e.g. some legacy paths).
 *
 * Returns empty arrays / null when the row isn't on disk locally
 * (best-effort store reads — never throws). Callers gate their
 * cleanup work on `fillerOrderIds.length > 0`.
 */
/** Format the "N filler order(s) still uncancelled: id1, id2" error
 *  fragment used in both the verify-active and verify-cancelled
 *  paths. Returns null when nothing failed. */
function formatUncancelledFillerError(failed: string[]): string | null {
  if (failed.length === 0) return null;
  return `${failed.length} filler order(s) still uncancelled: ${failed.join(', ')}`;
}

async function loadFillerBuyContext(
  deps: Deps,
  job: AutoGJob,
  profileEmail: string,
  activeAttemptId: string,
): Promise<{
  buyAttemptId: string;
  fillerOrderIds: string[];
  cartAsins: string[];
  productTitle: string | null;
  /** Pre-buy order-history snapshot. Null when not captured (pre-feature
   *  attempts in the local store) — caller falls back to the legacy
   *  ASIN-walker in that case. */
  preBuyOrderIds: string[] | null;
}> {
  const buyAttemptId = job.buyJobId
    ? makeAttemptId(job.buyJobId, profileEmail)
    : activeAttemptId;
  const attempt = await deps.jobAttempts.get(buyAttemptId).catch(() => null);
  return {
    buyAttemptId,
    fillerOrderIds: attempt?.fillerOrderIds ?? [],
    cartAsins: attempt?.cartAsins ?? [],
    productTitle: attempt?.productTitle ?? null,
    preBuyOrderIds: attempt?.preBuyOrderIds ?? null,
  };
}

async function runVerifyFillerCleanupSweep(
  deps: Deps,
  page: Page,
  job: AutoGJob,
  activeAttemptId: string,
  profileEmail: string,
  targetOrderId: string,
  outcomeKind: 'error' | 'timeout',
  logCtx: Record<string, unknown>,
  cid: string,
): Promise<void> {
  try {
    const { fillerOrderIds } = await loadFillerBuyContext(
      deps,
      job,
      profileEmail,
      activeAttemptId,
    );
    if (fillerOrderIds.length === 0) return;
    logger.info(
      `job.verify.${outcomeKind}.filler.cleanup.start`,
      { ...logCtx, targetOrderId, fillerOrderIdCount: fillerOrderIds.length },
      cid,
    );
    const cleanup = await cancelFillerOrdersOnly(page, fillerOrderIds, cid, targetOrderId);
    logger.info(
      `job.verify.${outcomeKind}.filler.cleanup.done`,
      {
        ...logCtx,
        targetOrderId,
        fillerOrdersCancelled: cleanup.fillerOrdersCancelled.length,
        fillerOrdersFailed: cleanup.fillerOrdersFailed.length,
      },
      cid,
    );
  } catch (err) {
    // Cleanup is best-effort — never let it bubble out and rewrite the
    // failure/timeout status the caller is about to set.
    logger.warn(
      `job.verify.${outcomeKind}.filler.cleanup.threw`,
      { ...logCtx, targetOrderId, err: err instanceof Error ? err.message : String(err) },
      cid,
    );
  }
}

type FillerRunResult = {
  /** BuyResult-shaped adapter output the rest of runForProfile consumes. */
  buy: BuyResult;
  /**
   * Filler-only order ids from this buy (orders that don't contain the
   * target ASIN). Empty on dry-run or failure. Persisted to the job
   * attempt so verify phase can re-attempt cancellation.
   */
  fillerOrderIds: string[];
  /**
   * Full cart ASIN list at Place Order time (target + every committed
   * filler). Persisted so verify phase can re-scan order history with
   * the full list and catch filler-only orders that hadn't propagated
   * yet at buy-time. Empty on dry-run / failure / single-mode.
   */
  cartAsins: string[];
  /**
   * Pre-buy order-history snapshot. Persisted on the JobAttempt so the
   * verify rescan can use snapshot-diff instead of the ASIN-walker
   * (defeats the prev-order-bleed bug where today's filler ASIN
   * matches a 2-day-old order with the same ASIN). Empty on
   * non-filler / dry-run / failure.
   */
  preBuyOrderIds: string[];
  /**
   * Amazon's actual product title for the target (from /spc scraping).
   * Persisted so verify phase can locate the target on the cancel-
   * items page without needing ASIN (Chewbacca hides ASINs).
   */
  productTitle: string | null;
};

async function runFillerBuyWithRetries(
  page: Page,
  deps: Deps,
  job: AutoGJob,
  cid: string,
  /** Amazon profile email — threaded into BuyWithFillersOptions.profile
   *  so the disk-log sink routes step.fillerBuy.* events to the right
   *  per-attempt jsonl. */
  profile: string,
  /** Per-profile override of the min-cashback floor. See runForProfile. */
  minCashbackPct: number,
  /** Per-profile cashback gate enforcement. See runForProfile. */
  requireMinCashback: boolean,
  /** Live per-attempt filler-pool plan, re-read each claim. Array
   *  length is the retry count; entry N is attempt N's pool.
   *  Single-mode buys never reach here. */
  fillerAttempts: FillerPool[],
  /** Pre-scraped info from the worker's verify phase. Passed to the
   *  FIRST attempt so buyWithFillers can skip its internal scrapeProduct
   *  (saves 2-4s). Subsequent retries refetch in case Amazon changed
   *  state (price drift, OOS) between attempts. */
  prescrapedInfo: ProductInfo | undefined,
  /** Pre-flight clearCart promise from pollAndScrape. Forwarded to
   *  attempt 1 so the parallel HTTP-clear can be consumed. Attempts
   *  2/3 re-run the full clearCart since a previous attempt may have
   *  left the cart in an unknown state. */
  preflightCleared: Promise<ClearCartResult> | undefined,
  /** The account's BG receiving address — auto-added at checkout when
   *  Amazon parks on the "Add delivery address" state. */
  bgAddress: BGAddress | null,
  /** The account's assigned payment card — auto-added at checkout
   *  when Amazon has no payment method on file. */
  paymentCard: PaymentCardFill | null,
  onStage?: (stage: 'placing' | null) => void | Promise<void>,
): Promise<FillerRunResult> {
  let lastRaw: BuyWithFillersResult = {
    ok: false,
    stage: 'cashback_gate',
    reason: 'filler buy never ran',
  };
  // Shared dedup set across the up-to-3 attempts. Each call to
  // buyWithFillers seeds its picker from this Set and adds every
  // ASIN it considers (via addFillerItems → state.seen, which is
  // this same Set by reference). Means attempt 2/3 won't re-pick
  // anything attempt 1 tried — different fillers → different
  // shipping-group fan-out → different cashback eligibility, which
  // is the whole point of retrying on a cashback_gate miss.
  const attemptedAsins = new Set<string>();
  // The number of attempts and each attempt's pool come straight from
  // the user's `fillerAttempts` setting (clamped to 1–5 on load).
  const maxAttempts = Math.max(1, fillerAttempts.length);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const effectivePool: FillerPool =
      fillerAttempts[attempt - 1] ?? fillerAttempts[0] ?? 'eero';
    if (attempt > 1) {
      logger.info(
        'step.fillerBuy.retryWhole.start',
        {
          attempt,
          maxAttempts,
          priorReason: lastRaw.ok ? null : lastRaw.reason,
          excludedAsinsCount: attemptedAsins.size,
          effectivePool,
          ...(effectivePool !== fillerAttempts[0]
            ? { poolSwitched: true }
            : {}),
        },
        cid,
      );
    }
    // Seed for the pre-buy snapshot: orderIds from prior buys on this
    // amazon account in the last 10 min. Defeats Amazon's order-history
    // propagation race — a recently-completed prior buy whose orderId
    // hasn't yet appeared on /gp/css/order-history would otherwise
    // sneak into the post-buy diff and false-attribute as this buy's
    // filler. Caller-side lookup keeps the layering clean (action
    // code doesn't reach into the local attempts store directly).
    const RECENT_ORDER_WINDOW_MS = 10 * 60 * 1000;
    const recentOrderIds = await deps.jobAttempts
      .recentOrderIdsForEmail(profile, RECENT_ORDER_WINDOW_MS)
      .catch(() => [] as string[]);

    lastRaw = await buyWithFillers(page, {
      productUrl: job.productUrl,
      maxPrice: job.maxPrice,
      allowedAddressPrefixes: deps.allowedAddressPrefixes,
      bgAddress,
      paymentCard,
      minCashbackPct,
      requireMinCashback,
      bypassPriceCheck: job.bypassPriceCheck === true,
      // Global Settings.bypassPrimeCheck applies in addition to the
      // per-job flag — matches the outer PDP-verify in runForProfile.
      bypassPrimeCheck:
        job.bypassPrimeCheck === true || deps.bypassPrimeCheck === true,
      bgNameToggleEnabled: deps.bgNameToggleEnabled,
      resolveCardNumber: deps.resolveCardNumber,
      fillerPool: effectivePool,
      fillerCount: deps.fillerCount,
      attemptedAsins,
      recentOrderIds,
      // Only the first attempt can reuse the verify-phase scrape — by
      // attempt 2 the page state has drifted (we've been to /spc and
      // back, /cart, etc.) and a fresh scrape is needed anyway.
      prescrapedInfo: attempt === 1 ? prescrapedInfo : undefined,
      // Same reasoning for the pre-flight clearCart promise.
      preflightCleared: attempt === 1 ? preflightCleared : undefined,
      correlationId: `${cid}/attempt-${attempt}`,
      // Routing fields — see BuyWithFillersOptions.jobId docstring.
      // Without these every step.fillerBuy.* event silently drops at the
      // disk-log sink (main/index.ts:798-815).
      jobId: job.id,
      profile,
      onStage,
      // Plumb the worker's debugDir so inner helpers like
      // toggleBGNameAndRetry can dump HTML + screenshot + selector
      // probes on DOM-drift failures.
      debugDir: deps.debugDir,
    });
    if (lastRaw.ok) {
      if (attempt > 1) {
        logger.info(
          'step.fillerBuy.retryWhole.ok',
          { attempt, maxAttempts },
          cid,
        );
      }
      break;
    }
    // Stop early on a failure a re-run cannot fix (see
    // NON_RETRYABLE_BUY_STAGES) — notably confirm_parse, where a
    // retry would risk a duplicate order. Any other stage burns the
    // user's configured attempts.
    if (NON_RETRYABLE_BUY_STAGES.has(lastRaw.stage)) break;
    if (attempt >= maxAttempts) {
      logger.warn(
        'step.fillerBuy.retryWhole.exhausted',
        { attempt, maxAttempts, lastReason: lastRaw.reason },
        cid,
      );
      break;
    }
  }
  return {
    buy: fillerToBuyResult(lastRaw),
    fillerOrderIds:
      lastRaw.ok && 'fillerOrderIds' in lastRaw ? lastRaw.fillerOrderIds : [],
    cartAsins:
      lastRaw.ok && 'cartAsins' in lastRaw ? lastRaw.cartAsins : [],
    preBuyOrderIds:
      lastRaw.ok && 'preBuyOrderIds' in lastRaw ? lastRaw.preBuyOrderIds : [],
    productTitle: lastRaw.ok ? lastRaw.productInfo.title : null,
  };
}

/**
 * Translate a BuyWithFillersResult into the BuyResult shape the rest of
 * runForProfile consumes. Keeps the worker loop agnostic about which
 * flavor ran. Stage labels pass through unchanged — we broadened
 * BuyResult.stage to include the filler-specific ones so logs stay
 * faithful.
 */
function fillerToBuyResult(f: BuyWithFillersResult): BuyResult {
  if (!f.ok) {
    return {
      ok: false,
      stage: f.stage,
      reason: f.reason,
      ...(f.detail ? { detail: f.detail } : {}),
    };
  }
  return {
    ok: true,
    orderId: 'orderId' in f ? f.orderId : null,
    amazonPurchaseId: f.amazonPurchaseId,
    finalPrice: 'finalPrice' in f ? f.finalPrice : null,
    finalPriceText: 'finalPriceText' in f ? f.finalPriceText : null,
    cashbackPct: f.targetCashbackPct,
    quantity: f.placedQuantity ?? 1,
  };
}

export type ProfileResult = {
  email: string;
  status: 'completed' | 'failed' | 'action_required';
  orderId: string | null;
  placedPrice: string | null;
  placedCashbackPct: number | null;
  placedAt: string | null;
  /** Quantity actually checked out (max numeric option from /spc dropdown). */
  placedQuantity: number;
  error: string | null;
  /** Failure stage from BuyResult.stage (null on success or pre-buy
   *  verify-stage failures). Propagated to BG so the server can decide
   *  on follow-up actions like auto-rebuy on cashback_gate without
   *  text-matching the reason string. */
  stage: string | null;
  /** Filler-only order ids from this profile's Place Order fan-out.
   *  Empty on single-mode / failure. Snapshot at buy time — propagated
   *  to BG via the /status report for the audit trail. */
  fillerOrderIds: string[];
  /** Amazon's checkout-session purchaseId from the thank-you URL.
   *  Distinct from orderId; one per Place Order click, persists across
   *  fan-out splits. Null when the buy didn't reach Place Order or was
   *  a dry-run. Audit-only — see docs/research/amazon-pipeline.md. */
  amazonPurchaseId: string | null;
  /** Target ASIN parsed from job.productUrl. Forwarded to BG so each
   *  purchase row knows which product was bought, and so cancel_fillers
   *  can re-verify that a candidate filler order does NOT contain it
   *  before clicking Cancel. Null only when the productUrl lacks a
   *  parseable ASIN (rare; treated as "no defensive ASIN check"). */
  targetAsin: string | null;
  /** Full padded-cart ASIN list at buy time (target + every committed
   *  filler). Forwarded to BG so a cross-machine verify / cancel pass
   *  can re-scan order history. Empty on single-mode / dry-run / failure. */
  cartAsins?: string[];
  /** Order-history snapshot taken just before the Place Order click —
   *  the rescan diff baseline. Forwarded to BG for cross-machine
   *  reconcile. Empty when not captured. */
  preBuyOrderIds?: string[];
  /** How many filler items the buy added to the cart. Lets BG's
   *  never-give-up reconcile loop detect a gap (a filler buy that
   *  produced zero captured filler orders). 0 on single-mode buys. */
  fillersAddedCount?: number;
};

export function startWorker(deps: Deps): WorkerHandle {
  let running = true;
  const sessions = new Map<string, DriverSession>();

  // Ghost-order safety net (Part 2-safe). Surface any place-order
  // breadcrumb that never got a terminal event — a possible unrecorded
  // order from a prior run that crashed / was interrupted. Local-ledger
  // read only; fire-and-forget so it can't delay worker startup.
  void surfaceUnreconciledBreadcrumbs(deps.jobAttempts);
  // Ghost-order safety net: push every ledger-captured order id that the
  // normal report path may have failed to land to BG's recover-order
  // endpoint. Idempotent server-side; fire-and-forget.
  void reconcileLedgerToBG(deps.bg);

  let streamingHandle: { stop: () => Promise<void> } | null = null;
  // Per-job preamble for the streaming scheduler: filter eligible,
  // build per-account override maps. Called by StreamingScheduler's
  // producer for every claimed job before tuples are pushed to the
  // ready queue.
  const resolveStreamingJobContext = async (job: AutoGJob) => {
    const eligibleAll = await deps.listEligibleProfiles();
    if (eligibleAll.length === 0) return null;

    // Per-phase profile selection — see `profileFilters.ts` for the
    // pure helpers and the unit tests pinning the rules.
    //
    // Verify / fetch_tracking: only run on the account that placed
    // the order (`placedEmail`), and only if that account's `enabled`
    // is true. `autoBuy` is intentionally ignored here so the user
    // can pause new buys without losing tracking on existing orders.
    if (
      job.phase === 'verify' ||
      job.phase === 'fetch_tracking' ||
      job.phase === 'cancel_fillers'
    ) {
      const profile = selectVerifyTrackingProfile(eligibleAll, job.placedEmail);
      // Diagnose why eligible is empty so the scheduler can build a
      // specific error (and BG dashboard can distinguish "Signed Out"
      // vs "Disabled" pills). eligibleAll is the SIGNED-IN list; if
      // the target email is in it but selectVerifyTrackingProfile
      // returned null, the only reason is `enabled: false`.
      let emptyReason: 'not_signed_in' | 'disabled' | 'not_found' | undefined;
      if (!profile) {
        const target = (job.placedEmail ?? '').toLowerCase();
        if (!target) {
          emptyReason = 'not_found';
        } else if (eligibleAll.some((p) => p.email.toLowerCase() === target)) {
          emptyReason = 'disabled';
        } else {
          emptyReason = 'not_signed_in';
        }
      }
      return {
        eligible: profile ? [profile] : [],
        fillerByEmail: new Map<string, boolean>(),
        effectiveMinByEmail: new Map<string, number>(),
        requireMinByEmail: new Map<string, boolean>(),
        fillerAttempts: ['general'] as FillerPool[],
        ...(emptyReason ? { emptyReason } : {}),
      };
    }

    // Buy phase preamble:
    //   1. selectBuyProfiles applies enabled + autoBuy filter (rebuy
    //      path scopes to placedEmail). Master `enabled` flag drops
    //      accounts entirely; `autoBuy: false` keeps them live for
    //      verify/tracking but skips claiming new buy jobs.
    //   2. fillerByEmail from shouldUseFillers (per-profile decision)
    //   3. requireMinByEmail from BG's listAmazonAccounts. On failure
    //      default to gate-enforced so a BG outage can't silently
    //      skip the cashback gate.
    //   4. effectiveMinByEmail derived from per-account requireMinCashback
    //      AND-combined with job.requireMinCashback. Either side saying
    //      "skip" means skip.
    let eligible = selectBuyProfiles(eligibleAll, job.placedEmail);
    const parallelism = await deps.loadParallelism().catch(() => ({
      maxConcurrentBuys: DEFAULT_CONCURRENT_BUYS,
      fillerAttempts: ['general'] as FillerPool[],
    }));

    const fillerByEmail = new Map<string, boolean>(
      eligible.map((p) => [
        p.email,
        shouldUseFillers(deps.buyWithFillers, p, job.viaFiller),
      ]),
    );

    const accountOverrides = await deps.bg.listAmazonAccounts().catch(() => ({
      accounts: [] as Array<{ email: string; requireMinCashback: boolean }>,
      bgAccounts: [],
    }));
    const requireMinByEmail = new Map<string, boolean>(
      accountOverrides.accounts.map((a) => [
        a.email.toLowerCase(),
        a.requireMinCashback,
      ]),
    );

    const jobRequiresMinCashback = job.requireMinCashback !== false;
    const effectiveMinByEmail = new Map<string, number>(
      eligible.map((p) => {
        const accountRequires =
          requireMinByEmail.get(p.email.toLowerCase()) ?? true;
        const enforce = accountRequires && jobRequiresMinCashback;
        return [p.email, enforce ? deps.minCashbackPct : 0];
      }),
    );

    return {
      eligible,
      fillerByEmail,
      effectiveMinByEmail,
      requireMinByEmail,
      fillerAttempts: parallelism.fillerAttempts,
    };
  };

  const loop = (async () => {
    logger.info('worker.start');

    // The worker delegates to StreamingScheduler — claim jobs, fan
    // out tuples, dispatch with per-account locking. The IIFE just
    // owns lifecycle (start/stop, session cleanup).
    const initialParallelism = await deps
      .loadParallelism()
      .catch(() => null);
    const { StreamingScheduler } = await import('./scheduler.js');

    // Live-cap cache: scheduler calls cap() synchronously, but the
    // user's "Parallel buys" setting is async-loaded. Refresh the
    // cache every 5s so live tuning takes effect without restart.
    // Math.max(1, …) guards against a 0 in settings.json that would
    // otherwise stall the consumer.
    let cachedCap = Math.max(
      1,
      initialParallelism?.maxConcurrentBuys ?? DEFAULT_CONCURRENT_BUYS,
    );
    const capRefreshTimer = setInterval(() => {
      deps
        .loadParallelism()
        .then((p) => {
          cachedCap = Math.max(
            1,
            p.maxConcurrentBuys ?? DEFAULT_CONCURRENT_BUYS,
          );
        })
        .catch(() => undefined);
    }, 5_000);

    const sched = new StreamingScheduler({
      deps,
      sessions,
      parentCid: 'worker',
      cap: () => cachedCap,
      resolveJobContext: resolveStreamingJobContext,
      // Pre-claim gate: don't claim if no signed-in profile. Leaves
      // jobs queued in BG for another AmazonG instance instead of
      // claiming + failing every queued job in seconds.
      hasEligibleProfiles: async () => {
        const eligible = await deps.listEligibleProfiles().catch(() => []);
        return eligible.length > 0;
      },
    });
    logger.info('worker.scheduler.streaming.start', { initialCap: cachedCap });
    streamingHandle = sched;
    sched.start();
    // Park here while the scheduler runs. Stop() flips `running` and
    // calls streamingHandle.stop() which drains + exits.
    while (running) {
      await sleep(1_000, () => running);
    }
    clearInterval(capRefreshTimer);
    logger.info('worker.scheduler.streaming.stop');
    await closeAllSessions(sessions);
    logger.info('worker.stop');
  })();

  return {
    async stop() {
      // Flip running, drain the scheduler, close sessions. The
      // scheduler's stop() drains its ready queue + races in-flight
      // tuples, bounded at 4s. closeAllSessions afterward throws
      // 'Target closed' on any still-running Playwright op so the
      // overall Stop returns within a second or two even if a buy
      // was mid-flight. UI doesn't await `loop` — Stop click returns
      // immediately, loop drains in the background.
      running = false;
      if (streamingHandle) {
        await streamingHandle.stop().catch(() => undefined);
        streamingHandle = null;
      }
      await closeAllSessions(sessions);
    },
    async openProfileTab(email, url) {
      const session = sessions.get(email);
      if (!session) return false;
      try {
        // Open a new tab so we don't interrupt whatever job is currently
        // running in the main tab for this profile. Bring it to front.
        const page = await session.context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.bringToFront();
        return true;
      } catch (err) {
        logger.warn('worker.openProfileTab.error', { email, url, error: String(err) });
        return false;
      }
    },
  };
}


/**
 * Verify-phase job: BG sends these ~10min after a successful buy to check
 * whether Amazon cancelled the order. We don't fan out — only the profile
 * that placed the order can see it in their account history.
 *
 * The verify run does NOT create its own row in the Jobs table. It updates
 * the original buy attempt row in place (matched by buyJobId + placedEmail)
 * so the user sees a single lifecycle: queued → running → awaiting_verification
 * → verified | cancelled_by_amazon.
 *
 * Outcome → BG status:
 *   active     → 'completed' (verifies the buy stays placed)
 *   cancelled  → 'cancelled' (BG flips the original buy purchase row)
 *   timeout    → 'failed'    (BG keeps retrying / leaves as-is)
 */
// Re-exported under a tuple-shaped alias so runners.ts can import without
// circular-import warnings. Same body, same arguments.
export { handleVerifyJob as handleVerifyJobForTuple };

async function handleVerifyJob(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  job: AutoGJob,
  cid: string,
  eligible: AmazonProfile[],
): Promise<void> {
  const targetEmail = job.placedEmail;
  const targetOrderId = job.placedOrderId;
  if (!targetEmail || !targetOrderId) {
    const error = `verify: missing placedEmail (${targetEmail ?? 'null'}) or placedOrderId (${targetOrderId ?? 'null'}) on the job`;
    logger.error('job.verify.invalid', { jobId: job.id, error }, cid);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    return;
  }

  const profile = eligible.find((p) => p.email.toLowerCase() === targetEmail.toLowerCase());
  if (!profile) {
    const error = `verify: profile "${targetEmail}" not enabled or not signed in — cannot read its order history`;
    logger.error('job.verify.profile_missing', { jobId: job.id, targetEmail }, cid);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    return;
  }

  // Resolve the attempt row we'll track this verify against. Preferred:
  // roll the original buy row forward (single lifecycle). Fallback: if the
  // buy row was cleared/pruned or buyJobId is missing, create a fresh
  // phase='verify' row so the user can see the job running immediately.
  const activeAttemptId = await resolveRolloverAttemptRow(deps, job, profile.email, 'verify');

  // Verify-phase logs include `attemptId` so the log sink routes them to
  // the (usually buy-phase) attempt row this run rolls forward onto —
  // otherwise they'd land in a phantom <verifyJobId>__<email>.jsonl file
  // that has no visible row in the Jobs table and "View Log" on the
  // verified row would show buy logs only.
  const logCtx = { jobId: job.id, profile: profile.email, attemptId: activeAttemptId };

  logger.info(
    'job.verify.start',
    { ...logCtx, orderId: targetOrderId, viaFiller: job.viaFiller },
    cid,
  );

  // Track the verify-owned page so `finally` can close it without
  // touching any other tabs in the context (critical for borrowed
  // sessions where `context.pages()[0]` is the user's own window).
  let verifyPage: Page | null = null;
  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    if (await isUnpackagedRun()) await startTracing(session.context);
    // Always open a fresh page for the verify work. Reusing
    // `context.pages()[0]` would navigate a user-owned tab when the
    // session was borrowed from openOrderSessions, and leave that tab
    // pointing at the order-details page after the verify finishes
    // (closeAndForgetSession skips borrowed sessions by design).
    verifyPage = await session.newPage();
    const outcome = await verifyOrder(verifyPage, targetOrderId, {
      targetAsin: parseAsinFromUrl(job.productUrl),
    });

    if (outcome.kind === 'active') {
      logger.info(
        'job.verify.active',
        {
          ...logCtx,
          orderId: targetOrderId,
          viaFiller: job.viaFiller,
          message: `✓ Order ${targetOrderId} is still active on ${profile.email}`,
        },
        cid,
      );
      // Surface "Payment revision needed" as a warning when Amazon
      // parks the order awaiting a re-charge. The order is still
      // active and the customer's row stays `verified` — this log
      // is purely informational so View Log makes the issue visible.
      if (outcome.paymentRevisionRequired) {
        logger.warn(
          'job.verify.payment_revision',
          {
            ...logCtx,
            orderId: targetOrderId,
            message: `⚠ Payment revision needed on ${targetOrderId} — Amazon will re-attempt the charge; customer can fix the payment method on amazon.com to speed it up`,
          },
          cid,
        );
      }
      await deps.jobAttempts
        .update(activeAttemptId, {
          status: 'verified',
          error: null,
          orderId: targetOrderId,
        })
        .catch(() => undefined);

      // Filler-mode cleanup: cancel filler-only orders we couldn't
      // cancel during buy, and strip fillers out of the target's
      // order. Runs AFTER the attempt has been marked verified so a
      // cleanup failure doesn't knock the verified status back — the
      // order is successfully placed regardless, we just logged what
      // went wrong with the cancellations.
      //
      // `verifyFillerCleanup` captured here so the post-cleanup
      // `reportSafe` call below can forward `targetOrderCleanupOutcome`
      // to BG (v0.13.44+ — drives the dashboard "Uncancelled filler
      // orders" list's in-target-order row type).
      let verifyFillerCleanup: Awaited<ReturnType<typeof runVerifyFillerCleanup>> | null = null;
      if (job.viaFiller) {
        const {
          fillerOrderIds: persistedFillerOrderIds,
          productTitle,
          cartAsins,
          preBuyOrderIds: persistedPreBuyOrderIds,
        } = await loadFillerBuyContext(
          deps,
          job,
          profile.email,
          activeAttemptId,
        );
        const targetAsin = parseAsinFromUrl(job.productUrl);
        // Active-outcome rescan (audit #3). The cancelled-outcome path
        // re-scans order history for late-propagating fillers before
        // cleanup. The active path historically skipped that and only
        // cancelled buy-time-captured filler order IDs. A filler that
        // propagated to order-history between buy-time poll (~5s) and
        // verify-time (~10min) would silently slip through. Mirror
        // the cancelled-path rescan here, dedup with Set, persist
        // the merged set so audit reflects reality.
        let fillerOrderIds = persistedFillerOrderIds;
        if (cartAsins.length > 0) {
          const rescan = await rescanFillerOrderIds(
            verifyPage,
            cartAsins,
            targetOrderId,
            cid,
            persistedPreBuyOrderIds,
          );
          const known = new Set(persistedFillerOrderIds);
          const newlyFound = rescan.filter((id) => !known.has(id));
          if (newlyFound.length > 0) {
            logger.warn(
              'job.verify.filler.rescan.newlyFound',
              {
                ...logCtx,
                targetOrderId,
                buyTimeKnownCount: persistedFillerOrderIds.length,
                rescanFoundCount: rescan.length,
                newlyFoundOrderIds: newlyFound,
              },
              cid,
            );
            fillerOrderIds = Array.from(
              new Set([...persistedFillerOrderIds, ...newlyFound]),
            );
            await deps.jobAttempts
              .update(activeAttemptId, { fillerOrderIds })
              .catch(() => undefined);
          } else {
            logger.info(
              'job.verify.filler.rescan.complete',
              {
                ...logCtx,
                targetOrderId,
                buyTimeKnownCount: persistedFillerOrderIds.length,
                rescanFoundCount: rescan.length,
              },
              cid,
            );
          }
        }
        logger.info(
          'job.verify.filler.cleanup.start',
          {
            ...logCtx,
            targetOrderId,
            fillerOrderIdCount: fillerOrderIds.length,
            hasProductTitle: productTitle !== null,
            targetAsin,
          },
          cid,
        );
        const cleanup = await runVerifyFillerCleanup(
          verifyPage,
          targetOrderId,
          fillerOrderIds,
          { asin: targetAsin, title: productTitle },
          cid,
        );
        verifyFillerCleanup = cleanup;
        logger.info(
          'job.verify.filler.cleanup.done',
          {
            ...logCtx,
            targetOrderId,
            fillerOrdersCancelled: cleanup.fillerOrdersCancelled.length,
            fillerOrdersFailed: cleanup.fillerOrdersFailed.length,
            targetOrderCleaned: cleanup.targetOrderCleaned,
            targetCleanError: cleanup.targetCleanError,
          },
          cid,
        );
        // Surface any cleanup failures on the row's `error` field so a
        // human can follow up. We KEEP `fillerOrderIds` intact as the
        // immutable buy-time audit list — the user can still see every
        // filler order that came out of this purchase. The `error`
        // string carries the specific subset that's still uncancelled
        // (drives manual follow-up). Only update if there's something
        // to report.
        if (
          cleanup.fillerOrdersFailed.length > 0 ||
          !cleanup.targetOrderCleaned
        ) {
          const errorParts: string[] = [];
          const fillerError = formatUncancelledFillerError(cleanup.fillerOrdersFailed);
          if (fillerError) errorParts.push(fillerError);
          if (!cleanup.targetOrderCleaned && cleanup.targetCleanError) {
            errorParts.push(`target-order clean failed: ${cleanup.targetCleanError}`);
          }
          await deps.jobAttempts
            .update(activeAttemptId, {
              error: errorParts.join(' | '),
            })
            .catch(() => undefined);
        }
      }

      await reportSafe(
        deps,
        job.id,
        {
          status: 'completed',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
          // Forward the qty Amazon's order-details page reports. Used
          // by BG to correct any buy-time qty mis-report (e.g. /spc-DOM
          // returning 1 when Amazon actually placed 2). Only included
          // when the verify pass extracted a numeric qty — null/missing
          // leaves the existing purchasedCount alone on the BG side.
          ...(outcome.kind === 'active' && typeof outcome.placedQuantity === 'number'
            ? { correctPurchasedCount: outcome.placedQuantity }
            : {}),
          // Forward the payment-revision-needed flag when Amazon parked
          // the order awaiting a re-charge. BG persists this on the
          // AutoBuyPurchase row so its dashboard keeps the order in
          // Pending bucket (vs flipping to Success on a verify-passed
          // signal alone) — the order won't actually ship until the
          // user revises payment, so tracking is still pending until
          // either codes arrive or Amazon eventually cancels.
          ...(outcome.kind === 'active' && outcome.paymentRevisionRequired
            ? { paymentRevisionRequired: true }
            : {}),
          // Forward the verify-phase in-target-order cleanup outcome to
          // BG so the dashboard's "Uncancelled filler orders" list can
          // surface a row for target orders that still have filler
          // items inside them after cleanup. Only sent when cleanup
          // actually ran (filler-mode + outcome.kind === 'active' —
          // verifyFillerCleanup is null on non-filler buys + the
          // cancelled / error / timeout branches don't run cleanup).
          ...(verifyFillerCleanup
            ? {
                targetOrderCleanupOutcome: {
                  cleaned: verifyFillerCleanup.targetOrderCleaned,
                  error: verifyFillerCleanup.targetCleanError,
                  // True when the target's checkbox was missing from
                  // the cancel page. Combined with this branch (which
                  // only fires on outcome.kind === 'active') it tells
                  // BG: order is alive, but the target item inside it
                  // was cancelled — flip status to target_cancelled.
                  targetCancelledInsideActiveOrder:
                    verifyFillerCleanup.targetAbsentFromCancelPage,
                },
              }
            : {}),
        },
        cid,
      );
      return;
    }

    if (outcome.kind === 'cancelled') {
      logger.warn(
        'job.verify.cancelled',
        {
          ...logCtx,
          orderId: targetOrderId,
          message: `✗ Order ${targetOrderId} was cancelled by Amazon`,
        },
        cid,
      );
      await deps.jobAttempts
        .update(activeAttemptId, {
          status: 'cancelled_by_amazon',
          error: 'order was cancelled by Amazon',
          orderId: targetOrderId,
        })
        .catch(() => undefined);

      // Filler cleanup on cancelled target. Even though the target
      // order was cancelled by Amazon, the buy fan-out may have
      // dropped filler items into separate orders that are still
      // live. Cancel those so the customer isn't on the hook for
      // items they didn't intend to buy. Skips the "clean non-target
      // items from target order" step that the active path runs —
      // target is already cancelled, nothing to clean.
      //
      // Safety-net rescan: order-history is now stable (~10 min after
      // buy time, vs racy at buy time). Re-run the same DOM walker
      // against the persisted cartAsins; any orderIds in the rescan
      // result that weren't captured at buy time are filler-only
      // orders that propagated late. Union with buy-time
      // fillerOrderIds and persist the merged set so future
      // bookkeeping (cancel_fillers tasks, audit) sees the full list.
      // INC-2026-05-10 (purchaseId 106-0543366-6065024) had a
      // 114-4485329-7352228 missed at buy time; this rescan would
      // have caught it.
      let cancelledFillerError: string | null = null;
      if (job.viaFiller) {
        const { fillerOrderIds: persistedFillerOrderIds, cartAsins, preBuyOrderIds: persistedPreBuyOrderIds } =
          await loadFillerBuyContext(deps, job, profile.email, activeAttemptId);
        let mergedFillerOrderIds = persistedFillerOrderIds;
        if (cartAsins.length > 0) {
          const rescan = await rescanFillerOrderIds(
            verifyPage,
            cartAsins,
            targetOrderId,
            cid,
            persistedPreBuyOrderIds,
          );
          const known = new Set(persistedFillerOrderIds);
          const newlyFound = rescan.filter((id) => !known.has(id));
          if (newlyFound.length > 0) {
            logger.warn(
              'job.verify.cancelled.filler.rescan.newlyFound',
              {
                ...logCtx,
                targetOrderId,
                buyTimeKnownCount: persistedFillerOrderIds.length,
                rescanFoundCount: rescan.length,
                newlyFoundOrderIds: newlyFound,
              },
              cid,
            );
            // Dedup the merge via Set — defense against an edge case
            // where rescan returns an id that's somehow already in
            // persistedFillerOrderIds (shouldn't happen given the
            // `!known.has(id)` filter above, but a Set wrap is
            // free insurance against a future regression and the
            // cost of duplicate cancel attempts on the same order
            // is not zero — Amazon may rate-limit). Also drops any
            // accidental duplicates inside persistedFillerOrderIds
            // itself.
            mergedFillerOrderIds = Array.from(
              new Set([...persistedFillerOrderIds, ...newlyFound]),
            );
            await deps.jobAttempts
              .update(activeAttemptId, { fillerOrderIds: mergedFillerOrderIds })
              .catch(() => undefined);
          } else {
            logger.info(
              'job.verify.cancelled.filler.rescan.complete',
              {
                ...logCtx,
                targetOrderId,
                buyTimeKnownCount: persistedFillerOrderIds.length,
                rescanFoundCount: rescan.length,
              },
              cid,
            );
          }
        }
        if (mergedFillerOrderIds.length > 0) {
          logger.info(
            'job.verify.cancelled.filler.cleanup.start',
            {
              ...logCtx,
              targetOrderId,
              fillerOrderIdCount: mergedFillerOrderIds.length,
            },
            cid,
          );
          const cleanup = await cancelFillerOrdersOnly(
            verifyPage,
            mergedFillerOrderIds,
            cid,
            targetOrderId,
          );
          logger.info(
            'job.verify.cancelled.filler.cleanup.done',
            {
              ...logCtx,
              targetOrderId,
              fillerOrdersCancelled: cleanup.fillerOrdersCancelled.length,
              fillerOrdersFailed: cleanup.fillerOrdersFailed.length,
            },
            cid,
          );
          cancelledFillerError = formatUncancelledFillerError(cleanup.fillerOrdersFailed);
          if (cancelledFillerError !== null) {
            // Append to the row's error so the dashboard surfaces
            // both the target cancellation and any leftover fillers.
            // fillerOrderIds is left intact as the buy-time audit.
            await deps.jobAttempts
              .update(activeAttemptId, {
                error: `order was cancelled by Amazon · ${cancelledFillerError}`,
              })
              .catch(() => undefined);
          }
        }
      }

      await reportSafe(
        deps,
        job.id,
        {
          status: 'cancelled',
          error:
            cancelledFillerError !== null
              ? `order was cancelled by Amazon · ${cancelledFillerError}`
              : 'order was cancelled by Amazon',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
          // Target order cancelled by Amazon → the bundled filler is
          // definitionally gone with it (Amazon doesn't ship the
          // filler when the whole order is dead). Mark cleaned=true
          // so BG clears targetOrderHasUncancelledFillers, dropping
          // the row from "Uncancelled filler orders" and removing
          // the 📦 Uncancelled Filler pill on the purchase row.
          // Only relevant for filler-mode buys; single-mode never
          // had that flag set.
          ...(job.viaFiller
            ? {
                targetOrderCleanupOutcome: {
                  cleaned: true,
                  error: null,
                },
              }
            : {}),
        },
        cid,
      );
      // NOTE: rebuyOnCancel + buyWithFillerItems flow not yet implemented.
      // BG will reflect the cancellation; nothing else to do here for now.
      return;
    }

    if (outcome.kind === 'error') {
      const error = `verify: unexpected order-details error — ${outcome.message}`;
      logger.error(
        'job.verify.error',
        { ...logCtx, orderId: targetOrderId, amazonMessage: outcome.message },
        cid,
      );
      await maybeSnapshot(error, verifyPage, activeAttemptId, session, deps, cid, { ...logCtx });
      // Filler cleanup on error too. We don't know what state the
      // target order is in — but the buy fan-out's filler orders may
      // still be live regardless, and leaving them for the customer to
      // pay for is the worst-case bug we already saw on cancelled
      // targets. Best-effort, never blocks the failed-status write.
      if (job.viaFiller) {
        await runVerifyFillerCleanupSweep(
          deps,
          verifyPage,
          job,
          activeAttemptId,
          profile.email,
          targetOrderId,
          'error',
          { ...logCtx },
          cid,
        );
      }
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'failed', error })
        .catch(() => undefined);
      await reportSafe(deps, job.id, { status: 'failed', error }, cid);
      return;
    }

    if (outcome.kind === 'signed_out') {
      // Amazon redirected the order-details fetch to /ap/signin —
      // the account's session is expired. Flip the local loggedIn
      // flag so the Accounts tab + JobsTable "Signed out" pill
      // update immediately, mark the row failed with a recognizable
      // error, and propagate to BG so the dashboard shows the cause.
      const error = `account signed out — re-sign-in on the Accounts tab to resume verify and tracking for this profile`;
      logger.error(
        'job.verify.signed_out',
        { ...logCtx, orderId: targetOrderId, landedUrl: outcome.landedUrl },
        cid,
      );
      await deps.markProfileSignedOut?.(profile.email).catch(() => undefined);
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'failed', error })
        .catch(() => undefined);
      await reportSafe(deps, job.id, { status: 'failed', error }, cid);
      return;
    }

    // timeout — we don't know whether the order is alive or dead. Leave
    // the row in 'awaiting_verification' so BG's next verify retry can
    // resolve it; don't mark it failed.
    const error = `verify: timed out reading order-details for ${targetOrderId} (page never showed cancellation marker or order id)`;
    logger.error(
      'job.verify.timeout',
      { ...logCtx, orderId: targetOrderId },
      cid,
    );
    // Same reasoning as the error branch: cancel any live filler
    // orders even if we couldn't read the target's status. The retry
    // budget is small (fillers list is typically <= 10) and avoids the
    // worst-case "customer pays for filler items" outcome.
    if (job.viaFiller) {
      await runVerifyFillerCleanupSweep(
        deps,
        verifyPage,
        job,
        activeAttemptId,
        profile.email,
        targetOrderId,
        'timeout',
        { ...logCtx },
        cid,
      );
    }
    await deps.jobAttempts
      .update(activeAttemptId, { status: 'awaiting_verification', error: null })
      .catch(() => undefined);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const error = friendlyJobError(raw, profile.email);
    logger.error(
      'job.verify.error',
      { ...logCtx, orderId: targetOrderId, error },
      cid,
    );
    // Status-preservation guard. When the verify catch fires, the
    // buy WAS already successful (the order id is real, the row is
    // sitting in awaiting_verification or verified). Flipping to
    // status='failed' here lies — the order is alive, we just
    // couldn't check it on this attempt. Only record the error so
    // the user knows verify hit a snag; status stays where it was
    // so the row keeps its Pending/Success bucket. The user can
    // click Verify-now to retry. Same fix on the fetch_tracking
    // catch below. Pre-fix: a browser-crashed verify on an already-
    // placed order moved the row to the Failed bucket even though
    // the order was placed successfully and never cancelled.
    const hadOrder = await deps.jobAttempts
      .get(activeAttemptId)
      .then((a) => !!a?.orderId)
      .catch(() => false);
    if (hadOrder) {
      await deps.jobAttempts
        .update(activeAttemptId, { error })
        .catch(() => undefined);
    } else {
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'failed', error })
        .catch(() => undefined);
      await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    }
  } finally {
    // Always close the verify-phase browser window. Unlike the buy flow
    // (where we keep the window open on some failure modes so the user
    // can inspect), verify runs are fully headless in spirit — the user
    // never needs to see the order-details page, only the outcome.
    //
    // Close our own page first so borrowed sessions (user-opened
    // "View Order" windows) lose the verify tab even though the
    // context is left alive. For worker-owned sessions the context
    // close below tears down everything anyway — extra close is a no-op.
    if (verifyPage) {
      await verifyPage.close().catch(() => undefined);
    }
    await closeAndForgetSession(sessions, profile.email);
  }
}

/**
 * Fetch-tracking phase: BG sends one of these every 6h (starting 6h after
 * the verify confirmed the order was still active) until either every
 * shipment has a carrier tracking code OR Amazon cancels the order.
 *
 * Mirrors the verify handler's shape — single profile (placedEmail), rolls
 * the original buy attempt row forward, closes the session in `finally`.
 * Calls `fetchTracking` which internally runs a verifyOrder pass first.
 *
 * Outcome → BG status + local row:
 *   tracked      → BG 'completed' + trackingIds; local 'verified' + trackingIds
 *   partial      → BG 'pending_tracking' + trackingIds; local 'verified' + trackingIds
 *   not_shipped  → BG 'pending_tracking'; local 'verified' (no trackingIds yet)
 *   retry        → BG 'pending_tracking'; local 'verified' (transient verify fail)
 *   cancelled    → BG 'cancelled'; local 'cancelled_by_amazon'
 */
export { handleFetchTrackingJob as handleFetchTrackingJobForTuple };

async function handleFetchTrackingJob(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  job: AutoGJob,
  cid: string,
  eligible: AmazonProfile[],
): Promise<void> {
  const targetEmail = job.placedEmail;
  const targetOrderId = job.placedOrderId;
  if (!targetEmail || !targetOrderId) {
    const error = `fetch_tracking: missing placedEmail (${targetEmail ?? 'null'}) or placedOrderId (${targetOrderId ?? 'null'}) on the job`;
    logger.error('job.fetchTracking.invalid', { jobId: job.id, error }, cid);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    return;
  }

  const profile = eligible.find((p) => p.email.toLowerCase() === targetEmail.toLowerCase());
  if (!profile) {
    const error = `fetch_tracking: profile "${targetEmail}" not enabled or not signed in — cannot read its order history`;
    logger.error('job.fetchTracking.profile_missing', { jobId: job.id, targetEmail }, cid);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    return;
  }

  const activeAttemptId = await resolveRolloverAttemptRow(deps, job, profile.email, 'fetch_tracking');

  // See handleVerifyJob — include attemptId so the log sink routes these
  // into the (usually buy-phase) attempt row the UI surfaces, not the
  // phantom <fetchTrackingJobId>__<email>.jsonl file.
  const logCtx = { jobId: job.id, profile: profile.email, attemptId: activeAttemptId };

  logger.info(
    'job.fetchTracking.start',
    { ...logCtx, orderId: targetOrderId },
    cid,
  );

  // Same pattern as handleVerifyJob — use a dedicated page so the
  // follow-up close only affects our own tab on borrowed sessions.
  let fetchPage: Page | null = null;
  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    fetchPage = await session.newPage();

    // Filler retry sweep. Amazon's preship-cancel queue is eventually-
    // consistent and sometimes silently rejects pre-ship cancels we
    // attempted right after placement or 10 min later in verify. By
    // the time fetch_tracking runs (~6h after buy), Amazon has had
    // plenty of time to make any pending cancels actually cancellable.
    //
    // We re-attempt every filler order from the buy-time audit list
    // unconditionally. Already-cancelled orders short-circuit fast:
    // openCancelPage returns 'not on cancel-items page after
    // navigation — order likely already cancelled or shipped' which
    // isTerminalCancelReason catches → single request per order, no
    // wasted retries. So with ~9 total attempts spread across buy
    // (3) → verify (3) → fetch_tracking (3), the customer's exposure
    // to uncancellable fillers is minimized.
    if (job.viaFiller) {
      const { fillerOrderIds } = await loadFillerBuyContext(
        deps,
        job,
        profile.email,
        activeAttemptId,
      );
      if (fillerOrderIds.length > 0) {
        logger.info(
          'job.fetchTracking.filler.cleanup.start',
          { ...logCtx, fillerOrderIdCount: fillerOrderIds.length },
          cid,
        );
        const cleanup = await cancelFillerOrdersOnly(
          fetchPage,
          fillerOrderIds,
          cid,
          targetOrderId,
        );
        logger.info(
          'job.fetchTracking.filler.cleanup.done',
          {
            ...logCtx,
            fillerOrdersCancelled: cleanup.fillerOrdersCancelled.length,
            fillerOrdersFailed: cleanup.fillerOrdersFailed.length,
          },
          cid,
        );
        // Don't overwrite the row's error here — verify already
        // surfaced any uncancelled subset, and fetch_tracking's job
        // is to capture tracking, not to manage diagnostics. If the
        // sweep happened to succeed where verify failed, the error
        // string from verify is now stale, but that's acceptable
        // (next manual click on the row would re-verify and refresh).
      }
    }

    const outcome = await fetchTracking(fetchPage, targetOrderId);

    // Hoisted ahead of the outcome dispatch so the warning fires
    // exactly once regardless of which active-derived outcome we
    // ended up with (tracked / partial / not_shipped). Same
    // motivation as the verify-phase warning: surface a stuck-on-
    // payment order in View Log without changing the outcome.
    if (
      (outcome.kind === 'tracked' ||
        outcome.kind === 'partial' ||
        outcome.kind === 'not_shipped') &&
      outcome.paymentRevisionRequired
    ) {
      logger.warn(
        'job.fetchTracking.payment_revision',
        {
          ...logCtx,
          orderId: targetOrderId,
          message: `⚠ Payment revision needed on ${targetOrderId} — Amazon will re-attempt the charge; customer can fix the payment method on amazon.com to speed it up`,
        },
        cid,
      );
    }

    if (outcome.kind === 'tracked') {
      logger.info(
        'job.fetchTracking.tracked',
        {
          ...logCtx,
          orderId: targetOrderId,
          trackingIds: outcome.trackingIds,
          message: `✓ Got ${outcome.trackingIds.length} tracking ID${outcome.trackingIds.length === 1 ? '' : 's'} for ${targetOrderId}`,
        },
        cid,
      );
      await deps.jobAttempts
        .update(activeAttemptId, {
          status: 'verified',
          error: null,
          orderId: targetOrderId,
          trackingIds: outcome.trackingIds,
        })
        .catch(() => undefined);
      await reportSafe(
        deps,
        job.id,
        {
          status: 'completed',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
          trackingIds: outcome.trackingIds,
        },
        cid,
      );
      return;
    }

    if (outcome.kind === 'partial') {
      logger.info(
        'job.fetchTracking.partial',
        {
          ...logCtx,
          orderId: targetOrderId,
          trackingIds: outcome.trackingIds,
          message: `Partial tracking — ${outcome.trackingIds.length} code(s) so far, more shipments still pending`,
        },
        cid,
      );
      await deps.jobAttempts
        .update(activeAttemptId, {
          status: 'verified',
          error: null,
          orderId: targetOrderId,
          trackingIds: outcome.trackingIds,
        })
        .catch(() => undefined);
      await reportSafe(
        deps,
        job.id,
        {
          status: 'pending_tracking',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
          trackingIds: outcome.trackingIds,
        },
        cid,
      );
      return;
    }

    if (outcome.kind === 'not_shipped') {
      logger.info(
        'job.fetchTracking.not_shipped',
        {
          ...logCtx,
          orderId: targetOrderId,
          message: 'Order active but not yet shipped — BG will reschedule in 6h',
        },
        cid,
      );
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'verified', error: null, orderId: targetOrderId })
        .catch(() => undefined);
      await reportSafe(
        deps,
        job.id,
        {
          status: 'pending_tracking',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
          // Same forwarding reason as the verify-completion branch:
          // BG persists this so its dashboard keeps the row in Pending
          // bucket while we wait for either tracking or cancellation.
          ...(outcome.paymentRevisionRequired
            ? { paymentRevisionRequired: true }
            : {}),
        },
        cid,
      );
      return;
    }

    if (outcome.kind === 'retry') {
      logger.warn(
        'job.fetchTracking.retry',
        {
          ...logCtx,
          orderId: targetOrderId,
          reason: outcome.reason,
          message: 'Verify step failed transiently — BG will reschedule in 6h',
        },
        cid,
      );
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'verified', error: null, orderId: targetOrderId })
        .catch(() => undefined);
      await reportSafe(
        deps,
        job.id,
        {
          status: 'pending_tracking',
          placedOrderId: targetOrderId,
          placedEmail: profile.email,
        },
        cid,
      );
      return;
    }

    if (outcome.kind === 'signed_out') {
      // Same handling as verify-phase signed_out: flip the local
      // loggedIn flag, surface a clean error, propagate to BG. No
      // BG retry — re-sign-in is a manual user action.
      const error = `account signed out — re-sign-in on the Accounts tab to resume verify and tracking for this profile`;
      logger.error(
        'job.fetchTracking.signed_out',
        { ...logCtx, orderId: targetOrderId, landedUrl: outcome.landedUrl },
        cid,
      );
      await deps.markProfileSignedOut?.(profile.email).catch(() => undefined);
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'failed', error })
        .catch(() => undefined);
      await reportSafe(deps, job.id, { status: 'failed', error }, cid);
      return;
    }

    // outcome.kind === 'cancelled'
    logger.warn(
      'job.fetchTracking.cancelled',
      {
        ...logCtx,
        orderId: targetOrderId,
        reason: outcome.reason,
        message: `✗ Order ${targetOrderId} was cancelled by Amazon`,
      },
      cid,
    );
    await deps.jobAttempts
      .update(activeAttemptId, {
        status: 'cancelled_by_amazon',
        error: outcome.reason,
        orderId: targetOrderId,
      })
      .catch(() => undefined);
    await reportSafe(
      deps,
      job.id,
      {
        status: 'cancelled',
        error: outcome.reason,
        placedOrderId: targetOrderId,
        placedEmail: profile.email,
      },
      cid,
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const error = friendlyJobError(raw, profile.email);
    logger.error(
      'job.fetchTracking.error',
      { ...logCtx, orderId: targetOrderId, error },
      cid,
    );
    // Status-preservation guard — see the matching verify-catch
    // commentary above. fetch_tracking ALWAYS runs against a row
    // that already has an orderId (it's scheduled by BG only after
    // buy+verify), so in practice this branch always preserves
    // status. Mirror the verify shape anyway for defensive
    // consistency in case fetch_tracking is ever called for a
    // pre-placement attempt.
    const hadOrder = await deps.jobAttempts
      .get(activeAttemptId)
      .then((a) => !!a?.orderId)
      .catch(() => false);
    if (hadOrder) {
      await deps.jobAttempts
        .update(activeAttemptId, { error })
        .catch(() => undefined);
    } else {
      await deps.jobAttempts
        .update(activeAttemptId, { status: 'failed', error })
        .catch(() => undefined);
      await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    }
  } finally {
    if (fetchPage) {
      await fetchPage.close().catch(() => undefined);
    }
    await closeAndForgetSession(sessions, profile.email);
  }
}

/**
 * Pick (and persist up-front) the attempt row a verify- or fetch-
 * tracking-phase run will track.
 *
 * Preferred path: bump the original buy attempt row from
 * 'awaiting_verification' → 'in_progress' so the single lifecycle stays
 * intact. If that row was cleared (user hit "Clear All", pruned, etc.) or
 * the job has no buyJobId linkage, create a fresh row for this phase in
 * 'in_progress' immediately so the user sees the job actually running
 * in the Jobs table instead of a silent no-op.
 *
 * Returns the attempt id that the caller should update with the final
 * outcome.
 */
async function resolveRolloverAttemptRow(
  deps: Deps,
  job: AutoGJob,
  profileEmail: string,
  phase: 'verify' | 'fetch_tracking',
): Promise<string> {
  // Always key the rollover row by the BUY job's id (buyJobId + email)
  // so listMergedAttempts unifies with the server's AutoBuyPurchase row
  // (which BG keys by buyJobId + email). Keying by job.id — the verify
  // / fetch_tracking AutoBuyJob's id — fragments the table: the local
  // row never merges, leaving stale qty=job.quantity (BG-requested) and
  // cashbackPct=null in the display while the real values sit on the
  // unmerged server row.
  const rolloverJobId = job.buyJobId ?? job.id;
  const attemptId = makeAttemptId(rolloverJobId, profileEmail);

  const bumped = await deps.jobAttempts
    .update(attemptId, { status: 'in_progress', error: null })
    .catch(() => null);
  if (bumped) return attemptId;

  await deps.jobAttempts
    .create({
      attemptId,
      jobId: rolloverJobId,
      amazonEmail: profileEmail,
      phase,
      dealKey: job.dealKey,
      dealId: job.dealId,
      dealTitle: job.dealTitle,
      productUrl: job.productUrl,
      maxPrice: job.maxPrice,
      price: job.price,
      quantity: job.quantity,
      cost: null,
      cashbackPct: null,
      orderId: job.placedOrderId,
      status: 'in_progress',
      error: null,
      buyMode: 'single',
      trackingIds: null,
      fillerOrderIds: null,
      cartAsins: null,
      fillerCancelTasks: null,
      productTitle: null,
      stage: null,
    })
    .catch(() => undefined);
  return attemptId;
}

async function reportSafe(
  deps: Deps,
  jobId: string,
  body: Parameters<BGClient['reportStatus']>[1],
  cid: string,
): Promise<void> {
  try {
    await deps.bg.reportStatus(jobId, body);
  } catch (err) {
    logger.error('job.report.error', { jobId, error: String(err) }, cid);
  }
}

/**
 * cancel_fillers phase: process every pending FillerCancelTask for
 * this job's (user, placedEmail) scope. Per-task work:
 *
 *   1. Fetch order-details HTML once (single round-trip per task —
 *      reused for shipped detection AND tracking extraction AND the
 *      defensive ASIN check).
 *   2. DEFENSIVE: if the order contains the target ASIN, signal
 *      `danger_target_in_order`. STOP — never click Cancel against
 *      an order that might be the user's actual deal. (Catastrophic-
 *      loss prevention.)
 *   3. State-driven action:
 *        pending_cancel:
 *          - already cancelled  → `order_already_cancelled`
 *          - shipped detected   → `order_shipped_detected` (+ codes)
 *          - cancel-unable copy → `cancel_unable`
 *          - order-not-found    → `order_not_found`
 *          - else → run cancel form, classify result
 *        pending_tracking:
 *          - codes captured     → `tracking_codes_received` (+ codes)
 *          - already cancelled  → `order_already_cancelled` (Amazon
 *                                  auto-cancelled post-ship)
 *          - else               → `transient_error`
 *
 * No per-attempt row in the local Jobs table — the cancel work is
 * tracked per-task on BG, surfaced via the dashboard's chip render.
 *
 * Re-exported under a tuple-shaped alias so runners.ts can dispatch
 * without circular-import warnings.
 */
export { handleCancelFillersJob as handleCancelFillersJobForTuple };

async function handleCancelFillersJob(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  job: AutoGJob,
  cid: string,
  eligible: AmazonProfile[],
): Promise<void> {
  const targetEmail = job.placedEmail;
  if (!targetEmail) {
    const error = `cancel_fillers: missing placedEmail on the job`;
    logger.error('job.cancelFillers.invalid', { jobId: job.id, error }, cid);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
    return;
  }
  const profile = eligible.find(
    (p) => p.email.toLowerCase() === targetEmail.toLowerCase(),
  );
  if (!profile) {
    // Profile not signed in. Send back a single profile_signed_out
    // signal per pending task so BG keeps them in pending_cancel
    // without burning attempts. We can't get the task list without
    // calling BG first either way — call list, then report.
    const list = await deps.bg
      .listFillerCancelTasks(job.id)
      .catch(() => null);
    if (!list) {
      // Task-list fetch failed AND the profile is signed out. We
      // can't enumerate the tasks to signal profile_signed_out per
      // task, and reporting `completed` would orphan them. Fail the
      // job so BG reschedules — a later claim retries the fetch.
      logger.warn(
        'job.cancelFillers.profile_missing.list_failed',
        { jobId: job.id, targetEmail },
        cid,
      );
      await reportSafe(
        deps,
        job.id,
        {
          status: 'failed',
          error:
            'cancel_fillers: profile signed out and the task-list fetch failed — will retry',
        },
        cid,
      );
      return;
    }
    const tasks = list.tasks;
    logger.warn(
      'job.cancelFillers.profile_missing',
      { jobId: job.id, targetEmail, taskCount: tasks.length },
      cid,
    );
    await reportSafe(
      deps,
      job.id,
      {
        status: 'completed',
        fillerCancelTaskUpdates: tasks.map((t) => ({
          taskId: t.taskId,
          signal: 'profile_signed_out' as const,
        })),
      },
      cid,
    );
    return;
  }

  const logCtx = { jobId: job.id, profile: profile.email };
  logger.info('job.cancelFillers.start', logCtx, cid);

  const list = await deps.bg.listFillerCancelTasks(job.id).catch((err) => {
    logger.warn(
      'job.cancelFillers.list.error',
      { ...logCtx, error: err instanceof Error ? err.message : String(err) },
      cid,
    );
    return null;
  });
  if (!list) {
    // The task-list FETCH failed (transient BG error / network).
    // This is NOT the same as "no tasks" — reporting `completed`
    // here would flip the AutoBuyJob out of in_progress and orphan
    // whatever pending cancel tasks actually exist, so the fillers
    // ship uncancelled. Report `failed` instead so BG reschedules
    // and a later claim retries the fetch.
    await reportSafe(
      deps,
      job.id,
      {
        status: 'failed',
        error: 'cancel_fillers: could not fetch the task list from BG — will retry',
      },
      cid,
    );
    return;
  }
  // Never-give-up reconcile context. When present, every cancel_fillers
  // tick re-scans Amazon order history with the buy-time cart snapshot
  // so a filler order the buy-time + verify-time scans missed still
  // gets a durable task. We rescan even when the task list is empty —
  // that's the only place a straggler with no task yet can be caught.
  const reconcileCtx = list.reconcile;
  const canReconcile =
    !!reconcileCtx &&
    reconcileCtx.viaFiller &&
    reconcileCtx.cartAsins.length > 0;
  if (list.tasks.length === 0 && !canReconcile) {
    // Genuinely empty and nothing to reconcile — rescheduling raced,
    // or every task already terminated. Safe to report completed (no
    // updates) so the AutoBuyJob row flips out of in_progress.
    logger.info('job.cancelFillers.empty', logCtx, cid);
    await reportSafe(deps, job.id, { status: 'completed' }, cid);
    return;
  }

  const updates: Parameters<BGClient['reportStatus']>[1]['fillerCancelTaskUpdates'] = [];
  let workPage: Page | null = null;
  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    workPage = await session.newPage();

    for (const t of list.tasks) {
      // Wall-clock safety net — BG marked these expired, just round-trip
      // the signal back without an Amazon hit.
      if (t.expiredSafetyNet) {
        updates.push({ taskId: t.taskId, signal: 'wall_clock_expired' });
        continue;
      }

      const update = await processCancelFillerTask(
        workPage,
        t,
        cid,
      );
      updates.push(update);

      // Tiny inter-task pause — Amazon's cancel pipeline is
      // eventually-consistent; chaining without breath sometimes
      // hits anti-bot heuristics.
      await workPage.waitForTimeout(800);
    }

    // Never-give-up reconcile rescan. Re-scan Amazon order history
    // with the buy-time cart snapshot so any filler order the
    // buy-time + verify-time scans missed gets a durable task this
    // cycle. New ids go back via `fillerOrderIds` — BG's status route
    // creates FillerCancelTasks for them, which keeps this
    // cancel_fillers job alive for another tick. The loop terminates
    // naturally: `knownFillerOrderIds` includes terminal tasks, so
    // once every real filler has a task the rescan reports nothing
    // new and the job completes.
    let reconcileNewFillerIds: string[] = [];
    if (canReconcile && reconcileCtx) {
      const found = await rescanFillerOrderIds(
        workPage,
        reconcileCtx.cartAsins,
        reconcileCtx.targetOrderId ?? '',
        cid,
        reconcileCtx.preBuyOrderIds.length > 0
          ? reconcileCtx.preBuyOrderIds
          : null,
      ).catch(() => [] as string[]);
      const known = new Set(reconcileCtx.knownFillerOrderIds);
      reconcileNewFillerIds = found.filter(
        (id) => !known.has(id) && id !== reconcileCtx.targetOrderId,
      );
      if (reconcileNewFillerIds.length > 0) {
        logger.warn(
          'job.cancelFillers.reconcile.newlyFound',
          {
            ...logCtx,
            newlyFoundOrderIds: reconcileNewFillerIds,
            knownTaskCount: reconcileCtx.knownFillerOrderIds.length,
            fillersAddedCount: reconcileCtx.fillersAddedCount,
          },
          cid,
        );
      } else {
        logger.info(
          'job.cancelFillers.reconcile.clean',
          {
            ...logCtx,
            knownTaskCount: reconcileCtx.knownFillerOrderIds.length,
          },
          cid,
        );
      }
    }
    logger.info(
      'job.cancelFillers.done',
      {
        ...logCtx,
        taskCount: list.tasks.length,
        signals: updates.map((u) => u.signal),
        reconcileNewCount: reconcileNewFillerIds.length,
      },
      cid,
    );
    await reportSafe(
      deps,
      job.id,
      {
        status: 'completed',
        fillerCancelTaskUpdates: updates,
        ...(reconcileNewFillerIds.length > 0
          ? {
              fillerOrderIds: reconcileNewFillerIds,
              targetAsin: parseAsinFromUrl(job.productUrl),
            }
          : {}),
      },
      cid,
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    logger.error('job.cancelFillers.error', { ...logCtx, error: raw }, cid);
    // Report what we managed to collect plus a job-level error. BG
    // will reschedule the next cancel_fillers run for any tasks
    // still pending.
    await reportSafe(
      deps,
      job.id,
      {
        status: 'failed',
        error: `cancel_fillers worker error: ${raw.slice(0, 200)}`,
        fillerCancelTaskUpdates: updates,
      },
      cid,
    );
  } finally {
    if (workPage) {
      await workPage.close().catch(() => undefined);
    }
    await closeAndForgetSession(sessions, profile.email);
  }
}

/**
 * Process one filler-cancel task. Single round-trip to Amazon's
 * order-details page → classify the HTML signal → either return
 * that signal directly (already cancelled / shipped / not found),
 * or fall through to the cancel form.
 *
 * Imports kept lazy so the action's HTML parsers aren't paid by
 * tests / paths that don't exercise this phase.
 */
async function processCancelFillerTask(
  page: Page,
  task: {
    taskId: string;
    amazonOrderId: string;
    targetAsin: string | null;
    status: 'pending_cancel' | 'pending_tracking';
  },
  cid: string,
): Promise<NonNullable<Parameters<BGClient['reportStatus']>[1]['fillerCancelTaskUpdates']>[number]> {
  const {
    classifyOrderDetailsHtml,
    orderContainsAsin,
    cancelFormResultToSignal,
  } = await import('../actions/cancelFillerSignals.js');
  const { HTTP_BROWSERY_HEADERS } = await import('../actions/amazonHttp.js');

  const orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(
    task.amazonOrderId,
  )}`;

  // 1. Fetch order-details HTML.
  let html: string;
  try {
    const res = await page.context().request.get(orderDetailsUrl, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
    if (!res.ok()) {
      logger.warn(
        'cancelFillers.task.http_error',
        { taskId: task.taskId, orderId: task.amazonOrderId, status: res.status() },
        cid,
      );
      return { taskId: task.taskId, signal: 'transient_error' };
    }
    html = await res.text();
  } catch (err) {
    logger.warn(
      'cancelFillers.task.fetch_threw',
      {
        taskId: task.taskId,
        orderId: task.amazonOrderId,
        error: err instanceof Error ? err.message : String(err),
      },
      cid,
    );
    return { taskId: task.taskId, signal: 'transient_error' };
  }

  // 2. DEFENSIVE: if the supposed filler order contains the target
  //    ASIN, BAIL — never click cancel. Surfaces as DANGER notify on
  //    BG so a human investigates.
  if (task.targetAsin && orderContainsAsin(html, task.targetAsin)) {
    logger.error(
      'cancelFillers.task.danger',
      {
        taskId: task.taskId,
        orderId: task.amazonOrderId,
        targetAsin: task.targetAsin,
      },
      cid,
    );
    return { taskId: task.taskId, signal: 'danger_target_in_order' };
  }

  // 3. Classify the page state.
  const probe = classifyOrderDetailsHtml(html);

  // pending_tracking branch — we already detected shipped on a prior
  // cycle. Now we're collecting codes.
  if (task.status === 'pending_tracking') {
    if (probe.signal === 'order_already_cancelled') {
      // Amazon auto-cancelled post-ship (rare but happens).
      return { taskId: task.taskId, signal: 'order_already_cancelled' };
    }
    if (probe.trackingIds && probe.trackingIds.length > 0) {
      return {
        taskId: task.taskId,
        signal: 'tracking_codes_received',
        trackingIds: probe.trackingIds,
      };
    }
    // No codes yet — transient until 14d cap.
    return { taskId: task.taskId, signal: 'transient_error' };
  }

  // pending_cancel branch.
  // Direct terminal-ish signals from the page state:
  if (
    probe.signal === 'order_already_cancelled' ||
    probe.signal === 'cancel_unable' ||
    probe.signal === 'order_not_found'
  ) {
    return { taskId: task.taskId, signal: probe.signal };
  }
  if (probe.signal === 'order_shipped_detected') {
    return {
      taskId: task.taskId,
      signal: 'order_shipped_detected',
      ...(probe.trackingIds && probe.trackingIds.length > 0
        ? { trackingIds: probe.trackingIds }
        : {}),
    };
  }

  // Indeterminate page — proceed to cancel form. Reuse the existing
  // action; classify its result as a signal.
  const { cancelFillerOrder, cancelFillerOrderViaOrderDetails } = await import(
    '../actions/cancelFillerOrder.js'
  );
  const primary = await cancelFillerOrder(page, task.amazonOrderId, {
    correlationId: cid,
  });
  let mapped = cancelFormResultToSignal(
    primary.ok,
    primary.ok ? undefined : primary.reason,
  );
  if (mapped === null) {
    // Ambiguous "not on cancel-items page" — try the order-details
    // fallback. It opens the same form via the order-details link
    // when Amazon's primary cancel URL redirects away.
    const fb = await cancelFillerOrderViaOrderDetails(
      page,
      task.amazonOrderId,
      { correlationId: cid },
    );
    mapped = cancelFormResultToSignal(
      fb.ok,
      fb.ok ? undefined : fb.reason,
    );
    // If still ambiguous, treat as transient — BG will retry in 5 min.
    if (mapped === null) mapped = 'transient_error';
  }
  return { taskId: task.taskId, signal: mapped };
}

export async function runForProfile(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  job: AutoGJob,
  profileData: AmazonProfile,
  parentCid: string,
  useFillers: boolean,
  /** Per-profile override of the worker's min-cashback floor. With
   *  `AmazonAccount.requireMinCashback=false` on BG the effective
   *  floor drops to 0 — but `pickBestCashbackDelivery` still uses
   *  this value to choose the highest-cashback delivery option, so
   *  even permissive accounts benefit from picking the best
   *  available rate. */
  effectiveMinCashbackPct: number,
  /** Per-profile cashback gate enforcement. False = skip the gate
   *  entirely and default a missing /spc reading to 5%. See
   *  shared/cashbackGate.ts. */
  requireMinCashback: boolean,
  /** Per-attempt filler-pool plan. Re-read per claim by the caller.
   *  Single-mode buys ignore. */
  fillerAttempts: FillerPool[],
  /** Shared kill-switch fired when ONE profile in the fan-out detects
   *  a PRODUCT-level failure (out_of_stock / price_exceeds). When this
   *  signal is aborted, every other profile bails at its next
   *  checkpoint — saves ~25-50s on a 3-profile fan-out where the deal
   *  itself is dead (item OOS, price drifted past the cap). Account-
   *  specific failures (cashback_gate, signed_out, etc.) DON'T fire
   *  this, since other profiles may have different eligibility. */
  signal: AbortSignal,
  /** Callback for THIS profile to fire when it detects a PRODUCT-level
   *  failure that should kill siblings. Reasons map 1:1 to the
   *  AbortController.abort() reason argument so log lines and the
   *  sibling's abort-detection message stay consistent. */
  abortSiblings: (reason: 'out_of_stock' | 'price_exceeds') => void,
): Promise<ProfileResult> {
  const profile = profileData.email;
  // Per-profile correlation id so logs across the parallel runs are
  // distinguishable (parent cid is shared by all profiles in a fan-out).
  const cid = `${parentCid}/${profile}`;
  const attemptId = makeAttemptId(job.id, profile);

  // Ghost-order safety net (Part 2-safe) — also run as a new buy job
  // starts. By now any prior ghost has fully propagated to Amazon's
  // order history, and this is a known-healthy moment. Local-ledger
  // read only; fire-and-forget so it can't delay the buy.
  if (job.phase === 'buy') {
    void surfaceUnreconciledBreadcrumbs(deps.jobAttempts);
    void reconcileLedgerToBG(deps.bg);
  }

  // Centralized abort checkpoint. Returns a ProfileResult if the
  // sibling-abort signal has fired, null otherwise. Caller pattern:
  //   const aborted = checkAbortPoint('preflight'); if (aborted) return aborted;
  // Used at every major await boundary in the buy flow (but NOT after
  // Place Order click — past that point we can't safely bail).
  const checkAbortPoint = (stage: string): ProfileResult | null => {
    if (!signal.aborted) return null;
    const reason = String(signal.reason ?? 'unknown');
    const error = `Aborted: sibling reported ${reason}`;
    logger.info(
      'job.profile.aborted_by_sibling',
      { jobId: job.id, profile, reason, stage },
      cid,
    );
    void deps.jobAttempts
      .update(attemptId, { status: 'failed', error })
      .catch(() => undefined);
    return failed(profile, error, 'aborted_by_sibling');
  };

  await deps.jobAttempts
    .update(attemptId, { status: 'in_progress' })
    .catch(() => undefined);

  // Earliest checkpoint — queued profiles hit this when picked up by a
  // freed pMap slot. Bails before opening any browser session so the
  // sibling-abort case incurs zero PDP/cookie/session cost.
  {
    const aborted = checkAbortPoint('preflight');
    if (aborted) return aborted;
  }

  let page: Page | null = null;
  let session: DriverSession | null = null;
  try {
    logger.info('job.profile.start', { jobId: job.id, profile }, cid);
    session = await getSession(deps, sessions, profile, profileData.headless);
    {
      const aborted = checkAbortPoint('after_getSession');
      if (aborted) {
        await closeAndForgetSession(sessions, profile);
        return aborted;
      }
    }
    if (await isUnpackagedRun()) await startTracing(session.context);
    // Always open our own page. A borrowed session (user previously
    // clicked "Order ID" on this profile, opening a window tracked in
    // openOrderSessions) would otherwise have the user's tab at
    // context.pages()[0] — reusing it would navigate their view away
    // and the follow-up `closeAndForgetSession` deliberately skips the
    // context close for borrowed sessions, leaving the window stuck on
    // whatever Amazon page our buy ended on. A dedicated page that we
    // always close in `finally` avoids both problems: fresh sessions
    // get torn down by the context close anyway; borrowed sessions
    // lose just our own tab.
    page = await session.newPage();

    // Pre-flight clearCart fire-and-forget. The HTTP fast path
    // (ctx.request.get/post) shares the BrowserContext but doesn't
    // navigate the visible tab, so it runs concurrently with
    // scrapeProduct's page.goto. Saves ~1.5s/buy on the typical case
    // where clearCart's HTTP path succeeds. We capture the promise
    // here and pass it through to buyWithFillers / buyNow so they
    // skip their internal clearCart when the preflight succeeded.
    //
    // If the preflight fails (rare — bot challenge, csrf rotation,
    // Amazon shape drift), the buy actions fall back to the sequential
    // clearCart (HTTP path retried + click-loop fallback). Worst case
    // wall-clock = today's behavior; best case = parallelized.
    // Only filler-mode reliably uses the cart (every buy posts to
    // /cart/add-to-cart/ref=...). Single-mode chooses between
    // buy-now-click (the common case for Prime listings — bypasses the
    // cart entirely) and an atc fallback (rare). Firing the preflight
    // for single-mode wastes HTTP capacity + cookie-pool slots ~80%
    // of the time and orphans the promise on the buy-now-click branch.
    // For atc fallbacks, buyNow runs its own sequential clearCart
    // (slightly slower wall-clock but acceptable for the rare path).
    const preflightCleared = useFillers
      ? clearCartHttpOnly(page, { correlationId: cid })
      : undefined;

    const info = await scrapeProduct(page, job.productUrl).catch(async (err) => {
      // Stale-pipeline recovery: a prior abandoned checkout on this
      // profile left items in the cart, so Amazon server-redirects
      // /gp/product/<asin> into /checkout/p/.../spc mid-commit and
      // page.goto aborts. Detect by the wedged URL, drain via HTTP
      // (ctx.request — no tab nav), retry once. clearCartHttpOnly
      // logs its own outcome internally and never throws.
      if (!/\/(?:checkout\/p\/[^/]+\/spc|gp\/buy)\b/i.test(page!.url())) throw err;
      logger.warn('step.scrape.redirected_to_spc', { jobId: job.id, profile, landedUrl: page!.url() }, cid);
      await clearCartHttpOnly(page!, { correlationId: cid });
      return scrapeProduct(page!, job.productUrl);
    });
    logger.info(
      'job.scrape.ok',
      {
        jobId: job.id,
        profile,
        title: info.title,
        price: info.price,
        cashbackPct: info.cashbackPct,
        inStock: info.inStock,
        condition: info.condition,
        shipsToAddress: info.shipsToAddress,
        isPrime: info.isPrime,
        hasBuyNow: info.hasBuyNow,
      },
      cid,
    );
    {
      const aborted = checkAbortPoint('after_scrape');
      if (aborted) {
        await closeAndForgetSession(sessions, profile);
        return aborted;
      }
    }

    // Bypass: PDP-level price gate runs before /spc. If the user opted
    // into "Bypass price check" on the BG Trigger panel, null out the
    // cap here so verifyProductDetailed skips the price step entirely
    // — otherwise we'd fail with `price_too_high` long before reaching
    // the /spc gates that already honor the flag.
    const effectiveMaxPrice =
      job.bypassPriceCheck === true ? null : job.maxPrice;
    if (job.bypassPriceCheck === true && job.maxPrice !== null) {
      logger.info(
        'step.verify.price.bypass',
        { jobId: job.id, profile, cap: job.maxPrice, reason: 'user_opt_in' },
        cid,
      );
    }
    // Global override composes OR-wise with the BG-side per-job flag
    // — either side saying "bypass" skips the Prime check. The
    // worker-wide toggle lives on Settings.bypassPrimeCheck and is
    // configured in Settings → Accounts (default false).
    const bypassPrime =
      job.bypassPrimeCheck === true || deps.bypassPrimeCheck === true;
    if (bypassPrime) {
      logger.info(
        'step.verify.prime.bypass',
        {
          jobId: job.id,
          profile,
          reason:
            job.bypassPrimeCheck === true
              ? 'user_opt_in_job'
              : 'user_opt_in_global',
        },
        cid,
      );
    }
    const constraints = {
      ...DEFAULT_CONSTRAINTS,
      maxPrice: effectiveMaxPrice,
      ...(bypassPrime ? { requirePrime: false } : {}),
    };
    const enabledChecks = [
      ...(constraints.requireInStock ? ['inStock'] : []),
      ...(constraints.maxPrice !== null ? ['price'] : []),
      ...(constraints.requireNew ? ['condition'] : []),
      ...(constraints.requireShipping ? ['shipping'] : []),
      ...(constraints.requirePrime ? ['prime'] : []),
      ...(constraints.requireBuyNow ? ['buyNow'] : []),
    ];
    logger.info(
      'step.verify.start',
      { jobId: job.id, profile, message: 'Running product page verification', checks: enabledChecks },
      cid,
    );

    const report = verifyProductDetailed(info, constraints);
    for (const step of report.steps) {
      if (step.skipped) continue;
      const event = step.pass ? 'step.verify.check.pass' : 'step.verify.check.fail';
      const level: 'info' | 'warn' = step.pass ? 'info' : 'warn';
      logger[level](
        event,
        {
          jobId: job.id,
          profile,
          check: step.name,
          observed: step.observed,
          expected: step.expected,
          ...(step.reason ? { reason: step.reason } : {}),
          ...(step.detail ? { detail: step.detail } : {}),
        },
        cid,
      );
    }

    if (!report.ok) {
      // Trim a trailing "." since most parser details are scraped page text
      // like "Quantity limit met for this seller." — table reads cleaner
      // without it. Fall back to reason, then to a generic message.
      const error = (report.detail ?? report.reason ?? 'verification failed').replace(/\.\s*$/, '');
      logger.error('step.verify.fail', { jobId: job.id, profile, reason: report.reason }, cid);
      // Diagnostic capture for `oos` failures (the path Amazon's
      // non-standard availability text like "Available to ship in
      // 1-2 days" lands on — see classifyInStock in amazonProduct.ts).
      // The classifier only recognizes "in stock" / "out of stock" /
      // "currently unavailable" / "temporarily out of stock"; anything
      // else falls back to ATC/Buy-Now presence, and if neither button
      // is visible at scrape time we report oos with Amazon's raw text
      // as the user-visible reason. To fix the classifier we need to
      // see which availability variants Amazon shows in the wild —
      // this probe + dev-only HTML capture gives us that signal.
      //
      // Dev-only gate (npm run dev) — production installs emit no
      // probe events and capture no HTML/PNG for this failure.
      if (report.reason === 'oos' && (await isUnpackagedRun())) {
        const oosProbe = await probePageDiag(page, {
          availability_block: '#availability',
          availability_color_state: '#availability .a-color-state, #availability .a-color-success, #availability .a-color-price',
          availability_inside_buybox: '#availabilityInsideBuyBox_feature_div, #buybox-availability',
          add_to_cart_visible: '#add-to-cart-button',
          buy_now_visible: '#buy-now-button',
          buy_now_alt_submit: 'input[name="submit.buy-now"]',
          atc_alt_submit: 'input[name="submit.add-to-cart"]',
          out_of_stock_indicator: '#outOfStock',
          unqualified_buybox: '#unqualifiedBuyBox',
          delivery_promise: '#deliveryBlockMessage, #mir-layout-DELIVERY_BLOCK, [data-csa-c-delivery-time]',
          backorder_msg: '.a-color-state, .a-color-attainable',
          product_title: '#productTitle',
          variation_locked: '#variation_size_name .a-color-state, #variation_color_name .a-color-state',
          signin_form: 'form#ap_signin_form, input#ap_email',
          captcha: 'form[action*="validateCaptcha"], #captchacharacters',
        }).catch(() => null);
        logger.warn(
          'step.verify.oos.probe',
          {
            jobId: job.id,
            profile,
            availabilityText: info.availabilityText,
            inStockFlag: info.inStock,
            isPrimeFlag: info.isPrime,
            priceText: info.priceText,
            url: page.url(),
            probe: oosProbe,
          },
          cid,
        );
        // Dev-only HTML+PNG capture so an investigator can open the
        // exact PDP that triggered the oos. captureDebugSnapshot gates
        // on NODE_ENV — production installs write nothing.
        const oosSnap = await captureDebugSnapshot(
          page,
          deps.debugDir,
          'verify_oos',
        );
        if (oosSnap) {
          logger.info(
            'step.verify.oos.snapshot',
            {
              jobId: job.id,
              profile,
              png: oosSnap.pngPath,
              html: oosSnap.htmlPath,
            },
            cid,
          );
        }
      }
      await maybeSnapshot(error, page, attemptId, session, deps, cid, { jobId: job.id, profile });
      // signed_out is the canonical action_required trigger from the
      // verify pipeline — anything else is a product-side issue and stays
      // a plain failure.
      const needsHuman = report.reason === 'signed_out';
      await deps.jobAttempts
        .update(attemptId, {
          status: needsHuman ? 'action_required' : 'failed',
          error,
          cost: info.priceText,
          cashbackPct: info.cashbackPct,
        })
        .catch(() => undefined);
      // Close the window on every verify failure. Multi-profile runs
      // stack up a headed Chromium per account that never ran the buy
      // flow, which is visually noisy and eats memory. The failure
      // reason is captured in the attempt row + snapshot, so nothing
      // is lost by closing.
      await closeAndForgetSession(sessions, profile);
      // Sibling-abort trigger: PDP-level oos / price-exceeds are
      // deterministic across accounts (same product, same Amazon
      // display, regardless of who's looking). Fire the abort so other
      // in-flight + queued profiles bail at their next checkpoint
      // instead of all loading the same dead PDP.
      // 'oos' is the explicit OOS signal. 'price_unknown' means the
      // PDP price block was hidden — per productConstraints.ts:166-170
      // that's almost always the "Currently unavailable" buy box, so
      // treat it as OOS too. 'price_too_high' is the cap-exceeded case.
      if (report.reason === 'oos' || report.reason === 'price_unknown') {
        abortSiblings('out_of_stock');
      } else if (report.reason === 'price_too_high') {
        abortSiblings('price_exceeds');
      }
      return needsHuman ? actionRequired(profile, error) : failed(profile, error);
    }
    logger.info('step.verify.ok', { jobId: job.id, profile }, cid);
    {
      const aborted = checkAbortPoint('after_verify');
      if (aborted) {
        await closeAndForgetSession(sessions, profile);
        return aborted;
      }
    }

    // Drive a real (or dry-run) Amazon checkout on the SAME tab. Branch
    // on the global filler switch: filler mode replaces the entire
    // product-page → Buy Now → /spc path with the cart-based flow (Buy
    // Now as add-to-cart → 10 filler items → Proceed to Checkout → SPC
    // tail). Both paths return a BuyResult-shaped value for the
    // downstream logging/attempt-update code to consume.
    let buy: BuyResult;
    let fillerOrderIds: string[] = [];
    let cartAsins: string[] = [];
    let preBuyOrderIds: string[] = [];
    let productTitle: string | null = null;
    // Persist the Place-Order stage on the attempt so the recovery
    // sweep can tell "stopped in a safe re-runnable phase" from
    // "stopped mid-Place-Order" (which Amazon may or may not have
    // accepted and must not be auto-retried).
    // Force-flush the `placing` marker so a hard kill within the
    // 250ms debounce window can't leave an on-disk row showing
    // stage=null while Amazon was actually processing the click.
    // The recovery sweep would otherwise mis-classify the row as
    // safe-to-retry and risk a duplicate order. Cost: ~5ms fsync
    // per critical-section transition (set + clear = 2× per buy).
    const onStage = (stage: 'placing' | null): Promise<void> =>
      deps.jobAttempts
        .update(attemptId, { stage }, { forceFlush: true })
        .then(() => undefined);
    // Resolve the account's assigned payment card (if any) so checkout
    // can auto-add it when Amazon has no payment method on file.
    const paymentCard: PaymentCardFill | null =
      profileData.cardId && deps.resolveCardById
        ? await deps.resolveCardById(profileData.cardId).catch(() => null)
        : null;
    if (useFillers) {
      const r = await runFillerBuyWithRetries(page, deps, job, cid, profile, effectiveMinCashbackPct, requireMinCashback, fillerAttempts, info, preflightCleared, profileData.bgAddress, paymentCard, onStage);
      buy = r.buy;
      fillerOrderIds = r.fillerOrderIds;
      cartAsins = r.cartAsins;
      preBuyOrderIds = r.preBuyOrderIds;
      productTitle = r.productTitle;
    } else {
      buy = await buyNow(page, {
        minCashbackPct: effectiveMinCashbackPct,
        requireMinCashback,
        bypassPriceCheck: job.bypassPriceCheck === true,
        // bypassPrimeCheck has no effect in single-mode — buyNow doesn't
        // run verifyProductDetailed; the outer pollAndScrape PDP verify
        // (above this dispatch) is the only Prime gate that fires.
        bgNameToggleEnabled: deps.bgNameToggleEnabled,
        resolveCardNumber: deps.resolveCardNumber,
        maxPrice: job.maxPrice,
        allowedAddressPrefixes: deps.allowedAddressPrefixes,
        bgAddress: profileData.bgAddress,
        paymentCard,
        correlationId: cid,
        // Routing fields — see BuyOptions.jobId docstring. Without these
        // every step.buy.* event silently drops at the disk-log sink.
        jobId: job.id,
        profile,
        debugDir: deps.debugDir,
        preflightCleared,
        onStage,
      });
    }

    if (!buy.ok) {
      const error = buy.reason;
      logger.error(
        'step.buy.fail',
        { jobId: job.id, profile, stage: buy.stage, reason: buy.reason },
        cid,
      );
      await maybeSnapshot(error, page, attemptId, session, deps, cid, { jobId: job.id, profile });
      // PMTS "Verify your card" challenge needs the user to satisfy it
      // in the Amazon UI — the bot can't proceed automatically. Anything
      // else is a buy-flow failure (selector miss, address picker, etc.)
      // that the worker can retry on the next claim.
      const needsHuman = isActionRequiredReason(buy.reason);
      await deps.jobAttempts
        .update(attemptId, {
          status: needsHuman ? 'action_required' : 'failed',
          error,
          cost: info.priceText,
          cashbackPct: info.cashbackPct,
        })
        .catch(() => undefined);
      await closeAndForgetSession(sessions, profile);
      // Sibling-abort trigger: stage='checkout_price' means the price
      // drifted past the cap on /spc (between PDP load and checkout).
      // Same as PDP-level price-exceeds — propagate to siblings.
      // stage='item_unavailable' is also product-level (covers both the
      // "this item is currently unavailable" page and the per-account
      // quantity-cap page; for the latter, propagating wastes minimal
      // work since other accounts may not have hit the cap yet — but
      // out_of_stock is the closer match and the deal is dead either
      // way, so propagation is the right call).
      if (buy.stage === 'checkout_price') {
        abortSiblings('price_exceeds');
      } else if (buy.stage === 'item_unavailable') {
        abortSiblings('out_of_stock');
      }
      // buy.stage is the structured failure category (e.g. 'cashback_gate',
      // 'item_unavailable'). Forwarding it lets BG decide on follow-ups —
      // notably auto-rebuy with fillers when a single-mode buy aborts at
      // the cashback gate — without text-matching the reason string.
      return needsHuman
        ? actionRequired(profile, error, buy.stage)
        : failed(profile, error, buy.stage);
    }

    if (session && (await isUnpackagedRun())) await discardTracing(session.context);

    logger.info(
      'job.profile.placed',
      {
        jobId: job.id,
        profile,
        orderId: buy.orderId,
        finalPrice: buy.finalPrice,
        cashbackPct: buy.cashbackPct,
        message: `✓ Order placed for ${profile} — orderId ${buy.orderId ?? '(unknown)'}`,
      },
      cid,
    );
    // Close the session so the visible browser window goes away on
    // successful placements.
    await closeAndForgetSession(sessions, profile);

    const placedAt = new Date().toISOString();
    // Ghost-order guard. buyNow / buyWithFillers only return ok:true
    // AFTER the confirmation page was reached — so the order IS placed
    // on Amazon. But the post-buy order-history scan can still come up
    // empty (propagation lag beyond the retry budget, history-page nav
    // failure). Shipping that as a clean "awaiting_verification" with a
    // null orderId is the root of the "placed but AmazonG lost it" bug:
    // BG gets no orderId, verify can never run, the order silently
    // ships unreconciled. Instead surface it as action_required with a
    // message pointing the user at Amazon's order history. We still
    // keep placedAt + amazonPurchaseId + filler context so the row is
    // a real, reconcilable record — not a vanished order.
    const orderIdUnknown = !buy.orderId;
    const orderIdUnknownError = orderIdUnknown
      ? `Order placed but AmazonG could not capture the Amazon orderId. Open Amazon order history for ${profile} and reconcile manually` +
        (buy.amazonPurchaseId
          ? ` (checkout purchaseId ${buy.amazonPurchaseId})`
          : '')
      : null;
    if (orderIdUnknown) {
      logger.warn(
        'job.profile.placed.orderid.unknown',
        {
          jobId: job.id,
          profile,
          amazonPurchaseId: buy.amazonPurchaseId,
          message: orderIdUnknownError,
        },
        cid,
      );
    }
    // Buy succeeded — the order isn't fully "done" until the verify-phase
    // job (queued for ~10 min later by BG) confirms Amazon didn't auto-
    // cancel it. Show as "Waiting for Verification" in the table.
    // orderId-unknown placements go to action_required instead — verify
    // can't run without an orderId, and a human needs to reconcile.
    const finalStatus: JobAttemptStatus = orderIdUnknown
      ? 'action_required'
      : 'awaiting_verification';
    // Retail price source: Amazon's confirmation page first (reflects any
    // mid-flow delivery-price bumps), PDP scrape as fallback when the
    // confirmation parser doesn't find a price element. Used for BOTH
    // the local attempt row AND the /status report to BG — keeping them
    // in sync means the server copy can repopulate a fresh install.
    const retailPriceText = buy.finalPriceText ?? info.priceText;
    await deps.jobAttempts
      .update(attemptId, {
        status: finalStatus,
        cost: retailPriceText,
        cashbackPct: buy.cashbackPct,
        orderId: buy.orderId,
        // Actual quantity picked at /spc — replaces the BG-requested
        // quantity that was stored at fan-out time (always 1 for now).
        quantity: buy.quantity,
        error: orderIdUnknownError,
        // Filler-mode context for the verify phase to pick up ~10 min
        // later. Empty arrays / null on non-filler buys. cartAsins is
        // the FULL cart ASIN list (target + every committed filler) —
        // verify uses it to re-scan order history when buy-time scan
        // had partial coverage (INC-2026-05-10).
        ...(useFillers
          ? { fillerOrderIds, cartAsins, preBuyOrderIds, productTitle }
          : {}),
      },
      // forceFlush: a buy that placed an order MUST hit disk the
      // instant its orderId/status is known. The normal debounced
      // write can be deferred up to MAX_DEBOUNCE_MS, and a process
      // restart/crash in that window would drop the placed order's
      // record entirely (the ghost-order bug).
      { forceFlush: true })
      .catch(() => undefined);
    return {
      email: profile,
      // action_required when the order placed but we couldn't capture
      // its orderId — keeps it OUT of the "completed" bucket so it
      // can't be mistaken for a clean success, while still preserving
      // placedAt / amazonPurchaseId below so it's a reconcilable row.
      status: orderIdUnknown ? 'action_required' : 'completed',
      orderId: buy.orderId,
      placedPrice: retailPriceText,
      placedCashbackPct: buy.cashbackPct,
      placedAt,
      placedQuantity: buy.quantity,
      error: orderIdUnknownError,
      stage: null,
      fillerOrderIds,
      amazonPurchaseId: buy.amazonPurchaseId,
      targetAsin: parseAsinFromUrl(job.productUrl),
      // Filler buy-context — forwarded to BG so a cross-machine verify
      // / cancel_fillers pass can re-scan order history. cartAsins is
      // target + every committed filler; fillersAdded excludes the
      // target. Empty / 0 on single-mode buys.
      cartAsins,
      preBuyOrderIds,
      fillersAddedCount: useFillers ? Math.max(0, cartAsins.length - 1) : 0,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = friendlyJobError(raw, profile);
    // Surface err.cause's message when present (NavigationError /
    // SelectorNotFoundError / etc. wrap underlying Playwright errors as
    // `cause`). Without this we lose the actionable signal — "goto
    // failed" alone doesn't tell us whether it was a timeout, an
    // ERR_ABORTED on Amazon's redirect chain, "Target closed", etc.
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause : null;
    logger.error(
      'job.profile.fail',
      {
        jobId: job.id,
        profile,
        error: message,
        ...(cause ? { causeName: cause.name, causeMessage: cause.message.slice(0, 400) } : {}),
      },
      cid,
    );
    // Dev-mode HTML+PNG + probe when scrape navigation fails. Gives us
    // the page state at the moment goto threw (often a /ap/signin
    // redirect, a captcha interstitial, or a stale-cart /spc redirect).
    // captureDebugSnapshot writes only on unpackaged dev runs.
    if (page && /NavigationError/.test(raw)) {
      const probe = await probePageDiag(page, {
        signin_form: 'form#ap_signin_form, input#ap_email',
        captcha: 'form[action*="validateCaptcha"], #captchacharacters',
        buy_now_button: '#buy-now-button',
        oos_widget: '#outOfStock_feature_div',
        qty_limit_widget: '#quantityLimitExhaustionAOD_feature_div',
        spc_marker: 'input[name="placeYourOrder1"]',
        errors_marker: 'h1, h2',
      }).catch(() => null);
      logger.warn(
        'job.profile.fail.nav.probe',
        { jobId: job.id, profile, url: page.url(), probe },
        cid,
      );
      const snap = await captureDebugSnapshot(page, deps.debugDir, 'nav_failed');
      if (snap) {
        logger.info(
          'job.profile.fail.nav.snapshot',
          { jobId: job.id, profile, png: snap.pngPath, html: snap.htmlPath },
          cid,
        );
      }
    }
    await maybeSnapshot(message, page, attemptId, session, deps, cid, { jobId: job.id, profile });
    await deps.jobAttempts
      .update(attemptId, { status: 'failed', error: message })
      .catch(() => undefined);
    await closeAndForgetSession(sessions, profile);
    return failed(profile, message);
  } finally {
    // Tear down our buy page. On worker-owned sessions the preceding
    // closeAndForgetSession already nuked the context (this becomes a
    // cheap catch). On borrowed sessions the context stays up (by
    // design — it's the user's "View Order" window) but our tab is
    // gone, so they don't see a wedged buy page.
    if (page) {
      await page.close().catch(() => undefined);
    }
  }
}

async function maybeSnapshot(
  error: string,
  page: Page | null,
  attemptId: string,
  session: DriverSession | null,
  deps: Deps,
  cid: string,
  logCtx: Record<string, unknown>,
): Promise<void> {
  const inDev = await isUnpackagedRun();
  if (page && inDev) {
    const snap = await captureFailureSnapshot(page, attemptId, session?.context).catch(() => null);
    if (snap) logger.info('snapshot.captured', { ...logCtx, ...snap }, cid);
  } else if (session && inDev) {
    // Dev started tracing earlier — stop it cleanly when we can't capture.
    await discardTracing(session.context).catch(() => undefined);
  }
}

function failed(email: string, error: string, stage: string | null = null): ProfileResult {
  return {
    email,
    status: 'failed',
    orderId: null,
    placedPrice: null,
    placedCashbackPct: null,
    placedAt: null,
    placedQuantity: 0,
    error,
    stage,
    fillerOrderIds: [],
    amazonPurchaseId: null,
    targetAsin: null,
  };
}

/**
 * Per-profile outcome for situations the bot can't resolve on its own —
 * the user has to step in (re-login, complete a card-verification
 * challenge, etc.). Distinct from `failed` so the dashboard can flag
 * actionable rows separately from rows that failed for product-side
 * reasons (oos, price, etc.). The reason text is what the user sees in
 * the table, so callers should phrase it as instructions ("Account
 * signed out — re-login from Accounts tab").
 */
function actionRequired(email: string, error: string, stage: string | null = null): ProfileResult {
  return {
    email,
    status: 'action_required',
    orderId: null,
    placedPrice: null,
    placedCashbackPct: null,
    placedAt: null,
    placedQuantity: 0,
    error,
    stage,
    fillerOrderIds: [],
    amazonPurchaseId: null,
    targetAsin: null,
  };
}

/**
 * Reasons the bot maps to action_required instead of failed. Kept narrow
 * intentionally — only situations where the user has a clear next step.
 * Verify-stage card challenges (PMTS "Verify your card"), signed-out
 * sessions, and a missing delivery address all fit; product-side issues
 * (out of stock, wrong region) do not — those are environmental and the
 * bot retries them on the next round naturally.
 */
function isActionRequiredReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const s = reason.toLowerCase();
  // signed_out reason from the verifyProductDetailed signedIn step
  // surfaces as "Amazon account is signed out — …" in the report.detail.
  if (s.includes('signed out')) return true;
  // PMTS "Verify your card" buyNow place_order failure, surfaced
  // verbatim by the place-order helper when the challenge is detected.
  if (s.includes('verify your card')) return true;
  // The Amazon account has no delivery address — checkout can't
  // proceed until the user adds one. waitForCheckout surfaces this
  // verbatim as "Add delivery address".
  if (s.includes('add delivery address')) return true;
  // No payment method on the account and no assignable card (or the
  // auto-add failed) — needs the user. Surfaced as "Add payment
  // method".
  if (s.includes('add payment method')) return true;
  return false;
}

function friendlyJobError(raw: string, profile: string): string {
  if (/ProcessSingleton|profile is already in use|SingletonLock/i.test(raw)) {
    return `Amazon profile "${profile}" is in use by another open window (e.g. Your Orders or a sign-in window). Close it before running jobs — Chromium only allows one process per profile.`;
  }
  if (/Target page, context or browser has been closed/i.test(raw)) {
    return `Browser session for "${profile}" closed unexpectedly. Try Start again.`;
  }
  return raw;
}

/**
 * Sessions we borrowed from outside the worker (e.g. a user-opened
 * "View Order" window). These are tracked separately so the worker's
 * own close paths never shut down a context another part of the app
 * still depends on — we just drop our reference to it.
 */
const borrowedSessions = new WeakSet<DriverSession>();

async function getSession(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  profile: string,
  headlessOverride?: boolean,
): Promise<DriverSession> {
  const existing = sessions.get(profile);
  if (existing) return existing;
  // Before launching a fresh persistent context, see if another part
  // of the app already has one open for this profile (e.g. a "View
  // Order" window the user clicked open). Chromium's SingletonLock
  // only allows one process per userDataDir, so a blind openSession
  // call would fail with "profile in use by another open window"
  // — which is exactly what happens on manual force-verify when the
  // user still has an order tab open. Reuse the existing context.
  const external = deps.findExistingSession?.(profile) ?? null;
  if (external) {
    borrowedSessions.add(external);
    sessions.set(profile, external);
    return external;
  }
  // Per-profile value wins over the global fallback. Undefined (caller
  // didn't pass) means no per-profile preference known → use global.
  const headless = headlessOverride ?? deps.headless;
  const s = await openSession(profile, {
    userDataRoot: deps.userDataRoot,
    headless,
  });
  sessions.set(profile, s);
  return s;
}

async function closeAndForgetSession(
  sessions: Map<string, DriverSession>,
  profile: string,
): Promise<void> {
  const s = sessions.get(profile);
  if (!s) return;
  sessions.delete(profile);
  // Borrowed sessions are owned elsewhere — dropping our map entry
  // is enough. Calling close() would kill the user's "View Order"
  // window (or whatever external thing opened the context).
  if (borrowedSessions.has(s)) return;
  try {
    await s.close();
  } catch {
    // already closed / browser exited
  }
}

/**
 * Close every session in the map in parallel. Swallows individual
 * close errors (a context that's already gone throws, but we want to
 * keep draining the rest of the map). Borrowed sessions (from
 * elsewhere in the app) are dropped but not actually closed — they
 * live past the worker's lifetime.
 */
async function closeAllSessions(sessions: Map<string, DriverSession>): Promise<void> {
  const snapshot = Array.from(sessions.entries());
  sessions.clear();
  await Promise.allSettled(
    snapshot.map(async ([email, s]) => {
      if (borrowedSessions.has(s)) return;
      try {
        await s.close();
      } catch (err) {
        logger.warn('session.close.error', { email, error: String(err) });
      }
    }),
  );
}

async function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  const step = 200;
  for (let elapsed = 0; elapsed < ms && stillRunning(); elapsed += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}
