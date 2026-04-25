import { describe, expect, it } from 'vitest';
import type { AmazonDeal } from '../../src/shared/ipc.js';
import type { JobAttempt } from '../../src/shared/types.js';
import {
  clampInterval,
  clampMaxPerTick,
  isDealActive,
  marginPct,
  passesShipTo,
  selectDealsForTick,
} from '../../src/main/autoEnqueueScheduler.js';

/** Minimal AmazonDeal factory. Only the fields the scheduler reads need
 *  defaults; tests override per-case. Keeps each `it` block focused on
 *  the one or two fields the assertion is actually about. */
function deal(overrides: Partial<AmazonDeal> = {}): AmazonDeal {
  return {
    dealId: 'DL-00000001',
    dealKey: 'k1',
    dealTitle: 'Test deal',
    price: '100.00',
    oldPrice: '110.00',
    expiryDay: null,
    upc: null,
    shipToStates: [],
    imageUrl: null,
    dealCreatedAt: '2024-01-01T00:00:00.000Z',
    discoveredAt: '2024-01-01T00:00:00.000Z',
    amazonLink: 'https://amazon.com/dp/B000',
    ...overrides,
  };
}

/** Minimal attempt projection — selectDealsForTick only reads
 *  phase/dealKey/createdAt, so the rest of JobAttempt is irrelevant. */
function attempt(
  overrides: Partial<Pick<JobAttempt, 'phase' | 'dealKey' | 'createdAt'>> = {},
): Pick<JobAttempt, 'phase' | 'dealKey' | 'createdAt'> {
  return {
    phase: 'buy',
    dealKey: 'k1',
    createdAt: new Date('2024-06-15T12:00:00').toISOString(),
    ...overrides,
  };
}

const REF_NOW = new Date('2024-06-15T12:00:00.000Z').getTime();

describe('marginPct', () => {
  it('computes a negative margin for a typical loss-leader deal', () => {
    // payout 100, retail 110 → -9.09%
    expect(marginPct({ price: '100.00', oldPrice: '110.00' })).toBeCloseTo(-9.0909, 3);
  });

  it('computes a positive margin when payout exceeds retail', () => {
    expect(marginPct({ price: '120.00', oldPrice: '100.00' })).toBeCloseTo(20, 5);
  });

  it('returns 0 when retail is missing (BG convention: payout==retail)', () => {
    expect(marginPct({ price: '50.00', oldPrice: null })).toBe(0);
  });

  it('returns 0 when retail is the empty string', () => {
    expect(marginPct({ price: '50.00', oldPrice: '' })).toBe(0);
  });

  it('returns 0 when retail is zero (avoids divide-by-zero / Infinity)', () => {
    expect(marginPct({ price: '50.00', oldPrice: '0' })).toBe(0);
  });

  it('returns null when payout is missing — no anchor for the comparison', () => {
    // Empty string is the realistic "missing" wire shape (BG may
    // serialize a missing decimal that way); parseDecimal funnels it
    // to null, so margin can't be computed.
    expect(marginPct({ price: '', oldPrice: '100.00' })).toBeNull();
  });

  it('returns null when payout is unparseable', () => {
    expect(marginPct({ price: 'not-a-number', oldPrice: '100.00' })).toBeNull();
  });

  it('returns 0 at break-even', () => {
    expect(marginPct({ price: '100.00', oldPrice: '100.00' })).toBe(0);
  });
});

