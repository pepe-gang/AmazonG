import { describe, it, expect } from 'vitest';
import { findUnreconciledSubmissions } from '../../src/main/placedOrderLedger.js';
import type { StoredPlacedOrderEvent } from '../../src/main/placedOrderLedger.js';

const ev = (
  over: Partial<StoredPlacedOrderEvent> & Pick<StoredPlacedOrderEvent, 'event'>,
): StoredPlacedOrderEvent => ({
  ts: '2026-05-17T00:00:00.000Z',
  profile: 'a@x.com',
  ...over,
});

describe('findUnreconciledSubmissions', () => {
  it('returns a submitted breadcrumb with no terminal event', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
    ]);
    expect(out.map((e) => e.submissionId)).toEqual(['s1']);
  });

  it('treats orderid_captured as terminal — submission resolved', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
      ev({ event: 'orderid_captured', submissionId: 's1' }),
    ]);
    expect(out).toEqual([]);
  });

  it('treats reconcile_recovered / reconcile_abandoned as terminal', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
      ev({ event: 'reconcile_recovered', submissionId: 's1' }),
      ev({ event: 'place_order_submitted', submissionId: 's2' }),
      ev({ event: 'reconcile_abandoned', submissionId: 's2' }),
    ]);
    expect(out).toEqual([]);
  });

  it('does NOT treat a buy-time orderid_missing as terminal — still retryable', () => {
    // The order may simply not have propagated to order history yet.
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
      ev({ event: 'orderid_missing', submissionId: 's1' }),
    ]);
    expect(out.map((e) => e.submissionId)).toEqual(['s1']);
  });

  it('does NOT treat order_confirmed alone as terminal', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
      ev({ event: 'order_confirmed', submissionId: 's1' }),
    ]);
    expect(out.map((e) => e.submissionId)).toEqual(['s1']);
  });

  it('isolates submissions by id — one resolved, one not', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted', submissionId: 's1' }),
      ev({ event: 'orderid_captured', submissionId: 's1' }),
      ev({ event: 'place_order_submitted', submissionId: 's2' }),
    ]);
    expect(out.map((e) => e.submissionId)).toEqual(['s2']);
  });

  it('ignores a breadcrumb with no submissionId (legacy / pre-fix rows)', () => {
    const out = findUnreconciledSubmissions([
      ev({ event: 'place_order_submitted' }),
      ev({ event: 'order_confirmed' }),
    ]);
    expect(out).toEqual([]);
  });
});
