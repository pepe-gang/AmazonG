import { describe, it, expect } from 'vitest';
import { selectGhostAlerts } from '../../src/workflows/surfaceUnreconciled.js';
import type { StoredPlacedOrderEvent } from '../../src/main/placedOrderLedger.js';

const NOW = Date.parse('2026-05-17T12:00:00.000Z');
const minsAgo = (m: number) =>
  new Date(NOW - m * 60_000).toISOString();

const bc = (
  over: Partial<StoredPlacedOrderEvent> = {},
): StoredPlacedOrderEvent => ({
  ts: minsAgo(30),
  event: 'place_order_submitted',
  submissionId: 's1',
  profile: 'a@x.com',
  jobId: 'job1',
  productUrl: 'https://amazon.com/dp/B0TEST',
  ...over,
});

describe('selectGhostAlerts', () => {
  it('flags a breadcrumb older than the 10-minute grace period', () => {
    const out = selectGhostAlerts([bc({ ts: minsAgo(30) })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.attemptId).toBe('job1__a@x.com');
    expect(out[0]!.submissionId).toBe('s1');
  });

  it('does NOT flag a fresh breadcrumb (within the grace period)', () => {
    // A healthy buy resolves its breadcrumb within ~a minute.
    expect(selectGhostAlerts([bc({ ts: minsAgo(3) })], NOW)).toEqual([]);
  });

  it('flags exactly at / past the grace boundary, not before', () => {
    expect(selectGhostAlerts([bc({ ts: minsAgo(9) })], NOW)).toEqual([]);
    expect(selectGhostAlerts([bc({ ts: minsAgo(11) })], NOW)).toHaveLength(1);
  });

  it('skips a breadcrumb with no submissionId', () => {
    expect(
      selectGhostAlerts([bc({ submissionId: undefined })], NOW),
    ).toEqual([]);
  });

  it('skips a breadcrumb with an unparseable timestamp', () => {
    expect(selectGhostAlerts([bc({ ts: 'not-a-date' })], NOW)).toEqual([]);
  });

  it('handles a null jobId — empty attemptId, still alerts', () => {
    const out = selectGhostAlerts([bc({ jobId: null })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.attemptId).toBe('');
  });

  it('carries profile / productUrl / submittedAt through to the alert', () => {
    const ts = minsAgo(40);
    const out = selectGhostAlerts(
      [bc({ ts, profile: 'b@x.com', productUrl: 'u' })],
      NOW,
    );
    expect(out[0]).toMatchObject({
      profile: 'b@x.com',
      productUrl: 'u',
      submittedAt: ts,
    });
  });
});
