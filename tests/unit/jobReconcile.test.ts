import { describe, expect, it } from 'vitest';
import {
  classifyOrphans,
  jobAttemptKey,
  PENDING_ORPHAN_GRACE_MS,
  STALE_PENDING_REASON,
  TERMINAL_ORPHAN_GRACE_MS,
} from '../../src/main/jobReconcile';
import type { JobAttempt, JobAttemptStatus } from '../../src/shared/types';

/**
 * Unit tests for the orphan-classifier inside `listMergedAttempts`.
 *
 * Two pruning behaviors:
 *   - Terminal orphans (failed | cancelled_by_amazon) older than 60s
 *     with no BG match → drop (returns in `terminalOrphanIds`)
 *   - Pending orphans (queued | in_progress | awaiting_verification)
 *     older than 30 min with no BG match → flip to failed (returns in
 *     `stalePendingIds`)
 *
 * Anything else (recent timestamps, BG match exists, status is not in
 * either set) → no-op.
 */

const NOW = Date.parse('2026-05-07T12:00:00Z');

function makeRow(overrides: Partial<JobAttempt> & {
  attemptId: string;
  jobId: string;
  amazonEmail: string;
  status: JobAttemptStatus;
  /** ms ago that updatedAt was set; defaults to 0 */
  agedMsAgo?: number;
}): JobAttempt {
  const { agedMsAgo, ...rest } = overrides;
  const aged = agedMsAgo ?? 0;
  const ts = new Date(NOW - aged).toISOString();
  return {
    phase: 'buy',
    dealKey: null,
    dealId: null,
    dealTitle: null,
    productUrl: 'https://www.amazon.com/dp/B0TEST',
    maxPrice: null,
    price: null,
    quantity: 1,
    cost: null,
    cashbackPct: null,
    orderId: null,
    error: null,
    buyMode: 'single',
    dryRun: false,
    trackingIds: null,
    fillerOrderIds: null,
    productTitle: null,
    stage: null,
    createdAt: ts,
    updatedAt: ts,
    ...rest,
  } as JobAttempt;
}

