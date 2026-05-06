/**
 * Build the BG `reportStatus` payload from per-profile buy results.
 *
 * Single source of truth used by:
 *   - The legacy `handleJob` path in pollAndScrape.ts after pMap returns
 *   - The streaming `StreamingScheduler.reportBuyBundle` after a
 *     bundle reaches its tuple total
 *
 * Mirrors the inline aggregation that lived in handleJob lines 1210–1338
 * pre-refactor. Behavior is byte-identical to the legacy aggregation
 * for buy-phase jobs.
 *
 * Signature: `(results, fillerByEmail)` → `{status, error?, placedAt,
 * placedQuantity, placedPrice, placedCashbackPct, placedOrderId,
 * placedEmail, purchases[]}`. The fillerByEmail map is needed to set
 * the per-purchase `viaFiller` flag — same map both paths build at
 * job-claim time.
 *
 * NOT used for verify / fetch_tracking phases — those report their
 * own status internally via reportSafe (see actions/verifyOrder.ts +
 * actions/fetchTracking.ts).
 */

import type { ProfileResult } from './pollAndScrape.js';
import type { JobStatusReport } from '../shared/types.js';

export type BuildBuyJobReportInput = {
  results: ProfileResult[];
  fillerByEmail: Map<string, boolean>;
};

export function buildBuyJobReport(
  input: BuildBuyJobReportInput,
): JobStatusReport {
  const { results, fillerByEmail } = input;

  const successes = results.filter(
    (r) => r.status === 'completed' && !r.dryRun,
  );
  const dryRunPasses = results.filter(
    (r) => r.status === 'completed' && r.dryRun,
  );
  const failures = results.filter((r) => r.status === 'failed');
  const actionRequireds = results.filter(
    (r) => r.status === 'action_required',
  );

  // Winner pick: highest-cashback successful real (non-dry-run) result.
  // Ties broken by first appearance in input order.
  const winner = [...successes].sort(
    (a, b) => (b.placedCashbackPct ?? 0) - (a.placedCashbackPct ?? 0),
  )[0];

  // Overall status rollup (handleJob lines 1248-1285):
  //   - success + no failures + no action_required → awaiting_verification
  //   - success + any non-success siblings → partial
  //   - all dry-runs → failed (BG must NOT schedule verify on dry-runs)
  //   - no success but action_required → action_required
  //   - else → failed
  let overallStatus: 'awaiting_verification' | 'partial' | 'failed' | 'action_required';
  let parentError: string | null = null;

  if (successes.length > 0) {
    overallStatus =
      failures.length === 0 && actionRequireds.length === 0
        ? 'awaiting_verification'
        : 'partial';
  } else if (dryRunPasses.length > 0) {
    overallStatus = 'failed';
    parentError =
      failures.length === 0
        ? `[DRY RUN OK] All ${dryRunPasses.length} profile(s) passed all checks and would have placed orders. No real Place Order click — flip to LIVE mode to actually buy.`
        : `[DRY RUN] ${dryRunPasses.length} profile(s) would have placed orders; ${failures.length} failed verification.`;
  } else if (actionRequireds.length > 0) {
    overallStatus = 'action_required';
    parentError = actionRequireds[0]!.error ?? 'profile needs attention';
  } else {
    overallStatus = 'failed';
    parentError = failures[0]?.error ?? 'all profiles failed';
  }

  // Per-profile purchase rows. Live successes report as
  // awaiting_verification (NOT completed) so BG schedules the
  // verify-phase job. Dry-runs ALWAYS report failed (no real order).
  //
  // Defensive ?? null on optional fields: test mocks + future
  // ProfileResult variants may omit some fields. We never want this
  // helper to crash mid-aggregation — that would silently drop the
  // BG report and leave the parent job stuck `in_progress` until
  // BG's stale-claim recovery (10 min). Better to ship a row with
  // null fields than no row at all.
  const purchases = results.map((r) => ({
    amazonEmail: r.email,
    status: r.dryRun
      ? ('failed' as const)
      : r.status === 'completed'
        ? ('awaiting_verification' as const)
        : r.status === 'action_required'
          ? ('action_required' as const)
          : ('failed' as const),
    ...(fillerByEmail.get(r.email) && !r.dryRun && r.status === 'completed'
      ? { viaFiller: true as const }
      : {}),
    purchasedCount: r.placedQuantity ?? 0,
    orderId: r.orderId ?? null,
    placedPrice: r.placedPrice ?? null,
    placedCashbackPct: r.placedCashbackPct ?? null,
    placedAt: r.placedAt ?? null,
    error: r.error ?? null,
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.fillerOrderIds && r.fillerOrderIds.length > 0
      ? { fillerOrderIds: r.fillerOrderIds }
      : {}),
    ...(r.amazonPurchaseId ? { amazonPurchaseId: r.amazonPurchaseId } : {}),
  }));

  return {
    status: overallStatus,
    ...(parentError ? { error: parentError } : {}),
    placedAt: winner?.placedAt ?? null,
    placedQuantity: winner?.placedQuantity ?? null,
    placedPrice: winner?.placedPrice ?? null,
    placedCashbackPct: winner?.placedCashbackPct ?? null,
    placedOrderId: winner?.orderId ?? null,
    placedEmail: winner?.email ?? null,
    purchases,
  };
}

/**
 * Construct a synthetic `failed` ProfileResult for tuples the
 * scheduler couldn't run (worker stopping, lock-acquire error,
 * runner threw before producing a result, etc.). Populates ALL
 * required fields with safe nulls so buildBuyJobReport doesn't
 * misclassify and BG receives a clean "this account failed" row.
 *
 * Used by StreamingScheduler — kept here so the report shape and
 * the failure-shape are co-located.
 */
export function syntheticFailedResult(
  email: string,
  error: string,
): ProfileResult {
  return {
    email,
    status: 'failed',
    orderId: null,
    placedPrice: null,
    placedCashbackPct: null,
    placedAt: null,
    placedQuantity: 0,
    error,
    stage: null,
    dryRun: false,
    fillerOrderIds: [],
    amazonPurchaseId: null,
  };
}
