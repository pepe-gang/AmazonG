import type { ChasePaymentEntry } from './types.js';

/**
 * Format a number as a Chase-style dollar string: leading "$",
 * thousands commas, two decimals. Negative values get a leading "-"
 * BEFORE the "$" — matches Chase's recon-bar rendering convention.
 *
 * Pure function: importable from main, renderer, or tests.
 */
export function formatChaseDollarAmount(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Sum the dollar amounts on a list of ChasePaymentEntry rows and
 * return the displayed total ("$18,050.00"). Negative amounts (rare,
 * but possible on refund rows) are summed with sign preserved —
 * caller decides whether to filter first.
 *
 * Bad / unparsable amounts are silently treated as zero rather than
 * throwing. Empty input returns "$0.00".
 */
export function sumPaymentAmounts(entries: ChasePaymentEntry[]): string {
  const total = entries.reduce((acc, e) => {
    // Strip everything except digits and dot; keep the sign separately.
    // Chase's strings look like "$13,000.00" or "-$50.00".
    const sign = e.amount.trim().startsWith('-') ? -1 : 1;
    const cleaned = e.amount.replace(/[^\d.]/g, '');
    const n = parseFloat(cleaned);
    return acc + (Number.isFinite(n) ? sign * n : 0);
  }, 0);
  return formatChaseDollarAmount(total);
}