describe('classifyOrphans', () => {
  it('returns empty when local is empty', () => {
    const r = classifyOrphans({ local: [], serverKeys: new Set(), now: NOW });
    expect(r.terminalOrphanIds).toEqual([]);
    expect(r.stalePendingIds).toEqual([]);
  });

  describe('terminal orphans (failed | cancelled_by_amazon)', () => {
    it('drops failed orphan older than grace window', () => {
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'failed',
        agedMsAgo: TERMINAL_ORPHAN_GRACE_MS + 1000,
      });
      const r = classifyOrphans({ local: [row], serverKeys: new Set(), now: NOW });
      expect(r.terminalOrphanIds).toEqual(['A']);
      expect(r.stalePendingIds).toEqual([]);
    });

    it('drops cancelled_by_amazon orphan older than grace window', () => {
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'cancelled_by_amazon',
        agedMsAgo: TERMINAL_ORPHAN_GRACE_MS + 1000,
      });
      const r = classifyOrphans({ local: [row], serverKeys: new Set(), now: NOW });
      expect(r.terminalOrphanIds).toEqual(['A']);
    });

    it('keeps recent failed orphan inside grace window', () => {
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'failed',
        agedMsAgo: TERMINAL_ORPHAN_GRACE_MS - 1000, // 59s old, under 60s
      });
      const r = classifyOrphans({ local: [row], serverKeys: new Set(), now: NOW });
      expect(r.terminalOrphanIds).toEqual([]);
    });

    it('keeps failed row even when stale, if BG has a match', () => {
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'failed',
        agedMsAgo: TERMINAL_ORPHAN_GRACE_MS + 60_000,
      });
      const serverKeys = new Set([jobAttemptKey(row)]);
      const r = classifyOrphans({ local: [row], serverKeys, now: NOW });
      expect(r.terminalOrphanIds).toEqual([]);
    });
  });

  describe('pending orphans (queued | in_progress | awaiting_verification)', () => {
    for (const status of ['queued', 'in_progress', 'awaiting_verification'] as const) {
      it(`flips ${status} orphan older than 30 min`, () => {
        const row = makeRow({
          attemptId: 'A',
          jobId: 'job1',
          amazonEmail: 'a@x',
          status,
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000,
        });
        const r = classifyOrphans({
          local: [row],
          serverKeys: new Set(),
          now: NOW,
        });
        expect(r.stalePendingIds).toEqual(['A']);
        expect(r.terminalOrphanIds).toEqual([]);
      });

      it(`keeps recent ${status} orphan under grace window`, () => {
        const row = makeRow({
          attemptId: 'A',
          jobId: 'job1',
          amazonEmail: 'a@x',
          status,
          agedMsAgo: PENDING_ORPHAN_GRACE_MS - 60_000, // 29 min — under 30
        });
        const r = classifyOrphans({
          local: [row],
          serverKeys: new Set(),
          now: NOW,
        });
        expect(r.stalePendingIds).toEqual([]);
      });

      it(`keeps stale ${status} row when BG has a match`, () => {
        const row = makeRow({
          attemptId: 'A',
          jobId: 'job1',
          amazonEmail: 'a@x',
          status,
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000,
        });
        const serverKeys = new Set([jobAttemptKey(row)]);
        const r = classifyOrphans({ local: [row], serverKeys, now: NOW });
        expect(r.stalePendingIds).toEqual([]);
      });
    }
  });

  describe('non-orphan-target statuses', () => {
    for (const status of [
      'verified',
      'completed',
      'action_required',
      'dry_run_success',
    ] as const) {
      it(`ignores ${status} entirely (never returned in either list)`, () => {
        const row = makeRow({
          attemptId: 'A',
          jobId: 'job1',
          amazonEmail: 'a@x',
          status,
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000, // very old
        });
        const r = classifyOrphans({
          local: [row],
          serverKeys: new Set(),
          now: NOW,
        });
        expect(r.terminalOrphanIds).toEqual([]);
        expect(r.stalePendingIds).toEqual([]);
      });
    }
  });

  describe('mixed populations', () => {
    it('partitions a realistic mix correctly', () => {
      const rows: JobAttempt[] = [
        // (1) stale failed orphan → terminal
        makeRow({
          attemptId: 'A1',
          jobId: 'j1',
          amazonEmail: 'a@x',
          status: 'failed',
          agedMsAgo: TERMINAL_ORPHAN_GRACE_MS + 5_000,
        }),
        // (2) recent failed orphan → keep (under grace)
        makeRow({
          attemptId: 'A2',
          jobId: 'j2',
          amazonEmail: 'a@x',
          status: 'failed',
          agedMsAgo: 30_000,
        }),
        // (3) stale queued orphan → pending
        makeRow({
          attemptId: 'A3',
          jobId: 'j3',
          amazonEmail: 'a@x',
          status: 'queued',
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000,
        }),
        // (4) recent queued (still in flight) → keep
        makeRow({
          attemptId: 'A4',
          jobId: 'j4',
          amazonEmail: 'a@x',
          status: 'queued',
          agedMsAgo: 10_000,
        }),
        // (5) stale in_progress with BG match → keep (server has it)
        makeRow({
          attemptId: 'A5',
          jobId: 'j5',
          amazonEmail: 'a@x',
          status: 'in_progress',
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000,
        }),
        // (6) stale awaiting_verification orphan → pending
        makeRow({
          attemptId: 'A6',
          jobId: 'j6',
          amazonEmail: 'a@x',
          status: 'awaiting_verification',
          agedMsAgo: PENDING_ORPHAN_GRACE_MS + 60_000,
        }),
        // (7) verified non-target → keep regardless of age/match
        makeRow({
          attemptId: 'A7',
          jobId: 'j7',
          amazonEmail: 'a@x',
          status: 'verified',
          agedMsAgo: PENDING_ORPHAN_GRACE_MS * 10,
        }),
      ];
      const serverKeys = new Set([jobAttemptKey(rows[4]!)]); // only j5 has a BG match
      const r = classifyOrphans({ local: rows, serverKeys, now: NOW });
      expect(r.terminalOrphanIds.sort()).toEqual(['A1']);
      expect(r.stalePendingIds.sort()).toEqual(['A3', 'A6']);
    });

    it('uses updatedAt over createdAt when present (live workers refresh updatedAt)', () => {
      const oldCreated = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
      const recentUpdate = new Date(NOW - 60_000).toISOString(); // 1 min ago
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'in_progress',
      });
      // Override timestamps after construction.
      const live: JobAttempt = { ...row, createdAt: oldCreated, updatedAt: recentUpdate };
      const r = classifyOrphans({ local: [live], serverKeys: new Set(), now: NOW });
      expect(r.stalePendingIds).toEqual([]);
    });

    it('falls back to createdAt when updatedAt is missing/invalid', () => {
      const oldCreated = new Date(NOW - PENDING_ORPHAN_GRACE_MS - 60_000).toISOString();
      const row = makeRow({
        attemptId: 'A',
        jobId: 'job1',
        amazonEmail: 'a@x',
        status: 'queued',
      });
      // Simulate a row missing updatedAt — the helper handles
      // `l.updatedAt ?? l.createdAt`.
      const live = { ...row, createdAt: oldCreated, updatedAt: undefined as unknown as string };
      const r = classifyOrphans({ local: [live], serverKeys: new Set(), now: NOW });
      expect(r.stalePendingIds).toEqual(['A']);
    });
  });

  describe('time-window edges', () => {
    it('terminal grace cutoff is exactly 60s', () => {
      const just60sOld = makeRow({
        attemptId: 'EQ',
        jobId: 'j1',
        amazonEmail: 'a@x',
        status: 'failed',
        agedMsAgo: TERMINAL_ORPHAN_GRACE_MS, // exactly 60s
      });
      const r = classifyOrphans({ local: [just60sOld], serverKeys: new Set(), now: NOW });
      // exactly equal to cutoff → not strictly greater than cutoff → eligible
      expect(r.terminalOrphanIds).toEqual(['EQ']);
    });

    it('pending grace cutoff is exactly 30 min', () => {
      const just30minOld = makeRow({
        attemptId: 'EQ',
        jobId: 'j1',
        amazonEmail: 'a@x',
        status: 'queued',
        agedMsAgo: PENDING_ORPHAN_GRACE_MS,
      });
      const r = classifyOrphans({ local: [just30minOld], serverKeys: new Set(), now: NOW });
      expect(r.stalePendingIds).toEqual(['EQ']);
    });
  });

  describe('STALE_PENDING_REASON', () => {
    it('starts with the auto-reconcile prefix the user-facing UI checks for', () => {
      expect(STALE_PENDING_REASON).toMatch(/^Auto-reconciled/);
    });
    it('mentions the 30-min window so the user can plan around it', () => {
      expect(STALE_PENDING_REASON).toContain('30 min');
    });
  });

  describe('jobAttemptKey', () => {
    it('matches the format listMergedAttempts uses', () => {
      expect(jobAttemptKey({ jobId: 'j1', amazonEmail: 'a@x' })).toBe('j1__a@x');
      expect(jobAttemptKey({ jobId: 'j1', amazonEmail: null })).toBe('j1____none__');
    });
  });
});
