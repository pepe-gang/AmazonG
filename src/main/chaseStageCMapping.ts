import { formatChaseDollarAmount } from '../shared/chasePayments.js';
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

/**
 * Map an overview-response paymentDetail object to a ChasePaymentEntry
 * array. Used as the FALLBACK source for in-process payments — the
 * primary source is `mapBillpayActivitiesToInProcess` (multi-row)
 * which is preferred whenever the billpay/card/payment/list endpoint
 * succeeds. Returns an empty array when there's no in-flight payment
 * encoded.
 *
 * Round-2 audit (pass-7) note: paymentDetail is a one-slot summary —
 * users with multiple simultaneous in-flight payments per card see
 * only the most-imminent one. The billpay endpoint covers all rows.
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
    typeof detail.paymentAmount === 'number' ? formatChaseDollarAmount(detail.paymentAmount) : '';
  if (!date && !amount) return [];
  return [{ date, status, amount }];
}

/** Subset of /svc/rr/payments/secure/v1/billpay/card/payment/list's
 *  paymentActivities[] entry shape that mapBillpayActivitiesToInProcess
 *  reads. Empirically captured 2026-05-08 — see
 *  docs/research/chase-billpay-payment-list-empirical-2026-05-08.md.
 *  Other fields (paymentId, fundingAccountNickname, confirmationNumber,
 *  description, autoPayPayment, etc.) exist but aren't surfaced today. */
export type StageCBillpayActivity = {
  amount?: number;
  dueDate?: string;
  activityStatus?: string;
  autoPayPayment?: boolean;
};

/**
 * Map billpay/card/payment/list paymentActivities[] to ChasePaymentEntry[].
 * Filters to activityStatus === 'IN_PROCESS' (the SPA's own filter for
 * the activity-page "In process" tab). Multi-row — replaces the one-slot
 * paymentDetail summary.
 *
 * Empirically (2026-05-08): the user's Amazon card has 64 total
 * paymentActivities with statuses {IN_PROCESS, COMPLETED, RETURNED,
 * CANCELED}. Only IN_PROCESS rows count as in-flight.
 */
export function mapBillpayActivitiesToInProcess(
  activities: StageCBillpayActivity[] | null,
): ChasePaymentEntry[] {
  if (!Array.isArray(activities)) return [];
  const out: ChasePaymentEntry[] = [];
  for (const a of activities) {
    if (a?.activityStatus !== 'IN_PROCESS') continue;
    const date = formatChaseYmdDate(a.dueDate);
    const amount = typeof a.amount === 'number' ? formatChaseDollarAmount(a.amount) : '';
    if (!date && !amount) continue;
    const status = a.autoPayPayment ? 'Auto-pay in process' : 'In process';
    out.push({ date, status, amount });
  }
  return out;
}
