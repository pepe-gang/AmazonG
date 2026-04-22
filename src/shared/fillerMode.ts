import type { AmazonProfile } from './types.js';

/**
 * Decide whether this (job, profile) pair runs through the filler flow.
 *
 * Precedence:
 *   1. `jobViaFiller` — BG-set per-job override (rebuys + scheduled
 *      verify jobs for filler buys carry this). Wins outright.
 *   2. Global toggle — `settings.buyWithFillers`. When on, every
 *      eligible account uses fillers regardless of the per-profile flag.
 *   3. Per-profile toggle — `profile.buyWithFillers`. The account-
 *      specific override when the global is off.
 *
 * Mirrors the UI's mental model: the global master is a cascade, the
 * per-profile switch is the account-specific opt-in.
 */
export function shouldUseFillers(
  globalOn: boolean,
  profile: AmazonProfile,
  jobViaFiller: boolean,
): boolean {
  if (jobViaFiller) return true;
  if (globalOn) return true;
  return profile.buyWithFillers === true;
}
