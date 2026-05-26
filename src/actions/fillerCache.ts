/**
 * Shared, process-local cache of filler-search candidates.
 *
 * Why this exists:
 *   Every `buyWithFillers` attempt used to run a fresh Amazon search
 *   for filler ASINs. Under high deal volume this hit Amazon's edge
 *   rate-limiter (INC-2026-05-10 + recurrences through 2026-05-22) and
 *   bubbled up to BG as `no_filler_candidates — search rate-limited
 *   across all pools`. The data we're searching for is functionally
 *   stable for 30+ minutes: "Prime-eligible cheap fillers under pool
 *   X". Caching it eliminates the per-buy search and the rate-limit
 *   class of failures with it.
 *
 * Shape:
 *   One in-memory Map keyed by pool name. Each entry is a list of
 *   `CachedFillerItem`s plus a `populatedAt` timestamp. The cache is
 *   shared across all Amazon profiles on this worker — the items are
 *   pool-scoped, not account-scoped, so cross-account reuse is safe.
 *
 * Single-flight:
 *   When many concurrent buys hit an empty cache at the same time we'd
 *   stampede Amazon's search endpoint. `getOrPopulate` coalesces
 *   concurrent misses against a per-pool in-flight Promise so only the
 *   first miss triggers the actual search; the rest await its result.
 *
 * Eviction:
 *   - TTL (60 min, read-time only). Buys already holding cached items
 *     continue safely past expiry — items are just ASINs, they don't
 *     go stale mid-flight.
 *   - Cart-add failure: when an ASIN is requested in a batch POST but
 *     doesn't echo back as committed, evict it. Likely OOS or now
 *     rejected by Amazon for that account.
 *   - Capacity: hard cap MAX_PER_POOL per pool (oldest entries pruned).
 *
 * Persistence:
 *   None. Worker restart drops the cache; first buy after restart pays
 *   one search to repopulate. Acceptable.
 *
 * Tested in tests/unit/fillerCache.test.ts (16 cases).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../shared/logger.js';
import type { FillerPool } from '../shared/ipc.js';

/**
 * Dev-mode-only path where every cache populate/evict appends a full
 * item-level snapshot as one JSON line. Lets the user (or me, via
 * `cat`) inspect exactly what's in the cache after a buy without
 * trawling the npm-run-dev terminal scrollback.
 *
 * Production builds (electron.app.isPackaged === true) skip the file
 * write — see emitDevItemDump's gate.
 *
 * Append-only. Wipe manually if it grows: `rm /tmp/amazong-filler-cache.log`
 */
export const DEV_DUMP_PATH = path.join(os.tmpdir(), 'amazong-filler-cache.log');

/** Cache key. Mirrors FillerPool but adds an explicit 'default' bucket
 *  for the no-pool case (general filler list, no blocklist). Keeping
 *  it as a separate key — rather than collapsing undefined → 'general'
 *  — avoids surprising cross-pool reuse if the caller wires up a new
 *  pool but forgets to map it through. */
export type PoolKey = 'default' | FillerPool;

/** Subset of SearchResultCandidate we persist. `csrf` is intentionally
 *  excluded — it's page-scoped and short-lived; the caller threads in
 *  the target item's PDP csrf (already fetched on every buy) for the
 *  batch POST. `merchantId` excluded too — the search URL filter
 *  already restricts to Amazon-sold listings; storing it would just
 *  carry stale metadata. */
export type CachedFillerItem = {
  asin: string;
  offerListingId: string;
  /** Diagnostic only — included in eviction/hit log lines so the
   *  operator can sanity-check which items came out of cache. */
  title: string | null;
  /** Diagnostic only — same purpose as title. */
  price: number | null;
  /** ms epoch when this specific item entered the cache. Used for
   *  stable LRU when over MAX_PER_POOL — oldest entries evicted
   *  first. NOT the entry-level TTL; that's `populatedAt`. */
  cachedAt: number;
};

type CacheEntry = {
  items: CachedFillerItem[];
  /** ms epoch of the most recent populate. Drives TTL freshness. */
  populatedAt: number;
};

