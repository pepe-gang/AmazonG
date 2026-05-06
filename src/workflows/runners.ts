/**
 * Per-tuple runners — uniform API surface for the three workflow
 * phases AmazonG handles (`buy`, `verify`, `fetch_tracking`).
 *
 * Both the legacy pMap path and the StreamingScheduler invoke phases
 * through these thin delegators. Keeps the dispatch boundary in one
 * place so the two paths can't drift in argument ordering or option
 * shape — a refactor in `runForProfile` / `handleVerifyJob` /
 * `handleFetchTrackingJob` only needs to update the matching ctx
 * type here.
 */

import type { AmazonProfile, AutoGJob } from '../shared/types.js';
import type { ProfileResult } from './pollAndScrape.js';
import type { Deps } from './pollAndScrape.js';
import type { DriverSession } from '../browser/driver.js';
import {
  runForProfile,
  handleVerifyJobForTuple,
  handleFetchTrackingJobForTuple,
} from './pollAndScrape.js';

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

/**
 * Inputs for verify / fetch_tracking tuple runners. These phases are
 * already single-account per job (the job carries `placedEmail`), so
 * the tuple maps 1:1 with the existing `handleVerifyJob` /
 * `handleFetchTrackingJob` shape. The runners just delegate.
 */
export type LifecycleTupleCtx = {
  deps: Deps;
  sessions: Map<string, DriverSession>;
  job: AutoGJob;
  profile: AmazonProfile;
  parentCid: string;
};

export async function runVerifyTuple(ctx: LifecycleTupleCtx): Promise<void> {
  return handleVerifyJobForTuple(
    ctx.deps,
    ctx.sessions,
    ctx.job,
    ctx.parentCid,
    [ctx.profile],
  );
}

export async function runFetchTrackingTuple(
  ctx: LifecycleTupleCtx,
): Promise<void> {
  return handleFetchTrackingJobForTuple(
    ctx.deps,
    ctx.sessions,
    ctx.job,
    ctx.parentCid,
    [ctx.profile],
  );
}
