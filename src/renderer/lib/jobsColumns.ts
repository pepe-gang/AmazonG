/**
 * Jobs-table column + status taxonomy, with TSV copy helpers.
 *
 * Column-order resolution, sort keys, and the rules for turning a
 * JobAttempt into a row of spreadsheet cells all live here. Keeping the
 * logic React-free so it can be unit-tested and reused by any future
 * export path without pulling in the whole renderer.
 */
import type { JobAttempt, JobAttemptStatus } from '../../shared/types.js';
import { computeProfit, retailPrice } from '../../shared/profit.js';

export type SortKey =
  | 'date' | 'item' | 'dealId' | 'account' | 'buyMode' | 'qty'
  | 'retail' | 'totalRetail' | 'payout' | 'cb' | 'profit'
  | 'status' | 'orderId' | 'fillerOrders';

export type SortDir = 'asc' | 'desc';

/**
 * Stable identifiers for each draggable column in the Jobs table. The
 * user-chosen ordering lives in settings.jobsColumnOrder; unknown ids
 * are dropped, missing ids fall back to DEFAULT_COLUMN_ORDER's tail.
 *
 * The Action menu column is intentionally excluded — it's not part of
 * the data, it stays pinned to the right.
 */
export type JobColumnId =
  | 'date' | 'item' | 'dealId' | 'account' | 'buyMode' | 'qty'
  | 'retail' | 'totalRetail' | 'payout' | 'cb' | 'profit'
  | 'orderId' | 'tracking' | 'fillerOrders' | 'status';

export const DEFAULT_COLUMN_ORDER: JobColumnId[] = [
  'date', 'item', 'dealId', 'account', 'buyMode', 'qty',
  'retail', 'totalRetail', 'payout', 'cb', 'profit',
  'orderId', 'fillerOrders', 'tracking', 'status',
];

/**
 * Columns hidden the first time a user sees them. Once they explicitly
 * tick the column on (which writes the new order back to settings),
 * the "haven't-seen-it-yet" check stops firing.
 */
export const DEFAULT_HIDDEN_COLUMNS = new Set<JobColumnId>(['totalRetail']);

export function resolveColumnOrder(saved: string[]): JobColumnId[] {
  const valid = new Set<JobColumnId>(DEFAULT_COLUMN_ORDER);
  const seen = new Set<JobColumnId>();
  const out: JobColumnId[] = [];
  for (const id of saved) {
    if (valid.has(id as JobColumnId) && !seen.has(id as JobColumnId)) {
      out.push(id as JobColumnId);
      seen.add(id as JobColumnId);
    }
  }
  // Slot any defaults the saved order didn't mention (e.g. brand-new
  // columns added in a later release) into their natural position —
  // right after the nearest default-predecessor the user already has.
  DEFAULT_COLUMN_ORDER.forEach((id, i) => {
    if (seen.has(id)) return;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = DEFAULT_COLUMN_ORDER[j]!;
      const idx = out.indexOf(prev);
      if (idx !== -1) { insertAt = idx + 1; break; }
    }
    out.splice(insertAt, 0, id);
    seen.add(id);
  });
  return out;
}

// Display label per raw status — collapses to one of 4 visible buckets.
// "Done" and "Dry-run OK" are gone; everything that's a finished-good
// outcome reads as "Success" now.
export const STATUS_LABEL: Record<JobAttemptStatus, string> = {
  queued: 'Pending',
  in_progress: 'Pending',
  awaiting_verification: 'Pending',
  verified: 'Success',
  completed: 'Success',
  dry_run_success: 'Success',
  cancelled_by_amazon: 'Cancelled',
  failed: 'Failed',
};

/**
 * Visible status buckets. The underlying JobAttemptStatus enum still
 * has 8 values for the worker's internal state machine, but the user
 * only ever sees 4 buckets in the filter + badge — Pending, Success,
 * Cancelled, Failed. The `Done` and `Dry-run OK` raw statuses get
 * folded into Success; the in-flight three (queued / in_progress /
 * awaiting_verification) all read as Pending.
 */
export type StatusGroup = 'pending' | 'success' | 'cancelled' | 'failed';