/** 60 min. Validated empirically: filler items rarely change Prime
 *  status or go OOS within an hour. Erring shorter than the typical
 *  buy-queue cycle (~6h) so a worker that's been up all day still
 *  rotates candidates a few times. */
export const TTL_MS = 60 * 60 * 1000;

/** Per-pool cap. ~50 candidates fit on one Amazon search-results
 *  page; 60 leaves headroom for a second term without unbounded
 *  growth. Hard cap protects against pathological populate calls
 *  (e.g., bug-bug-bug 200 items). */
export const MAX_PER_POOL = 60;

/** Minimum buffer above `targetCount` for a hit to count. If the
 *  caller wants 8 fillers and `excludeAsins` already covers 5 of
 *  the 8 cached items, returning 3 isn't useful — we want a fresh
 *  search. PICK_BUFFER guards that boundary by requiring the cache
 *  to have at least targetCount + buffer ITEMS NET OF EXCLUSIONS
 *  before declaring hit. */
export const PICK_BUFFER = 2;

// Module-private state. Kept in module scope (not a class) because
// the worker is single-process and a singleton is the right model.
// `clearAll()` resets it for tests.
const cache = new Map<PoolKey, CacheEntry>();
const inflight = new Map<PoolKey, Promise<void>>();

/** Test hook + clean-state guarantee for `npm run dev` restarts.
 *  Production code should never call this. */
export function clearAll(): void {
  cache.clear();
  inflight.clear();
}

export type PoolStats = {
  itemCount: number;
  /** ms since populatedAt. Infinity when the pool has no entry. */
  ageMs: number;
  isStale: boolean;
  inFlight: boolean;
};

/** Pure inspection helper. Safe to call from any code path. */
export function getStats(pool: PoolKey, now: number = Date.now()): PoolStats {
  const entry = cache.get(pool);
  if (!entry) {
    return {
      itemCount: 0,
      ageMs: Infinity,
      isStale: true,
      inFlight: inflight.has(pool),
    };
  }
  const ageMs = now - entry.populatedAt;
  return {
    itemCount: entry.items.length,
    ageMs,
    isStale: ageMs >= TTL_MS,
    inFlight: inflight.has(pool),
  };
}

/** Snapshot every pool — used by the dev-mode IPC handler that powers
 *  the renderer's cache-stats panel. */
export function getAllStats(now: number = Date.now()): Record<string, PoolStats> {
  const out: Record<string, PoolStats> = {};
  for (const pool of cache.keys()) {
    out[pool] = getStats(pool, now);
  }
  // Also surface any pool that's only in-flight (mid-populate first
  // miss before the entry is written).
  for (const pool of inflight.keys()) {
    if (!out[pool]) out[pool] = getStats(pool, now);
  }
  return out;
}

/** Write fresh search results into the cache, deduping by asin
 *  (latest cachedAt wins) and enforcing MAX_PER_POOL with LRU prune.
 *  Idempotent — calling twice with the same input ends up with the
 *  same final state. */
export function populateFromSearch(
  pool: PoolKey,
  candidates: ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>,
  now: number = Date.now(),
): void {
  if (candidates.length === 0) return;
  const existing = cache.get(pool);
  // Build a new list: existing items first (preserved order), then new
  // candidates appended. Dedupe by asin keeping the LATER entry —
  // newer candidate metadata wins.
  const byAsin = new Map<string, CachedFillerItem>();
  if (existing) {
    for (const it of existing.items) byAsin.set(it.asin, it);
  }
  for (const c of candidates) {
    if (!c.asin || !c.offerListingId) continue;
    byAsin.set(c.asin, {
      asin: c.asin,
      offerListingId: c.offerListingId,
      title: c.title ?? null,
      price: c.price ?? null,
      cachedAt: now,
    });
  }
  let items = Array.from(byAsin.values());
  // LRU prune: sort by cachedAt asc → drop oldest until ≤ cap.
  if (items.length > MAX_PER_POOL) {
    items.sort((a, b) => a.cachedAt - b.cachedAt);
    items = items.slice(items.length - MAX_PER_POOL);
  }
  cache.set(pool, { items, populatedAt: now });
  logger.info(
    'step.fillerCache.populate',
    {
      pool,
      added: candidates.length,
      totalAfter: items.length,
      capped: candidates.length + (existing?.items.length ?? 0) > MAX_PER_POOL,
    },
  );
  emitDevSummary('populate', pool, now);
  emitDevItemDump('populate', pool, now);
}

