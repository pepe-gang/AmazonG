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

  const successes = results.filter((r) => r.status === 'completed');
  const failures = results.filter((r) => r.status === 'failed');
  const actionRequireds = results.filter(
    (r) => r.status === 'action_required',
  );

  // Winner pick: highest-cashback successful result. Ties broken by
  // first appearance in input order.
  const winner = [...successes].sort(
    (a, b) => (b.placedCashbackPct ?? 0) - (a.placedCashbackPct ?? 0),
  )[0];

  // Overall status rollup:
  //   - success + no failures + no action_required → awaiting_verification
  //   - success + any non-success siblings → partial
  //   - no success but action_required → action_required
  //   - else → failed
  let overallStatus: 'awaiting_verification' | 'partial' | 'failed' | 'action_required';
  let parentError: string | null = null;

  if (successes.length > 0) {
    overallStatus =
      failures.length === 0 && actionRequireds.length === 0
        ? 'awaiting_verification'
        : 'partial';
  } else if (actionRequireds.length > 0) {
    overallStatus = 'action_required';
    parentError = actionRequireds[0]!.error ?? 'profile needs attention';
  } else {
    overallStatus = 'failed';
    parentError = failures[0]?.error ?? 'all profiles failed';
  }

  // Per-profile purchase rows. Live successes report as
  // awaiting_verification (NOT completed) so BG schedules the
  // verify-phase job.
  //
  // Defensive ?? null on optional fields: test mocks + future
  // ProfileResult variants may omit some fields. We never want this
  // helper to crash mid-aggregation — that would silently drop the
  // BG report and leave the parent job stuck `in_progress` until
  // BG's stale-claim recovery (10 min). Better to ship a row with
  // null fields than no row at all.
  const purchases = results.map((r) => ({
    amazonEmail: r.email,
    status:
      r.status === 'completed'
        ? ('awaiting_verification' as const)
        : r.status === 'action_required'
          ? ('action_required' as const)
          : ('failed' as const),
    ...(fillerByEmail.get(r.email) && r.status === 'completed'
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
    ...(r.targetAsin ? { targetAsin: r.targetAsin } : {}),
    // Filler buy-context — only on filler buys that committed a cart.
    // BG persists these so a cross-machine verify / cancel_fillers
    // pass can re-scan order history for missed filler orders.
    ...(r.cartAsins && r.cartAsins.length > 0
      ? { cartAsins: r.cartAsins }
      : {}),
    ...(r.preBuyOrderIds && r.preBuyOrderIds.length > 0
      ? { preBuyOrderIds: r.preBuyOrderIds }
      : {}),
    ...(typeof r.fillersAddedCount === 'number' && r.fillersAddedCount > 0
      ? { fillersAddedCount: r.fillersAddedCount }
      : {}),
  }));

  // Retry-chain hint. BG enforces the cap (retryDepth < 1) and only
  // actually requeues on terminal "failed" — this is just the worker
  // saying "the failure I just produced is in the auto-retry class."
  //
  // Conservative criteria: we set this ONLY when overallStatus is
  // "failed" AND every failed profile reports the same retryable
  // class. A mixed bag (one confirm_timeout + one cashback gate
  // failure, say) is NOT eligible — different failure surfaces
  // probably mean different root causes and we'd rather surface
  // them to the operator than retry blindly.
  const retryReason = pickRetryReason(failures, overallStatus);
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
    ...(retryReason
      ? { requeueEligible: true as const, retryReason }
      : {}),
  };
}

/**
 * Return the retry class name when the failure pattern warrants
 * an auto-retry — null otherwise.
 *
 *   - "confirm_timeout": EVERY failure mentions "confirmation URL
 *     never loaded" (after AmazonG's history-scan budget was
 *     exhausted). Order MAY have placed; the strict `every` gate
 *     prevents retry on mixed-mode failures where retrying could
 *     race against an actual placed order on a different account.
 *     BG-side retry then leans on Amazon's QLA to prevent dups.
 *
 *   - "filler_search": ANY failure mentions `no_filler_candidates
 *     — search rate-limited across all pools`. The filler-search
 *     path is zero-dup-risk (buy never reaches checkout), AND the
 *     rate-limit is transient — so it's worth retrying even when
 *     other profiles failed for unrelated reasons like QLA or OOS
 *     (those will just re-fail the same way on retry, while the
 *     filler-search profiles get a second shot).
 *
 *   - `overallStatus === "partial"` does NOT count for retries:
 *     partial means at least one profile succeeded; the deal has
 *     real orders. Retrying could needlessly hit Amazon QLA on
 *     the succeeded accounts.
 */
function pickRetryReason(
  failures: BuildBuyJobReportInput['results'],
  overallStatus: string,
): 'confirm_timeout' | 'filler_search' | null {
  if (overallStatus !== 'failed') return null;
  if (failures.length === 0) return null;
  const allConfirm = failures.every((r) =>
    (r.error ?? '').toLowerCase().includes('confirmation url never loaded'),
  );
  if (allConfirm) return 'confirm_timeout';
  // Permissive `some` for filler_search — see comment block above.
  const anyFiller = failures.some((r) =>
    (r.error ?? '').toLowerCase().includes('no_filler_candidates'),
  );
  if (anyFiller) return 'filler_search';
  return null;
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
    fillerOrderIds: [],
    amazonPurchaseId: null,
    targetAsin: null,
    cartAsins: [],
    preBuyOrderIds: [],
    fillersAddedCount: 0,
  };
}
