/**
 * Pure helpers for filtering Amazon profiles into the per-phase
 * "eligible" list. Extracted from `resolveStreamingJobContext` so
 * the per-phase rules (buy needs `enabled && autoBuy`; verify and
 * fetch_tracking need just `enabled`) are unit-testable without
 * mocking the BG client + worker injection harness.
 */

import type { AmazonProfile } from '../shared/types.js';

/**
 * Pick the single profile to run a verify or fetch_tracking job
 * against. Both phases target the account that placed the original
 * order, identified by `placedEmail` on the job. The profile must
 * also be `enabled`; we DON'T check `autoBuy` here because that
 * flag gates new BUYs only — verify/tracking continues for orders
 * the account already placed even when autoBuy is off.
 */
export function selectVerifyTrackingProfile(
  eligibleAll: readonly AmazonProfile[],
  placedEmail: string | null | undefined,
): AmazonProfile | null {
  const target = (placedEmail ?? '').toLowerCase();
  if (!target) return null;
  return (
    eligibleAll.find(
      (p) => p.email.toLowerCase() === target && p.enabled,
    ) ?? null
  );
}

/**
 * Filter profiles for the buy phase. A profile is buy-eligible iff
 * BOTH the master `enabled` flag AND the `autoBuy` flag are true.
 *
 * `enabled: false` removes the account from the worker pool entirely
 * (also blocks verify/tracking). `autoBuy: false` keeps the account
 * live for verify/tracking but skips new buy claims.
 *
 * If `job.placedEmail` is set (rebuy-targeted job), narrow further
 * to only that account.
 */
export function selectBuyProfiles(
  eligibleAll: readonly AmazonProfile[],
  placedEmail: string | null | undefined,
): AmazonProfile[] {
  let eligible = eligibleAll.filter((p) => p.enabled && p.autoBuy);
  if (placedEmail) {
    const t = placedEmail.toLowerCase();
    eligible = eligible.filter((p) => p.email.toLowerCase() === t);
  }
  return eligible;
}
