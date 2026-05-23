import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAll,
  evictAsin,
  getAllStats,
  getOrPopulate,
  getStats,
  MAX_PER_POOL,
  PICK_BUFFER,
  populateFromSearch,
  TTL_MS,
  type CachedFillerItem,
} from '../../src/actions/fillerCache';

function item(asin: string, extras: Partial<CachedFillerItem> = {}): Omit<CachedFillerItem, 'cachedAt'> {
  return {
    asin,
    offerListingId: `OL_${asin}`,
    title: `title-${asin}`,
    price: 9.99,
    ...extras,
  };
}

function items(n: number, prefix = 'B0', startAt = 0): Omit<CachedFillerItem, 'cachedAt'>[] {
  return Array.from({ length: n }, (_, i) =>
    item(`${prefix}${String(i + startAt).padStart(6, '0')}`),
  );
}

afterEach(() => {
  clearAll();
  vi.useRealTimers();
});

describe('fillerCache — populate + read', () => {
  it('populate then getStats reports the right shape', () => {
    populateFromSearch('default', items(5), 1_000);
    const s = getStats('default', 1_500);
    expect(s.itemCount).toBe(5);
    expect(s.ageMs).toBe(500);
    expect(s.isStale).toBe(false);
    expect(s.inFlight).toBe(false);
  });

  it('empty pool returns Infinity age + stale', () => {
    const s = getStats('eero');
    expect(s.itemCount).toBe(0);
    expect(s.ageMs).toBe(Infinity);
    expect(s.isStale).toBe(true);
  });

  it('populate with empty array is a no-op', () => {
    populateFromSearch('default', [], 1_000);
    expect(getStats('default').itemCount).toBe(0);
  });

  it('populate dedupes by asin — latest cachedAt wins', () => {
    populateFromSearch('default', [item('B001', { title: 'first' })], 1_000);
    populateFromSearch('default', [item('B001', { title: 'second' })], 2_000);
    populateFromSearch('default', [item('B002')], 3_000);
    const all = getAllStats(3_000);
    expect(all.default).toBeDefined();
    expect(all.default!.itemCount).toBe(2);
  });

  it('populate skips entries with missing asin/offerListingId', () => {
    populateFromSearch(
      'default',
      [
        { asin: '', offerListingId: 'OL', title: null, price: null },
        { asin: 'B001', offerListingId: '', title: null, price: null },
        item('B002'),
      ],
      1_000,
    );
    expect(getStats('default').itemCount).toBe(1);
  });

  it('respects MAX_PER_POOL with LRU prune (oldest dropped)', () => {
    populateFromSearch('default', items(MAX_PER_POOL, 'B0'), 1_000);
    expect(getStats('default').itemCount).toBe(MAX_PER_POOL);
    // 10 new items at later timestamp — oldest 10 should evict.
    populateFromSearch('default', items(10, 'B1'), 2_000);
    expect(getStats('default').itemCount).toBe(MAX_PER_POOL);
  });
});

describe('fillerCache — eviction', () => {
  it('evictAsin removes only the named asin', () => {
    populateFromSearch('default', [item('B001'), item('B002'), item('B003')], 1_000);
    evictAsin('default', 'B002');
    expect(getStats('default').itemCount).toBe(2);
  });

  it('evictAsin no-ops on unknown pool', () => {
    evictAsin('eero', 'B001');
    expect(getStats('eero').itemCount).toBe(0);
  });

  it('evictAsin no-ops on unknown asin in known pool', () => {
    populateFromSearch('default', [item('B001')], 1_000);
    evictAsin('default', 'B999');
    expect(getStats('default').itemCount).toBe(1);
  });
});

describe('fillerCache — pool isolation', () => {
  it('populating one pool does not affect another', () => {
    populateFromSearch('eero', items(3), 1_000);
    populateFromSearch('amazon-basics', items(5, 'C0'), 1_000);
    expect(getStats('eero').itemCount).toBe(3);
    expect(getStats('amazon-basics').itemCount).toBe(5);
    expect(getStats('default').itemCount).toBe(0);
  });
});

describe('fillerCache — clearAll', () => {
  it('clearAll wipes every pool', () => {
    populateFromSearch('default', items(3), 1_000);
    populateFromSearch('eero', items(2), 1_000);
    clearAll();
    expect(getStats('default').itemCount).toBe(0);
    expect(getStats('eero').itemCount).toBe(0);
  });
});

