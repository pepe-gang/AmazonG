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
 * Only computes for verified ("Success") orders — that's the one status
 * where we know:
 *   - the buy actually placed (vs queued / in_progress / failed)
 *   - Amazon didn't auto-cancel (vs awaiting_verification / cancelled)
 *   - real money moved (vs dry_run_success)
 * For every other status the cell shows "—" so we don't pretend to know
 * profit for a row whose outcome isn't final.
 */
export function computeProfit(a: JobAttempt): number | null {
  // Both 'verified' (AmazonG-local terminology after the verify-phase
  // pass succeeds) and 'completed' (BG's terminology for the same final
  // state, persisted on AutoBuyPurchase.status and what comes back via
  // listMergedAttempts) count as the success terminal. The two
  // vocabularies exist for historical reasons; until the BG-side enum
  // is unified to AmazonG's, treat both as Success here so server-merged
  // rows aren't silently excluded from profit totals.
  if (a.status !== 'verified' && a.status !== 'completed') return null;
  const retail = retailPrice(a);
  const payout = typeof a.price === 'number' ? a.price : null;
  const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : null;
  const cb = typeof a.cashbackPct === 'number' ? a.cashbackPct : null;
  if (retail === null || payout === null || qty === null || cb === null) return null;
  const perUnit = payout - retail * (1 - cb / 100);
  return perUnit * qty;
}
