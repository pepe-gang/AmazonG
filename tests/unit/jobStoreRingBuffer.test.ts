import { describe, expect, it } from 'vitest';
import { pickIdsToEvict } from '@main/jobStoreRingBuffer';

function seed(count: number): Record<string, { createdAt: string }> {
  // createdAt strings built so lexicographic sort matches numeric order
  // (matches real ISO-8601 "YYYY-MM-DDTHH:MM:SS.sssZ" ordering).
  const out: Record<string, { createdAt: string }> = {};
  for (let i = 0; i < count; i++) {
    const id = `a${String(i).padStart(4, '0')}`;
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    out[id] = { createdAt: ts };
  }
  return out;
}

describe('pickIdsToEvict', () => {
  it('returns nothing when below cap', () => {
    expect(pickIdsToEvict(seed(3), 10)).toEqual([]);
  });

  it('returns nothing when exactly at cap', () => {
    expect(pickIdsToEvict(seed(10), 10)).toEqual([]);
  });

  it('evicts one oldest when size is cap+1', () => {
    const attempts = seed(11);
    const evicted = pickIdsToEvict(attempts, 10);
    expect(evicted).toEqual(['a0000']);
  });

  it('evicts N-cap oldest rows when above cap', () => {
    const attempts = seed(15);
    const evicted = pickIdsToEvict(attempts, 10);
    expect(evicted).toHaveLength(5);
    expect(evicted).toEqual(['a0000', 'a0001', 'a0002', 'a0003', 'a0004']);
  });

  it('orders by createdAt, not by insertion order', () => {
    // Insert newest first; pickIdsToEvict should still pick the oldest.
    const attempts: Record<string, { createdAt: string }> = {
      newest: { createdAt: '2026-04-22T00:00:00.000Z' },
      middle: { createdAt: '2026-04-21T00:00:00.000Z' },
      oldest: { createdAt: '2026-04-20T00:00:00.000Z' },
    };
    expect(pickIdsToEvict(attempts, 1)).toEqual(['oldest', 'middle']);
  });

  it('handles cap of 0 (evict everything)', () => {
    const attempts = seed(3);
    expect(pickIdsToEvict(attempts, 0)).toEqual(['a0000', 'a0001', 'a0002']);
  });

  it('empty map is a no-op', () => {
    expect(pickIdsToEvict({}, 10)).toEqual([]);
  });

  it('stable on duplicate timestamps (deterministic order by key)', () => {
    // Two rows with same createdAt — sort is stable, so input order wins.
    // Test just confirms we evict the right count and don't crash.
    const attempts: Record<string, { createdAt: string }> = {
      a: { createdAt: '2026-04-20T00:00:00.000Z' },
      b: { createdAt: '2026-04-20T00:00:00.000Z' },
      c: { createdAt: '2026-04-21T00:00:00.000Z' },
    };
    const evicted = pickIdsToEvict(attempts, 1);
    expect(evicted).toHaveLength(2);
    // 'c' is newest — must not be evicted
    expect(evicted).not.toContain('c');
  });
});
