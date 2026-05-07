import { describe, expect, it } from 'vitest';
import {
  selectBuyProfiles,
  selectVerifyTrackingProfile,
} from '../../src/workflows/profileFilters';
import type { AmazonProfile } from '../../src/shared/types';

/**
 * Pin the per-phase profile-eligibility rules shared by every
 * worker dispatch path. Two switches matter:
 *
 *   - enabled : master per-account participation. Off → account
 *     skipped on EVERY phase (buy + verify + fetch_tracking).
 *   - autoBuy : per-account buy gate. Off (with `enabled: true`)
 *     → account skipped on the BUY phase only; verify and
 *     fetch_tracking still run for orders this account already
 *     placed.
 *
 * Behavior matrix:
 *
 *   | enabled | autoBuy | buy   | verify  | tracking |
 *   |---------|---------|-------|---------|----------|
 *   | true    | true    | runs  | runs    | runs     |
 *   | true    | false   | skip  | runs    | runs     |
 *   | false   | (any)   | skip  | skip    | skip     |
 */

function profile(overrides: Partial<AmazonProfile> & { email: string }): AmazonProfile {
  return {
    displayName: null,
    enabled: true,
    autoBuy: true,
    addedAt: '2026-05-07T00:00:00Z',
    lastLoginAt: null,
    loggedIn: true,
    headless: true,
    buyWithFillers: false,
    ...overrides,
  };
}

describe('selectVerifyTrackingProfile', () => {
  it('finds the profile matching placedEmail when enabled', () => {
    const profiles = [profile({ email: 'a@x' }), profile({ email: 'b@x' })];
    const r = selectVerifyTrackingProfile(profiles, 'a@x');
    expect(r?.email).toBe('a@x');
  });

  it('matches case-insensitively on email', () => {
    const profiles = [profile({ email: 'CASE@x' })];
    expect(selectVerifyTrackingProfile(profiles, 'case@x')?.email).toBe('CASE@x');
    expect(selectVerifyTrackingProfile(profiles, 'CASE@X')?.email).toBe('CASE@x');
  });

  it('returns null when placedEmail is null/undefined/empty', () => {
    const profiles = [profile({ email: 'a@x' })];
    expect(selectVerifyTrackingProfile(profiles, null)).toBeNull();
    expect(selectVerifyTrackingProfile(profiles, undefined)).toBeNull();
    expect(selectVerifyTrackingProfile(profiles, '')).toBeNull();
  });

  it('returns null when no profile matches placedEmail', () => {
    const profiles = [profile({ email: 'a@x' })];
    expect(selectVerifyTrackingProfile(profiles, 'nobody@x')).toBeNull();
  });

  it('SKIPS the profile when enabled=false (the new strict semantics)', () => {
    // This is the behavior change in v0.13.27 — pre-this-version
    // `enabled: false` only blocked buys; now it blocks verify and
    // fetch_tracking too.
    const profiles = [profile({ email: 'a@x', enabled: false })];
    expect(selectVerifyTrackingProfile(profiles, 'a@x')).toBeNull();
  });

  it('returns the profile when autoBuy=false but enabled=true', () => {
    // The whole point of the autoBuy flag — keep tracking running
    // even when buys are paused.
    const profiles = [profile({ email: 'a@x', enabled: true, autoBuy: false })];
    expect(selectVerifyTrackingProfile(profiles, 'a@x')?.email).toBe('a@x');
  });

  it('returns the first match when duplicate emails exist (defensive)', () => {
    const profiles = [
      profile({ email: 'a@x', displayName: 'first' }),
      profile({ email: 'a@x', displayName: 'second' }),
    ];
    expect(selectVerifyTrackingProfile(profiles, 'a@x')?.displayName).toBe('first');
  });
});