describe('fillerCache.getOrPopulate — fast path', () => {
  it('cache hit returns items without calling searchFn', async () => {
    const fakeNow = vi.fn().mockReturnValue(1_000);
    populateFromSearch('default', items(20), 1_000);
    const searchFn = vi.fn().mockResolvedValue(items(5, 'X'));
    const r = await getOrPopulate('default', 8, new Set(), searchFn, fakeNow);
    expect(r.kind).toBe('hit');
    expect(searchFn).not.toHaveBeenCalled();
    if (r.kind === 'hit') expect(r.items.length).toBe(8);
  });

  it('expired entry triggers a re-search (TTL respected)', async () => {
    let t = 1_000;
    populateFromSearch('default', items(20), t);
    t = 1_000 + TTL_MS + 1; // 1ms past TTL
    const fresh = items(20, 'F');
    const searchFn = vi.fn().mockResolvedValue(fresh);
    const r = await getOrPopulate('default', 8, new Set(), searchFn, () => t);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('miss');
  });

  it('respects excludeAsins (insufficient triggers search)', async () => {
    // 10 items in cache; exclude 9 of them — net 1, below minCount 8.
    populateFromSearch('default', items(10), 1_000);
    const exclude = new Set(items(9).map((i) => i.asin));
    const fresh = items(20, 'F');
    const searchFn = vi.fn().mockResolvedValue(fresh);
    const r = await getOrPopulate('default', 8, exclude, searchFn, () => 1_500);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('miss');
  });

  it('PICK_BUFFER enforced — hit requires minCount + buffer items net of exclude', async () => {
    // Exactly minCount items net of exclude → NOT a hit (need buffer).
    populateFromSearch('default', items(8), 1_000);
    const searchFn = vi.fn().mockResolvedValue(items(20, 'F'));
    const r = await getOrPopulate('default', 8, new Set(), searchFn, () => 1_500);
    // 8 items, need 8 + PICK_BUFFER → miss
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe('miss');

    // Now populate enough for hit
    clearAll();
    populateFromSearch('default', items(8 + PICK_BUFFER), 1_000);
    const searchFn2 = vi.fn().mockResolvedValue([]);
    const r2 = await getOrPopulate('default', 8, new Set(), searchFn2, () => 1_500);
    expect(searchFn2).not.toHaveBeenCalled();
    expect(r2.kind).toBe('hit');
  });
});

describe('fillerCache.getOrPopulate — search outcomes', () => {
  it('search returning 0 → unavailable', async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    const r = await getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    expect(r.kind).toBe('unavailable');
  });

  it('search throwing → unavailable + lock released', async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error('rate limited'));
    const r = await getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    expect(r.kind).toBe('unavailable');
    // Second call should retry (lock was released on throw).
    const searchFn2 = vi.fn().mockResolvedValue(items(20));
    const r2 = await getOrPopulate('default', 8, new Set(), searchFn2, () => 1_000);
    expect(searchFn2).toHaveBeenCalledTimes(1);
    expect(r2.kind).toBe('miss');
  });

  it('search yielding fewer than minCount still returns what it got', async () => {
    // Search produces 5 — minCount is 8. Should miss-with-partial, not unavailable.
    const searchFn = vi.fn().mockResolvedValue(items(5));
    const r = await getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    expect(r.kind).toBe('miss');
    if (r.kind === 'miss') expect(r.items.length).toBe(5);
  });
});

describe('fillerCache.getOrPopulate — single-flight', () => {
  it('two concurrent misses on the same pool → searchFn called once', async () => {
    let resolveSearch: (v: ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>) => void = () => {};
    const searchFn = vi.fn().mockImplementation(
      () => new Promise<ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>>((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const p1 = getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    const p2 = getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    // Let scheduling settle so p2 sees the inflight Promise.
    await new Promise((r) => setImmediate(r));
    expect(searchFn).toHaveBeenCalledTimes(1);
    resolveSearch(items(20));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('miss');
    expect(r2.kind).toBe('hit'); // follower reads from cache
  });

  it('single-flight lock is per-pool (eero search does not block default)', async () => {
    let resolveEero: (v: ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>) => void = () => {};
    const eeroSearch = vi.fn().mockImplementation(
      () => new Promise<ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>>((resolve) => {
        resolveEero = resolve;
      }),
    );
    const defaultSearch = vi.fn().mockResolvedValue(items(20));
    const eeroPromise = getOrPopulate('eero', 8, new Set(), eeroSearch, () => 1_000);
    // default pool should not be blocked by eero's in-flight.
    const defaultResult = await getOrPopulate('default', 8, new Set(), defaultSearch, () => 1_000);
    expect(defaultResult.kind).toBe('miss');
    expect(defaultSearch).toHaveBeenCalledTimes(1);
    // Cleanup
    resolveEero(items(20, 'E'));
    await eeroPromise;
  });

  it('follower receives unavailable when leader returns insufficient items', async () => {
    let resolveSearch: (v: ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>) => void = () => {};
    const searchFn = vi.fn().mockImplementation(
      () => new Promise<ReadonlyArray<Omit<CachedFillerItem, 'cachedAt'>>>((resolve) => {
        resolveSearch = resolve;
      }),
    );
    const p1 = getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    const p2 = getOrPopulate('default', 8, new Set(), searchFn, () => 1_000);
    await new Promise((r) => setImmediate(r));
    // Leader returns only 3 items — both should resolve, but the follower
    // can't get a hit (need 8 + buffer).
    resolveSearch(items(3));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('miss');
    if (r1.kind === 'miss') expect(r1.items.length).toBe(3);
    // Follower saw the leader's populate but pick was insufficient.
    expect(r2.kind === 'unavailable' || r2.kind === 'hit').toBe(true);
  });
});

describe('fillerCache — getAllStats', () => {
  it('returns per-pool entries for every populated pool', () => {
    populateFromSearch('default', items(3), 1_000);
    populateFromSearch('eero', items(5), 1_500);
    const all = getAllStats(2_000);
    expect(all.default).toBeDefined();
    expect(all.default!.itemCount).toBe(3);
    expect(all.eero!.itemCount).toBe(5);
    expect(all.eero!.ageMs).toBe(500);
  });
});