describe('isDealActive', () => {
  // Anchor "now" inside the day so today's expiry hasn't yet hit
  // 23:59:59 — matches how a tick fires at, say, noon.
  const noon = new Date(2024, 5, 15, 12, 0, 0); // 2024-06-15 local 12:00

  it('treats null expiry as always active', () => {
    expect(isDealActive({ expiryDay: null }, noon)).toBe(true);
  });

  it('keeps a deal expiring later today active until end-of-day', () => {
    expect(isDealActive({ expiryDay: '06-15-2024' }, noon)).toBe(true);
  });

  it('keeps a deal expiring tomorrow active', () => {
    expect(isDealActive({ expiryDay: '06-16-2024' }, noon)).toBe(true);
  });

  it('drops a deal that expired yesterday', () => {
    expect(isDealActive({ expiryDay: '06-14-2024' }, noon)).toBe(false);
  });

  it('keeps malformed expiry strings (lenient — let BG reject server-side)', () => {
    expect(isDealActive({ expiryDay: 'not-a-date' }, noon)).toBe(true);
    expect(isDealActive({ expiryDay: '13-99-9999' }, noon)).toBe(true);
    expect(isDealActive({ expiryDay: '' }, noon)).toBe(true);
  });
});

describe('passesShipTo', () => {
  it("'all' always passes regardless of states", () => {
    expect(passesShipTo({ shipToStates: ['oregon'] }, 'all')).toBe(true);
    expect(passesShipTo({ shipToStates: [] }, 'all')).toBe(true);
  });

  it("empty shipToStates means 'ships anywhere' and always passes", () => {
    expect(passesShipTo({ shipToStates: [] }, 'oregon')).toBe(true);
  });

  it('passes when the filter is in the state list', () => {
    expect(passesShipTo({ shipToStates: ['oregon', 'florida'] }, 'oregon')).toBe(true);
  });

  it('fails when the filter is not in the state list', () => {
    expect(passesShipTo({ shipToStates: ['florida', 'texas'] }, 'oregon')).toBe(false);
  });

  it('matches case-insensitively in both directions', () => {
    expect(passesShipTo({ shipToStates: ['OREGON'] }, 'oregon')).toBe(true);
    expect(passesShipTo({ shipToStates: ['oregon'] }, 'OREGON')).toBe(true);
  });
});

describe('clampInterval', () => {
  it('passes valid hour values straight through', () => {
    expect(clampInterval(24)).toBe(24);
    expect(clampInterval(1)).toBe(1);
    expect(clampInterval(168)).toBe(168);
  });

  it('clamps below the lower bound (1h)', () => {
    expect(clampInterval(0)).toBe(1);
    expect(clampInterval(-5)).toBe(1);
  });

  it('clamps above the upper bound (168h = 1 week)', () => {
    expect(clampInterval(200)).toBe(168);
    expect(clampInterval(99999)).toBe(168);
  });

  it('falls back to 24 for NaN / Infinity', () => {
    expect(clampInterval(NaN)).toBe(24);
    expect(clampInterval(Infinity)).toBe(24);
    expect(clampInterval(-Infinity)).toBe(24);
  });

  it('floors fractional values', () => {
    expect(clampInterval(2.9)).toBe(2);
  });
});

describe('clampMaxPerTick', () => {
  it('passes valid values straight through', () => {
    expect(clampMaxPerTick(25)).toBe(25);
    expect(clampMaxPerTick(1)).toBe(1);
    expect(clampMaxPerTick(1000)).toBe(1000);
  });

  it('clamps to [1, 1000]', () => {
    expect(clampMaxPerTick(0)).toBe(1);
    expect(clampMaxPerTick(-10)).toBe(1);
    expect(clampMaxPerTick(5000)).toBe(1000);
  });

  it('falls back to 25 for NaN', () => {
    expect(clampMaxPerTick(NaN)).toBe(25);
  });
});