describe('selectBuyProfiles', () => {
  it('returns all enabled+autoBuy profiles when no placedEmail', () => {
    const profiles = [
      profile({ email: 'a@x' }),
      profile({ email: 'b@x' }),
      profile({ email: 'c@x' }),
    ];
    const r = selectBuyProfiles(profiles, null);
    expect(r.map((p) => p.email).sort()).toEqual(['a@x', 'b@x', 'c@x']);
  });

  it('drops profiles with enabled=false', () => {
    const profiles = [
      profile({ email: 'on@x', enabled: true }),
      profile({ email: 'off@x', enabled: false }),
    ];
    const r = selectBuyProfiles(profiles, null);
    expect(r.map((p) => p.email)).toEqual(['on@x']);
  });

  it('drops profiles with autoBuy=false (even if enabled)', () => {
    // The new flag — pauses buys without taking the account out of
    // the worker pool entirely.
    const profiles = [
      profile({ email: 'buys@x', enabled: true, autoBuy: true }),
      profile({ email: 'paused@x', enabled: true, autoBuy: false }),
    ];
    const r = selectBuyProfiles(profiles, null);
    expect(r.map((p) => p.email)).toEqual(['buys@x']);
  });

  it('drops profiles where BOTH flags would let it through (sanity)', () => {
    const profiles = [
      profile({ email: 'a@x', enabled: false, autoBuy: false }),
      profile({ email: 'b@x', enabled: false, autoBuy: true }),
      profile({ email: 'c@x', enabled: true, autoBuy: false }),
    ];
    expect(selectBuyProfiles(profiles, null)).toEqual([]);
  });

  it('narrows to placedEmail when set (rebuy path)', () => {
    const profiles = [
      profile({ email: 'target@x' }),
      profile({ email: 'other@x' }),
      profile({ email: 'another@x' }),
    ];
    const r = selectBuyProfiles(profiles, 'target@x');
    expect(r.map((p) => p.email)).toEqual(['target@x']);
  });

  it('narrows case-insensitively', () => {
    const profiles = [profile({ email: 'TARGET@X' })];
    expect(selectBuyProfiles(profiles, 'target@x').map((p) => p.email)).toEqual(['TARGET@X']);
  });

  it('returns empty if placedEmail target is filtered out by enabled/autoBuy', () => {
    const profiles = [profile({ email: 'target@x', autoBuy: false })];
    expect(selectBuyProfiles(profiles, 'target@x')).toEqual([]);
  });

  it('returns empty for placedEmail not in the profile list', () => {
    const profiles = [profile({ email: 'a@x' })];
    expect(selectBuyProfiles(profiles, 'nobody@x')).toEqual([]);
  });

  it('preserves input order in the filtered list', () => {
    const profiles = [
      profile({ email: 'first@x' }),
      profile({ email: 'second@x' }),
      profile({ email: 'third@x' }),
    ];
    expect(selectBuyProfiles(profiles, null).map((p) => p.email)).toEqual([
      'first@x',
      'second@x',
      'third@x',
    ]);
  });

  it('handles empty input cleanly', () => {
    expect(selectBuyProfiles([], null)).toEqual([]);
    expect(selectBuyProfiles([], 'a@x')).toEqual([]);
  });
});

describe('full behavior matrix (matches docs/code comments)', () => {
  // Single source of truth for the user-facing behavior contract.
  // If a future refactor regresses the matrix, these tests fail.
  const cases: Array<{
    label: string;
    enabled: boolean;
    autoBuy: boolean;
    buyEligible: boolean;
    verifyEligible: boolean;
  }> = [
    { label: 'fully on', enabled: true, autoBuy: true, buyEligible: true, verifyEligible: true },
    { label: 'paused (autoBuy off)', enabled: true, autoBuy: false, buyEligible: false, verifyEligible: true },
    { label: 'disabled (enabled off)', enabled: false, autoBuy: true, buyEligible: false, verifyEligible: false },
    { label: 'fully off', enabled: false, autoBuy: false, buyEligible: false, verifyEligible: false },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const p = profile({ email: 'p@x', enabled: c.enabled, autoBuy: c.autoBuy });
      // Buy
      const buy = selectBuyProfiles([p], null);
      expect(buy.length > 0).toBe(c.buyEligible);
      // Verify
      const verify = selectVerifyTrackingProfile([p], 'p@x');
      expect(verify !== null).toBe(c.verifyEligible);
      // Tracking — same code path as verify
      const track = selectVerifyTrackingProfile([p], 'p@x');
      expect(track !== null).toBe(c.verifyEligible);
    });
  }
});
