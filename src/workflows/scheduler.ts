/**
 * Account-aware streaming scheduler — Phase 2 of the streaming-
 * scheduler rollout (proposal-scheduler-redesign.md).
 *
 * Replaces today's per-job pMap fan-out with a single FIFO queue of
 * (jobId, account, phase) tuples shared across all in-flight jobs.
 * When a worker slot frees, we pull the next runnable tuple — could
 * belong to job 1's tail or job 2's head. Saturates worker slots
 * across job boundaries.
 *
 * Per-account locking ensures we never run two buys in parallel on
 * the same Amazon account (proposal §3 + §9 risk #1):
 *   - buy:           AccountLock.acquireWrite (exclusive)
 *   - verify:        AccountLock.acquireRead_conservative (Phase 1)
 *   - fetch_tracking: AccountLock.acquireRead_conservative (Phase 1)
 *
 * Phase 1 lock policy = conservative (read also blocks write). Mirrors
 * today's "drain lifecycle before buy" behavior at
 * pollAndScrape.ts:762-764. Phase 2 aggressive policy (read concurrent
 * with write) is gated on proposal §14 open question #1.
 *
 * Skip-blocked dispatch: when the head of readyQueue is for a locked
 * account, scan further for any runnable tuple instead of head-of-line
 * blocking.
 *
 * Per-job aggregation via JobBundle: each tuple's result is collected
 * into the bundle for its jobId; when bundle.results.length === total,
 * we fire the existing bg.reportStatus once (same atomicity as today's
 * end-of-pMap report).
 *
 * Behind the `streamingScheduler` settings flag (default false).
 */

import { logger } from '../shared/logger.js';
import type { AmazonProfile, AutoGJob } from '../shared/types.js';
import type { DriverSession } from '../browser/driver.js';
import { makeAttemptId } from '../shared/sanitize.js';
import { AccountLock } from './accountLock.js';
import {
  runBuyTuple,
  runVerifyTuple,
  runFetchTrackingTuple,
} from './runners.js';
import type {
  Deps,
  ProfileResult,
} from './pollAndScrape.js';
import { buildBuyJobReport, syntheticFailedResult } from './jobReport.js';

type Phase = 'buy' | 'verify' | 'fetch_tracking';

type Tuple = {
  jobId: string;
  job: AutoGJob;
  account: string; // amazonEmail.toLowerCase()
  profile: AmazonProfile;
  phase: Phase;
  enqueuedAt: number;
  // For buy phase: per-account overrides resolved at expandToTuples time.
  buyCtx?: {
    useFiller: boolean;
    effectiveMinCashbackPct: number;
    requireMinCashback: boolean;
    wheyProteinFillerOnly: boolean;
  };
};

type JobBundle = {
  jobId: string;
  total: number;
  results: ProfileResult[];
  abortController: AbortController;
  // Per-account filler-mode flags captured at expandToTuples time.
  // Needed by buildBuyJobReport for the per-purchase `viaFiller` flag.
  // For verify/tracking phases this stays empty (helper isn't called
  // for those phases).
  fillerByEmail: Map<string, boolean>;
};

type Sleep = (ms: number, stillRunning: () => boolean) => Promise<void>;

export type SchedulerDeps = {
  deps: Deps;
  sessions: Map<string, DriverSession>;
  parentCid: string;
  cap: () => number;
  // Source of eligible profiles + per-account overrides at claim time.
  // Kept as a callback so the producer can re-read the latest settings
  // / signed-in state without holding stale references.
  resolveJobContext: (job: AutoGJob) => Promise<JobContext | null>;
  // Optional injection for testing — defaults to runBuyTuple etc.
  runners?: {
    buy?: typeof runBuyTuple;
    verify?: typeof runVerifyTuple;
    fetchTracking?: typeof runFetchTrackingTuple;
  };
  sleep?: Sleep;
  /** Pre-claim eligibility gate. Mirrors legacy worker.start
   *  (pollAndScrape.ts:842-855): if no Amazon accounts are signed in,
   *  don't claim — leaves jobs queued for another instance instead of
   *  claim-then-fail-burning every job in BG. Returns true when at
   *  least one signed-in profile exists. */
  hasEligibleProfiles?: () => Promise<boolean>;
};

