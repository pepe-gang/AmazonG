import { describe, expect, it } from 'vitest';
import { shouldUseFillers } from '@shared/fillerMode';
import type { AmazonProfile } from '@shared/types';

function profile(overrides: Partial<AmazonProfile> = {}): AmazonProfile {
  return {
    email: 'user@example.com',
    displayName: null,
    enabled: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    loggedIn: true,
    headless: true,
    buyWithFillers: false,
    ...overrides,
  };
}

describe('shouldUseFillers', () => {
  it('returns false when nothing is on', () => {
    expect(shouldUseFillers(false, profile(), false)).toBe(false);
  });

  it('global on → true regardless of profile flag', () => {
    expect(shouldUseFillers(true, profile({ buyWithFillers: false }), false)).toBe(true);
    expect(shouldUseFillers(true, profile({ buyWithFillers: true }), false)).toBe(true);
  });

  it('per-profile on → true when global is off', () => {
    expect(shouldUseFillers(false, profile({ buyWithFillers: true }), false)).toBe(true);
  });

  it('job.viaFiller overrides both to true', () => {
    // Even if global AND per-profile are off, a viaFiller-flagged job
    // (e.g. a rebuy) still runs through the filler flow.
    expect(shouldUseFillers(false, profile({ buyWithFillers: false }), true)).toBe(true);
  });

  it('job.viaFiller precedence over per-profile off', () => {
    expect(shouldUseFillers(false, profile({ buyWithFillers: false }), true)).toBe(true);
  });

  it('per-profile off + global off + no viaFiller → false', () => {
    expect(shouldUseFillers(false, profile({ buyWithFillers: false }), false)).toBe(false);
  });

  it('all three flags on → true (no surprises)', () => {
    expect(shouldUseFillers(true, profile({ buyWithFillers: true }), true)).toBe(true);
  });
});
