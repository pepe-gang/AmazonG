import { describe, expect, it } from 'vitest';
import {
  formatChaseYmdDate,
  mapPaymentDetailToInProcess,
} from '../../src/main/chaseStageCMapping.js';

describe('formatChaseYmdDate', () => {
  it('formats a YYYYMMDD string to "Mon DD, YYYY"', () => {
    expect(formatChaseYmdDate('20260507')).toBe('May 7, 2026');
    expect(formatChaseYmdDate('20260101')).toBe('Jan 1, 2026');
    expect(formatChaseYmdDate('20261231')).toBe('Dec 31, 2026');
  });

  it('returns empty string for empty / null / undefined input', () => {
    expect(formatChaseYmdDate(undefined)).toBe('');
    expect(formatChaseYmdDate('')).toBe('');
  });

  it('returns empty string for malformed input (wrong length, non-numeric)', () => {
    expect(formatChaseYmdDate('2026')).toBe('');
    expect(formatChaseYmdDate('2026-05-07')).toBe('');
    expect(formatChaseYmdDate('not-a-date')).toBe('');
  });

  it('renders the date using UTC to avoid tz drift across day boundaries', () => {
    // 20260101 must render as Jan 1 regardless of where the test runs.
    // If the renderer used local-tz the result would be Dec 31 in
    // negative-utc zones at midnight. UTC sidesteps the whole class.
    expect(formatChaseYmdDate('20260101')).toBe('Jan 1, 2026');
  });
});

describe('mapPaymentDetailToInProcess', () => {
  it('returns [] when detail is null', () => {
    expect(mapPaymentDetailToInProcess(null)).toEqual([]);
  });

  it('returns [] when paymentMessageStatusCode is missing', () => {
    expect(mapPaymentDetailToInProcess({ paymentAmount: 100 })).toEqual([]);
  });

  it('returns [] for non-in-flight status codes (NOPAYMENTDUE, PASTDUE, ...)', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'NOPAYMENTDUE',
        paymentAmount: 0,
      }),
    ).toEqual([]);
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'PASTDUE',
        paymentAmount: 100,
      }),
    ).toEqual([]);
  });

  it('maps PAYMENTSCHEDULED to a Scheduled entry with date + amount', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'PAYMENTSCHEDULED',
        scheduledPaymentDate: '20260507',
        paymentAmount: 13278.77,
      }),
    ).toEqual([
      {
        date: 'May 7, 2026',
        status: 'Scheduled',
        amount: '$13,278.77',
      },
    ]);
  });

  it('maps AUTOPAYSCHEDULED to an Auto-pay scheduled entry', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'AUTOPAYSCHEDULED',
        scheduledPaymentDate: '20260520',
        paymentAmount: 250,
      }),
    ).toEqual([
      {
        date: 'May 20, 2026',
        status: 'Auto-pay scheduled',
        amount: '$250.00',
      },
    ]);
  });

  it('maps PAYMENTTODAY to a Today entry', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'PAYMENTTODAY',
        scheduledPaymentDate: '20260508',
        paymentAmount: 1000.5,
      }),
    ).toEqual([
      {
        date: 'May 8, 2026',
        status: 'Today',
        amount: '$1,000.50',
      },
    ]);
  });

  it('handles missing scheduledPaymentDate gracefully (still maps if amount present)', () => {
    const out = mapPaymentDetailToInProcess({
      paymentMessageStatusCode: 'PAYMENTSCHEDULED',
      paymentAmount: 100,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ date: '', status: 'Scheduled', amount: '$100.00' });
  });

  it('handles missing paymentAmount gracefully (still maps if date present)', () => {
    const out = mapPaymentDetailToInProcess({
      paymentMessageStatusCode: 'PAYMENTSCHEDULED',
      scheduledPaymentDate: '20260507',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ date: 'May 7, 2026', status: 'Scheduled', amount: '' });
  });

  it('returns [] when both date and amount are missing (degenerate paymentDetail)', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'PAYMENTSCHEDULED',
      }),
    ).toEqual([]);
  });

  it('formats negative amounts with a leading minus sign (matches recon-bar format)', () => {
    // Unusual case but possible if Chase ever returns a refund-style
    // negative paymentAmount. formatDollar handles it.
    const out = mapPaymentDetailToInProcess({
      paymentMessageStatusCode: 'PAYMENTSCHEDULED',
      scheduledPaymentDate: '20260507',
      paymentAmount: -50.25,
    });
    expect(out[0]?.amount).toBe('-$50.25');
  });

  it('skips unknown status codes (forward-compat: Chase invents a new status, we ignore it cleanly)', () => {
    expect(
      mapPaymentDetailToInProcess({
        paymentMessageStatusCode: 'SOMETHING_NEW_2027',
        scheduledPaymentDate: '20260507',
        paymentAmount: 100,
      }),
    ).toEqual([]);
  });
});
