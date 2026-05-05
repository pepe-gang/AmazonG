import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { BGClient } from '../bg/client.js';
import type { DriverSession } from '../browser/driver.js';
import { openSession } from '../browser/driver.js';
import { scrapeProduct } from '../actions/scrapeProduct.js';
import { buyNow } from '../actions/buyNow.js';
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
} from '../shared/types.js';

export type JobAttemptStore = {
  create(
    partial: Omit<JobAttempt, 'createdAt' | 'updatedAt'>,
  ): Promise<JobAttempt>;
  update(
    attemptId: string,
    patch: Partial<Omit<JobAttempt, 'attemptId' | 'jobId' | 'amazonEmail' | 'createdAt'>>,
  ): Promise<JobAttempt | null>;
  get(attemptId: string): Promise<JobAttempt | null>;
};

type Deps = {
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

/** Bounds for the parallel-buy setting exposed in the Settings page.
 *  The user-set value is clamped to this range so a hand-edited
 *  settings.json can't ask for 100 parallel Chromium windows. Lower
 *  bound 1 keeps the worker functional. */
const MIN_CONCURRENT_BUYS = 1;
const MAX_CONCURRENT_BUYS = 5;
/** Fallback defaults if a Settings field is missing (e.g. a user
 *  upgrading from a version where these didn't exist). Loadsettings
 *  itself merges defaults, so this is belt-and-suspenders. */
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
  /** Per-profile override of the min-cashback floor. See runForProfile. */
  minCashbackPct: number,
  /** Per-profile cashback gate enforcement. See runForProfile. */
  requireMinCashback: boolean,
  /** Live "Whey Protein Filler only" toggle, re-read each claim. Single-
   *  mode buys never reach here. */
  wheyProteinFillerOnly: boolean,
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
  for (let attempt = 1; attempt <= FILLER_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logger.info(
        'step.fillerBuy.retryWhole.start',
        {
          attempt,
          maxAttempts: FILLER_MAX_ATTEMPTS,
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
      correlationId: `${cid}/attempt-${attempt}`,
      onStage,
    });
    if (lastRaw.ok) {
      if (attempt > 1) {
        logger.info(
          'step.fillerBuy.retryWhole.ok',
          { attempt, maxAttempts: FILLER_MAX_ATTEMPTS },
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
    if (attempt >= FILLER_MAX_ATTEMPTS) {
      logger.warn(
        'step.fillerBuy.retryWhole.exhausted',
        { attempt, maxAttempts: FILLER_MAX_ATTEMPTS, lastReason: lastRaw.reason },
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
 * Effective fan-out concurrency — how many Amazon accounts run the
 * same job in parallel. The user-set value comes from the Settings
 * page (Parallel buys panel); falls back to DEFAULT_CONCURRENT_BUYS
 * if a settings field is missing, and is clamped to safe bounds.
 *
 * Single-mode and filler-mode share this knob since v0.13.19 — the
 * batch cart-add refactor brought filler-mode's per-account resource
 * profile in line with single-mode (no more parallel tabs inside one
 * window, just one HTTP POST).
 */
function fanoutConcurrency(parallelism: { maxConcurrentBuys: number }): number {
  const v = parallelism.maxConcurrentBuys ?? DEFAULT_CONCURRENT_BUYS;
  return Math.max(MIN_CONCURRENT_BUYS, Math.min(MAX_CONCURRENT_BUYS, v));
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

type ProfileResult = {
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
  let backoffMs = 5_000;
  const sessions = new Map<string, DriverSession>();

  let lastNoProfilesWarn = 0;
  const NO_PROFILES_WARN_INTERVAL_MS = 60_000;

  // Tracked set of in-flight lifecycle jobs (verify + fetch_tracking).
  // When the user bulk-clicks "Verify" or "Tracking now" on N rows,
  // BG queues N lifecycle jobs at once. The default serial loop
  // drains them at ~one-every-5s; running them in parallel up to
  // `maxConcurrentBuys` (the existing "Parallel buys" setting) cuts
  // the total wall-clock by Nx for typical
  // bulk operations. Both phases share one cap because they both
  // open a Playwright page in the same per-profile context — letting
  // them sum to 2× the cap could blow past the user's intended
  // window count. Buy stays serial (it has its own per-job profile
  // fan-out) and drains this set before running so phases don't
  // compete for the same browser resources. Held outside the loop
  // closure so the stop handler can drain it.
  const lifecycleInFlight = new Set<Promise<void>>();

  const loop = (async () => {
    logger.info('worker.start');
    while (running) {
      try {
        // Eligibility gate: don't claim a job if we have no enabled+signed-in
        // Amazon profiles to run it on. Leaves the job in BG for another
        // AutoG instance instead of claiming and immediately failing it
        // (which would mark it permanently failed in BG).
        const eligible = await deps.listEligibleProfiles();
        if (eligible.length === 0) {
          if (Date.now() - lastNoProfilesWarn > NO_PROFILES_WARN_INTERVAL_MS) {
            logger.warn('worker.idle.no_profiles', {
              note: 'No signed-in Amazon accounts. Worker is polling but will not claim jobs until at least one account is signed in. (Disabled-but-signed-in accounts can still process verify/tracking; buys require enabled.)',
            });
            lastNoProfilesWarn = Date.now();
          }
          await sleep(5_000, () => running);
          continue;
        }

        // Re-read the parallelism setting each cycle so the user can
        // tune live without restarting. Math.max(1, …) defends against
        // a 0 in settings.json (saved by mistake) — we'd otherwise
        // refuse to ever claim.
        const cap = Math.max(
          1,
          (await deps.loadParallelism().catch(() => ({
            maxConcurrentBuys: DEFAULT_CONCURRENT_BUYS,
            wheyProteinFillerOnly: false,
          }))).maxConcurrentBuys,
        );

        // At-cap → wait for one lifecycle job to finish before
        // claiming again. Promise.race resolves on the first settle
        // (success or rejection); the .finally() inside the spawn
        // removes the resolved promise from the set, so the next
        // loop iteration sees one slot freed.
        if (lifecycleInFlight.size >= cap) {
          await Promise.race(lifecycleInFlight).catch(() => undefined);
          continue;
        }

        const job = await deps.bg.claimJob();
        if (!job) {
          backoffMs = 5_000;
          // If background lifecycle work is in flight, loop again
          // right away (no sleep) so we re-claim as soon as any of
          // them finishes — keeps the pipeline saturated when BG has
          // more work waiting. Only sleep when truly idle.
          if (lifecycleInFlight.size > 0) {
            await Promise.race(lifecycleInFlight).catch(() => undefined);
            continue;
          }
          await sleep(5_000, () => running);
          continue;
        }
        const cid = randomUUID();
        logger.info('job.claim', { jobId: job.id, phase: job.phase, url: job.productUrl }, cid);

        if (job.phase === 'verify' || job.phase === 'fetch_tracking') {
          // Fire-and-track: don't await the handler. The loop body
          // continues to the next claim immediately, up to `cap`
          // concurrent in-flight jobs. Errors are logged inside the
          // IIFE so an unhandled rejection can't sneak past Node's
          // process-level handlers and crash the worker. Phase is
          // included in the log key so a wedged verify vs a wedged
          // tracking is distinguishable from log search alone.
          const phase = job.phase;
          const p = (async () => {
            try {
              await handleJob(deps, sessions, job, cid, eligible);
            } catch (err) {
              logger.error(
                `worker.${phase}.background.error`,
                {
                  error: err instanceof Error ? err.message : String(err),
                  jobId: job.id,
                },
                cid,
              );
            }
          })();
          lifecycleInFlight.add(p);
          // Self-removal so the next at-cap check is accurate. void
          // discards the chained promise (we don't need its result).
          void p.finally(() => {
            lifecycleInFlight.delete(p);
          });
          backoffMs = 5_000;
          continue;
        }

        // Buy path — serial. Drain any background verify /
        // fetch_tracking first so the buy run doesn't compete with
        // them for the same Playwright session resources.
        if (lifecycleInFlight.size > 0) {
          await Promise.allSettled([...lifecycleInFlight]);
        }
        await handleJob(deps, sessions, job, cid, eligible);
        backoffMs = 5_000;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('worker.loop.error', { error: message });
        await sleep(backoffMs, () => running);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
    // On shutdown, give in-flight lifecycle jobs a beat to settle
    // (their Playwright ops will throw shortly after closeAllSessions
    // runs, which is what we want). allSettled never rejects, so this
    // is safe even if some are mid-error.
    if (lifecycleInFlight.size > 0) {
      await Promise.allSettled([...lifecycleInFlight]);
    }
    await closeAllSessions(sessions);
    logger.info('worker.stop');
  })();

  return {
    async stop() {
      // Flip the running flag so the polling loop stops claiming new
      // jobs, then proactively close every open session. Closing the
      // BrowserContexts makes any in-flight Playwright op throw
      // immediately (page.click, page.goto, waitForSelector, etc.),
      // which the loop catches + logs, iterates once, then exits via
      // the `while (running)` gate. That means pressing Stop aborts
      // the current buy within a second or two instead of waiting
      // for the 60–300 s filler flow to finish on its own.
      //
      // We don't await `loop` — the renderer's Stop click should
      // return immediately so the UI unblocks. The loop drains its
      // in-flight work in the background.
      running = false;
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

async function handleJob(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  job: AutoGJob,
  cid: string,
  eligible: AmazonProfile[],
): Promise<void> {
  if (job.phase === 'verify') {
    await handleVerifyJob(deps, sessions, job, cid, eligible);
    return;
  }
  if (job.phase === 'fetch_tracking') {
    await handleFetchTrackingJob(deps, sessions, job, cid, eligible);
    return;
  }
  // Buy / rebuy phase — disabled accounts are excluded here. `eligible`
  // arrives carrying every signed-in account (including disabled ones,
  // because verify/tracking phases above need them); we filter down to
  // only `enabled` accounts before fan-out so disabling correctly
  // blocks new buys while leaving in-flight verify/tracking jobs intact.
  //
  // Rebuy path: when BG scopes a buy-phase job to a single Amazon account
  // (placedEmail set — e.g. the user clicked Re-buy on a cancelled row),
  // skip fan-out and run only for that account. viaFiller on a buy-phase
  // job is a per-job override of the global toggle so a rebuy always goes
  // through the filler flow even if buyWithFillers is off globally.
  if (job.placedEmail) {
    const target = job.placedEmail.toLowerCase();
    const match = eligible.find(
      (p) => p.email.toLowerCase() === target && p.enabled,
    );
    if (!match) {
      const signedInButDisabled = eligible.some(
        (p) => p.email.toLowerCase() === target && !p.enabled,
      );
      const error = signedInButDisabled
        ? `rebuy target ${job.placedEmail} is signed in but disabled — re-enable in the Accounts tab to allow rebuys`
        : `rebuy target ${job.placedEmail} is not enabled or not signed in`;
      logger.error('job.rebuy.no_profile', { jobId: job.id, target: job.placedEmail, signedInButDisabled }, cid);
      await deps.bg
        .reportStatus(job.id, { status: 'failed', error })
        .catch(() => undefined);
      return;
    }
    eligible = [match];
  } else {
    // Fan-out buy: filter to enabled-only accounts. Disabled accounts that
    // are signed in stay in the parent `eligible` list for verify/tracking
    // but are dropped here so they can't take new buys.
    const beforeFilter = eligible.length;
    eligible = eligible.filter((p) => p.enabled);
    if (eligible.length === 0) {
      const error =
        beforeFilter === 0
          ? 'no signed-in Amazon accounts available for this buy'
          : `no enabled Amazon accounts available for this buy (${beforeFilter} signed-in but all disabled)`;
      logger.error(
        'job.buy.no_enabled_profiles',
        { jobId: job.id, signedInCount: beforeFilter },
        cid,
      );
      await deps.bg
        .reportStatus(job.id, { status: 'failed', error })
        .catch(() => undefined);
      return;
    }
  }
  // Per-profile filler decision. The returned map lets every downstream
  // step (row create, BG report, runForProfile branch) agree on which
  // accounts ran through the filler flow, without re-computing.
  const fillerByEmail = new Map<string, boolean>(
    eligible.map((p) => [p.email, shouldUseFillers(deps.buyWithFillers, p, job.viaFiller)]),
  );

  // Per-Amazon-account cashback-gate overrides from BG. One HTTP call per
  // job claim; on failure we fall through to the default (gate enabled)
  // so a BG outage can't silently skip the gate. Accounts the user
  // hasn't registered on BG aren't in the map → default to requireMinCashback=true.
  const accountOverrides = await deps.bg.listAmazonAccounts().catch((err) => {
    logger.warn(
      'job.accounts.load.fail',
      { jobId: job.id, error: err instanceof Error ? err.message : String(err) },
      cid,
    );
    return { accounts: [], bgAccounts: [] };
  });
  const requireMinByEmail = new Map<string, boolean>(
    accountOverrides.accounts.map((a) => [a.email.toLowerCase(), a.requireMinCashback]),
  );
  // Per-job override AND-combines with the per-account flag — either side
  // saying "skip" means skip. Defaults to true (gate enforced) so older BG
  // deployments that don't send the field keep the existing behavior.
  const jobRequiresMinCashback = job.requireMinCashback !== false;
  const effectiveMinByEmail = new Map<string, number>(
    eligible.map((p) => {
      const accountRequires = requireMinByEmail.get(p.email.toLowerCase()) ?? true;
      const enforce = accountRequires && jobRequiresMinCashback;
      return [p.email, enforce ? deps.minCashbackPct : 0];
    }),
  );
  logger.info(
    'job.accounts.gates',
    {
      jobId: job.id,
      jobRequiresMinCashback,
      gates: eligible.map((p) => ({
        email: p.email,
        requireMinCashback: requireMinByEmail.get(p.email.toLowerCase()) ?? true,
        effectiveMinCashbackPct: effectiveMinByEmail.get(p.email) ?? deps.minCashbackPct,
      })),
    },
    cid,
  );
  const anyFiller = Array.from(fillerByEmail.values()).some(Boolean);
  // Re-read parallelism settings per claim — lets the user tune from
  // the Settings page without restarting the worker. Loadsettings is
  // cheap (one JSON file read) and only fires once per job claim
  // (~5s cadence under heavy load), so the cost is negligible.
  const parallelism = await deps.loadParallelism().catch(() => ({
    maxConcurrentBuys: DEFAULT_CONCURRENT_BUYS,
    wheyProteinFillerOnly: false,
  }));
  const concurrency = fanoutConcurrency(parallelism);
  logger.info(
    'job.fanout.start',
    {
      jobId: job.id,
      profiles: eligible.map((p) => p.email),
      concurrency: Math.min(concurrency, eligible.length),
      maxConcurrentBuys: parallelism.maxConcurrentBuys,
      buyWithFillers: deps.buyWithFillers,
      anyFiller,
      rebuy: !!job.placedEmail,
    },
    cid,
  );

  // Create one attempt row per (job, profile) so the table reflects work
  // about to start (status: queued → in_progress as each runs).
  await Promise.all(
    eligible.map((p) =>
      deps.jobAttempts.create({
        attemptId: makeAttemptId(job.id, p.email),
        jobId: job.id,
        amazonEmail: p.email,
        phase: job.phase,
        dealKey: job.dealKey,
        dealId: job.dealId,
        dealTitle: job.dealTitle,
        productUrl: job.productUrl,
        maxPrice: job.maxPrice,
        price: job.price,
        quantity: job.quantity,
        cost: null,
        cashbackPct: null,
        orderId: null,
        status: 'queued',
        error: null,
        buyMode: fillerByEmail.get(p.email) ? 'filler' : 'single',
        dryRun: deps.buyDryRun,
        trackingIds: null,
        fillerOrderIds: null,
        productTitle: null,
        stage: null,
      }),
    ),
  );

  // Sibling-abort controller — shared across the fan-out. When ONE
  // profile detects a PRODUCT-level failure (out_of_stock or
  // price_exceeds), it fires `abortController.abort(reason)` to short-
  // circuit every other profile. In-flight siblings catch it at the
  // next checkpoint and bail with `stage: 'aborted_by_sibling'`; queued
  // workers (waiting for an in-flight slot) bail at preflight without
  // doing any PDP load. ACCOUNT-level failures (cashback_gate,
  // checkout_address, etc.) do NOT propagate — they may be specific to
  // one account's eligibility / address state, so we let other profiles
  // run independently.
  //
  // Critical invariant: the abort signal is checked BEFORE buyNow /
  // runFillerBuyWithRetries. We never abort during or after the Place
  // Order click — once the buy is in flight at Amazon, killing it
  // would leave us not knowing if it succeeded.
  const abortController = new AbortController();
  const abortSiblings = (reason: 'out_of_stock' | 'price_exceeds'): void => {
    if (abortController.signal.aborted) return;
    logger.info(
      'job.fanout.abort.fired',
      { jobId: job.id, reason },
      cid,
    );
    abortController.abort(reason);
  };

  const results = await pMap(eligible, concurrency, (profile) =>
    runForProfile(
      deps,
      sessions,
      job,
      profile,
      cid,
      fillerByEmail.get(profile.email) === true,
      effectiveMinByEmail.get(profile.email) ?? deps.minCashbackPct,
      requireMinByEmail.get(profile.email.toLowerCase()) ?? true,
      parallelism.wheyProteinFillerOnly,
      abortController.signal,
      abortSiblings,
    ),
  );

  // Aggregate.
  const successes = results.filter((r) => r.status === 'completed' && !r.dryRun);
  const dryRunPasses = results.filter((r) => r.status === 'completed' && r.dryRun);
  const failures = results.filter((r) => r.status === 'failed');
  const actionRequireds = results.filter((r) => r.status === 'action_required');

  // Summary log line — celebratory for dry-run all-pass, neutral otherwise.
  if (dryRunPasses.length === results.length && results.length > 0) {
    logger.info(
      'job.fanout.dryrun.success',
      {
        jobId: job.id,
        total: results.length,
        message: `✓ Dry run successful: all ${results.length} profile(s) would have placed an order`,
      },
      cid,
    );
  } else {
    logger.info(
      'job.fanout.done',
      {
        jobId: job.id,
        total: results.length,
        placed: successes.length,
        dryRunPassed: dryRunPasses.length,
        failed: failures.length,
        actionRequired: actionRequireds.length,
      },
      cid,
    );
  }

  // Choose the "winning" purchase (highest cashback %, ties broken by first
  // success). Used to populate parent-level placed* fields on BG.
  const winner = [...successes].sort(
    (a, b) => (b.placedCashbackPct ?? 0) - (a.placedCashbackPct ?? 0),
  )[0];

  // Determine overall status reported to BG. Dry-run never reports as
  // completed (BG would schedule a verify phase for an order that wasn't
  // actually placed). Real completions report as 'awaiting_verification'
  // — the verify-phase job (~10 min later) flips them to 'completed'
  // once Amazon confirms the order is still active. This matches the
  // AmazonG Jobs-table label "Waiting for Verification".
  //
  // action_required ranks ABOVE failed in the rollup so a job where
  // every profile needs human attention surfaces as Action Required
  // (the user gets a cleaner signal of what to fix). When there's at
  // least one success, partial still wins regardless — a partial fan-
  // out's user value is the success rows, not the action-required ones.
  let overallStatus: 'awaiting_verification' | 'partial' | 'failed' | 'action_required';
  let parentError: string | null = null;
  if (successes.length > 0) {
    overallStatus = failures.length === 0 && actionRequireds.length === 0
      ? 'awaiting_verification'
      : 'partial';
  } else if (dryRunPasses.length > 0) {
    // All dry-run successes (no live orders) — BG status is 'failed' (no
    // real order to verify), but the message clearly marks it as a
    // successful test, not an actual failure.
    overallStatus = 'failed';
    parentError =
      failures.length === 0
        ? `[DRY RUN OK] All ${dryRunPasses.length} profile(s) passed all checks and would have placed orders. No real Place Order click — flip to LIVE mode to actually buy.`
        : `[DRY RUN] ${dryRunPasses.length} profile(s) would have placed orders; ${failures.length} failed verification.`;
  } else if (actionRequireds.length > 0) {
    // No success, no dry-run pass, but at least one profile needs human
    // attention. Surface as action_required (not failed) so the user can
    // resolve it; failures.length > 0 alongside this still rolls up here
    // because the actionable signal is what the user can do something about.
    overallStatus = 'action_required';
    parentError = actionRequireds[0]!.error ?? 'profile needs attention';
  } else {
    overallStatus = 'failed';
    parentError = failures[0]?.error ?? 'all profiles failed';
  }

  // Per-profile purchase rows for BG. Live successes report as
  // 'awaiting_verification' regardless of buy mode — the user wants the
  // display status consistent across modes. Whether the buy went
  // through the filler-items flow is signalled via a separate
  // `viaFiller` field on each purchase, which BG reads to flag the
  // scheduled verify job with `viaFiller=true` (which in turn triggers
  // our filler-cancellation cleanup on the verify-phase run).
  // Dry-runs always report as failed (no real order).
  const purchases = results.map((r) => ({
    amazonEmail: r.email,
    status: r.dryRun
      ? ('failed' as const)
      : r.status === 'completed'
        ? ('awaiting_verification' as const)
        : r.status === 'action_required'
          ? ('action_required' as const)
          : ('failed' as const),
    ...(fillerByEmail.get(r.email) && !r.dryRun && r.status === 'completed'
      ? { viaFiller: true as const }
      : {}),
    purchasedCount: r.placedQuantity,
    orderId: r.orderId,
    placedPrice: r.placedPrice,
    placedCashbackPct: r.placedCashbackPct,
    placedAt: r.placedAt,
    error: r.error,
    // Structured failure category (e.g. 'cashback_gate'). Forwarded so
    // BG can route follow-ups (auto-rebuy with fillers on cashback_gate)
    // without text-matching the human-readable error string.
    ...(r.stage ? { stage: r.stage } : {}),
    // Audit snapshot — only attach when this profile ran in filler mode
    // AND produced filler orders. BG persists on AutoBuyPurchase for
    // post-hoc reconciliation (see PurchaseReport.fillerOrderIds docs).
    ...(r.fillerOrderIds.length > 0 ? { fillerOrderIds: r.fillerOrderIds } : {}),
    // Amazon's checkout-session purchaseId from the thank-you URL —
    // distinct from orderId, captured at click time. Audit-only field;
    // attach only when present (failed/dry-run buys leave it null and
    // we don't bother sending null-only payloads).
    ...(r.amazonPurchaseId ? { amazonPurchaseId: r.amazonPurchaseId } : {}),
  }));

  try {
    await deps.bg.reportStatus(job.id, {
      status: overallStatus,
      ...(parentError ? { error: parentError } : {}),
      placedAt: winner?.placedAt ?? null,
      placedQuantity: winner?.placedQuantity ?? null,
      placedPrice: winner?.placedPrice ?? null,
      placedCashbackPct: winner?.placedCashbackPct ?? null,
      placedOrderId: winner?.orderId ?? null,
      placedEmail: winner?.email ?? null,
      purchases,
    });
  } catch (err) {
    logger.error('job.report.error', { jobId: job.id, error: String(err) }, cid);
  }
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

async function runForProfile(
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
    const onStage = (stage: 'placing' | null): Promise<void> =>
      deps.jobAttempts.update(attemptId, { stage }).then(() => undefined);
    if (useFillers) {
      const r = await runFillerBuyWithRetries(page, deps, job, cid, effectiveMinCashbackPct, requireMinCashback, wheyProteinFillerOnly, onStage);
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
        debugDir: deps.debugDir,
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

/** Concurrency-limited Promise.all. Preserves input order in results. */
async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  const step = 200;
  for (let elapsed = 0; elapsed < ms && stillRunning(); elapsed += step) {
    await new Promise((r) => setTimeout(r, step));
  }
}
