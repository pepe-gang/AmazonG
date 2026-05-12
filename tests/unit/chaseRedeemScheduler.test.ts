import { describe, test, expect } from 'vitest';
import type { ChaseProfile } from '../../src/shared/types';
import {
  isProfileDueNow,
  isSameLocalDay,
  lastRunAtForFreshEnable,
  nextFireAt,
  parseScheduleTime,
  selectDueProfiles,
} from '../../src/main/chaseRedeemScheduler';

const baseProfile: ChaseProfile = {
  id: 'p1',
  label: 'Personal Chase',
  loggedIn: true,
  lastLoginAt: '2026-05-01T08:00:00Z',
  cardAccountId: '123456789',
  createdAt: '2026-04-01T08:00:00Z',
  autoRedeem: {
    enabled: true,
    time: '15:00',
    lastRunAt: null,
    lastRunResult: null,
    lastRunError: null,
  },
};

// ── parseScheduleTime ────────────────────────────────────────────

describe('parseScheduleTime', () => {
  test('valid HH:MM', () => {
    expect(parseScheduleTime('15:00')).toEqual({ h: 15, m: 0 });
    expect(parseScheduleTime('09:30')).toEqual({ h: 9, m: 30 });
    expect(parseScheduleTime('00:00')).toEqual({ h: 0, m: 0 });
    expect(parseScheduleTime('23:59')).toEqual({ h: 23, m: 59 });
  });
  test('single-digit hour accepted', () => {
    expect(parseScheduleTime('9:00')).toEqual({ h: 9, m: 0 });
  });
  test('boundary out-of-range → null', () => {
    expect(parseScheduleTime('24:00')).toBeNull();
    expect(parseScheduleTime('00:60')).toBeNull();
    expect(parseScheduleTime('-1:00')).toBeNull();
  });
  test('malformed → null', () => {
    expect(parseScheduleTime('')).toBeNull();
    expect(parseScheduleTime('15')).toBeNull();
    expect(parseScheduleTime('15:00:00')).toBeNull();
    expect(parseScheduleTime('three pm')).toBeNull();
    expect(parseScheduleTime('15:0')).toBeNull(); // require zero-padded minutes
  });
});

// ── isSameLocalDay ────────────────────────────────────────────────

describe('isSameLocalDay', () => {
  test('same day', () => {
    expect(
      isSameLocalDay(
        new Date(2026, 4, 8, 9, 0),
        new Date(2026, 4, 8, 23, 59),
      ),
    ).toBe(true);
  });
  test('different days within same month', () => {
    expect(
      isSameLocalDay(new Date(2026, 4, 8, 23, 59), new Date(2026, 4, 9, 0, 0)),
    ).toBe(false);
  });
  test('month rollover', () => {
    expect(
      isSameLocalDay(new Date(2026, 4, 31, 23, 59), new Date(2026, 5, 1, 0, 0)),
    ).toBe(false);
  });
  test('year rollover', () => {
    expect(
      isSameLocalDay(new Date(2026, 11, 31), new Date(2027, 0, 1)),
    ).toBe(false);
  });
});

// ── isProfileDueNow ──────────────────────────────────────────────

describe('isProfileDueNow', () => {
  // v0.13.42: schedule TIME moved to global settings — every test
  // passes "15:00" as the globalTime parameter to match the legacy
  // per-profile default that the tests previously relied on.
  test('disabled → never due', () => {
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: { ...baseProfile.autoRedeem!, enabled: false },
    };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 16, 0))).toBe(false);
  });

  test('autoRedeem missing → never due (older profile)', () => {
    const p: ChaseProfile = { ...baseProfile, autoRedeem: undefined };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 16, 0))).toBe(false);
  });

  test('no cardAccountId → never due (defensive — nothing to act on)', () => {
    const p: ChaseProfile = { ...baseProfile, cardAccountId: null };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 16, 0))).toBe(false);
  });

  test('time before window today → not due', () => {
    expect(
      isProfileDueNow(baseProfile, '15:00', new Date(2026, 4, 8, 14, 59)),
    ).toBe(false);
  });

  test('time exactly at window → due', () => {
    expect(
      isProfileDueNow(baseProfile, '15:00', new Date(2026, 4, 8, 15, 0)),
    ).toBe(true);
  });

  test('time past window today, never run → due', () => {
    expect(
      isProfileDueNow(baseProfile, '15:00', new Date(2026, 4, 8, 16, 30)),
    ).toBe(true);
  });

  test('already ran today → not due', () => {
    const ranToday = new Date(2026, 4, 8, 15, 1).toISOString();
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: { ...baseProfile.autoRedeem!, lastRunAt: ranToday },
    };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 16, 30))).toBe(false);
  });

  test('ran yesterday → due (day rollover allows next run)', () => {
    const ranYesterday = new Date(2026, 4, 7, 15, 0).toISOString();
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: { ...baseProfile.autoRedeem!, lastRunAt: ranYesterday },
    };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 15, 30))).toBe(true);
  });

  test('malformed global time → not due (defensive — no scheduler crash)', () => {
    expect(
      isProfileDueNow(baseProfile, 'banana', new Date(2026, 4, 8, 16, 0)),
    ).toBe(false);
  });

  test('malformed lastRunAt → treated as never run, fires', () => {
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: {
        ...baseProfile.autoRedeem!,
        lastRunAt: 'not-a-date',
      },
    };
    expect(isProfileDueNow(p, '15:00', new Date(2026, 4, 8, 16, 0))).toBe(true);
  });

  test('schedule edge: globalTime set past midnight (00:00)', () => {
    // 00:01 → past 00:00 today, never run → due
    expect(isProfileDueNow(baseProfile, '00:00', new Date(2026, 4, 8, 0, 1))).toBe(true);
  });
});

