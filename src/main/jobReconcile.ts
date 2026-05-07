/**
 * Pure helper for `listMergedAttempts`'s orphan-classification pass.
 * Extracted so it's unit-testable without mocking the IPC + BG client +
 * file store that `listMergedAttempts` itself depends on.
 *
 * Two orphan classes get returned, both keyed against a server-row
 * presence set the caller built from a successful BG `listPurchases`:
 *
 *   - `terminalOrphanIds`: rows already in failed / cancelled_by_amazon
 *     state with no matching BG row, older than the terminal grace
 *     window. The caller hard-deletes these.
 *
 *   - `stalePendingIds`: rows in queued / in_progress /
 *     awaiting_verification with no matching BG row, older than the
 *     pending grace window. The caller flips these to `failed` (they
 *     then become terminal orphans on the next broadcast and get
 *     dropped via the path above).
 *
 * The caller passes the local rows, the server-key set, and a
 * monotonic `now` value (parameterized for testability — any test can
 * pin time without mocking Date.now).
 */

import type { JobAttempt, JobAttemptStatus } from '../shared/types.js';

const PENDING_STATUSES = new Set<JobAttemptStatus>([
  'queued',
  'in_progress',
  'awaiting_verification',
]);
const TERMINAL_STATUSES = new Set<JobAttemptStatus>([
  'failed',
  'cancelled_by_amazon',
]);

export const TERMINAL_ORPHAN_GRACE_MS = 60_000;
export const PENDING_ORPHAN_GRACE_MS = 30 * 60 * 1000;

export type ClassifyOrphansInput = {
  local: ReadonlyArray<JobAttempt>;
  /** `${jobId}__${amazonEmail ?? '__none__'}` keys built from the BG
   *  server-row response. */
  serverKeys: ReadonlySet<string>;
  /** Monotonic timestamp; injected for testability. */
  now: number;
};

export type ClassifyOrphansResult = {
  /** Local rows in failed / cancelled_by_amazon state, no BG match,
   *  older than `TERMINAL_ORPHAN_GRACE_MS`. */
  terminalOrphanIds: string[];
  /** Local rows in queued / in_progress / awaiting_verification state,
   *  no BG match, older than `PENDING_ORPHAN_GRACE_MS`. */
  stalePendingIds: string[];
};

/** Same `(jobId, amazonEmail)` keying `listMergedAttempts` uses. */
export function jobAttemptKey(a: {
  jobId: string;
  amazonEmail: string | null;
}): string {
  return `${a.jobId}__${a.amazonEmail ?? '__none__'}`;
}

/** Pure orphan classifier — no I/O, no globals. */
export function classifyOrphans(input: ClassifyOrphansInput): ClassifyOrphansResult {
  const { local, serverKeys, now } = input;
  const cutoffTerminal = now - TERMINAL_ORPHAN_GRACE_MS;
  const cutoffPending = now - PENDING_ORPHAN_GRACE_MS;
  const terminalOrphanIds: string[] = [];
  const stalePendingIds: string[] = [];
  for (const l of local) {
    if (serverKeys.has(jobAttemptKey(l))) continue;
    const lastTouched = Date.parse(l.updatedAt ?? l.createdAt);
    const lastTouchedMs = Number.isFinite(lastTouched) ? lastTouched : 0;
    if (TERMINAL_STATUSES.has(l.status)) {
      if (lastTouchedMs > cutoffTerminal) continue;
      terminalOrphanIds.push(l.attemptId);
      continue;
    }
    if (PENDING_STATUSES.has(l.status)) {
      if (lastTouchedMs > cutoffPending) continue;
      stalePendingIds.push(l.attemptId);
    }
  }
  return { terminalOrphanIds, stalePendingIds };
}

/** Reason string written to `JobAttempt.error` when a stale pending
 *  orphan gets auto-flipped to `failed`. Exported so the test asserts
 *  the same string the production code writes. */
export const STALE_PENDING_REASON =
  'Auto-reconciled — no matching BG purchase after 30 min. ' +
  'Worker likely crashed or app was closed before outcome reported.';
