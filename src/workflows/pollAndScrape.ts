import type { Page } from 'playwright';
import type { BGClient } from '../bg/client.js';
import type { DriverSession } from '../browser/driver.js';
import { openSession } from '../browser/driver.js';
import { scrapeProduct } from '../actions/scrapeProduct.js';
import { buyNow } from '../actions/buyNow.js';
import { clearCartHttpOnly, type ClearCartResult } from '../actions/clearCart.js';
import {
  buyWithFillers,
  type BuyWithFillersResult,
} from '../actions/buyWithFillers.js';
import {
  cancelFillerOrder,
  cancelFillerOrderViaOrderDetails,
} from '../actions/cancelFillerOrder.js';
import { cancelNonTargetItems } from '../actions/cancelNonTargetItems.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { fetchTracking } from '../actions/fetchTracking.js';
import { DEFAULT_CONSTRAINTS, verifyProductDetailed } from '../parsers/productConstraints.js';
import { runBuyTuple } from './runners.js';
import { buildBuyJobReport } from './jobReport.js';
import { shouldUseFillers } from '../shared/fillerMode.js';
import { logger } from '../shared/logger.js';
import { captureFailureSnapshot, discardTracing, shouldCapture, startTracing } from '../browser/snapshot.js';
import { makeAttemptId, parseAsinFromUrl } from '../shared/sanitize.js';
import type {
  AmazonProfile,
  AutoGJob,
  BuyResult,
  JobAttempt,
  JobAttemptStatus,
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
};

