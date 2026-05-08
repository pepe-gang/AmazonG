import { describe, expect, it } from 'vitest';
import {
  formatChaseYmdDate,
  mapBillpayActivitiesToInProcess,
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

describe('mapBillpayActivitiesToInProcess', () => {
  it('returns [] for null', () => {
    expect(mapBillpayActivitiesToInProcess(null)).toEqual([]);
  });

  it('returns [] for empty array', () => {
    expect(mapBillpayActivitiesToInProcess([])).toEqual([]);
  });

  it('filters to IN_PROCESS only and ignores COMPLETED / CANCELED / RETURNED', () => {
    const out = mapBillpayActivitiesToInProcess([
      { amount: 100, dueDate: '20260507', activityStatus: 'IN_PROCESS' },
      { amount: 50, dueDate: '20260501', activityStatus: 'COMPLETED' },
      { amount: 25, dueDate: '20260430', activityStatus: 'CANCELED' },
      { amount: 75, dueDate: '20260425', activityStatus: 'RETURNED' },
    ]);
    expect(out).toEqual([{ date: 'May 7, 2026', status: 'In process', amount: '$100.00' }]);
  });

  it('preserves multi-row coverage when several payments are IN_PROCESS simultaneously', () => {
    const out = mapBillpayActivitiesToInProcess([
      { amount: 6883.4, dueDate: '20260507', activityStatus: 'IN_PROCESS' },
      { amount: 3744.81, dueDate: '20260507', activityStatus: 'IN_PROCESS' },
      { amount: 250, dueDate: '20260601', activityStatus: 'IN_PROCESS' },
    ]);
    expect(out).toEqual([
      { date: 'May 7, 2026', status: 'In process', amount: '$6,883.40' },
      { date: 'May 7, 2026', status: 'In process', amount: '$3,744.81' },
      { date: 'Jun 1, 2026', status: 'In process', amount: '$250.00' },
    ]);
  });

  it('marks autoPayPayment IN_PROCESS rows distinctly so the renderer can show the auto-pay tag', () => {
    const out = mapBillpayActivitiesToInProcess([
      { amount: 100, dueDate: '20260507', activityStatus: 'IN_PROCESS', autoPayPayment: true },
      { amount: 50, dueDate: '20260601', activityStatus: 'IN_PROCESS', autoPayPayment: false },
    ]);
    expect(out).toEqual([
      { date: 'May 7, 2026', status: 'Auto-pay in process', amount: '$100.00' },
      { date: 'Jun 1, 2026', status: 'In process', amount: '$50.00' },
    ]);
  });

  it('handles missing date or amount gracefully (still maps if either is present)', () => {
    const out = mapBillpayActivitiesToInProcess([
      { amount: 100, activityStatus: 'IN_PROCESS' },
      { dueDate: '20260507', activityStatus: 'IN_PROCESS' },
    ]);
    expect(out).toEqual([
      { date: '', status: 'In process', amount: '$100.00' },
      { date: 'May 7, 2026', status: 'In process', amount: '' },
    ]);
  });

  it('drops entirely-empty IN_PROCESS rows (no date AND no amount — degenerate)', () => {
    const out = mapBillpayActivitiesToInProcess([
      { activityStatus: 'IN_PROCESS' },
      { amount: 100, dueDate: '20260507', activityStatus: 'IN_PROCESS' },
    ]);
    expect(out).toEqual([{ date: 'May 7, 2026', status: 'In process', amount: '$100.00' }]);
  });

  it('handles a non-array input by returning [] (defensive against shape drift)', () => {
    // simulate "Chase ships a refactor renaming paymentActivities to something else"
    expect(mapBillpayActivitiesToInProcess(undefined as unknown as null)).toEqual([]);
    expect(mapBillpayActivitiesToInProcess('oops' as unknown as null)).toEqual([]);
  });

  it('formats negative amounts with a leading minus (refund-style refunds remain rare but handled)', () => {
    const out = mapBillpayActivitiesToInProcess([
      { amount: -50.25, dueDate: '20260507', activityStatus: 'IN_PROCESS' },
    ]);
    expect(out).toEqual([
      { date: 'May 7, 2026', status: 'In process', amount: '-$50.25' },
    ]);
  });
});