/** Remove a single ASIN from a pool's cache. Called when a cart-add
 *  batch POST shows the ASIN wasn't committed. Silent no-op if the
 *  asin or pool isn't cached. */
export function evictAsin(pool: PoolKey, asin: string): void {
  const entry = cache.get(pool);
  if (!entry) return;
  const before = entry.items.length;
  entry.items = entry.items.filter((it) => it.asin !== asin);
  if (entry.items.length === before) return;
  logger.info(
    'step.fillerCache.evict',
    { pool, asin, remaining: entry.items.length },
  );
  emitDevSummary('evict', pool);
  emitDevItemDump('evict', pool);
}

/** Result shape from getOrPopulate. */
export type GetOrPopulateResult =
  | { kind: 'hit'; items: CachedFillerItem[]; ageMs: number }
  | { kind: 'miss'; items: CachedFillerItem[] }
  | { kind: 'unavailable'; reason: string };

/** Search callback contract: produces fresh candidates OR returns
 *  empty array if the search itself failed/rate-limited. Never throws
 *  on the caller side — wrap throws and return [] instead. */
export type SearchFn = () => Promise<ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>>;

/**
 * THE main entry point. Returns cached items if the pool has enough
 * fresh ones (after applying excludeAsins); otherwise runs the
 * caller-provided searchFn and caches its result. Concurrent misses
 * on the same pool coalesce — only the first caller invokes searchFn,
 * the rest await it and read from the now-populated cache.
 *
 * The return shape:
 *   - `hit`: cache had ≥ minCount items net of excludes. Items
 *     returned in cachedAt asc order (oldest first); caller may
 *     slice or shuffle as needed.
 *   - `miss`: cache was stale/empty, search ran and populated the
 *     cache. The same selection logic runs against the fresh data
 *     and items are returned. May still be < minCount if Amazon
 *     itself yielded few candidates.
 *   - `unavailable`: search returned 0 candidates (rate-limited or
 *     errored). Caller MAY treat this as `no_filler_candidates` and
 *     surface to retry chain.
 */