export type Deps = {
  bg: BGClient;
  userDataRoot: string;
  /** Where buyNow drops debug screenshots when checkout silently fails. */
  debugDir: string;
  /** Snapshot capture settings — read from Settings at worker start. */
  snapshotOnFailure: boolean;
  snapshotGroups: string[];
  headless: boolean;
  buyDryRun: boolean;
  /**
   * Global "Buy with Fillers" switch — when true EVERY enabled account's
   * buy phase routes through the cart+filler flow (Buy Now as add-to-cart,
   * 10 filler items, Proceed to Checkout, then the shared SPC tail).
   * When true the fan-out concurrency also drops to 1 (one account at a
   * time) so we don't hammer Amazon with parallel filler sessions.
   */
  buyWithFillers: boolean;
  minCashbackPct: number;
  allowedAddressPrefixes: string[];
  /**
   * Re-read each per-claim from disk so the user can tune Parallel
   * buys in Settings without stopping the worker. Returns the
   * parallel-buy knobs as a struct; we don't pass the whole Settings
   * object so the worker stays decoupled from fields it doesn't care
   * about.
   */
  loadParallelism: () => Promise<{
    maxConcurrentBuys: number;
    /** When true (and the buy is in filler mode), the filler picker
     *  uses a whey-protein-only term pool instead of the general
     *  impulse mix. Read every claim so a Settings toggle takes
     *  effect on the next deal without restarting the worker. */
    wheyProteinFillerOnly: boolean;
    /** Experimental: when true AND the buy is in filler mode AND the
     *  cashback gate fails with B1 (target's group has no "% back"
     *  radio at all), run surgical recovery (remove bundle-mates
     *  from cart, optionally replace fillers) instead of the default
     *  3-attempt replace-everything retry. Read every claim so a
     *  Settings toggle takes effect on the next deal. */
    surgicalCashbackRecovery: boolean;
  }>;
  /** Returns every enabled+loggedIn profile we should fan out the job to. */
  listEligibleProfiles: () => Promise<AmazonProfile[]>;
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
 * How many times we re-run the whole filler buy (clear cart → Buy Now
 * → pick new random fillers → Proceed to Checkout → verify cashback)
 * before giving up on a cashback_gate failure.
 *
 * Rationale: the 6% back eligibility on /spc is attached to Amazon's
 * random shipping-group assignment, which depends on which fillers
 * land in the cart this time around. A different filler set often
 * lands the target in a different group with different cashback. So
 * retrying the whole thing with fresh fillers is a legit way to shake
 * the dice. Other failure stages (item_unavailable, buy_now_click,
 * checkout_address, etc.) indicate the account or product is the
 * problem, so we fail fast on those.
 */
const FILLER_MAX_ATTEMPTS = 3;

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
    /only target item is cancellable/i.test(reason)
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
): Promise<{
  fillerOrdersCancelled: string[];
  fillerOrdersFailed: string[];
}> {
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
}> {
  const MAX_TRIES = 3;

  // 1. Cancel the filler-only orders (orders that do NOT contain the target).
  const { fillerOrdersCancelled, fillerOrdersFailed } =
    await cancelFillerOrdersOnly(page, fillerOrderIds, cid);

  // 2. Clean the target order — cancel everything except the target.
  let targetOrderCleaned = false;
  let targetCleanError: string | null = null;
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
    logger.warn(
      'job.verify.filler.targetClean.attempt',
      { orderId: targetOrderId, attempt: tryN, reason: r.reason, detail: r.detail },
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
  productTitle: string | null;
}> {
  const buyAttemptId = job.buyJobId
    ? makeAttemptId(job.buyJobId, profileEmail)
    : activeAttemptId;
  const attempt = await deps.jobAttempts.get(buyAttemptId).catch(() => null);
  return {
    buyAttemptId,
    fillerOrderIds: attempt?.fillerOrderIds ?? [],
    productTitle: attempt?.productTitle ?? null,
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
    const cleanup = await cancelFillerOrdersOnly(page, fillerOrderIds, cid);
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
  /** Live "Whey Protein Filler only" toggle, re-read each claim. Single-
   *  mode buys never reach here. */
  wheyProteinFillerOnly: boolean,
  /** Live experimental.surgicalCashbackRecovery toggle. When on,
   *  buyWithFillers handles B1 cashback failures via the inline
   *  surgical flow AND we skip the 3-attempt outer retry — surgical
   *  is the only recovery path. */
  surgicalCashbackRecovery: boolean,
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
  // When surgical recovery is on, we run buyWithFillers ONCE — it
  // handles B1 cashback failures inline via the surgical flow. The
  // outer 3-attempt retry exists to give "different-fillers shuffle"
  // a chance; surgical is a different (and incompatible) recovery
  // strategy that runs in-place. Forcing maxAttempts=1 when surgical
  // is on means a non-cashback_gate failure short-circuits same as
  // before; a cashback_gate failure surfaces the surgical-exhausted
  // result directly.
  const maxAttempts = surgicalCashbackRecovery ? 1 : FILLER_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      logger.info(
        'step.fillerBuy.retryWhole.start',
        {
          attempt,
          maxAttempts,
          priorReason: lastRaw.ok ? null : lastRaw.reason,
          excludedAsinsCount: attemptedAsins.size,
        },
        cid,
      );
    }
    lastRaw = await buyWithFillers(page, {
      productUrl: job.productUrl,
      maxPrice: job.maxPrice,
      allowedAddressPrefixes: deps.allowedAddressPrefixes,
      minCashbackPct,
      requireMinCashback,
      dryRun: deps.buyDryRun,
      wheyProteinFillerOnly,
      attemptedAsins,
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
      // Experimental — buyWithFillers handles B1 cashback failures
      // inline when this is on. See BuyWithFillersOptions.surgicalCashbackRecovery.
      surgicalCashbackRecovery,
      onStage,
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
    // Only retry when the failure is specifically a cashback_gate miss.
    // Any other stage (item_unavailable, buy_now_click, checkout_address,
    // etc.) points at account or product state that a rerun won't fix —
    // cheaper to bail out than to burn another ~60–80s per attempt.
    if (lastRaw.stage !== 'cashback_gate') break;
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
  const isDryRun = f.stage === 'dry_run_success';
  return {
    ok: true,
    dryRun: isDryRun,
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
  /** Failure stage from BuyResult.stage (null on success, dry run, or
   *  pre-buy verify-stage failures). Propagated to BG so the server can
   *  decide on follow-up actions like auto-rebuy on cashback_gate
   *  without text-matching the reason string. */
  stage: string | null;
  dryRun: boolean;
  /** Filler-only order ids from this profile's Place Order fan-out.
   *  Empty on single-mode / dry-run / failure. Snapshot at buy time —
   *  propagated to BG via the /status report for the audit trail. */
  fillerOrderIds: string[];
  /** Amazon's checkout-session purchaseId from the thank-you URL.
   *  Distinct from orderId; one per Place Order click, persists across
   *  fan-out splits. Null when the buy didn't reach Place Order or was
   *  a dry-run. Audit-only — see docs/research/amazon-pipeline.md. */
  amazonPurchaseId: string | null;
};

export function startWorker(deps: Deps): WorkerHandle {
  let running = true;
  const sessions = new Map<string, DriverSession>();

  let streamingHandle: { stop: () => Promise<void> } | null = null;
  // Per-job preamble for the streaming scheduler: filter eligible,
  // build per-account override maps. Called by StreamingScheduler's
  // producer for every claimed job before tuples are pushed to the
  // ready queue.
  const resolveStreamingJobContext = async (job: AutoGJob) => {
    const eligibleAll = await deps.listEligibleProfiles();
    if (eligibleAll.length === 0) return null;

    // Buy phase: use enabled profiles and build per-account overrides.
    // Verify/tracking phase: use the placedEmail account if it's
    // signed in (handleVerifyJob/handleFetchTrackingJob accept the
    // single-element list and select internally).
    if (job.phase === 'verify' || job.phase === 'fetch_tracking') {
      const target = (job.placedEmail ?? '').toLowerCase();
      const profile = eligibleAll.find(
        (p) => p.email.toLowerCase() === target,
      );
      return {
        eligible: profile ? [profile] : [],
        fillerByEmail: new Map<string, boolean>(),
        effectiveMinByEmail: new Map<string, number>(),
        requireMinByEmail: new Map<string, boolean>(),
        wheyProteinFillerOnly: false,
        surgicalCashbackRecovery: false,
      };
    }

    // Buy phase preamble:
    //   1. enabled profiles only (rebuy path scopes to placedEmail)
    //   2. fillerByEmail from shouldUseFillers (per-profile decision)
    //   3. requireMinByEmail from BG's listAmazonAccounts. On failure
    //      default to gate-enforced so a BG outage can't silently
    //      skip the cashback gate.
    //   4. effectiveMinByEmail derived from per-account requireMinCashback
    //      AND-combined with job.requireMinCashback. Either side saying
    //      "skip" means skip.
    let eligible = eligibleAll.filter((p) => p.enabled);
    if (job.placedEmail) {
      const t = job.placedEmail.toLowerCase();
      eligible = eligible.filter((p) => p.email.toLowerCase() === t);
    }
    const parallelism = await deps.loadParallelism().catch(() => ({
      maxConcurrentBuys: DEFAULT_CONCURRENT_BUYS,
      wheyProteinFillerOnly: false,
      surgicalCashbackRecovery: false,
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
      wheyProteinFillerOnly: parallelism.wheyProteinFillerOnly,
      surgicalCashbackRecovery: parallelism.surgicalCashbackRecovery,
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
    if (deps.snapshotOnFailure) await startTracing(session.context);
    // Always open a fresh page for the verify work. Reusing
    // `context.pages()[0]` would navigate a user-owned tab when the
    // session was borrowed from openOrderSessions, and leave that tab
    // pointing at the order-details page after the verify finishes
    // (closeAndForgetSession skips borrowed sessions by design).
    verifyPage = await session.newPage();
    const outcome = await verifyOrder(verifyPage, targetOrderId);

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
      if (job.viaFiller) {
        const { fillerOrderIds, productTitle } = await loadFillerBuyContext(
          deps,
          job,
          profile.email,
          activeAttemptId,
        );
        const targetAsin = parseAsinFromUrl(job.productUrl);
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
      let cancelledFillerError: string | null = null;
      if (job.viaFiller) {
        const { fillerOrderIds } = await loadFillerBuyContext(
          deps,
          job,
          profile.email,
          activeAttemptId,
        );
        if (fillerOrderIds.length > 0) {
          logger.info(
            'job.verify.cancelled.filler.cleanup.start',
            { ...logCtx, targetOrderId, fillerOrderIdCount: fillerOrderIds.length },
            cid,
          );
          const cleanup = await cancelFillerOrdersOnly(
            verifyPage,
            fillerOrderIds,
            cid,
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
    await deps.jobAttempts
      .update(activeAttemptId, { status: 'failed', error })
      .catch(() => undefined);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
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
    await deps.jobAttempts
      .update(activeAttemptId, { status: 'failed', error })
      .catch(() => undefined);
    await reportSafe(deps, job.id, { status: 'failed', error }, cid);
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
      dryRun: false,
      trackingIds: null,
      fillerOrderIds: null,
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
  /** When true (and the buy is in filler mode), the picker uses a
   *  whey-protein-only term pool with a 10–12 random count. Re-read
   *  per claim by the caller. Single-mode buys ignore. */
  wheyProteinFillerOnly: boolean,
  /** Live experimental.surgicalCashbackRecovery toggle. Re-read per
   *  claim. Filler-mode only (single-mode buys never hit the cashback
   *  gate's recovery paths in the same way). */
  surgicalCashbackRecovery: boolean,
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
    if (deps.snapshotOnFailure) await startTracing(session.context);
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

    const info = await scrapeProduct(page, job.productUrl);
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

    const constraints = { ...DEFAULT_CONSTRAINTS, maxPrice: job.maxPrice };
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
    if (useFillers) {
      const r = await runFillerBuyWithRetries(page, deps, job, cid, profile, effectiveMinCashbackPct, requireMinCashback, wheyProteinFillerOnly, surgicalCashbackRecovery, info, preflightCleared, onStage);
      buy = r.buy;
      fillerOrderIds = r.fillerOrderIds;
      productTitle = r.productTitle;
    } else {
      buy = await buyNow(page, {
        dryRun: deps.buyDryRun,
        minCashbackPct: effectiveMinCashbackPct,
        requireMinCashback,
        maxPrice: job.maxPrice,
        allowedAddressPrefixes: deps.allowedAddressPrefixes,
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

    if (session && deps.snapshotOnFailure) await discardTracing(session.context);

    if (buy.dryRun) {
      logger.info(
        'job.profile.dryrun.success',
        {
          jobId: job.id,
          profile,
          cashbackPct: buy.cashbackPct,
          message: `✓ Dry run successful for ${profile} — would have placed an order (cashback ${buy.cashbackPct ?? 'n/a'}%)`,
        },
        cid,
      );
      // Close the session so the visible browser window goes away. Next
      // job for this profile will reopen a fresh session.
      await closeAndForgetSession(sessions, profile);
    } else {
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
      // successful live placements (mirrors dry-run cleanup).
      await closeAndForgetSession(sessions, profile);
    }

    const placedAt = new Date().toISOString();
    // Buy succeeded — the order isn't fully "done" until the verify-phase
    // job (queued for ~10 min later by BG) confirms Amazon didn't auto-
    // cancel it. Show as "Waiting for Verification" in the table.
    const finalStatus: JobAttemptStatus = buy.dryRun
      ? 'dry_run_success'
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
        error: null,
        // Filler-mode context for the verify phase to pick up ~10 min
        // later. Empty arrays / null on non-filler buys.
        ...(useFillers
          ? { fillerOrderIds, productTitle }
          : {}),
      })
      .catch(() => undefined);
    return {
      email: profile,
      status: 'completed',
      orderId: buy.orderId,
      placedPrice: retailPriceText,
      placedCashbackPct: buy.cashbackPct,
      placedAt,
      placedQuantity: buy.quantity,
      error: null,
      stage: null,
      dryRun: buy.dryRun,
      fillerOrderIds,
      amazonPurchaseId: buy.amazonPurchaseId,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = friendlyJobError(raw, profile);
    logger.error('job.profile.fail', { jobId: job.id, profile, error: message }, cid);
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
  if (page && shouldCapture(error, deps.snapshotOnFailure, deps.snapshotGroups)) {
    const snap = await captureFailureSnapshot(page, attemptId, session?.context).catch(() => null);
    if (snap) logger.info('snapshot.captured', { ...logCtx, ...snap }, cid);
  } else if (session && deps.snapshotOnFailure) {
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
    dryRun: false,
    fillerOrderIds: [],
    amazonPurchaseId: null,
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
    dryRun: false,
    fillerOrderIds: [],
    amazonPurchaseId: null,
  };
}

/**
 * Reasons the bot maps to action_required instead of failed. Kept narrow
 * intentionally — only situations where the user has a clear next step.
 * Verify-stage card challenges (PMTS "Verify your card") and signed-out
 * sessions both fit; product-side issues (out of stock, wrong region) do
 * not — those are environmental and the bot retries them on the next
 * round naturally.
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