export type JobContext = {
  // Eligible profiles for this job after filtering (signed-in,
  // enabled, not action_required). Empty array → job dropped with
  // a "no profiles" status report.
  eligible: AmazonProfile[];
  // Per-account overrides — same maps the existing handleJob builds.
  fillerByEmail: Map<string, boolean>;
  effectiveMinByEmail: Map<string, number>;
  requireMinByEmail: Map<string, boolean>;
  wheyProteinFillerOnly: boolean;
  // Optional: the verify/tracking job carries placedEmail at the
  // job level. For those phases the eligible list is already filtered
  // to one profile (or empty if the email isn't signed in).
};

export class StreamingScheduler {
  private readyQueue: Tuple[] = [];
  private bundles = new Map<string, JobBundle>();
  private inFlight = new Map<Promise<void>, { tuple: Tuple }>();
  private lock = new AccountLock();
  private running = true;

  // Producer + consumer loop handles for graceful stop.
  private producerDone: Promise<void> | null = null;
  private consumerDone: Promise<void> | null = null;

  constructor(private sd: SchedulerDeps) {}

  /** Kick off producer + consumer loops. Resolves immediately; the
   *  loops run until `stop()` is called. */
  start(): void {
    this.producerDone = this.runProducer();
    this.consumerDone = this.runConsumer();
  }

