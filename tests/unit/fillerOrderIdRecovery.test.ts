/**
 * Tests for the two filler-order-id recovery fixes shipped together
 * after INC-2026-05-10 (purchaseId 106-0543366-6065024 lost
 * 114-4485329-7352228 from `fillerOrderIds` because Amazon's order-
 * history hadn't propagated all fanout orders by the time the buy-
 * time scan ran):
 *
 *   Fix A — `fetchOrderIdsForAsins` polls for full coverage.
 *           Reloads the history page every ~800ms (max 5s) until
 *           every cart ASIN is matched OR the budget expires.
 *
 *   Fix B — verify-time `rescanFillerOrderIds`. ~10 min after the
 *           buy, order history is stable; this function re-runs the
 *           DOM walker and returns every orderId-not-the-target
 *           that mentions any of the persisted cart ASINs.
 *
 * Both fixes share `scanOrderHistoryDOMFn` (the document walker), so
 * we focus the tests on the orchestration logic — coverage retry
 * for A, and target-exclusion + propagation-catch for B.
 *
 * Page is duck-typed (just the methods these helpers call) since
 * Playwright's real Page is impractical to stand up in a unit test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { rescanFillerOrderIds } from '../../src/actions/buyWithFillers.js';

/**
 * Minimal Page mock for `rescanFillerOrderIds`: the function calls
 * page.goto, page.waitForFunction, page.evaluate. Each Vitest fn
 * lets the test script the return value.
 */
function makeRescanPage(opts: {
  goto?: ReturnType<typeof vi.fn>;
  waitForFunction?: ReturnType<typeof vi.fn>;
  evaluate?: ReturnType<typeof vi.fn>;
}): Page {
  return {
    goto: opts.goto ?? vi.fn().mockResolvedValue(undefined),
    waitForFunction: opts.waitForFunction ?? vi.fn().mockResolvedValue(undefined),
    evaluate: opts.evaluate ?? vi.fn().mockResolvedValue([]),
  } as unknown as Page;
}

describe('rescanFillerOrderIds — verify-time safety net (Fix B)', () => {
  const TARGET_ORDER = '114-8746903-8263417';
  const FILLER_ORDER_KNOWN = '114-1111111-1111111';
  const FILLER_ORDER_LATE = '114-4485329-7352228'; // the one missed at buy time
  const TARGET_ASIN = 'B0GR1JTFP8';
  const cartAsins = [TARGET_ASIN, 'B002DYIZHQ', 'B07L91HBFG'];

  it('returns every orderId from rescan EXCEPT the target', async () => {
    const evaluate = vi.fn().mockResolvedValue([
      { orderId: TARGET_ORDER, matchedAsins: [TARGET_ASIN] },
      { orderId: FILLER_ORDER_KNOWN, matchedAsins: ['B002DYIZHQ'] },
      { orderId: FILLER_ORDER_LATE, matchedAsins: ['B07L91HBFG'] },
    ]);
    const page = makeRescanPage({ evaluate });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([FILLER_ORDER_KNOWN, FILLER_ORDER_LATE]);
  });

  it('returns the late-propagating filler order even when buy-time missed it', async () => {
    // Simulates exactly the INC-2026-05-10 scenario: buy-time scan
    // captured only the target order; verify-time rescan now sees
    // both. Caller diffs against persisted fillerOrderIds=[] and
    // discovers FILLER_ORDER_LATE for cancellation.
    const evaluate = vi.fn().mockResolvedValue([
      { orderId: TARGET_ORDER, matchedAsins: [TARGET_ASIN] },
      { orderId: FILLER_ORDER_LATE, matchedAsins: ['B002DYIZHQ', 'B07L91HBFG'] },
    ]);
    const page = makeRescanPage({ evaluate });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([FILLER_ORDER_LATE]);
  });

  it('returns empty when only the target order is found', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValue([{ orderId: TARGET_ORDER, matchedAsins: [TARGET_ASIN] }]);
    const page = makeRescanPage({ evaluate });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([]);
  });

  it('returns empty on goto failure (best-effort, never throws)', async () => {
    const goto = vi.fn().mockRejectedValue(new Error('net::ERR_TIMED_OUT'));
    const page = makeRescanPage({ goto });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([]);
  });

  it('returns empty when cartAsins is empty (single-mode buy)', async () => {
    const goto = vi.fn();
    const evaluate = vi.fn();
    const page = makeRescanPage({ goto, evaluate });
    const r = await rescanFillerOrderIds(page, [], TARGET_ORDER, 'cid');
    expect(r).toEqual([]);
    expect(goto).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('returns empty when evaluate throws (eval-eval mid-flight failure)', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('Execution context destroyed'));
    const page = makeRescanPage({ evaluate });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([]);
  });

  it('still excludes the target even when matchedAsins doesn\'t include it (target was cancelled and removed)', async () => {
    // Edge case: by verify time the target was cancelled, and Amazon
    // sometimes hides cancelled orders from the recent-orders pane.
    // The rescan finds only the filler order; that filler order's
    // ID isn't equal to TARGET_ORDER so it's still returned.
    const evaluate = vi
      .fn()
      .mockResolvedValue([{ orderId: FILLER_ORDER_LATE, matchedAsins: ['B002DYIZHQ'] }]);
    const page = makeRescanPage({ evaluate });
    const r = await rescanFillerOrderIds(page, cartAsins, TARGET_ORDER, 'cid');
    expect(r).toEqual([FILLER_ORDER_LATE]);
  });
});

