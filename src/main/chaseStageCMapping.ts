import type { ChasePaymentEntry } from '../shared/types.js';

/**
 * Pure mapping helpers for Stage C overview-response → snapshot
 * fields. Extracted from chaseDriver.ts so they can be unit-tested
 * without pulling in electron / Playwright.
 */

export type StageCPaymentDetail = {
  paymentMessageStatusCode?: string;
  scheduledPaymentDate?: string;
  paymentAmount?: number;
};

/**
 * Format a YYYYMMDD date string from Chase's overview JSON to the
 * "Mon DD, YYYY" shape the activity-page DOM scrape produced. Empty
 * input → empty output (Bank.tsx renders dash).
 */
export function formatChaseYmdDate(ymd: string | undefined): string {
  if (!ymd || ymd.length !== 8) return '';
  const yyyy = Number(ymd.slice(0, 4));
  const mm = Number(ymd.slice(4, 6));
  const dd = Number(ymd.slice(6, 8));
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return '';
  // Construct in UTC to dodge local-tz day-shift on the boundary
  // (Chase's YYYYMMDD has no tz; we render as "the calendar date Chase
  // sent us" not "the date right now in user's tz").
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Same shape as chaseDriver.ts's formatChaseDollarAmount — duplicated
 *  here to keep this module electron-free for testing. The two stay
 *  in lockstep because they're trivial; if either changes, update both. */
function formatDollar(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Map an overview-response paymentDetail object to a ChasePaymentEntry
 * array compatible with what the activity-page DOM scrape produced.
 * Returns an empty array when there's no in-flight payment encoded.
 *
 * Round-2 audit (pass-7) note: paymentDetail is a one-slot summary.
 * Users with multiple simultaneous in-flight payments per card will
 * only see the most-imminent one here. Stage C v2 (deferred) will use
 * /svc/rr/payments/secure/v1/billpay/card/payment/list for multi-row
 * coverage; v1 covers the ≥95% case.
 */
export function mapPaymentDetailToInProcess(
  detail: StageCPaymentDetail | null,
): ChasePaymentEntry[] {
  if (!detail) return [];
  const code = detail.paymentMessageStatusCode;
  if (!code) return [];
  let status: string;
  if (code === 'PAYMENTSCHEDULED') status = 'Scheduled';
  else if (code === 'AUTOPAYSCHEDULED') status = 'Auto-pay scheduled';
  else if (code === 'PAYMENTTODAY') status = 'Today';
  else return [];
  const date = formatChaseYmdDate(detail.scheduledPaymentDate);
  const amount =
    typeof detail.paymentAmount === 'number' ? formatDollar(detail.paymentAmount) : '';
  if (!date && !amount) return [];
  return [{ date, status, amount }];
}
