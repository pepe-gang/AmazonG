/**
 * Pure helpers for the per-Chase-profile auto-redeem schedule.
 *
 * The scheduler runs on a 60-second tick in the main process. On each
 * tick, for every profile with `autoRedeem.enabled === true`, we ask:
 *   - has today's scheduled time elapsed?
 *   - has it already run today?
 *
 * Both answers must be yes to fire a run. Once-a-day semantics — if
 * the user changes the time mid-day or the computer was asleep at the
 * scheduled instant, the next tick after the time + an unfired-today
 * state catches it.
 *
 * This module is intentionally side-effect-free so the firing decision
 * can be unit-tested without spinning up Chromium or Prisma. The
 * lifecycle wiring (timer + redeem invocation) lives in the consumer
 * (`main/index.ts`).
 */

import type { ChaseProfile } from '../shared/types.js';

/**
 * True when two Date instances fall on the same calendar day in the
 * machine's local timezone. Local on purpose — the user's "3 PM"
 * means their local 3 PM, and "already ran today" means their local
 * day. DST boundaries are handled correctly by getFullYear/Month/Date
 * (these are local-timezone accessors).
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Parse "HH:MM" 24h format. Returns null on any malformed input —
 * caller treats null as "skip this profile this tick" so a corrupt
 * settings value can't crash the scheduler loop.
 */
export function parseScheduleTime(s: string): { h: number; m: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return { h, m: min };
}

/**
 * The decision: should this profile fire its auto-redeem on the
 * current tick?
 *
 *   1. autoRedeem must be enabled (per-profile flag)
 *   2. profile must be ready to act on (has a card linked) — defended
 *      so a freshly-added profile that hasn't logged in yet can't get
 *      a run scheduled against a null cardAccountId
 *   3. parsed GLOBAL time valid (Settings.chaseAutoRedeemTime, single
 *      schedule shared by every enabled profile as of v0.13.42)
 *   4. now >= scheduled-instant-today
 *   5. lastRunAt (per-profile) is missing OR not today (local)
 */
export function isProfileDueNow(
  profile: ChaseProfile,
  globalTime: string,
  now: Date = new Date(),
): boolean {
  const ar = profile.autoRedeem;
  if (!ar?.enabled) return false;
  if (!profile.cardAccountId) return false;

  const t = parseScheduleTime(globalTime);
  if (!t) return false;

  const scheduledToday = new Date(now);
  scheduledToday.setHours(t.h, t.m, 0, 0);

  if (now.getTime() < scheduledToday.getTime()) return false;

  if (!ar.lastRunAt) return true;
  const lastRun = new Date(ar.lastRunAt);
  if (Number.isNaN(lastRun.getTime())) return true;
  return !isSameLocalDay(lastRun, now);
}

/**
 * When the user flips `enabled: false → true`, we want to skip
 * today's window if it's already passed — otherwise a user toggling
 * "auto redeem at 3 PM" at 11 PM would have their full points balance
 * redeemed within seconds of flipping the switch. That's almost
 * certainly not what they meant; they want behavior to start
 * "tomorrow." This helper computes the lastRunAt timestamp the
 * caller should stamp onto the profile to skip today (a Date at
 * start-of-today, local).
 *
 * Returns null when today's window is still in the future, meaning
 * the natural fire-today path is correct and no skip needed.
 */
export function lastRunAtForFreshEnable(
  time: string,
  now: Date = new Date(),
): Date | null {
  const t = parseScheduleTime(time);
  if (!t) return null;
  const scheduledToday = new Date(now);
  scheduledToday.setHours(t.h, t.m, 0, 0);
  if (now.getTime() < scheduledToday.getTime()) return null;
  // Stamp start-of-today so isSameLocalDay(stamp, now) === true →
  // skips today; tomorrow's tick passes the not-today check and fires.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return startOfToday;
}

/**
 * Pick all profiles due to fire on this tick. Tiny convenience over
 * mapping isProfileDueNow — keeps the consumer's tick loop concise.
 */
export function selectDueProfiles(
  profiles: readonly ChaseProfile[],
  globalTime: string,
  now: Date = new Date(),
): ChaseProfile[] {
  return profiles.filter((p) => isProfileDueNow(p, globalTime, now));
}

/**
 * Compute the next-fire wall-clock instant for an enabled profile —
 * used by the header indicator chip to render "next run at HH:MM" or
 * "next run tomorrow at HH:MM" as a tooltip / label.
 *
 * Returns null when the profile is disabled, has no card linked, or
 * has a malformed time (caller hides the chip).
 */
export function nextFireAt(
  profile: ChaseProfile,
  globalTime: string,
  now: Date = new Date(),
): Date | null {
  const ar = profile.autoRedeem;
  if (!ar?.enabled) return null;
  if (!profile.cardAccountId) return null;
  const t = parseScheduleTime(globalTime);
  if (!t) return null;

  const scheduledToday = new Date(now);
  scheduledToday.setHours(t.h, t.m, 0, 0);

  // Already ran today → next fire is tomorrow's window.
  if (ar.lastRunAt) {
    const lastRun = new Date(ar.lastRunAt);
    if (!Number.isNaN(lastRun.getTime()) && isSameLocalDay(lastRun, now)) {
      const tomorrow = new Date(scheduledToday);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    }
  }

  // Today's window already passed without a run → fires on next tick
  // (within a minute). Surface today's scheduled instant as the
  // "should-have-fired" anchor; UI rounds up to "any minute now."
  if (now.getTime() >= scheduledToday.getTime()) return scheduledToday;

  // Today's window still in the future.
  return scheduledToday;
}
