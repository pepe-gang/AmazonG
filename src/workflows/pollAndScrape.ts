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
import { cancelFillerOrder } from '../actions/cancelFillerOrder.js';
import { cancelNonTargetItems } from '../actions/cancelNonTargetItems.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { fetchTracking } from '../actions/fetchTracking.js';
import { DEFAULT_CONSTRAINTS, verifyProductDetailed } from '../parsers/productConstraints.js';
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

const FANOUT_CONCURRENCY = 3;
const FANOUT_CONCURRENCY_FILLER = 1;

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
  const fillerOrdersCancelled: string[] = [];
  const fillerOrdersFailed: string[] = [];

  // 1. Retry cancel on each filler-only order.
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
  onStage?: (stage: 'placing' | null) => void | Promise<void>,
): Promise<FillerRunResult> {
  let lastRaw: BuyWithFillersResult = {
    ok: false,
    stage: 'cashback_gate',
    reason: 'filler buy never ran',
  };
  for (let attempt = 1; attempt <= FILLER_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logger.info(
        'step.fillerBuy.retryWhole.start',
        { attempt, maxAttempts: FILLER_MAX_ATTEMPTS, priorReason: lastRaw.ok ? null : lastRaw.reason },
        cid,
      );
    }
    lastRaw = await buyWithFillers(page, {
      productUrl: job.productUrl,
      maxPrice: job.maxPrice,
      allowedAddressPrefixes: deps.allowedAddressPrefixes,
      minCashbackPct: deps.minCashbackPct,
      dryRun: deps.buyDryRun,
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
 * Effective fan-out concurrency. Filler mode spins up FILLER_WORKERS parallel tabs
 * inside each account's BrowserContext already; running more than one
 * account simultaneously layers on 5× extra tabs per account and is
 * the fastest way to get rate-limited. One at a time for filler mode.
 */
function fanoutConcurrency(deps: { buyWithFillers: boolean }): number {
  return deps.buyWithFillers ? FANOUT_CONCURRENCY_FILLER : FANOUT_CONCURRENCY;
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
    finalPrice: 'finalPrice' in f ? f.finalPrice : null,
    finalPriceText: 'finalPriceText' in f ? f.finalPriceText : null,
    cashbackPct: f.targetCashbackPct,
    quantity: f.placedQuantity ?? 1,
  };
}

type ProfileResult = {
  email: string;
  status: 'completed' | 'failed';
  orderId: string | null;
  placedPrice: string | null;
  placedCashbackPct: number | null;
  placedAt: string | null;
  /** Quantity actually checked out (max numeric option from /spc dropdown). */
  placedQuantity: number;
  error: string | null;
  dryRun: boolean;
};

export function startWorker(deps: Deps): WorkerHandle {
  let running = true;
  let backoffMs = 5_000;
  const sessions = new Map<string, DriverSession>();

  let lastNoProfilesWarn = 0;
  const NO_PROFILES_WARN_INTERVAL_MS = 60_000;

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
              note: 'No enabled + signed-in Amazon accounts. Worker is polling but will not claim jobs until at least one account is ready.',
            });
            lastNoProfilesWarn = Date.now();
          }
          await sleep(5_000, () => running);
          continue;
        }

        const job = await deps.bg.claimJob();
        if (!job) {
          backoffMs = 5_000;
          await sleep(5_000, () => running);
          continue;
        }
        const cid = randomUUID();
        logger.info('job.claim', { jobId: job.id, phase: job.phase, url: job.productUrl }, cid);
        // Pass the eligibility check result through so handleJob doesn't
        // hit profiles.json a second time per claim.
        await handleJob(deps, sessions, job, cid, eligible);
        backoffMs = 5_000;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('worker.loop.error', { error: message });
        await sleep(backoffMs, () => running);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
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
  // Rebuy path: when BG scopes a buy-phase job to a single Amazon account
  // (placedEmail set — e.g. the user clicked Re-buy on a cancelled row),
  // skip fan-out and run only for that account. viaFiller on a buy-phase
  // job is a per-job override of the global toggle so a rebuy always goes
  // through the filler flow even if buyWithFillers is off globally.
  if (job.placedEmail) {
    const target = job.placedEmail.toLowerCase();
    const match = eligible.find((p) => p.email.toLowerCase() === target);
    if (!match) {
      const error = `rebuy target ${job.placedEmail} is not an enabled + signed-in Amazon account`;
      logger.error('job.rebuy.no_profile', { jobId: job.id, target: job.placedEmail }, cid);
      await deps.bg
        .reportStatus(job.id, { status: 'failed', error })
        .catch(() => undefined);
      return;
    }
    eligible = [match];
  }
  const useFillers = deps.buyWithFillers || job.viaFiller;
  const localDeps: Deps = useFillers === deps.buyWithFillers
    ? deps
    : { ...deps, buyWithFillers: useFillers };
  const concurrency = fanoutConcurrency(localDeps);
  logger.info(
    'job.fanout.start',
    {
      jobId: job.id,
      profiles: eligible.map((p) => p.email),
      concurrency: Math.min(concurrency, eligible.length),
      buyWithFillers: localDeps.buyWithFillers,
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
        buyMode: localDeps.buyWithFillers ? 'filler' : 'single',
        dryRun: localDeps.buyDryRun,
        trackingIds: null,
        fillerOrderIds: null,
        productTitle: null,
        stage: null,
      }),
    ),
  );

  const results = await pMap(eligible, concurrency, (profile) =>
    runForProfile(localDeps, sessions, job, profile, cid),
  );

  // Aggregate.
  const successes = results.filter((r) => r.status === 'completed' && !r.dryRun);
  const dryRunPasses = results.filter((r) => r.status === 'completed' && r.dryRun);
  const failures = results.filter((r) => r.status === 'failed');

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
  let overallStatus: 'awaiting_verification' | 'partial' | 'failed';
  let parentError: string | null = null;
  if (successes.length > 0) {
    overallStatus = failures.length === 0 ? 'awaiting_verification' : 'partial';
  } else if (dryRunPasses.length > 0) {
    // All dry-run successes (no live orders) — BG status is 'failed' (no
    // real order to verify), but the message clearly marks it as a
    // successful test, not an actual failure.
    overallStatus = 'failed';
    parentError =
      failures.length === 0
        ? `[DRY RUN OK] All ${dryRunPasses.length} profile(s) passed all checks and would have placed orders. No real Place Order click — flip to LIVE mode to actually buy.`
        : `[DRY RUN] ${dryRunPasses.length} profile(s) would have placed orders; ${failures.length} failed verification.`;
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
        : ('failed' as const),
    ...(localDeps.buyWithFillers && !r.dryRun && r.status === 'completed'
      ? { viaFiller: true as const }
      : {}),
    purchasedCount: r.placedQuantity,
    orderId: r.orderId,
    placedPrice: r.placedPrice,
    placedCashbackPct: r.placedCashbackPct,
    placedAt: r.placedAt,
    error: r.error,
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

  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    if (deps.snapshotOnFailure) await startTracing(session.context);
    const existing = session.context.pages();
    const page = existing[0] ?? (await session.newPage());
    const outcome = await verifyOrder(page, targetOrderId);

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
        // Load the attempt we just updated to pull the stashed filler
        // context from buy time. List the attempts via jobAttempts —
        // the store exposes update; we read through a plain lookup.
        const buyAttemptId = job.buyJobId
          ? makeAttemptId(job.buyJobId, profile.email)
          : activeAttemptId;
        const attemptForContext = await deps.jobAttempts
          .update(buyAttemptId, {})
          .catch(() => null);
        const fillerOrderIds = attemptForContext?.fillerOrderIds ?? [];
        const productTitle = attemptForContext?.productTitle ?? null;
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
          page,
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
        // Persist any remaining uncancelled filler orders on the
        // attempt so a future sweep (or a human) can see which
        // orders slipped through — rather than losing that info.
        if (
          cleanup.fillerOrdersFailed.length > 0 ||
          !cleanup.targetOrderCleaned
        ) {
          const errorParts: string[] = [];
          if (cleanup.fillerOrdersFailed.length > 0) {
            errorParts.push(
              `${cleanup.fillerOrdersFailed.length} filler order(s) still uncancelled: ${cleanup.fillerOrdersFailed.join(', ')}`,
            );
          }
          if (!cleanup.targetOrderCleaned && cleanup.targetCleanError) {
            errorParts.push(`target-order clean failed: ${cleanup.targetCleanError}`);
          }
          await deps.jobAttempts
            .update(activeAttemptId, {
              fillerOrderIds: cleanup.fillerOrdersFailed,
              error: errorParts.join(' | '),
            })
            .catch(() => undefined);
        } else {
          // All clean — empty the persisted list.
          await deps.jobAttempts
            .update(activeAttemptId, { fillerOrderIds: [] })
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
      await reportSafe(
        deps,
        job.id,
        {
          status: 'cancelled',
          error: 'order was cancelled by Amazon',
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
      await maybeSnapshot(error, page, activeAttemptId, session, deps, cid, { ...logCtx });
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
    logger.info(
      'job.verify.cleanup',
      { ...logCtx, message: 'Closing verify browser window' },
      cid,
    );
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

  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    const existing = session.context.pages();
    const page = existing[0] ?? (await session.newPage());
    const outcome = await fetchTracking(page, targetOrderId);

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
    logger.info(
      'job.fetchTracking.cleanup',
      { ...logCtx, message: 'Closing fetch_tracking browser window' },
      cid,
    );
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
  const buyAttemptId = job.buyJobId
    ? makeAttemptId(job.buyJobId, profileEmail)
    : null;

  if (buyAttemptId) {
    const bumped = await deps.jobAttempts
      .update(buyAttemptId, { status: 'in_progress', error: null })
      .catch(() => null);
    if (bumped) return buyAttemptId;
  }

  const attemptId = makeAttemptId(job.id, profileEmail);
  await deps.jobAttempts
    .create({
      attemptId,
      jobId: job.id,
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
): Promise<ProfileResult> {
  const profile = profileData.email;
  // Per-profile correlation id so logs across the parallel runs are
  // distinguishable (parent cid is shared by all profiles in a fan-out).
  const cid = `${parentCid}/${profile}`;
  const attemptId = makeAttemptId(job.id, profile);

  await deps.jobAttempts
    .update(attemptId, { status: 'in_progress' })
    .catch(() => undefined);

  let page: Page | null = null;
  let session: DriverSession | null = null;
  try {
    logger.info('job.profile.start', { jobId: job.id, profile }, cid);
    session = await getSession(deps, sessions, profile, profileData.headless);
    if (deps.snapshotOnFailure) await startTracing(session.context);
    // Reuse the persistent context's existing tab (Chromium starts with an
    // about:blank). Don't create a new tab for each job — that leaves the
    // initial blank tab orphaned next to ours.
    const existing = session.context.pages();
    page = existing[0] ?? (await session.newPage());

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
      await deps.jobAttempts
        .update(attemptId, {
          status: 'failed',
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
      logger.info(
        'job.profile.fail.cleanup',
        {
          jobId: job.id,
          profile,
          reason: report.reason,
          message: `Closing browser window after verify failure (${report.reason})`,
        },
        cid,
      );
      await closeAndForgetSession(sessions, profile);
      return failed(profile, error);
    }
    logger.info('step.verify.ok', { jobId: job.id, profile }, cid);

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
    if (deps.buyWithFillers) {
      const r = await runFillerBuyWithRetries(page, deps, job, cid, onStage);
      buy = r.buy;
      fillerOrderIds = r.fillerOrderIds;
      productTitle = r.productTitle;
    } else {
      buy = await buyNow(page, {
        dryRun: deps.buyDryRun,
        minCashbackPct: deps.minCashbackPct,
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
      await deps.jobAttempts
        .update(attemptId, {
          status: 'failed',
          error,
          cost: info.priceText,
          cashbackPct: info.cashbackPct,
        })
        .catch(() => undefined);
      logger.info(
        'job.profile.fail.cleanup',
        {
          jobId: job.id,
          profile,
          stage: buy.stage,
          message: `Closing browser window after buy failure (${buy.stage})`,
        },
        cid,
      );
      await closeAndForgetSession(sessions, profile);
      return failed(profile, error);
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
      logger.info(
        'job.profile.dryrun.cleanup',
        {
          jobId: job.id,
          profile,
          message: 'Closing browser window after dry-run success',
        },
        cid,
      );
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
      logger.info(
        'job.profile.placed.cleanup',
        {
          jobId: job.id,
          profile,
          message: 'Closing browser window after successful order placement',
        },
        cid,
      );
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
        ...(deps.buyWithFillers
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
      dryRun: buy.dryRun,
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
    // Do NOT close the page — it's the session's only tab and closing it
    // would terminate the persistent Chromium context (browser quits when
    // the last page closes). Next job reuses the same tab via goto().
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

function failed(email: string, error: string): ProfileResult {
  return {
    email,
    status: 'failed',
    orderId: null,
    placedPrice: null,
    placedCashbackPct: null,
    placedAt: null,
    placedQuantity: 0,
    error,
    dryRun: false,
  };
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