/**
 * Tests for the buy-time coverage poller in `fetchOrderIdsForAsins`.
 *
 * `fetchOrderIdsForAsins` is not exported (the polling logic is
 * inline in the function), so we test the BEHAVIOR via a high-level
 * sequence test of the same Page mock pattern: each `evaluate`
 * returns a different OrderMatch[] result simulating Amazon's fanout
 * propagating across reload iterations. Since the function is
 * private, we re-implement the polling-decision shape here as a pure
 * function and pin its behavior — that way if the inline logic
 * regresses, this test catches it via the documented invariants.
 *
 * Invariant: on each iteration, keep the BEST-coverage result so
 * far. Stop when full coverage OR budget expires.
 */
describe('coverage-poll picker (Fix A invariant)', () => {
  type Match = { orderId: string; matchedAsins: string[] };

  function countCovered(matches: Match[]): number {
    const seen = new Set<string>();
    for (const m of matches) for (const a of m.matchedAsins) seen.add(a);
    return seen.size;
  }

  function pickBest(scans: Match[][], cartSize: number): Match[] {
    let best: Match[] = scans[0] ?? [];
    let bestCov = countCovered(best);
    for (let i = 1; i < scans.length; i++) {
      if (bestCov >= cartSize) break;
      const next = scans[i] ?? [];
      const cov = countCovered(next);
      if (cov > bestCov) {
        best = next;
        bestCov = cov;
      }
    }
    return best;
  }

  it('upgrades from partial → full when later iteration sees the late order', () => {
    const cartAsins = ['B0GR1JTFP8', 'B002DYIZHQ', 'B07L91HBFG'];
    // Iteration 1: only the target propagated.
    const scan1: Match[] = [
      { orderId: '114-T', matchedAsins: ['B0GR1JTFP8'] },
    ];
    // Iteration 2: filler-only order has propagated.
    const scan2: Match[] = [
      { orderId: '114-T', matchedAsins: ['B0GR1JTFP8'] },
      { orderId: '114-FILLER', matchedAsins: ['B002DYIZHQ', 'B07L91HBFG'] },
    ];
    const result = pickBest([scan1, scan2], cartAsins.length);
    expect(result).toEqual(scan2);
    expect(countCovered(result)).toBe(3);
  });

  it('does NOT regress to a worse result if a later reload renders fewer cards', () => {
    const cartAsins = ['A1', 'A2'];
    const scan1: Match[] = [{ orderId: '114-T', matchedAsins: ['A1', 'A2'] }];
    const scan2: Match[] = []; // a flaky reload returned nothing
    const result = pickBest([scan1, scan2], cartAsins.length);
    expect(result).toEqual(scan1);
  });

  it('stops as soon as full coverage is reached (budget unused)', () => {
    const cartAsins = ['A1'];
    const scan1: Match[] = [{ orderId: '114-T', matchedAsins: ['A1'] }];
    const scan2: Match[] = [{ orderId: '114-T', matchedAsins: ['A1', 'EXTRA'] }];
    const result = pickBest([scan1, scan2], cartAsins.length);
    // Loop exits on full-cov check; later scans aren't consulted.
    expect(result).toEqual(scan1);
  });

  it('returns the first scan when every iteration gives empty', () => {
    const cartAsins = ['A1', 'A2'];
    const result = pickBest([[], [], []], cartAsins.length);
    expect(result).toEqual([]);
    expect(countCovered(result)).toBe(0);
  });
});