export const STATUS_GROUP: Record<JobAttemptStatus, StatusGroup> = {
  queued: 'pending',
  in_progress: 'pending',
  awaiting_verification: 'pending',
  verified: 'success',
  completed: 'success',
  dry_run_success: 'success',
  cancelled_by_amazon: 'cancelled',
  failed: 'failed',
};

export const ALL_STATUS_GROUPS: StatusGroup[] = ['pending', 'success', 'cancelled', 'failed'];

export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  pending: 'Pending',
  success: 'Success',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const STATUS_GROUP_BADGE_CLASS: Record<StatusGroup, string> = {
  pending: 'badge-amber',
  success: 'badge-green',
  // Cancelled is a distinct "terminated-but-not-our-fault" state
  // (Amazon killed the order post-placement); Failed is "we never
  // got that far". Different badge tones so users stop reading them
  // as the same thing at a glance.
  cancelled: 'badge-orange',
  failed: 'badge-red',
};

/** Default visible: in-flight + finished-good. Settled bad rows hidden. */
export const DEFAULT_VISIBLE_STATUS_GROUPS: StatusGroup[] = ['pending', 'success'];

/** TSV cell value extractor for one column id. Used by both copy paths. */
export function tsvCell(id: JobColumnId, a: JobAttempt): string | number {
  switch (id) {
    case 'date':    return new Date(a.createdAt).toISOString();
    case 'item':    return a.dealTitle ?? '';
    case 'dealId':  return a.dealId ?? a.dealKey ?? '';
    case 'account': return a.amazonEmail;
    case 'buyMode': return a.buyMode === 'filler' ? 'Filler' : 'Single';
    case 'qty':     return typeof a.quantity === 'number' ? a.quantity : '';
    case 'retail': {
      const n = retailPrice(a);
      return n !== null ? n.toFixed(2) : '';
    }
    case 'totalRetail': {
      const n = retailPrice(a);
      if (n === null || typeof a.quantity !== 'number' || a.quantity <= 0) {
        return '';
      }
      return (n * a.quantity).toFixed(2);
    }
    case 'payout':  return typeof a.price === 'number' ? a.price.toFixed(2) : '';
    case 'cb':      return typeof a.cashbackPct === 'number' ? a.cashbackPct : '';
    case 'profit': {
      const p = computeProfit(a);
      return p === null ? '' : p.toFixed(2);
    }
    case 'orderId': return a.orderId ?? '';
    case 'tracking': return (a.trackingIds ?? []).join(', ');
    case 'fillerOrders': return (a.fillerOrderIds ?? []).join(', ');
    case 'status':  return STATUS_LABEL[a.status] ?? a.status;
  }
}

/**
 * Format attempt rows as TSV for paste-to-spreadsheet flows. Column
 * order matches the visible Jobs table (whatever the user dragged it
 * to). NO HEADER row — paste-append into an existing tracker is the
 * primary use case, and the user explicitly doesn't want column names.
 * Cells get the standard TSV escape (wrap in quotes + double internal
 * quotes) when they contain tab/newline/quote so Google Sheets / Excel
 * parse them correctly.
 */
export function attemptsToTSV(rows: JobAttempt[], order: JobColumnId[]): string {
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows
    .map((a) => order.map((id) => escape(tsvCell(id, a))).join('\t'))
    .join('\n');
}

export const COLUMN_LABEL: Record<JobColumnId, string> = {
  date: 'Date',
  item: 'Item',
  dealId: 'Deal ID',
  account: 'Amazon Account',
  buyMode: 'Buy Mode',
  qty: 'Qty',
  retail: 'Retail',
  totalRetail: 'Total Retail',
  payout: 'Payout',
  cb: 'CB',
  profit: 'Profit',
  orderId: 'Order ID',
  tracking: 'Tracking',
  fillerOrders: 'Filler Orders',
  status: 'Status',
};

export const COLUMN_ALIGN: Partial<Record<JobColumnId, 'right' | 'center'>> = {
  buyMode: 'center',
  qty: 'center',
  retail: 'right',
  totalRetail: 'right',
  payout: 'right',
  cb: 'right',
  profit: 'right',
  status: 'center',
};
