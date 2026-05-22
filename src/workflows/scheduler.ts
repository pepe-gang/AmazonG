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
 * we fire bg.reportStatus once (same atomicity as the previous
 * end-of-pMap report).
 */

import { logger } from '../shared/logger.js';
import type { AmazonProfile, AutoGJob } from '../shared/types.js';
import type { FillerPool } from '../shared/ipc.js';
import type { DriverSession } from '../browser/driver.js';
import { makeAttemptId } from '../shared/sanitize.js';
import { AccountLock } from './accountLock.js';
import {
  runBuyTuple,
  runVerifyTuple,
  runFetchTrackingTuple,
  runCancelFillersTuple,
} from './runners.js';
import type {
  Deps,
  ProfileResult,
} from './pollAndScrape.js';
import { buildBuyJobReport, syntheticFailedResult } from './jobReport.js';
import { recordPlacedOrderEvent } from '../main/placedOrderLedger.js';

type Phase = 'buy' | 'verify' | 'fetch_tracking' | 'cancel_fillers';

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
    fillerAttempts: FillerPool[];
    surgicalCashbackRecovery: boolean;
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
  fillerAttempts: FillerPool[];
  surgicalCashbackRecovery: boolean;
  // Optional: the verify/tracking job carries placedEmail at the
  // job level. For those phases the eligible list is already filtered
  // to one profile (or empty if the email isn't signed in).
  /**
   * When `eligible` is empty for a verify/fetch_tracking job, this
   * tells the scheduler WHY so it can build a specific error string
   * (and the BG dashboard can render distinct pills):
   *   - 'not_signed_in' — profile not in the signed-in list
   *   - 'disabled'      — signed in but `enabled === false`
   *   - 'not_found'     — no matching profile at all
   * Undefined when `eligible.length > 0`.
   */
  emptyReason?: 'not_signed_in' | 'disabled' | 'not_found';
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
      this.collectResult(
        t,
        this.failedResult(
          t,
          'AmazonG worker stopped — job abandoned mid-flight (will retry on next claim)',
        ),
      );
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
    // Fast poll for the no-job path. New rebuys / scheduled jobs
    // become claimable in BG at countdown expiry — at 5s polling
    // a job ready right after our last poll waits up to 5s. 2s
    // strikes a balance: fast enough to keep idle workers fed
    // when a single new job appears mid-flight, while keeping
    // BG load modest (~30 req/min vs ~12 req/min at 5s).
    // Idle-poll interval — only fires when a full burst-claim cycle
    // came back EMPTY (queue is drained). Bumped from 2s to 10s on
    // 2026-05-21 to cut Vercel Function Invocations + Observability
    // Events ~5×; for 2 PCs running 24/7 this is the dominant cost
    // line. Queue-drain throughput is unaffected — bursts of up to
    // `cap * 3` parallel claims still fire instantly the moment the
    // buffer has room AND BG has jobs, so a queue of 30 still drains
    // in one burst-loop, not 30 × 10s. Only effect: when you trigger
    // a brand-new job while the worker is sleeping, worst-case
    // pickup latency goes from 2s to 10s. Avg 5s. Invisible against
    // the 60-90s per-buy wall-clock.
    const NO_JOB_SLEEP_MS = 10_000;
    // Eligibility / error backoff stays at 5s — these are "wait for a
    // user action / wait for BG to recover" cases, not "wait for the
    // next job to be ready". No reason to hammer BG when no profile
    // is signed in.
    const BACKOFF_SLEEP_MS = 5_000;
    while (this.running) {
      const cap = this.sd.cap();
      // Pre-buffer cap. Bumped from cap*2 to cap*3 so the producer
      // stays ahead even when verify/tracking jobs are single-tuple
      // (so the consumer doesn't starve waiting on the producer's
      // next claim cycle). Combined with parallel-claim below, this
      // lets the consumer keep cap slots busy without the producer
      // becoming the bottleneck.
      const buffered = this.readyQueue.length + this.inFlight.size;
      if (buffered >= cap * 3) {
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

      // PARALLEL CLAIM + PROCESS. Previously this loop claimed one
      // job at a time and blocked on resolveJobContext() (2 BG
      // round-trips per call) before claiming the next. Result: with
      // verify/tracking phases (always single-tuple per job), the
      // consumer would sit idle waiting for the producer to push
      // tuples one-by-one — user observed "1 browser working, 3-4
      // idle, then 1 finishes and the next starts." With parallel
      // claim+process the producer fills the queue in one cycle,
      // letting the consumer dispatch up to `cap` tuples concurrently
      // from the get-go.
      //
      // Burst size = remaining pre-buffer capacity. Each claim is
      // independent on the BG side (atomic per-call), so claiming N
      // jobs in parallel just yields up to N jobs back. Per-job
      // processing (resolve + expand + push) runs in parallel via
      // Promise.all — bundles.set and readyQueue.push are single-
      // threaded JS event-loop operations, so no race.
      const burst = Math.max(1, cap * 3 - buffered);
      const claimedRaw = await Promise.all(
        Array.from({ length: burst }, () =>
          this.sd.deps.bg.claimJob().catch((err) => {
            logger.warn(
              'scheduler.claim.error',
              { error: err instanceof Error ? err.message : String(err) },
              this.sd.parentCid,
            );
            return null;
          }),
        ),
      );
      const claimed = claimedRaw.filter((j): j is AutoGJob => j !== null);
      if (claimed.length === 0) {
        await sleep(NO_JOB_SLEEP_MS, () => this.running);
        continue;
      }
      await Promise.all(claimed.map((job) => this.processClaimedJob(job)));
    }
  }

  /** Resolve + expand + push for one claimed job. Called concurrently
   *  by the producer's parallel-claim loop. Side effects (bundles.set,
   *  readyQueue.push) are single-threaded JS event-loop ops so
   *  concurrent invocations don't race. Each branch reports the
   *  appropriate BG status on failure so jobs don't sit stuck in
   *  `claimed` state until the 10-min stale-claim recovery. */
  private async processClaimedJob(job: AutoGJob): Promise<void> {
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
      return;
    }
    if (ctx.eligible.length === 0) {
      let error: string;
      if (job.phase === 'buy') {
        error = 'no enabled Amazon accounts available for this buy';
      } else if (ctx.emptyReason === 'disabled') {
        // Signed in but account is disabled in AmazonG. Distinct
        // from "not signed in" so BG's dashboard can render a
        // separate "🚫 Disabled" pill.
        error = `target account ${job.placedEmail ?? '(none)'} is disabled in AmazonG`;
      } else {
        error = `target account ${job.placedEmail ?? '(none)'} not signed in`;
      }
      logger.warn(
        'scheduler.eligible.empty',
        { jobId: job.id, phase: job.phase, placedEmail: job.placedEmail },
        this.sd.parentCid,
      );
      await this.sd.deps.bg
        .reportStatus(job.id, { status: 'failed', error })
        .catch(() => undefined);
      return;
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
      return;
    }

    const bundle = this.createBundle(job.id, tuples.length, ctx.fillerByEmail);
    this.bundles.set(job.id, bundle);
    this.readyQueue.push(...tuples);
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
          fillerAttempts: ctx.fillerAttempts,
          surgicalCashbackRecovery: ctx.surgicalCashbackRecovery,
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
      // GHOST-ORDER GUARD. A buy tuple whose attempt row was never
      // created is poison: runForProfile only ever calls
      // jobAttempts.update, and updateAttempt is a silent no-op when
      // the row is missing — so the buy would place a REAL order on
      // Amazon and leave zero local trace (no row, no orderId, no
      // status). Previously a per-create `.catch()` swallowed the
      // failure and dispatched the tuple anyway. Now: a tuple whose
      // create fails is DROPPED — that profile skips this deal (a
      // recoverable miss, BG re-queues) rather than placing an
      // untracked order (unrecoverable money loss).
      const created = await Promise.all(
        tuples.map((t) =>
          this.sd.deps.jobAttempts
            .create({
              attemptId: makeAttemptId(job.id, t.profile.email),
              jobId: job.id,
              amazonEmail: t.profile.email,
              // Pin to literal — gated by `job.phase === 'buy'` above. TS
              // can't narrow the union through the .map() closure since
              // AutoGJob.phase now includes 'cancel_fillers'.
              phase: 'buy' as const,
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
              fillerCancelTasks: null,
              productTitle: null,
              stage: null,
            })
            .then(() => t) // create ok → keep the tuple
            .catch((err) => {
              // create failed → DROP this tuple. Running its buy
              // would place an untracked order (see GHOST-ORDER
              // GUARD above). Logged at error level so the skipped
              // deal is visible.
              logger.error(
                'scheduler.attempts.create.failed',
                {
                  jobId: job.id,
                  email: t.profile.email,
                  error: err instanceof Error ? err.message : String(err),
                  note: 'profile skipped this deal — attempt row could not be created',
                },
                this.sd.parentCid,
              );
              return null;
            }),
        ),
      );
      return created.filter((t): t is Tuple => t !== null);
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
    if (!bundle) {
      // Bundle missing is an invariant break — collectResult will
      // fail loudly. Don't try to label this as an abort.
      this.collectResult(
        tuple,
        this.failedResult(tuple, 'internal: bundle missing at dispatch'),
      );
      return;
    }
    if (bundle.abortController.signal.aborted) {
      // Sibling on the same job hit a PRODUCT-level failure
      // (out_of_stock / price_exceeds) and fired bundle.abortController.
      // Surface the reason so this row's failure message points at the
      // root cause instead of the cryptic "aborted before start".
      // Matches runForProfile's aborted_by_sibling format
      // (pollAndScrape.ts:2079) for log consistency.
      const reason = String(
        bundle.abortController.signal.reason ?? 'unknown',
      );
      this.collectResult(
        tuple,
        this.failedResult(tuple, `aborted before start: sibling reported ${reason}`),
      );
      return;
    }

    // Phase 1 conservative policy: every tuple takes the equivalent
    // of a write lock (read = write). Mirrors today's drain-before-
    // buy behavior. Switching verify/tracking to acquireRead is
    // gated on proposal §14 open question #1.
    let release: (() => void) | null = null;
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
          fillerAttempts: tuple.buyCtx.fillerAttempts,
          surgicalCashbackRecovery: tuple.buyCtx.surgicalCashbackRecovery,
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
      } else if (tuple.phase === 'cancel_fillers') {
        // cancel_fillers reports its own status to BG (with the per-task
        // signal updates). Bundle just counts completion — same as
        // verify/fetch_tracking.
        await runCancelFillersTuple({
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
      release?.();
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
    // reportBuyBundle handles its own error logging — fire-and-forget.
    if (tuple.phase === 'buy') {
      void this.reportBuyBundle(bundle, tuple.job);
    }
    this.bundles.delete(tuple.jobId);
  }

  /** Fires the aggregate BG report at end of bundle. Always completes
   *  (never throws / never rejects) — caller fires-and-forgets via
   *  `void`, so any unhandled rejection here would become a warning
   *  in the renderer console + a Sentry-equivalent event. Catches
   *  both the buildBuyJobReport synchronous path and the bg call. */
  private async reportBuyBundle(
    bundle: JobBundle,
    job: AutoGJob,
  ): Promise<void> {
    let reportErr = '';
    try {
      // Single source of truth for the report shape — same helper the
      // legacy pMap path uses post-fan-out. Handles status rollup,
      // dry-run mapping, winner pick, viaFiller, stage, fillerOrderIds.
      const report = buildBuyJobReport({
        results: bundle.results,
        fillerByEmail: bundle.fillerByEmail,
      });
      await this.sd.deps.bg.reportStatus(job.id, report);
    } catch (err) {
      reportErr = err instanceof Error ? err.message : String(err);
      logger.error(
        'scheduler.report.error',
        { jobId: job.id, error: reportErr },
        this.sd.parentCid,
      );
    }
    // Durable ledger: record per profile whether the buy report reached
    // BG. Closes the "order captured but never reached BG" blind spot
    // (worker crash before this fires, or a swallowed reportStatus
    // throw). Correlate to a place_order_submitted breadcrumb by
    // jobId + profile.
    for (const r of bundle.results) {
      recordPlacedOrderEvent({
        event: 'reported_to_bg',
        profile: r.email,
        jobId: job.id,
        orderId: r.orderId ?? null,
        detail: reportErr
          ? `report failed: ${reportErr}`.slice(0, 300)
          : 'ok',
      });
    }
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
      targetAsin: null,
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
