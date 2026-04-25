import { describe, expect, it } from 'vitest';
import { computeProfit, parseCost, retailPrice } from '@shared/profit';
import type { JobAttempt, JobAttemptStatus } from '@shared/types';

function attempt(overrides: Partial<JobAttempt> = {}): JobAttempt {
  return {
    attemptId: 'job-1__user@example.com',
    jobId: 'job-1',
    amazonEmail: 'user@example.com',
    phase: 'buy',
    dealKey: 'DEAL',
    dealId: 'DL-01',
    dealTitle: 'Test item',
    productUrl: 'https://amazon.com/dp/TEST',
    maxPrice: 100,
    price: 110, // BG payout per unit
    quantity: 1,
    cost: '$95.00',
    cashbackPct: 6,
    orderId: '111-1234567-1234567',
    status: 'verified' as JobAttemptStatus,
    error: null,
    buyMode: 'single',
    dryRun: false,
    trackingIds: null,
    fillerOrderIds: null,
    productTitle: null,
    stage: null,
    createdAt: '2026-04-22T00:00:00.000Z',
    updatedAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseCost', () => {
  it('parses plain dollars', () => {
    expect(parseCost('$12.99')).toBe(12.99);
  });
  it('parses commas', () => {
    expect(parseCost('$1,299.00')).toBe(1299);
  });
  it('parses currency prefix', () => {
    expect(parseCost('USD 399.99')).toBe(399.99);
  });
  it('returns null for empty', () => {
    expect(parseCost(null)).toBeNull();
    expect(parseCost('')).toBeNull();
  });
  it('returns null for non-numeric', () => {
    expect(parseCost('free')).toBeNull();
  });
  it('returns null for zero', () => {
    // parseCost filters out 0 and negatives (> 0 guard)
    expect(parseCost('$0.00')).toBeNull();
  });
});

describe('retailPrice', () => {
  it('prefers parsed cost over maxPrice', () => {
    expect(retailPrice(attempt({ cost: '$95.00', maxPrice: 100 }))).toBe(95);
  });
  it('falls back to maxPrice when cost unparseable', () => {
    expect(retailPrice(attempt({ cost: null, maxPrice: 100 }))).toBe(100);
  });
  it('falls back to maxPrice when cost is non-numeric', () => {
    expect(retailPrice(attempt({ cost: 'free', maxPrice: 100 }))).toBe(100);
  });
  it('returns null when both cost and maxPrice are unset', () => {
    expect(retailPrice(attempt({ cost: null, maxPrice: null }))).toBeNull();
  });
  it('returns null when cost unparseable and maxPrice is 0', () => {
    expect(retailPrice(attempt({ cost: null, maxPrice: 0 }))).toBeNull();
  });
});

describe('computeProfit', () => {
  it('computes per-unit profit with cashback', () => {
    // payout $110, retail $100, 5% cashback, qty 1
    // profit = 110 - 100 * (1 - 0.05) = 110 - 95 = $15
    const p = computeProfit(
      attempt({ price: 110, cost: '$100.00', cashbackPct: 5, quantity: 1 }),
    );
    expect(p).toBeCloseTo(15, 10);
  });

  it('multiplies by quantity', () => {
    const p = computeProfit(
      attempt({ price: 110, cost: '$100.00', cashbackPct: 5, quantity: 3 }),
    );
    expect(p).toBeCloseTo(45, 10);
  });

  it('handles zero cashback', () => {
    // payout $110, retail $100, 0% cashback → profit = 110 - 100 = $10
    const p = computeProfit(
      attempt({ price: 110, cost: '$100.00', cashbackPct: 0, quantity: 1 }),
    );
    expect(p).toBeCloseTo(10, 10);
  });

  it('handles negative profit (paid more than payout)', () => {
    // payout $90, retail $100, 0% cashback → profit = 90 - 100 = -$10
    const p = computeProfit(
      attempt({ price: 90, cost: '$100.00', cashbackPct: 0, quantity: 1 }),
    );
    expect(p).toBeCloseTo(-10, 10);
  });

  it('uses maxPrice fallback when cost is null', () => {
    const p = computeProfit(
      attempt({ price: 110, cost: null, maxPrice: 100, cashbackPct: 5, quantity: 1 }),
    );
    expect(p).toBeCloseTo(15, 10);
  });

  it.each<JobAttemptStatus>([
    'queued',
    'in_progress',
    'awaiting_verification',
    'cancelled_by_amazon',
    'failed',
    'dry_run_success',
  ])('returns null for status=%s (non-success terminal)', (status) => {
    expect(computeProfit(attempt({ status }))).toBeNull();
  });

  it('counts profit for status=completed (BG terminology — same final state as verified)', () => {
    // BG persists the post-verify success terminal as 'completed', and
    // listMergedAttempts lets server status win on the merge. Without
    // this, every server-merged success row would be silently excluded
    // from the all-time profit total.
    const p = computeProfit(
      attempt({ status: 'completed', price: 110, cost: '$100.00', cashbackPct: 5, quantity: 1 }),
    );
    expect(p).toBeCloseTo(15, 10);
  });

  it('returns null when payout (price) is missing', () => {
    expect(computeProfit(attempt({ price: null }))).toBeNull();
  });

  it('returns null when cashbackPct is missing', () => {
    expect(computeProfit(attempt({ cashbackPct: null }))).toBeNull();
  });

  it('returns null when quantity is 0', () => {
    expect(computeProfit(attempt({ quantity: 0 }))).toBeNull();
  });

  it('returns null when quantity is null', () => {
    expect(computeProfit(attempt({ quantity: null }))).toBeNull();
  });

  it('returns null when neither cost nor maxPrice is usable', () => {
    expect(
      computeProfit(attempt({ cost: null, maxPrice: null })),
    ).toBeNull();
  });
});
