import type { JobAttempt } from './types.js';

/**
 * Parse a formatted price string like "$399.99", "USD 399.99", or
 * "$1,299.95" into a number. Returns null for anything that doesn't
 * parse cleanly.
 */
export function parseCost(cost: string | null): number | null {
  if (!cost) return null;
  const cleaned = cost.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Effective retail price for a row: the actual Amazon /spc price we
 * captured at buy time (`cost`) when available, otherwise BG's retail
 * cap (`maxPrice`) as a fallback. Legacy rows placed before we started
 * capturing `cost` have no /spc price on file — falling back to BG's
 * cap is close enough for the Profit calc and avoids leaving the
 * column blank on every old row.
 */
export function retailPrice(a: JobAttempt): number | null {
  const actual = parseCost(a.cost);
  if (actual !== null) return actual;
  return typeof a.maxPrice === 'number' && a.maxPrice > 0 ? a.maxPrice : null;
}

/**
 * Per-row profit: BG pays us `payout` per unit, we pay Amazon `retail`,
 * and Amazon refunds `cashbackPct` of retail. So per unit:
 *   profit = payout - retail × (1 - cashback%)
 * Multiplied by quantity (units we ordered).
 *
 * Shown for any row where the buy successfully placed (orderId on
 * file) — `awaiting_verification`, `pending_tracking`, `verified`,
 * `completed`. Projected, not realized: if Amazon later cancels or
 * the user returns the item, the actual P&L differs. Matches BG's
 * dashboard which shows projected profit as soon as the buy places.
 *
 * Excluded: queued / in_progress (buy not placed yet) /
 * failed / cancelled / action_required (no successful placement).
 */
const PROFIT_ELIGIBLE_STATUSES = new Set<JobAttempt['status']>([
  'awaiting_verification',
  'verified',
  'completed',
]);

export function computeProfit(a: JobAttempt): number | null {
  if (!PROFIT_ELIGIBLE_STATUSES.has(a.status)) return null;
  const retail = retailPrice(a);
  const payout = typeof a.price === 'number' ? a.price : null;
  const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : null;
  const cb = typeof a.cashbackPct === 'number' ? a.cashbackPct : null;
  if (retail === null || payout === null || qty === null || cb === null) return null;
  const perUnit = payout - retail * (1 - cb / 100);
  return perUnit * qty;
}
