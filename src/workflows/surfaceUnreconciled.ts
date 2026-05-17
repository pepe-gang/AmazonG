import { logger } from '../shared/logger.js';
import {
  unreconciledSubmissions,
  recordPlacedOrderEvent,
  type StoredPlacedOrderEvent,
} from '../main/placedOrderLedger.js';
import type { JobAttemptStore } from './pollAndScrape.js';

/**
 * Part 2-safe of the ghost-order fix — surface unreconciled Place Order
 * breadcrumbs.
 *
 * A `place_order_submitted` breadcrumb (written by Part 1, before the
 * click) with no terminal event means a Place Order click happened but
 * no order/orderId was ever recorded — a possible "ghost" order.
 *
 * This pass is deliberately ALERT-ONLY. It reads the LOCAL ledger and
 * NOTHING else:
 *   - no order-history scan
 *   - no Amazon interaction of any kind
 *   - no orderId / filler-orderId attribution
 *   - no cancellation
 * So it carries zero misattribution risk — it identifies and touches
 * no order. It only flips the buy's existing JobAttempt row to
 * `action_required` and logs a warning, so the human is told *where*
 * to look and reconciles manually.
 *
 * Runs at worker startup + at the start of each buy run.
 */

/** A breadcrumb must be older than this before it's treated as a ghost
 *  — a healthy buy writes its terminal `orderid_captured` within ~a
 *  minute, so a 10-minute grace can't false-flag a slow-but-fine buy. */
const GHOST_GRACE_MS = 10 * 60_000;

/** Attempt statuses that mean the order was already handled — never
 *  flip these to action_required. */
const HANDLED_STATUSES: ReadonlySet<string> = new Set([
  'verified',
  'awaiting_verification',
  'cancelled_by_amazon',
]);

export type GhostAlert = {
  submissionId: string;
  /** `${jobId}__${profile}` — empty when the breadcrumb has no jobId. */
  attemptId: string;
  profile: string;
  jobId: string | null;
  productUrl: string | null;
  submittedAt: string;
  ageMs: number;
};

/**
 * Pure — pick the breadcrumbs old enough to be genuine ghosts (past the
 * grace period). Extracted so it's unit-testable without the ledger /
 * the attempt store.
 */
export function selectGhostAlerts(
  breadcrumbs: StoredPlacedOrderEvent[],
  now: number,
): GhostAlert[] {
  const out: GhostAlert[] = [];
  for (const b of breadcrumbs) {
    if (!b.submissionId) continue;
    const ageMs = now - Date.parse(b.ts);
    if (!Number.isFinite(ageMs) || ageMs < GHOST_GRACE_MS) continue;
    out.push({
      submissionId: b.submissionId,
      attemptId: b.jobId ? `${b.jobId}__${b.profile}` : '',
      profile: b.profile,
      jobId: b.jobId ?? null,
      productUrl: b.productUrl ?? null,
      submittedAt: b.ts,
      ageMs,
    });
  }
  return out;
}

/**
 * Surface every unreconciled breadcrumb. Best-effort — never throws,
 * never blocks the worker. Returns how many attempt rows were flipped
 * to action_required (for logging).
 */
export async function surfaceUnreconciledBreadcrumbs(
  jobAttempts: Pick<JobAttemptStore, 'get' | 'update'>,
): Promise<number> {
  let alerts: GhostAlert[];
  try {
    alerts = selectGhostAlerts(unreconciledSubmissions(), Date.now());
  } catch {
    return 0;
  }
  if (alerts.length === 0) return 0;

  let surfaced = 0;
  for (const a of alerts) {
    logger.warn('ghost.unreconciled', {
      submissionId: a.submissionId,
      profile: a.profile,
      jobId: a.jobId,
      productUrl: a.productUrl,
      submittedAt: a.submittedAt,
      ageMinutes: Math.round(a.ageMs / 60_000),
      note:
        'Place Order was clicked but no order/orderId was recorded — ' +
        'possible unrecorded ("ghost") order. Verify on Amazon order history.',
    });
    if (!a.attemptId) continue;

    const existing = await jobAttempts.get(a.attemptId).catch(() => null);
    // No row (evicted from the bounded store) — the log warning above
    // is the signal; nothing to flip.
    if (!existing) continue;
    if (HANDLED_STATUSES.has(existing.status)) {
      // The attempt shows the order WAS handled — the breadcrumb just
      // never got its terminal ledger event. Self-heal: append a
      // terminal event so this stops being re-examined every trigger.
      recordPlacedOrderEvent({
        event: 'reconcile_recovered',
        submissionId: a.submissionId,
        profile: a.profile,
        jobId: a.jobId,
        detail: `attempt already ${existing.status} — breadcrumb self-resolved`,
      });
      continue;
    }
    // Flip the buy's row to action_required so the ghost is visible in
    // the Jobs table. Idempotent — re-asserting the same status + error
    // on a later trigger is harmless.
    await jobAttempts
      .update(a.attemptId, {
        status: 'action_required',
        error:
          `Possible unrecorded order — Place Order was clicked for ` +
          `${a.profile} at ${a.submittedAt}, but no order confirmation was ` +
          `recorded. Open this account's Amazon order history, check whether ` +
          `an order was placed, and cancel any filler orders.` +
          (a.productUrl ? ` Product: ${a.productUrl}` : ''),
      })
      .catch(() => undefined);
    surfaced += 1;
  }
  if (surfaced > 0) {
    logger.warn('ghost.unreconciled.surfaced', { count: surfaced });
  }
  return surfaced;
}