describe('selectDealsForTick — eligibility filters', () => {
  // Margin floor relaxed to -100 so these tests aren't accidentally
  // gated by the default deal's -9% margin — the focus here is the
  // active / ship-to checks, not the margin filter.
  function baseInput() {
    return {
      attempts: [],
      shipToFilter: 'oregon',
      minMarginPct: -100,
      intervalHours: 24,
      maxPerTick: 25,
      now: REF_NOW,
    };
  }

  it('drops expired deals', () => {
    const ok = deal({
      dealKey: 'fresh',
      // REF_NOW is 2024-06-15; pick a future date.
      expiryDay: '12-31-2099',
      shipToStates: ['oregon'],
    });
    const expired = deal({
      dealKey: 'expired',
      expiryDay: '01-01-2020',
      shipToStates: ['oregon'],
    });
    const out = selectDealsForTick({ ...baseInput(), deals: [ok, expired] });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['fresh']);
    expect(out.skippedDup).toBe(0);
    expect(out.skippedCap).toBe(0);
  });

  it('drops deals that do not match the ship-to filter', () => {
    const okState = deal({ dealKey: 'or', shipToStates: ['oregon'] });
    const wrongState = deal({ dealKey: 'fl', shipToStates: ['florida'] });
    const out = selectDealsForTick({ ...baseInput(), deals: [okState, wrongState] });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['or']);
  });

  it("'all' filter keeps every state", () => {
    const a = deal({ dealKey: 'or', shipToStates: ['oregon'] });
    const b = deal({ dealKey: 'fl', shipToStates: ['florida'] });
    const c = deal({ dealKey: 'any', shipToStates: [] });
    const out = selectDealsForTick({
      ...baseInput(),
      shipToFilter: 'all',
      deals: [a, b, c],
    });
    expect(out.todo.map((d) => d.dealKey).sort()).toEqual(['any', 'fl', 'or']);
  });

  it('treats empty shipToStates as "ships anywhere"', () => {
    const anywhere = deal({ dealKey: 'any', shipToStates: [] });
    const out = selectDealsForTick({ ...baseInput(), deals: [anywhere] });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['any']);
  });
});