export async function getOrPopulate(
  pool: PoolKey,
  minCount: number,
  excludeAsins: ReadonlySet<string>,
  searchFn: SearchFn,
  now: () => number = Date.now,
): Promise<GetOrPopulateResult> {
  // 1. Fast-path: check the cache.
  const fastPick = pickFromCache(pool, minCount, excludeAsins, now());
  if (fastPick.ok) {
    logger.info(
      'step.fillerCache.hit',
      {
        pool,
        requested: minCount,
        returned: fastPick.items.length,
        ageMs: fastPick.ageMs,
        totalInPool: fastPick.totalInPool,
      },
    );
    emitDevSummary('hit', pool);
    return { kind: 'hit', items: fastPick.items, ageMs: fastPick.ageMs };
  }

  // 2. Miss. Single-flight: if another caller is already searching
  //    this pool, wait for them.
  const existing = inflight.get(pool);
  if (existing) {
    logger.info(
      'step.fillerCache.singleflight.wait',
      { pool, reason: fastPick.reason },
    );
    await existing.catch(() => {
      // singleflight leader's errors are surfaced via the cache state
      // we re-read below — we don't propagate them per-follower.
    });
    // Re-check the cache after the leader finished.
    const afterPick = pickFromCache(pool, minCount, excludeAsins, now());
    if (afterPick.ok) {
      logger.info(
        'step.fillerCache.singleflight.hit',
        {
          pool,
          requested: minCount,
          returned: afterPick.items.length,
          ageMs: afterPick.ageMs,
        },
      );
      return { kind: 'hit', items: afterPick.items, ageMs: afterPick.ageMs };
    }
    // Leader's search produced too few items — fall through to a
    // miss without re-searching (we'd just hit the same rate-limit).
    return {
      kind: 'unavailable',
      reason: `singleflight_leader_returned_insufficient:${afterPick.reason}`,
    };
  }

  // 3. We are the leader. Run the search under a fresh promise that
  //    every concurrent follower will await.
  logger.info(
    'step.fillerCache.miss',
    { pool, reason: fastPick.reason, requested: minCount },
  );
  emitDevSummary('miss', pool);
  let searchError: unknown = null;
  let candidates: ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>> = [];
  const leaderPromise = (async () => {
    try {
      candidates = await searchFn();
    } catch (err) {
      searchError = err;
      candidates = [];
    }
    if (candidates.length > 0) {
      populateFromSearch(pool, candidates, now());
    }
  })();
  inflight.set(pool, leaderPromise);
  try {
    await leaderPromise;
  } finally {
    // Always release the lock — even on error. Otherwise a thrown
    // search permanently jams the pool.
    inflight.delete(pool);
  }

  if (searchError) {
    logger.warn(
      'step.fillerCache.search.threw',
      { pool, error: String(searchError).slice(0, 200) },
    );
    return { kind: 'unavailable', reason: 'search_threw' };
  }
  if (candidates.length === 0) {
    return { kind: 'unavailable', reason: 'search_empty' };
  }

  // 4. Try the pick again against the freshly-populated cache.
  const finalPick = pickFromCache(pool, minCount, excludeAsins, now());
  if (finalPick.ok) {
    return { kind: 'miss', items: finalPick.items };
  }
  // Fresh search ran but yielded fewer than minCount after excludes.
  // Still return what we got under the `miss` kind — caller may
  // proceed with a partial cart.
  const fallbackItems = pickAvailable(pool, minCount, excludeAsins);
  return { kind: 'miss', items: fallbackItems };
}

// ─── Internal helpers ──────────────────────────────────────────────

type PickResult =
  | {
      ok: true;
      items: CachedFillerItem[];
      ageMs: number;
      totalInPool: number;
    }
  | { ok: false; reason: 'empty' | 'stale' | 'insufficient' };

/** Hit-test: do we have ≥ (minCount + PICK_BUFFER) items net of
 *  excludes AND is the entry fresh? */
function pickFromCache(
  pool: PoolKey,
  minCount: number,
  excludeAsins: ReadonlySet<string>,
  now: number,
): PickResult {
  const entry = cache.get(pool);
  if (!entry || entry.items.length === 0) return { ok: false, reason: 'empty' };
  const ageMs = now - entry.populatedAt;
  if (ageMs >= TTL_MS) return { ok: false, reason: 'stale' };
  const usable = entry.items.filter((it) => !excludeAsins.has(it.asin));
  const need = minCount + PICK_BUFFER;
  if (usable.length < need) return { ok: false, reason: 'insufficient' };
  // Return targetCount items (caller decides selection strategy by
  // post-filtering). Items pre-sorted oldest-first; callers wanting
  // recent items can reverse, callers wanting random can shuffle.
  return {
    ok: true,
    items: usable.slice(0, minCount),
    ageMs,
    totalInPool: entry.items.length,
  };
}

/** Non-strict picker — returns whatever is available net of
 *  excludes, capped at minCount. Used as the partial-result fallback
 *  after a search that yielded fewer than minCount items. */
function pickAvailable(
  pool: PoolKey,
  minCount: number,
  excludeAsins: ReadonlySet<string>,
): CachedFillerItem[] {
  const entry = cache.get(pool);
  if (!entry) return [];
  const usable = entry.items.filter((it) => !excludeAsins.has(it.asin));
  return usable.slice(0, minCount);
}

// ─── Dev-mode observability ────────────────────────────────────────
//
// Emits a single high-signal "stats summary" line after every cache
// event so the operator running `npm run dev` can grep one prefix and
// see exactly how the cache is performing.
//
//   npm run dev 2>&1 | grep '\[FILLER_CACHE\]'
//
// Gated on a coarse "are we in dev?" check evaluated once at boot. We
// avoid the per-call await isUnpackagedRun() — that would pull
// electron into the import graph for every call site, including
// vitest where electron isn't installed.

