import type { ChasePaymentEntry } from './types.js';

/**
 * Sum the dollar amounts on a list of ChasePaymentEntry rows and
 * return the displayed total ("$18,050.00"). Mirrors the format
 * Chase uses on each row: leading "$", thousands commas, two
 * decimals. Negative amounts (rare here, but possible if Chase
 * ever exposes a refund row in the activity feed) are summed
 * with sign preserved — caller decides whether to filter first.
 *
 * Pure function: importable from main, renderer, or tests without
 * dragging in scrape / Playwright / DOM dependencies.
 *
 * Bad / unparsable amounts are silently treated as zero rather
 * than throwing; the rendered total is "best-effort across what
 * we could read." Empty input returns "$0.00".
 */
export function sumPaymentAmounts(entries: ChasePaymentEntry[]): string {
  const total = entries.reduce((acc, e) => {
    // Strip everything except digits, dot, and a leading minus.
    // Chase's strings look like "$13,000.00" or "-$50.00"; we
    // keep the sign on the number, drop the "$" and commas.
    const sign = e.amount.trim().startsWith('-') ? -1 : 1;
    const cleaned = e.amount.replace(/[^\d.]/g, '');
    const n = parseFloat(cleaned);
    return acc + (Number.isFinite(n) ? sign * n : 0);
  }, 0);
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
