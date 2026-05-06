import { describe, expect, it, vi } from 'vitest';
import {
  StreamingScheduler,
  type SchedulerDeps,
  type JobContext,
} from '../../src/workflows/scheduler';
import type { AutoGJob, AmazonProfile } from '../../src/shared/types';

/**
 * Scheduler integration tests with mocked BG + runners. The lock-
 * chain semantics are tested directly in accountLock.test.ts; here
 * we test that the scheduler:
 *   - dispatches up to `cap` tuples in parallel
 *   - skip-blocks when an account is locked
 *   - aggregates per-job results correctly
 *   - de-dupes already-finished accounts on reclaim
 *   - drains the queue cleanly on stop()
 */

function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type FakeJob = AutoGJob & { phase: 'buy' };

function makeJob(jobId: string, attempts = 1): FakeJob {
  return {
    id: jobId,
    phase: 'buy',
    productUrl: 'https://www.amazon.com/dp/B0TEST',
    dealKey: `dk-${jobId}`,
    dealTitle: `Deal ${jobId}`,
    commitmentId: `c-${jobId}`,
    maxPrice: '50',
    quantity: 1,
    attempts,
  } as FakeJob;
}

function makeProfile(email: string): AmazonProfile {
  return {
    email,
    enabled: true,
    signedInAt: new Date().toISOString(),
    requireMinCashback: true,
    state: 'signed_in',
  } as unknown as AmazonProfile;
}

/** Build a properly-shaped ProfileResult — matches the actual type from
 *  pollAndScrape. Test runners use this so buildBuyJobReport doesn't
 *  crash on missing fields. */
function makeProfileResult(
  email: string,
  status: 'completed' | 'failed' | 'action_required',
) {
  return {
    email,
    status,
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
  } as unknown as Awaited<
    ReturnType<NonNullable<SchedulerDeps['runners']>['buy']>
  >;
}

