import { app } from 'electron';
import {
  readFile,
  mkdir,
  appendFile,
  readdir,
  unlink,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomicJson.js';
import type { JobAttempt, LogEvent } from '../shared/types.js';
import { snapshotDir, clearAllSnapshots } from '../browser/snapshot.js';
import { pickIdsToEvict } from './jobStoreRingBuffer.js';

type Stored = {
  attempts: Record<string, JobAttempt>;
};

const MAX_ATTEMPTS = 1_000; // ring-buffer cap; oldest evicted on overflow

// Debounce window for the disk write, and a HARD cap on how long the
// debounce may keep deferring. scheduleSave restarts the 250ms timer
// on every store mutation — under a busy run (a full deal list fanned
// across accounts) mutations arrive closer than 250ms apart, so the
// timer was perpetually reset and `persist()` never ran: the whole
// run's attempt rows lived only in `cache`, and a process restart /
// crash / quit dropped them (the ghost-order bug). MAX_DEBOUNCE_MS
// forces a flush even under continuous activity.
const SAVE_DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 2_000;

let cache: Stored | null = null;
let saveTimer: NodeJS.Timeout | null = null;
// Timestamp of the OLDEST un-persisted mutation. null when the store
// is clean (everything on disk). Used to enforce MAX_DEBOUNCE_MS.
let dirtySince: number | null = null;

function attemptsPath(): string {
  return join(app.getPath('userData'), 'job-attempts.json');
}

function logsDir(): string {
  return join(app.getPath('userData'), 'job-logs');
}

function logFile(attemptId: string): string {
  return join(logsDir(), `${attemptId}.jsonl`);
}

function removeSnapshot(attemptId: string): Promise<void> {
  return rm(snapshotDir(attemptId), { recursive: true, force: true }).catch(() => undefined) as Promise<void>;
}

async function load(): Promise<Stored> {
  if (cache) return cache;
  try {
    const raw = await readFile(attemptsPath(), 'utf8');
    cache = JSON.parse(raw) as Stored;
    migrateLegacyStatuses(cache);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    cache = { attempts: {} };
  }
  return cache;
}

/**
 * Older builds wrote verify-phase outcomes as their own attempt rows with
 * status='failed' and error='order was cancelled by Amazon'. The current
 * worker no longer creates verify rows (it updates the buy row in place),
 * but those legacy rows are still on disk. Re-tag them to the proper
 * 'cancelled_by_amazon' status so the table renders them as "Canceled"
 * instead of "Failed".
 */
function migrateLegacyStatuses(store: Stored): void {
  let touched = false;
  for (const a of Object.values(store.attempts)) {
    if (
      a.phase === 'verify' &&
      a.status === 'failed' &&
      typeof a.error === 'string' &&
      /cancell?ed by amazon/i.test(a.error)
    ) {
      a.status = 'cancelled_by_amazon';
      touched = true;
    }
  }
  if (touched) scheduleSave();
}

async function persist(): Promise<void> {
  if (!cache) return;
  await writeJsonAtomic(attemptsPath(), cache);
}

function scheduleSave(): void {
  const now = Date.now();
  if (dirtySince === null) dirtySince = now;
  // Hard cap: if the debounce has been deferring writes longer than
  // MAX_DEBOUNCE_MS, stop resetting and flush NOW. Without this, a
  // sustained run starves the timer indefinitely (see MAX_DEBOUNCE_MS
  // comment) and nothing reaches disk until activity pauses.
  if (now - dirtySince >= MAX_DEBOUNCE_MS) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    dirtySince = null;
    void persist().catch(() => {
      // silent — next mutation will retry
    });
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    dirtySince = null;
    void persist().catch(() => {
      // silent — next mutation will retry
    });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Synchronous flush variant — bypasses the 250ms debounce and persists
 * immediately. Use for writes that MUST be on disk before the next
 * statement runs (e.g., `stage='placing'` markers — recovery sweep
 * mis-classifies a row whose stage write didn't land before a hard
 * kill, risking duplicate orders).
 *
 * Cost: ~5ms fsync per call. Reserve for critical-section markers.
 */
async function persistNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirtySince = null;
  await persist().catch(() => undefined);
}

/**
 * Flush any pending (debounced) attempt-row writes to disk
 * synchronously. Call from the app's `before-quit` handler — without
 * it, a quit / restart abandons the in-memory `cache` and every row
 * not yet persisted is lost (the ghost-order bug). Safe to call when
 * the store is already clean (cheap no-op-ish write).
 */
export async function flushAttempts(): Promise<void> {
  await persistNow();
}

function evictOldestIfNeeded(): void {
  if (!cache) return;
  for (const id of pickIdsToEvict(cache.attempts, MAX_ATTEMPTS)) {
    delete cache.attempts[id];
    void unlink(logFile(id)).catch(() => undefined);
    void removeSnapshot(id);
  }
}

export async function createAttempt(
  partial: Omit<JobAttempt, 'createdAt' | 'updatedAt'>,
): Promise<JobAttempt> {
  const store = await load();
  const now = new Date().toISOString();
  const attempt: JobAttempt = {
    ...partial,
    createdAt: now,
    updatedAt: now,
  };
  store.attempts[attempt.attemptId] = attempt;
  evictOldestIfNeeded();
  scheduleSave();
  return attempt;
}

export async function updateAttempt(
  attemptId: string,
  patch: Partial<Omit<JobAttempt, 'attemptId' | 'jobId' | 'amazonEmail' | 'createdAt'>>,
  opts?: { forceFlush?: boolean },
): Promise<JobAttempt | null> {
  const store = await load();
  const existing = store.attempts[attemptId];
  if (!existing) return null;
  const updated: JobAttempt = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.attempts[attemptId] = updated;
  if (opts?.forceFlush) {
    // Synchronous flush: caller cannot proceed until this row is on
    // disk. Used for `stage='placing'` markers so a hard kill can't
    // leave a stale on-disk row that the recovery sweep mis-classifies.
    await persistNow();
  } else {
    scheduleSave();
  }
  return updated;
}

export async function getAttempt(attemptId: string): Promise<JobAttempt | null> {
  const store = await load();
  return store.attempts[attemptId] ?? null;
}

export async function listAttempts(): Promise<JobAttempt[]> {
  const store = await load();
  return Object.values(store.attempts).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function appendLogBatch(
  attemptId: string,
  events: LogEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await mkdir(logsDir(), { recursive: true });
  const payload = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  await appendFile(logFile(attemptId), payload, 'utf8');
}

export async function readLogs(attemptId: string): Promise<LogEvent[]> {
  try {
    const raw = await readFile(logFile(attemptId), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as LogEvent;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogEvent => x !== null);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteAttempt(attemptId: string): Promise<void> {
  const store = await load();
  delete store.attempts[attemptId];
  scheduleSave();
  try {
    await unlink(logFile(attemptId));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  void removeSnapshot(attemptId);
}

/**
 * Bulk delete — one cache mutation, one debounced save, parallel log +
 * snapshot removals. Dropping 1000+ rows via single deleteAttempt takes
 * seconds per-call because of the IPC + fs serialization; this path is
 * ~100x faster for large selections. Returns the count actually removed
 * (ids not in the store are silently skipped).
 */
export async function deleteAttempts(attemptIds: string[]): Promise<number> {
  if (attemptIds.length === 0) return 0;
  const store = await load();
  let removed = 0;
  for (const id of attemptIds) {
    if (store.attempts[id]) {
      delete store.attempts[id];
      removed += 1;
    }
  }
  if (removed === 0) return 0;
  scheduleSave();
  await Promise.all(
    attemptIds.map(async (id) => {
      try {
        await unlink(logFile(id));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      void removeSnapshot(id);
    }),
  );
  return removed;
}

/**
 * Drop attempt records older than `cutoff`. Used at app startup so the
 * table doesn't grow unbounded.
 */
export async function pruneOlderThan(cutoffMs: number): Promise<number> {
  const store = await load();
  let pruned = 0;
  for (const [id, a] of Object.entries(store.attempts)) {
    if (new Date(a.createdAt).getTime() < cutoffMs) {
      delete store.attempts[id];
      pruned += 1;
      void unlink(logFile(id)).catch(() => undefined);
      void removeSnapshot(id);
    }
  }
  if (pruned > 0) scheduleSave();
  return pruned;
}

export async function clearAll(): Promise<void> {
  cache = { attempts: {} };
  scheduleSave();
  // Wipe every per-attempt log file + snapshot directory.
  try {
    const files = await readdir(logsDir());
    await Promise.all(
      files.map((f) => unlink(join(logsDir(), f)).catch(() => undefined)),
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  void clearAllSnapshots();
}

/** Drop every attempt with status 'failed' and unlink its JSONL log. */
export async function clearFailed(): Promise<number> {
  return clearByStatus((s) => s === 'failed');
}

/** Drop every attempt that Amazon cancelled (post-verify). */
export async function clearCanceled(): Promise<number> {
  return clearByStatus((s) => s === 'cancelled_by_amazon');
}

async function clearByStatus(
  matcher: (s: JobAttempt['status']) => boolean,
): Promise<number> {
  const store = await load();
  let removed = 0;
  for (const [id, a] of Object.entries(store.attempts)) {
    if (matcher(a.status)) {
      delete store.attempts[id];
      removed += 1;
      void unlink(logFile(id)).catch(() => undefined);
      void removeSnapshot(id);
    }
  }
  if (removed > 0) scheduleSave();
  return removed;
}

export async function listLogFiles(): Promise<string[]> {
  try {
    return await readdir(logsDir());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