describe('selectDealsForTick — margin filter', () => {
  // Default ship-to is omitted so margin is the only knob in play.
  function baseInput() {
    return {
      attempts: [],
      shipToFilter: 'all',
      intervalHours: 24,
      maxPerTick: 25,
      now: REF_NOW,
    };
  }

  it('passes a deal whose margin equals the floor exactly (>= is inclusive)', () => {
    // payout 96.50, retail 100.00 → margin = -3.5%
    const onTheLine = deal({
      dealKey: 'edge',
      price: '96.50',
      oldPrice: '100.00',
    });
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: -3.5,
      deals: [onTheLine],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('rejects a deal whose margin is just below the floor', () => {
    // payout 96.49, retail 100.00 → margin ≈ -3.51% < -3.5%
    const justBelow = deal({
      dealKey: 'below',
      price: '96.49',
      oldPrice: '100.00',
    });
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: -3.5,
      deals: [justBelow],
    });
    expect(out.todo).toHaveLength(0);
  });

  it('passes deals well above the floor regardless of sign', () => {
    const profitable = deal({
      dealKey: 'win',
      price: '120',
      oldPrice: '100',
    });
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: -3.5,
      deals: [profitable],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('drops deals where margin is uncomputable (no payout)', () => {
    const noPayout = deal({ dealKey: 'meh', price: '' });
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: -100,
      deals: [noPayout],
    });
    // Even with the floor at -100, a null margin can't be compared so
    // we drop the deal rather than enqueue something we can't evaluate.
    expect(out.todo).toHaveLength(0);
  });

  it('a -100 floor effectively disables the filter for any computable deal', () => {
    const veryNegative = deal({
      dealKey: 'bad',
      price: '50',
      oldPrice: '100',
    }); // -50% margin
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: -100,
      deals: [veryNegative],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('a 0% floor only keeps break-even or profitable deals', () => {
    const lossDeal = deal({
      dealKey: 'loss',
      price: '90',
      oldPrice: '100',
    });
    const breakEven = deal({
      dealKey: 'even',
      price: '100',
      oldPrice: '100',
    });
    const out = selectDealsForTick({
      ...baseInput(),
      minMarginPct: 0,
      deals: [lossDeal, breakEven],
    });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['even']);
  });
});

describe('selectDealsForTick — dedup window', () => {
  function baseInput() {
    return {
      shipToFilter: 'all',
      minMarginPct: -100,
      maxPerTick: 25,
      now: REF_NOW,
    };
  }

  it('skips a deal with a recent buy attempt within the dedup window', () => {
    const d = deal({ dealKey: 'rebuyme' });
    const recent = attempt({
      phase: 'buy',
      dealKey: 'rebuyme',
      createdAt: new Date(REF_NOW - 2 * 3_600_000).toISOString(), // 2h ago
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 24,
      deals: [d],
      attempts: [recent],
    });
    expect(out.todo).toHaveLength(0);
    expect(out.skippedDup).toBe(1);
  });

  it('lets a deal through when the only matching attempt is older than the window', () => {
    const d = deal({ dealKey: 'staleok' });
    const old = attempt({
      phase: 'buy',
      dealKey: 'staleok',
      createdAt: new Date(REF_NOW - 48 * 3_600_000).toISOString(), // 48h ago
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 24,
      deals: [d],
      attempts: [old],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('enforces a 24h minimum dedup window even when intervalHours is shorter', () => {
    // intervalHours=1 with NO floor would give a 1h dedup window —
    // a deal bought 5 hours ago would re-enqueue. The 24h floor
    // prevents this.
    const d = deal({ dealKey: 'shortcycle' });
    const fiveHoursAgo = attempt({
      phase: 'buy',
      dealKey: 'shortcycle',
      createdAt: new Date(REF_NOW - 5 * 3_600_000).toISOString(),
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 1,
      deals: [d],
      attempts: [fiveHoursAgo],
    });
    expect(out.todo).toHaveLength(0);
    expect(out.skippedDup).toBe(1);
  });

  it('expands the dedup window beyond 24h when intervalHours is longer', () => {
    // 72h schedule + a 48h-old buy attempt → still dedup.
    const d = deal({ dealKey: 'longcycle' });
    const fortyEightHoursAgo = attempt({
      phase: 'buy',
      dealKey: 'longcycle',
      createdAt: new Date(REF_NOW - 48 * 3_600_000).toISOString(),
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 72,
      deals: [d],
      attempts: [fortyEightHoursAgo],
    });
    expect(out.todo).toHaveLength(0);
  });

  it('ignores non-buy phase attempts (verify/fetch_tracking are not buy events)', () => {
    const d = deal({ dealKey: 'verifyok' });
    const verifyOnly = attempt({
      phase: 'verify',
      dealKey: 'verifyok',
      createdAt: new Date(REF_NOW - 1 * 3_600_000).toISOString(),
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 24,
      deals: [d],
      attempts: [verifyOnly],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('ignores attempts with null dealKey', () => {
    const d = deal({ dealKey: 'k' });
    const noKey = attempt({
      phase: 'buy',
      dealKey: null,
      createdAt: new Date(REF_NOW).toISOString(),
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 24,
      deals: [d],
      attempts: [noKey],
    });
    expect(out.todo).toHaveLength(1);
  });

  it('ignores attempts with unparseable createdAt', () => {
    const d = deal({ dealKey: 'k' });
    const garbage = attempt({
      phase: 'buy',
      dealKey: 'k',
      createdAt: 'not-a-timestamp',
    });
    const out = selectDealsForTick({
      ...baseInput(),
      intervalHours: 24,
      deals: [d],
      attempts: [garbage],
    });
    expect(out.todo).toHaveLength(1);
  });
});

describe('selectDealsForTick — cap', () => {
  function baseInput() {
    return {
      attempts: [],
      shipToFilter: 'all',
      minMarginPct: -100,
      intervalHours: 24,
      now: REF_NOW,
    };
  }

  it('takes the first N when more eligible deals exist', () => {
    const deals = Array.from({ length: 5 }, (_, i) =>
      deal({ dealKey: `k${i}`, dealId: `DL-${i}` }),
    );
    const out = selectDealsForTick({ ...baseInput(), maxPerTick: 3, deals });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['k0', 'k1', 'k2']);
    expect(out.skippedCap).toBe(2);
    expect(out.skippedDup).toBe(0);
  });

  it('does not count anything as skippedCap when survivors fit under the cap', () => {
    const deals = [deal({ dealKey: 'a' }), deal({ dealKey: 'b' })];
    const out = selectDealsForTick({ ...baseInput(), maxPerTick: 25, deals });
    expect(out.todo).toHaveLength(2);
    expect(out.skippedCap).toBe(0);
  });

  it('counts dedup skips and cap skips separately', () => {
    // 4 eligible deals; one is dedup-skipped, cap is 2 → 2 queued, 1 skippedDup, 1 skippedCap.
    const deals = [
      deal({ dealKey: 'dup' }),
      deal({ dealKey: 'a' }),
      deal({ dealKey: 'b' }),
      deal({ dealKey: 'c' }),
    ];
    const recent = attempt({
      phase: 'buy',
      dealKey: 'dup',
      createdAt: new Date(REF_NOW - 1 * 3_600_000).toISOString(),
    });
    const out = selectDealsForTick({
      ...baseInput(),
      maxPerTick: 2,
      deals,
      attempts: [recent],
    });
    expect(out.todo.map((d) => d.dealKey)).toEqual(['a', 'b']);
    expect(out.skippedDup).toBe(1);
    expect(out.skippedCap).toBe(1);
  });

  it('clamps an out-of-bounds maxPerTick before applying it', () => {
    // maxPerTick = 0 should clamp up to 1 (per clampMaxPerTick), so
    // exactly one deal goes through and the rest count as skippedCap.
    const deals = [deal({ dealKey: 'a' }), deal({ dealKey: 'b' })];
    const out = selectDealsForTick({ ...baseInput(), maxPerTick: 0, deals });
    expect(out.todo).toHaveLength(1);
    expect(out.skippedCap).toBe(1);
  });
});

describe('selectDealsForTick — combined pipeline', () => {
  it('applies active → ship-to → margin → dedup → cap in that order', () => {
    const expired = deal({
      dealKey: 'expired',
      expiryDay: '01-01-2020',
      shipToStates: ['oregon'],
      price: '100',
      oldPrice: '100',
    });
    const wrongState = deal({
      dealKey: 'flonly',
      shipToStates: ['florida'],
      price: '100',
      oldPrice: '100',
    });
    const tooLow = deal({
      dealKey: 'tooLow',
      shipToStates: ['oregon'],
      price: '50', // -50% margin, below -3.5 floor
      oldPrice: '100',
    });
    const recentDup = deal({
      dealKey: 'dup',
      shipToStates: ['oregon'],
      price: '100',
      oldPrice: '100',
    });
    const goodA = deal({
      dealKey: 'a',
      dealId: 'DL-A',
      shipToStates: ['oregon'],
      price: '100',
      oldPrice: '100',
    });
    const goodB = deal({
      dealKey: 'b',
      dealId: 'DL-B',
      shipToStates: [],
      price: '120',
      oldPrice: '100',
    });
    const goodC = deal({
      dealKey: 'c',
      dealId: 'DL-C',
      shipToStates: ['oregon'],
      price: '99',
      oldPrice: '100',
    });

    const out = selectDealsForTick({
      deals: [expired, wrongState, tooLow, recentDup, goodA, goodB, goodC],
      attempts: [
        attempt({
          phase: 'buy',
          dealKey: 'dup',
          createdAt: new Date(REF_NOW - 3_600_000).toISOString(),
        }),
      ],
      shipToFilter: 'oregon',
      minMarginPct: -3.5,
      intervalHours: 24,
      maxPerTick: 2,
      now: REF_NOW,
    });

    // Survivors after eligibility (active + ship-to + margin):
    //   recentDup, a, b, c. expired/wrongState/tooLow dropped silently.
    // After dedup: a, b, c. recentDup matches a recent buy attempt → +1 skippedDup.
    // After cap=2: a, b → +1 skippedCap (c).
    expect(out.todo.map((d) => d.dealKey)).toEqual(['a', 'b']);
    expect(out.skippedDup).toBe(1);
    expect(out.skippedCap).toBe(1);
  });
});