  /** Graceful stop — drains readyQueue (marks queued tuples failed
   *  for their bundles), waits up to 4s for in-flight tuples to
   *  settle, then resolves. Closing of browser sessions is the
   *  caller's responsibility (today's worker.stop() already does
   *  that via closeAllSessions). */
  async stop(): Promise<void> {
    this.running = false;

    // Drain readyQueue: mark each queued tuple as failed locally so
    // its bundle finalizes (with whatever in-flight + already-completed
    // results are present).
    for (const t of this.readyQueue) {
      this.collectResult(t, this.failedResult(t, 'worker stopping'));
    }
    this.readyQueue.length = 0;

    // Wait up to 4s for in-flight tuples to settle (their callers
    // close sessions, which causes Playwright ops to throw 'Target
    // closed' within ~50ms, then runForProfile's catch maps to
    // 'failed', which we collect into the bundle).
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight.keys()]),
        new Promise((r) => setTimeout(r, 4_000)),
      ]);
    }

    // Wait for the producer/consumer loops to actually exit.
    await Promise.allSettled([
      this.producerDone ?? Promise.resolve(),
      this.consumerDone ?? Promise.resolve(),
    ]);
  }

  // ─── Producer ─────────────────────────────────────────────────

  private async runProducer(): Promise<void> {
    const sleep = this.sd.sleep ?? defaultSleep;
    let lastNoProfilesWarn = 0;
    const NO_PROFILES_WARN_INTERVAL_MS = 60_000;
    // Fast poll for the no-job and error paths. New rebuys / scheduled
    // jobs become claimable in BG at countdown expiry — at 5s polling
    // a job ready right after our last poll waits up to 5s for the
    // next call. With multiple workers idle and one busy on a long
    // buy, the BG queue can fill while we sleep. 1s polling catches
    // ready-now jobs within a second without meaningfully more BG load.
    const NO_JOB_SLEEP_MS = 1_000;
    // Eligibility / error backoff stays at 5s — these are "wait for a
    // user action / wait for BG to recover" cases, not "wait for the
    // next job to be ready". No reason to hammer BG when no profile
    // is signed in.
    const BACKOFF_SLEEP_MS = 5_000;
    while (this.running) {
      const cap = this.sd.cap();
      // Don't pre-buffer too many tuples; we want the BG-claimed jobs
      // to reflect recent state. cap*2 gives the consumer some
      // lookahead for skip-blocked dispatch without holding stale
      // claims for long.
      if (this.readyQueue.length + this.inFlight.size >= cap * 2) {
        await sleep(200, () => this.running);
        continue;
      }

      // Pre-claim eligibility gate. Mirrors legacy worker (pollAndScrape.ts
      // :842-855): if zero signed-in profiles, DO NOT claim — leaves jobs
      // queued in BG for another AutoG instance instead of claim-then-fail
      // burning every queued job. Without this gate a worker with no
      // signed-in accounts would brick every BG job within seconds.
      if (this.sd.hasEligibleProfiles) {
        const ok = await this.sd.hasEligibleProfiles().catch(() => true);
        if (!ok) {
          if (Date.now() - lastNoProfilesWarn > NO_PROFILES_WARN_INTERVAL_MS) {
            logger.warn(
              'scheduler.idle.no_profiles',
              {
                note: 'No signed-in Amazon accounts. Streaming scheduler is polling but will not claim jobs until at least one account is signed in.',
              },
              this.sd.parentCid,
            );
            lastNoProfilesWarn = Date.now();
          }
          await sleep(BACKOFF_SLEEP_MS, () => this.running);
          continue;
        }
      }

      let job: AutoGJob | null = null;
      try {
        job = await this.sd.deps.bg.claimJob();
      } catch (err) {
        logger.warn(
          'scheduler.claim.error',
          { error: err instanceof Error ? err.message : String(err) },
          this.sd.parentCid,
        );
        await sleep(BACKOFF_SLEEP_MS, () => this.running);
        continue;
      }
      if (!job) {
        await sleep(NO_JOB_SLEEP_MS, () => this.running);
        continue;
      }

      // Resolve per-job context (eligible profiles + overrides). Mirror
      // legacy handleJob's empty-eligible path (pollAndScrape.ts:1022-
      // 1036): report `failed` to BG so the job moves out of `claimed`
      // state. Otherwise the job stays stuck until BG's stale-claim
      // recovery (~10 min) and we'd reclaim it forever.
      const ctx = await this.sd.resolveJobContext(job).catch(() => null);
      if (!ctx) {
        logger.warn(
          'scheduler.resolve.error',
          { jobId: job.id, phase: job.phase },
          this.sd.parentCid,
        );
        await this.sd.deps.bg
          .reportStatus(job.id, {
            status: 'failed',
            error: 'failed to resolve job context',
          })
          .catch(() => undefined);
        continue;
      }
      if (ctx.eligible.length === 0) {
        const error =
          job.phase === 'buy'
            ? 'no enabled Amazon accounts available for this buy'
            : `target account ${job.placedEmail ?? '(none)'} not signed in`;
        logger.warn(
          'scheduler.eligible.empty',
          { jobId: job.id, phase: job.phase, placedEmail: job.placedEmail },
          this.sd.parentCid,
        );
        await this.sd.deps.bg
          .reportStatus(job.id, { status: 'failed', error })
          .catch(() => undefined);
        continue;
      }

      const tuples = await this.expandToTuples(job, ctx);
      if (tuples.length === 0) {
        // Buy phase reclaim where every account already finished on a
        // prior instance — purchases are reported, but the parent job
        // is still `claimed`. Roll the parent forward via a no-op
        // `awaiting_verification` report so BG can transition it (BG
        // de-dupes purchases by amazonEmail; an empty purchases list
        // just moves the parent state).
        logger.info(
          'scheduler.expand.empty',
          { jobId: job.id, phase: job.phase },
          this.sd.parentCid,
        );
        await this.sd.deps.bg
          .reportStatus(job.id, {
            status: 'awaiting_verification',
            placedAt: null,
            placedQuantity: null,
            placedPrice: null,
            placedCashbackPct: null,
            placedOrderId: null,
            placedEmail: null,
            purchases: [],
          })
          .catch(() => undefined);
        continue;
      }

      const bundle = this.createBundle(job.id, tuples.length, ctx.fillerByEmail);
      this.bundles.set(job.id, bundle);
      this.readyQueue.push(...tuples);
    }
  }

  /** Build tuples from a claimed job. For reclaimed jobs (attempts > 1
   *  or status was previously in_progress), filter out profiles that
   *  already finished on a previous instance — proposal §15.7. */
  private async expandToTuples(
    job: AutoGJob,
    ctx: JobContext,
  ): Promise<Tuple[]> {
    let alreadySucceeded = new Set<string>();

    if (job.phase === 'buy' && (job.attempts ?? 1) > 1) {
      // Stale-claim recovery: ask BG which accounts already finished
      // awaiting_verification / completed for this job. Skip those.
      try {
        const existing = await this.sd.deps.bg.listPurchasesForJob(job.id);
        alreadySucceeded = new Set(
          existing
            .filter(
              (p) =>
                p.status === 'awaiting_verification' ||
                p.status === 'verified' ||
                p.status === 'completed',
            )
            .map((p) => (p.amazonEmail ?? '').toLowerCase())
            .filter(Boolean),
        );
        if (alreadySucceeded.size > 0) {
          logger.info(
            'scheduler.expand.dedupe',
            {
              jobId: job.id,
              skippedAccounts: [...alreadySucceeded],
            },
            this.sd.parentCid,
          );
        }
      } catch (err) {
        // Best-effort — if BG is unreachable, fall through to the
        // un-filtered list. The runForProfile attempt-row state will
        // catch double-buys via its existing onStage('placing')
        // critical-section check.
        logger.warn(
          'scheduler.dedupe.error',
          { jobId: job.id, error: err instanceof Error ? err.message : String(err) },
          this.sd.parentCid,
        );
      }
    }

    const tuples: Tuple[] = [];
    for (const profile of ctx.eligible) {
      const account = profile.email.toLowerCase();
      if (alreadySucceeded.has(account)) continue;

      const tuple: Tuple = {
        jobId: job.id,
        job,
        account,
        profile,
        phase: job.phase as Phase,
        enqueuedAt: Date.now(),
      };

      if (job.phase === 'buy') {
        tuple.buyCtx = {
          useFiller: ctx.fillerByEmail.get(profile.email) === true,
          effectiveMinCashbackPct:
            ctx.effectiveMinByEmail.get(profile.email) ??
            this.sd.deps.minCashbackPct,
          requireMinCashback:
            ctx.requireMinByEmail.get(account) ?? true,
          wheyProteinFillerOnly: ctx.wheyProteinFillerOnly,
        };
      }
      tuples.push(tuple);
    }

    // Mirror legacy handleJob's upfront attempt-row creation (lines
    // 1127-1153). Without this, the UI table shows nothing for
    // streaming-scheduled buys: runForProfile only does .update on
    // the row (jobStore.updateAttempt is a no-op when the row is
    // missing). Lifecycle phases (verify/fetch_tracking) handle
    // their own row creation via ensureLifecycleAttempt — skip here.
    if (job.phase === 'buy' && tuples.length > 0) {
      await Promise.all(
        tuples.map((t) =>
          this.sd.deps.jobAttempts
            .create({
              attemptId: makeAttemptId(job.id, t.profile.email),
              jobId: job.id,
              amazonEmail: t.profile.email,
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
              buyMode: ctx.fillerByEmail.get(t.profile.email)
                ? 'filler'
                : 'single',
              dryRun: this.sd.deps.buyDryRun,
              trackingIds: null,
              fillerOrderIds: null,
              productTitle: null,
              stage: null,
            })
            .catch((err) => {
              // Per-row failures shouldn't block the whole job —
              // runForProfile's update will still no-op and the
              // BG report path is unaffected. Log and continue.
              logger.warn(
                'scheduler.attempts.create.error',
                {
                  jobId: job.id,
                  email: t.profile.email,
                  error: err instanceof Error ? err.message : String(err),
                },
                this.sd.parentCid,
              );
            }),
        ),
      );
    }

    return tuples;
  }

  // ─── Consumer ─────────────────────────────────────────────────

  private async runConsumer(): Promise<void> {
    const sleep = this.sd.sleep ?? defaultSleep;
    while (this.running) {
      const cap = this.sd.cap();
      if (this.inFlight.size >= cap) {
        // All slots busy. Wait for any in-flight to settle.
        await Promise.race([...this.inFlight.keys()]).catch(() => undefined);
        continue;
      }
      if (this.readyQueue.length === 0) {
        await sleep(50, () => this.running);
        continue;
      }

      // Skip-blocked dispatch: scan for the first runnable tuple.
      // Phase 1 lock policy is conservative (any held lock blocks).
      const idx = this.readyQueue.findIndex((t) => !this.lock.isAnyHeld(t.account));
      if (idx === -1) {
        // All queued tuples target locked accounts. Wait for any
        // in-flight to settle (which releases locks). Falls through
        // when something completes.
        if (this.inFlight.size > 0) {
          await Promise.race([...this.inFlight.keys()]).catch(() => undefined);
        } else {
          // Defensive: if no in-flight AND no runnable tuples, we'd
          // loop forever. This shouldn't happen (any locked tuple has
          // its lock-holder in inFlight) but guard against
          // pathological state.
          await sleep(100, () => this.running);
        }
        continue;
      }

      const tuple = this.readyQueue.splice(idx, 1)[0]!;
      const task = this.runTuple(tuple);
      this.inFlight.set(task, { tuple });
      task.finally(() => this.inFlight.delete(task));
    }
  }

  private async runTuple(tuple: Tuple): Promise<void> {
    const bundle = this.bundles.get(tuple.jobId);
    if (!bundle || bundle.abortController.signal.aborted) {
      // Job aborted before we could dispatch. Mark failed in bundle.
      this.collectResult(tuple, this.failedResult(tuple, 'aborted before start'));
      return;
    }

    // Phase 1 conservative policy: every tuple takes the equivalent
    // of a write lock (read = write). Mirrors today's drain-before-
    // buy behavior. Switching verify/tracking to acquireRead is
    // gated on proposal §14 open question #1.
    let release: () => void;
    try {
      release = await this.lock.acquireWrite(tuple.account);
    } catch (err) {
      this.collectResult(
        tuple,
        this.failedResult(
          tuple,
          'lock acquisition failed: ' + (err instanceof Error ? err.message : String(err)),
        ),
      );
      return;
    }

    try {
      if (tuple.phase === 'buy') {
        // buyCtx is set by expandToTuples for every buy-phase tuple —
        // missing here is an invariant break, not an expected branch.
        // Fail loudly so the bundle finalizes instead of silently
        // hanging on a missing collectResult.
        if (!tuple.buyCtx) {
          this.collectResult(
            tuple,
            this.failedResult(tuple, 'internal: buy tuple missing context'),
          );
          return;
        }
        const buyRunner = this.sd.runners?.buy ?? runBuyTuple;
        const result = await buyRunner({
          deps: this.sd.deps,
          sessions: this.sd.sessions,
          job: tuple.job,
          profile: tuple.profile,
          parentCid: this.sd.parentCid,
          useFiller: tuple.buyCtx.useFiller,
          effectiveMinCashbackPct: tuple.buyCtx.effectiveMinCashbackPct,
          requireMinCashback: tuple.buyCtx.requireMinCashback,
          wheyProteinFillerOnly: tuple.buyCtx.wheyProteinFillerOnly,
          abortSignal: bundle.abortController.signal,
          abortSiblings: (reason) => bundle.abortController.abort(reason),
        });
        this.collectResult(tuple, result);
      } else if (tuple.phase === 'verify') {
        const verifyRunner = this.sd.runners?.verify ?? runVerifyTuple;
        await verifyRunner({
          deps: this.sd.deps,
          sessions: this.sd.sessions,
          job: tuple.job,
          profile: tuple.profile,
          parentCid: this.sd.parentCid,
        });
        // verify/tracking runners report their own BG status internally
        // (handleVerifyJob/handleFetchTrackingJob call reportSafe).
        // Bundle aggregation just tracks completion via a placeholder.
        this.collectResult(tuple, this.lifecycleCompletionMarker(tuple));
      } else if (tuple.phase === 'fetch_tracking') {
        const trackingRunner =
          this.sd.runners?.fetchTracking ?? runFetchTrackingTuple;
        await trackingRunner({
          deps: this.sd.deps,
          sessions: this.sd.sessions,
          job: tuple.job,
          profile: tuple.profile,
          parentCid: this.sd.parentCid,
        });
        this.collectResult(tuple, this.lifecycleCompletionMarker(tuple));
      } else {
        // Defensive: unknown phase. Fail rather than silently no-op.
        this.collectResult(
          tuple,
          this.failedResult(tuple, `unknown phase: ${tuple.phase}`),
        );
      }
    } catch (err) {
      // Per-tuple error — don't take down the whole job. Mark this
      // tuple failed; siblings continue. (For buy phase, sibling-abort
      // fires explicitly via bundle.abortController on out_of_stock /
      // price_exceeds — see runBuyTuple's abortSiblings callback.)
      this.collectResult(
        tuple,
        this.failedResult(
          tuple,
          err instanceof Error ? err.message : String(err),
        ),
      );
    } finally {
      release!();
    }
  }

  // ─── Bundle aggregation ───────────────────────────────────────

  private createBundle(
    jobId: string,
    total: number,
    fillerByEmail: Map<string, boolean>,
  ): JobBundle {
    return {
      jobId,
      total,
      results: [],
      abortController: new AbortController(),
      fillerByEmail,
    };
  }

  /** Append a result to its bundle. When the bundle reaches `total`
   *  results, finalize: fire BG status report (for buy phase only —
   *  verify/tracking phases report internally), resolve `done`,
   *  remove from the bundles map.
   *
   *  Bundle-missing is unexpected: producer creates bundle BEFORE
   *  pushing tuples to readyQueue, and bundle is only deleted when
   *  total is reached. A miss here means an invariant broke (e.g.
   *  double-collect on the same tuple). Log loudly so we notice. */
  private collectResult(tuple: Tuple, result: ProfileResult): void {
    const bundle = this.bundles.get(tuple.jobId);
    if (!bundle) {
      logger.error(
        'scheduler.collectResult.missing_bundle',
        {
          jobId: tuple.jobId,
          phase: tuple.phase,
          email: tuple.profile.email,
          status: result.status,
        },
        this.sd.parentCid,
      );
      return;
    }
    bundle.results.push(result);
    if (bundle.results.length < bundle.total) return;
    if (bundle.results.length > bundle.total) {
      // Defensive: we should never push past total because each tuple
      // only collects once. If we do, something is double-collecting
      // (e.g. stop() drain race with in-flight settle). Log + drop.
      logger.error(
        'scheduler.collectResult.overflow',
        {
          jobId: tuple.jobId,
          total: bundle.total,
          collected: bundle.results.length,
        },
        this.sd.parentCid,
      );
      return;
    }

    // Bundle complete. For buy phase, fire the aggregate BG report
    // (matches today's end-of-pMap reportStatus call). For verify/
    // tracking phases, the per-tuple runner already reported internally.
    if (tuple.phase === 'buy') {
      void this.reportBuyBundle(bundle, tuple.job).catch((err) => {
        logger.warn(
          'scheduler.report.error',
          { jobId: bundle.jobId, error: err instanceof Error ? err.message : String(err) },
          this.sd.parentCid,
        );
      });
    }
    this.bundles.delete(tuple.jobId);
  }

  private async reportBuyBundle(
    bundle: JobBundle,
    job: AutoGJob,
  ): Promise<void> {
    // Single source of truth for the report shape — same helper the
    // legacy pMap path uses post-fan-out. Handles:
    //   - awaiting_verification status for live successes (so BG
    //     schedules verify-phase jobs)
    //   - dry-run → 'failed' status mapping (so BG doesn't schedule
    //     verify on dry-runs)
    //   - winner pick + parent-level placed* fields
    //   - per-purchase viaFiller flag from bundle.fillerByEmail
    //   - stage / fillerOrderIds / amazonPurchaseId per-purchase audit
    const report = buildBuyJobReport({
      results: bundle.results,
      fillerByEmail: bundle.fillerByEmail,
    });
    await this.sd.deps.bg.reportStatus(job.id, report).catch((err) => {
      logger.error(
        'scheduler.report.error',
        {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        },
        this.sd.parentCid,
      );
    });
  }

  private failedResult(tuple: Tuple, error: string): ProfileResult {
    // Use the helper from jobReport.ts so all required ProfileResult
    // fields are populated with safe nulls — buildBuyJobReport reads
    // every field, so a stub-shaped failure (missing fields) breaks
    // aggregation.
    return syntheticFailedResult(tuple.profile.email, error);
  }

  /** Lifecycle phases (verify/tracking) report their own status
   *  internally. The bundle aggregator just needs SOMETHING to count
   *  toward bundle.total. Using a fully-populated success-shape result
   *  keeps types honest, but for verify/tracking the bundle is
   *  finalized without firing reportBuyBundle (collectResult checks
   *  phase) so this object is never read by buildBuyJobReport. */
  private lifecycleCompletionMarker(tuple: Tuple): ProfileResult {
    return {
      email: tuple.profile.email,
      status: 'completed',
      orderId: null,
      placedPrice: null,
      placedCashbackPct: null,
      placedAt: null,
      placedQuantity: 0,
      error: null,
      stage: null,
      dryRun: false,
      fillerOrderIds: [],
      amazonPurchaseId: null,
    };
  }
}

function defaultSleep(ms: number, stillRunning: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Allow early exit when worker is stopping.
    const check = setInterval(() => {
      if (!stillRunning()) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, Math.min(50, ms));
  });
}
