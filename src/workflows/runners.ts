/**
 * Per-tuple runners — uniform API surface for the three workflow
 * phases AmazonG handles (`buy`, `verify`, `fetch_tracking`).
 *
 * Phase 1 of the streaming-scheduler rollout (proposal-scheduler-
 * redesign.md §8) extracts this surface so the existing pMap-driven
 * code path AND the future StreamingScheduler can both invoke phases
 * via the same boundary.
 *
 * Today only `runBuyTuple` is exposed — it's a thin delegator over
 * `runForProfile` in `pollAndScrape.ts`. `runVerifyTuple` and
 * `runFetchTrackingTuple` will be added in Phase 2 when the scheduler
 * needs per-tuple dispatch for verify/tracking jobs.
 *
 * No behavior change in this file vs today's direct `runForProfile`
 * call site at `pollAndScrape.ts:1015-1029`.
 */

import type { AmazonProfile, AutoGJob } from '../shared/types.js';
import type { ProfileResult } from './pollAndScrape.js';
import type { Deps } from './pollAndScrape.js';
import type { DriverSession } from '../browser/driver.js';
import { runForProfile } from './pollAndScrape.js';

/**
 * Inputs the buy-phase runner needs. Matches `runForProfile`'s
 * argument shape exactly so the delegation is byte-equivalent. Names
 * align with the per-tuple model the scheduler will introduce —
 * `useFiller`/`effectiveMinCashbackPct`/`requireMinCashback` etc. are
 * the per-account overrides today's pMap reads from
 * `fillerByEmail`/`effectiveMinByEmail`/`requireMinByEmail` maps.
 */
export type BuyTupleCtx = {
  deps: Deps;
  sessions: Map<string, DriverSession>;
  job: AutoGJob;
  profile: AmazonProfile;
  parentCid: string;
  useFiller: boolean;
  effectiveMinCashbackPct: number;
  requireMinCashback: boolean;
  wheyProteinFillerOnly: boolean;
  abortSignal: AbortSignal;
  abortSiblings: (reason: 'out_of_stock' | 'price_exceeds') => void;
};

export async function runBuyTuple(ctx: BuyTupleCtx): Promise<ProfileResult> {
  return runForProfile(
    ctx.deps,
    ctx.sessions,
    ctx.job,
    ctx.profile,
    ctx.parentCid,
    ctx.useFiller,
    ctx.effectiveMinCashbackPct,
    ctx.requireMinCashback,
    ctx.wheyProteinFillerOnly,
    ctx.abortSignal,
    ctx.abortSiblings,
  );
}