// FILLER_CACHE_DEBUG=1 forces the summary on. Otherwise we cache the
// answer from electron.app.isPackaged after the first event — once
// resolved (typically within the first second of worker boot) every
// subsequent summary call is sync.
//
// vitest path: `process.versions.electron` is undefined → resolves
// false → tests never spam console with the summary. (The structured
// logger.info lines still fire and are captured by vitest's stdout
// assertion harness if a test ever wants to assert on them.)
let devGateResolved = false;
let devGateValue = false;
async function resolveDevGate(): Promise<void> {
  if (devGateResolved) return;
  if (process.env.FILLER_CACHE_DEBUG === '1') {
    devGateValue = true;
    devGateResolved = true;
    return;
  }
  try {
    if (typeof process !== 'undefined' && process.versions?.electron) {
      const electron = await import('electron');
      const app = (electron as { app?: { isPackaged?: boolean } }).app;
      devGateValue = app?.isPackaged === false;
    } else {
      devGateValue = false;
    }
  } catch {
    devGateValue = false;
  }
  devGateResolved = true;
}

/**
 * Dev-mode-only: emit a full item-level snapshot of one pool to BOTH
 * the console (visible in `npm run dev` terminal) AND a known file
 * path (DEV_DUMP_PATH) so the operator can `cat` it after the fact.
 *
 * Fires on every populate / evict — the two events that mutate
 * cache contents. Hit/miss events are not dumped (they don't change
 * what's IN the cache, only what's read FROM it) — those still hit
 * the existing emitDevSummary stats line.
 *
 * Gated on devGateValue (same gate as emitDevSummary), so production
 * builds NEVER write to /tmp.
 */
function emitDevItemDump(
  event: 'populate' | 'evict',
  pool: PoolKey,
  now: number = Date.now(),
): void {
  if (!devGateResolved || !devGateValue) return;
  const entry = cache.get(pool);
  const items = entry
    ? entry.items.map((it) => ({
        asin: it.asin,
        title: it.title?.slice(0, 80) ?? null,
        price: it.price,
        ageSec: Math.round((now - it.cachedAt) / 1000),
      }))
    : [];
  const line = JSON.stringify({
    ts: new Date(now).toISOString(),
    event,
    pool,
    count: items.length,
    populatedAt: entry?.populatedAt ?? null,
    items,
  });
  // Console (npm run dev terminal)
  // eslint-disable-next-line no-console
  console.log(`[FILLER_CACHE_DUMP] ${line}`);
  // File — append-only for post-hoc inspection. Sync write is fine
  // here: dev-mode only, fires a handful of times per buy.
  try {
    fs.appendFileSync(DEV_DUMP_PATH, line + '\n');
  } catch {
    // /tmp inaccessible or disk full — drop silently. The console
    // line above is the primary path; file is a convenience.
  }
}

function emitDevSummary(
  event: 'populate' | 'evict' | 'hit' | 'miss',
  pool: PoolKey,
  now: number = Date.now(),
): void {
  // Fire-and-forget gate resolution. The first event in a worker may
  // skip the visible summary (because the gate hasn't resolved yet);
  // every subsequent event after the first ~1ms tick sees the cached
  // value. Acceptable — the structured logger.info lines always emit.
  if (!devGateResolved) {
    void resolveDevGate();
    return;
  }
  if (!devGateValue) return;
  const all = getAllStats(now);
  const cells = Object.entries(all)
    .map(([p, s]) => `${p}=${s.itemCount}@${Math.round(s.ageMs / 1000)}s`)
    .join(' ');
  // Use console.log directly (not the structured logger) so the line
  // is visually distinct from the JSON event stream — easy to spot.
  // eslint-disable-next-line no-console
  console.log(`[FILLER_CACHE] ${event} pool=${pool} | ${cells || '(empty)'}`);
}