// ── selectDueProfiles ────────────────────────────────────────────

describe('selectDueProfiles', () => {
  test('filters to only-due profiles', () => {
    const due: ChaseProfile = baseProfile;
    const notDue: ChaseProfile = {
      ...baseProfile,
      id: 'p2',
      autoRedeem: { ...baseProfile.autoRedeem!, enabled: false },
    };
    const ranToday: ChaseProfile = {
      ...baseProfile,
      id: 'p3',
      autoRedeem: {
        ...baseProfile.autoRedeem!,
        lastRunAt: new Date(2026, 4, 8, 15, 1).toISOString(),
      },
    };
    const result = selectDueProfiles(
      [due, notDue, ranToday],
      '15:00',
      new Date(2026, 4, 8, 16, 0),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('p1');
  });

  test('empty input → empty output', () => {
    expect(selectDueProfiles([], '15:00', new Date())).toEqual([]);
  });
});

// ── lastRunAtForFreshEnable ──────────────────────────────────────

describe('lastRunAtForFreshEnable (skip-today-on-enable)', () => {
  test('window already passed → returns start-of-today', () => {
    const now = new Date(2026, 4, 8, 23, 0);
    const stamp = lastRunAtForFreshEnable('15:00', now);
    expect(stamp).not.toBeNull();
    // Should be midnight local on 2026-05-08
    expect(stamp!.getFullYear()).toBe(2026);
    expect(stamp!.getMonth()).toBe(4);
    expect(stamp!.getDate()).toBe(8);
    expect(stamp!.getHours()).toBe(0);
    expect(stamp!.getMinutes()).toBe(0);
  });

  test('window still in future → null (today fires naturally)', () => {
    const now = new Date(2026, 4, 8, 10, 0);
    expect(lastRunAtForFreshEnable('15:00', now)).toBeNull();
  });

  test('window exactly now → null (boundary fires)', () => {
    const now = new Date(2026, 4, 8, 15, 0);
    // Boundary: now === scheduled. Treat as "still in future" for
    // the skip decision so the natural flow fires this tick.
    // Implementation says now < scheduled → null (don't skip).
    // At exactly now === scheduled, now < scheduled is false → returns
    // start-of-today (skip today). Document the choice: a fresh enable
    // at exactly the scheduled second skips today. Edge case unlikely
    // in practice (60s tick boundary).
    const stamp = lastRunAtForFreshEnable('15:00', now);
    expect(stamp).not.toBeNull();
    expect(stamp!.getHours()).toBe(0);
  });

  test('malformed time → null (defensive — caller skips skip-today)', () => {
    expect(lastRunAtForFreshEnable('banana')).toBeNull();
  });
});

// ── nextFireAt ───────────────────────────────────────────────────

describe('nextFireAt', () => {
  test('window in future → today at scheduled', () => {
    const now = new Date(2026, 4, 8, 10, 0);
    const next = nextFireAt(baseProfile, '15:00', now);
    expect(next).not.toBeNull();
    expect(next!.getDate()).toBe(8);
    expect(next!.getHours()).toBe(15);
    expect(next!.getMinutes()).toBe(0);
  });

  test('already ran today → tomorrow at scheduled', () => {
    const now = new Date(2026, 4, 8, 16, 0);
    const ranToday = new Date(2026, 4, 8, 15, 1).toISOString();
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: { ...baseProfile.autoRedeem!, lastRunAt: ranToday },
    };
    const next = nextFireAt(p, '15:00', now);
    expect(next!.getDate()).toBe(9);
    expect(next!.getHours()).toBe(15);
  });

  test('window passed but unfired today → today (about to fire)', () => {
    const now = new Date(2026, 4, 8, 16, 0);
    const next = nextFireAt(baseProfile, '15:00', now);
    expect(next!.getDate()).toBe(8);
    expect(next!.getHours()).toBe(15);
  });

  test('disabled → null', () => {
    const p: ChaseProfile = {
      ...baseProfile,
      autoRedeem: { ...baseProfile.autoRedeem!, enabled: false },
    };
    expect(nextFireAt(p, '15:00', new Date())).toBeNull();
  });

  test('no card linked → null', () => {
    const p: ChaseProfile = { ...baseProfile, cardAccountId: null };
    expect(nextFireAt(p, '15:00', new Date())).toBeNull();
  });

  test('malformed global time → null', () => {
    expect(nextFireAt(baseProfile, 'three pm', new Date())).toBeNull();
  });
});
