import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { BGClient } from '../bg/client.js';
import type { DriverSession } from '../browser/driver.js';
import { openSession } from '../browser/driver.js';
import { scrapeProduct } from '../actions/scrapeProduct.js';
import { buyNow } from '../actions/buyNow.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { DEFAULT_CONSTRAINTS, verifyProductDetailed } from '../parsers/productConstraints.js';
import { logger } from '../shared/logger.js';
import { makeAttemptId } from '../shared/sanitize.js';
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
  headless: boolean;
  buyDryRun: boolean;
  minCashbackPct: number;
  allowedAddressPrefixes: string[];
  /** Returns every enabled+loggedIn profile we should fan out the job to. */
  listEligibleProfiles: () => Promise<AmazonProfile[]>;
  /** Persistence for the jobs table — created on fan-out, updated as profiles run. */
  jobAttempts: JobAttemptStore;
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

type ProfileResult = {
  email: string;
  status: 'completed' | 'failed';
  orderId: string | null;
  placedPrice: string | null;
  placedCashbackPct: number | null;
  placedAt: string | null;
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
    for (const [email, s] of sessions) {
      try {
        await s.close();
      } catch (err) {
        logger.warn('session.close.error', { email, error: String(err) });
      }
    }
    logger.info('worker.stop');
  })();

  return {
    async stop() {
      running = false;
      await loop;
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
  // Caller (worker loop) already enforces the eligibility gate, so we
  // trust `eligible` is non-empty here.
  logger.info(
    'job.fanout.start',
    {
      jobId: job.id,
      profiles: eligible.map((p) => p.email),
      concurrency: Math.min(FANOUT_CONCURRENCY, eligible.length),
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
        dryRun: deps.buyDryRun,
      }),
    ),
  );

  const results = await pMap(eligible, FANOUT_CONCURRENCY, (profile) =>
    runForProfile(deps, sessions, job, profile, cid),
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
  // actually placed). Real completions take priority.
  let overallStatus: 'completed' | 'partial' | 'failed';
  let parentError: string | null = null;
  if (successes.length > 0) {
    overallStatus = failures.length === 0 ? 'completed' : 'partial';
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

  // Per-profile purchase rows for BG. Only LIVE successes count as
  // 'completed' in the purchases array — dry-runs report as failed there.
  const purchases = results.map((r) => ({
    amazonEmail: r.email,
    status: r.dryRun
      ? ('failed' as const)
      : r.status === 'completed'
        ? ('completed' as const)
        : ('failed' as const),
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
  const activeAttemptId = await resolveVerifyAttemptRow(deps, job, profile.email);

  logger.info(
    'job.verify.start',
    { jobId: job.id, profile: profile.email, orderId: targetOrderId, viaFiller: job.viaFiller },
    cid,
  );

  try {
    const session = await getSession(deps, sessions, profile.email, profile.headless);
    const existing = session.context.pages();
    const page = existing[0] ?? (await session.newPage());
    const outcome = await verifyOrder(page, targetOrderId);

    if (outcome.kind === 'active') {
      logger.info(
        'job.verify.active',
        {
          jobId: job.id,
          profile: profile.email,
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
      // NOTE: viaFiller orders should run cancelFillerItems here (remove
      // the 10 padding items so only the target ASIN ships). Not yet
      // implemented — for now we report active and leave fillers in the
      // order. BG flags `viaFiller` so they can manually cancel for now.
      if (job.viaFiller) {
        logger.warn(
          'job.verify.filler.skipped',
          {
            jobId: job.id,
            profile: profile.email,
            orderId: targetOrderId,
            note: 'cancelFillerItems not yet implemented in AmazonG — fillers remain in this order',
          },
          cid,
        );
      }
      return;
    }

    if (outcome.kind === 'cancelled') {
      logger.warn(
        'job.verify.cancelled',
        {
          jobId: job.id,
          profile: profile.email,
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
        { jobId: job.id, profile: profile.email, orderId: targetOrderId, amazonMessage: outcome.message },
        cid,
      );
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
      { jobId: job.id, profile: profile.email, orderId: targetOrderId },
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
      { jobId: job.id, profile: profile.email, orderId: targetOrderId, error },
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
      { jobId: job.id, profile: profile.email, message: 'Closing verify browser window' },
      cid,
    );
    await closeAndForgetSession(sessions, profile.email);
  }
}

/**
 * Pick (and persist up-front) the attempt row this verify run will track.
 *
 * Preferred path: bump the original buy attempt row from
 * 'awaiting_verification' → 'in_progress' so the single lifecycle stays
 * intact. If that row was cleared (user hit "Clear All", pruned, etc.) or
 * the verify job has no buyJobId linkage, create a fresh phase='verify'
 * row in 'in_progress' immediately so the user sees the verify actually
 * running in the Jobs table instead of a silent no-op.
 *
 * Returns the attempt id that the caller should update with the final
 * verify outcome.
 */
async function resolveVerifyAttemptRow(
  deps: Deps,
  job: AutoGJob,
  profileEmail: string,
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

  const verifyAttemptId = makeAttemptId(job.id, profileEmail);
  await deps.jobAttempts
    .create({
      attemptId: verifyAttemptId,
      jobId: job.id,
      amazonEmail: profileEmail,
      phase: 'verify',
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
      dryRun: false,
    })
    .catch(() => undefined);
  return verifyAttemptId;
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
  try {
    logger.info('job.profile.start', { jobId: job.id, profile }, cid);
    const session = await getSession(deps, sessions, profile, profileData.headless);
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
      await deps.jobAttempts
        .update(attemptId, {
          status: 'failed',
          error,
          cost: info.priceText,
          cashbackPct: info.cashbackPct,
        })
        .catch(() => undefined);
      // Close the window for terminal/conclusive failure reasons — nothing
      // for the user to debug visually. Other reasons (e.g. price_too_high,
      // not_prime) leave the window open in case the user wants to inspect.
      if (report.reason === 'quantity_limit') {
        logger.info(
          'job.profile.fail.cleanup',
          {
            jobId: job.id,
            profile,
            reason: report.reason,
            message: 'Closing browser window — quantity limit is terminal for this account/seller',
          },
          cid,
        );
        await closeAndForgetSession(sessions, profile);
      }
      return failed(profile, error);
    }
    logger.info('step.verify.ok', { jobId: job.id, profile }, cid);

    // Drive a real (or dry-run) Amazon checkout on the SAME tab.
    const buy: BuyResult = await buyNow(page, {
      dryRun: deps.buyDryRun,
      minCashbackPct: deps.minCashbackPct,
      maxPrice: job.maxPrice,
      allowedAddressPrefixes: deps.allowedAddressPrefixes,
      correlationId: cid,
      debugDir: deps.debugDir,
    });

    if (!buy.ok) {
      const error = buy.reason;
      logger.error(
        'step.buy.fail',
        { jobId: job.id, profile, stage: buy.stage, reason: buy.reason },
        cid,
      );
      await deps.jobAttempts
        .update(attemptId, {
          status: 'failed',
          error,
          cost: info.priceText,
          cashbackPct: info.cashbackPct,
        })
        .catch(() => undefined);
      return failed(profile, error);
    }

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
    await deps.jobAttempts
      .update(attemptId, {
        status: finalStatus,
        cost: buy.finalPriceText ?? info.priceText,
        cashbackPct: buy.cashbackPct,
        orderId: buy.orderId,
        // Actual quantity picked at /spc — replaces the BG-requested
        // quantity that was stored at fan-out time (always 1 for now).
        quantity: buy.quantity,
        error: null,
      })
      .catch(() => undefined);
    return {
      email: profile,
      status: 'completed',
      orderId: buy.orderId,
      placedPrice: buy.finalPriceText,
      placedCashbackPct: buy.cashbackPct,
      placedAt,
      error: null,
      dryRun: buy.dryRun,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = friendlyJobError(raw, profile);
    logger.error('job.profile.fail', { jobId: job.id, profile, error: message }, cid);
    await deps.jobAttempts
      .update(attemptId, { status: 'failed', error: message })
      .catch(() => undefined);
    return failed(profile, message);
  } finally {
    // Do NOT close the page — it's the session's only tab and closing it
    // would terminate the persistent Chromium context (browser quits when
    // the last page closes). Next job reuses the same tab via goto().
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

async function getSession(
  deps: Deps,
  sessions: Map<string, DriverSession>,
  profile: string,
  headlessOverride?: boolean,
): Promise<DriverSession> {
  const existing = sessions.get(profile);
  if (existing) return existing;
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
  try {
    await s.close();
  } catch {
    // already closed / browser exited
  }
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