/** Build a SchedulerDeps with stubbed BG + runners. */
function makeDeps(opts: {
  jobs: FakeJob[];
  eligibleByJob: Map<string, AmazonProfile[]>;
  cap?: number;
  buyDuration?: number;
  reportStatus?: (jobId: string, report: unknown) => Promise<void>;
  listPurchasesForJob?: (jobId: string) => Promise<unknown[]>;
}): { sd: SchedulerDeps; runs: { tuple: { account: string; jobId: string }; startedAt: number; finishedAt: number }[] } {
  const queue = [...opts.jobs];
  const runs: { tuple: { account: string; jobId: string }; startedAt: number; finishedAt: number }[] = [];

  const bg = {
    claimJob: vi.fn(async () => queue.shift() ?? null),
    reportStatus: vi.fn(async (jobId: string, report: unknown) => {
      if (opts.reportStatus) await opts.reportStatus(jobId, report);
    }),
    listPurchasesForJob: vi.fn(async (jobId: string) => {
      if (opts.listPurchasesForJob) return opts.listPurchasesForJob(jobId);
      return [];
    }),
  };

  const jobAttempts = {
    create: vi.fn(async (a) => ({
      ...a,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    update: vi.fn(async () => null),
    get: vi.fn(async () => null),
  };

  const sd: SchedulerDeps = {
    deps: {
      bg,
      minCashbackPct: 6,
      buyDryRun: false,
      jobAttempts,
    } as unknown as SchedulerDeps['deps'],
    sessions: new Map(),
    parentCid: 'test-cid',
    cap: () => opts.cap ?? 3,
    resolveJobContext: async (job: AutoGJob): Promise<JobContext | null> => {
      const eligible = opts.eligibleByJob.get(job.id) ?? [];
      return {
        eligible,
        fillerByEmail: new Map(),
        effectiveMinByEmail: new Map(),
        requireMinByEmail: new Map(),
        wheyProteinFillerOnly: false,
        surgicalCashbackRecovery: false,
      };
    },
    runners: {
      buy: vi.fn(async (ctx) => {
        const startedAt = Date.now();
        await tick(opts.buyDuration ?? 50);
        const finishedAt = Date.now();
        runs.push({
          tuple: {
            account: ctx.profile.email.toLowerCase(),
            jobId: ctx.job.id,
          },
          startedAt,
          finishedAt,
        });
        return makeProfileResult(ctx.profile.email, 'completed');
      }),
    },
    sleep: async (ms, stillRunning) => {
      // Tighter sleeps for tests so they finish quickly.
      const cap = Math.min(ms, 10);
      await tick(cap);
      void stillRunning;
    },
  };
  return { sd, runs };
}

describe('StreamingScheduler', () => {
  it('dispatches up to cap tuples in parallel', async () => {
    // 1 job, 5 profiles, cap=3 → at any moment ≤3 buys are running.
    const job = makeJob('j1');
    const profiles = ['a', 'b', 'c', 'd', 'e'].map((p) => makeProfile(p + '@test'));
    const { sd, runs } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', profiles]]),
      cap: 3,
      buyDuration: 50,
    });
    const sched = new StreamingScheduler(sd);
    sched.start();

    // Wait for all 5 buys to complete (5 buys, 3 in parallel = ~2 waves).
    await tick(250);
    await sched.stop();

    expect(runs).toHaveLength(5);
    expect(runs.map((r) => r.tuple.account).sort()).toEqual([
      'a@test',
      'b@test',
      'c@test',
      'd@test',
      'e@test',
    ]);

    // Verify parallelism: at no point should >3 runs overlap.
    // Sort by start; for each start time, count overlapping runs.
    const byStart = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    let maxOverlap = 0;
    for (const r of byStart) {
      const overlap = byStart.filter(
        (x) => x.startedAt <= r.startedAt && x.finishedAt > r.startedAt,
      ).length;
      maxOverlap = Math.max(maxOverlap, overlap);
    }
    expect(maxOverlap).toBeLessThanOrEqual(3);
  });

  it('saturates worker slots across job boundaries (the design point)', async () => {
    // 2 jobs back-to-back. Job 1 has one slow profile (a) and two
    // fast (b,c). Job 2 is all fast. With per-job pMap, job 2
    // wouldn't start until ALL of job 1 finishes — including the slow
    // a. With streaming, when b/c finish early they free slots that
    // job 2 takes WHILE a is still running.
    const job1 = makeJob('j1');
    const job2 = makeJob('j2');
    const j1Profiles = ['a', 'b', 'c'].map((p) => makeProfile(p + '@test'));
    const j2Profiles = ['d', 'e', 'f'].map((p) => makeProfile(p + '@test'));
    const { sd, runs } = makeDeps({
      jobs: [job1, job2],
      eligibleByJob: new Map([
        ['j1', j1Profiles],
        ['j2', j2Profiles],
      ]),
      cap: 3,
    });
    // Custom runner: a@test is slow (150ms); everyone else fast (30ms).
    sd.runners = {
      buy: vi.fn(async (ctx) => {
        const startedAt = Date.now();
        const slow = ctx.profile.email.startsWith('a@');
        await tick(slow ? 150 : 30);
        const finishedAt = Date.now();
        runs.push({
          tuple: {
            account: ctx.profile.email.toLowerCase(),
            jobId: ctx.job.id,
          },
          startedAt,
          finishedAt,
        });
        return makeProfileResult(ctx.profile.email, 'completed');
      }),
    };
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(400);
    await sched.stop();

    expect(runs).toHaveLength(6);

    // The streaming win: job 2's first tuple starts BEFORE job 1's
    // slow profile (a) finishes.
    const j1SlowEnd = runs.find((r) => r.tuple.account === 'a@test')!.finishedAt;
    const j2First = runs
      .filter((r) => r.tuple.jobId === 'j2')
      .reduce((acc, r) => Math.min(acc, r.startedAt), Infinity);
    expect(j2First).toBeLessThan(j1SlowEnd);
  });

  it('respects per-account exclusion (write lock) across jobs', async () => {
    // Two jobs, both targeting account A (plus extras). Account A
    // must not run two buys in parallel even across jobs.
    const job1 = makeJob('j1');
    const job2 = makeJob('j2');
    const profileA = makeProfile('a@test');
    const profileB = makeProfile('b@test');
    const profileC = makeProfile('c@test');
    const { sd, runs } = makeDeps({
      jobs: [job1, job2],
      eligibleByJob: new Map([
        ['j1', [profileA, profileB]],
        ['j2', [profileA, profileC]],
      ]),
      cap: 3,
      buyDuration: 60,
    });
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(400);
    await sched.stop();

    // Both jobs' a@test should run (4 total tuples: a×2, b, c).
    expect(runs).toHaveLength(4);

    // The two a@test runs MUST NOT overlap.
    const aRuns = runs
      .filter((r) => r.tuple.account === 'a@test')
      .sort((a, b) => a.startedAt - b.startedAt);
    expect(aRuns).toHaveLength(2);
    expect(aRuns[0]!.finishedAt).toBeLessThanOrEqual(aRuns[1]!.startedAt);
  });

  it('aborts queued tuples when bundle abortController is fired', async () => {
    // Job's runBuyTuple calls abortSiblings on the first profile;
    // remaining queued profiles for the same job should drop without
    // running the runner.
    const job = makeJob('j1');
    const profiles = ['a', 'b', 'c', 'd'].map((p) => makeProfile(p + '@test'));

    let firstHandled = false;
    const { sd, runs } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', profiles]]),
      cap: 1, // Force serial dispatch so we control when abort fires.
      buyDuration: 30,
    });
    // Override the runner: the first run aborts siblings; remaining
    // runs should NEVER fire because their bundle is aborted.
    const customRunner = vi.fn(async (ctx) => {
      if (!firstHandled) {
        firstHandled = true;
        ctx.abortSiblings('out_of_stock');
      }
      runs.push({
        tuple: { account: ctx.profile.email.toLowerCase(), jobId: ctx.job.id },
        startedAt: Date.now(),
        finishedAt: Date.now(),
      });
      return {
        amazonEmail: ctx.profile.email,
        status: 'completed' as const,
        dryRun: false,
      } as Awaited<ReturnType<NonNullable<SchedulerDeps['runners']>['buy']>>;
    });
    sd.runners = { buy: customRunner };
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(200);
    await sched.stop();

    // Only the first profile actually ran; siblings dropped.
    expect(runs.length).toBeLessThan(profiles.length);
    expect(customRunner).toHaveBeenCalledTimes(runs.length);
  });

  it('de-dupes already-succeeded accounts on reclaim', async () => {
    // Job with attempts=2 (reclaimed) — accounts already in
    // awaiting_verification should be filtered out by listPurchasesForJob.
    const job = { ...makeJob('j1'), attempts: 2 };
    const profiles = ['a', 'b', 'c'].map((p) => makeProfile(p + '@test'));
    const { sd, runs } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', profiles]]),
      cap: 3,
      buyDuration: 30,
      listPurchasesForJob: async () => [
        { jobId: 'j1', amazonEmail: 'a@test', status: 'awaiting_verification' },
      ],
    });
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(200);
    await sched.stop();

    // Only b and c ran; a was filtered.
    const accounts = runs.map((r) => r.tuple.account).sort();
    expect(accounts).toEqual(['b@test', 'c@test']);
  });

  it('stop() drains readyQueue without running queued tuples', async () => {
    const job = makeJob('j1');
    const profiles = ['a', 'b', 'c', 'd', 'e'].map((p) =>
      makeProfile(p + '@test'),
    );
    const { sd, runs } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', profiles]]),
      cap: 2, // Only 2 in flight; 3 will be queued
      buyDuration: 200, // Long enough that we stop mid-flight
    });
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(50); // Let queue fill
    await sched.stop();
    // The 2 in-flight tuples may or may not finish; the queued 3 should
    // not start.
    expect(runs.length).toBeLessThanOrEqual(2);
  });

  it('fires reportStatus once per buy bundle', async () => {
    const job = makeJob('j1');
    const profiles = ['a', 'b'].map((p) => makeProfile(p + '@test'));
    let reportCount = 0;
    const { sd } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', profiles]]),
      cap: 2,
      buyDuration: 30,
      reportStatus: async () => {
        reportCount++;
      },
    });
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(200);
    await sched.stop();
    expect(reportCount).toBe(1);
  });

  it('handles empty eligibility without stalling', async () => {
    const job = makeJob('j1');
    const { sd, runs } = makeDeps({
      jobs: [job],
      eligibleByJob: new Map([['j1', []]]),
      cap: 3,
      buyDuration: 30,
    });
    const sched = new StreamingScheduler(sd);
    sched.start();
    await tick(50);
    await sched.stop();
    expect(runs).toHaveLength(0);
  });
});
