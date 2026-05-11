import { describe, expect, it } from 'vitest';
import {
  buildBuyJobReport,
  syntheticFailedResult,
} from '../../src/workflows/jobReport';
import type { ProfileResult } from '../../src/workflows/pollAndScrape';

/**
 * Tests for the BG-status-report aggregation. Pin the rollup logic so
 * a future refactor (or a streaming-vs-pmap divergence) can't silently
 * break the BG contract.
 */

function res(overrides: Partial<ProfileResult> & { email: string; status: ProfileResult['status'] }): ProfileResult {
  return {
    orderId: null,
    placedPrice: null,
    placedCashbackPct: null,
    placedAt: null,
    placedQuantity: 0,
    error: null,
    stage: null,
    dryRun: false,
    fillerOrderIds: [],
    amazonPurchaseId: null,
    targetAsin: null,
    ...overrides,
  };
}

describe('buildBuyJobReport — overall status rollup', () => {
  it('all success → awaiting_verification', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', orderId: '111-1' }),
        res({ email: 'b@x', status: 'completed', orderId: '111-2' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('awaiting_verification');
    expect(r.error).toBeUndefined();
  });

  it('mixed success + failure → partial', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', orderId: '111-1' }),
        res({ email: 'b@x', status: 'failed', error: 'oos' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('partial');
  });

  it('mixed success + action_required → partial', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', orderId: '111-1' }),
        res({ email: 'b@x', status: 'action_required', error: 'signed_out' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('partial');
  });

  it('all failed (no success, no dry-run, no action_required) → failed', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'failed', error: 'cashback_gate' }),
        res({ email: 'b@x', status: 'failed', error: 'oos' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('cashback_gate');  // first failure's error
  });

  it('no success, only action_required → action_required', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'action_required', error: 'verify-card' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('action_required');
    expect(r.error).toBe('verify-card');
  });

  it('all dry-run successes → failed with [DRY RUN OK] prefix', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', dryRun: true }),
        res({ email: 'b@x', status: 'completed', dryRun: true }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^\[DRY RUN OK\]/);
    expect(r.error).toContain('2 profile(s)');
  });

  it('mixed dry-run + real failures → failed with [DRY RUN] (no OK)', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', dryRun: true }),
        res({ email: 'b@x', status: 'failed', error: 'oos' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^\[DRY RUN\]/);
    expect(r.error).not.toMatch(/\[DRY RUN OK\]/);
  });

  it('empty results array → failed with default error', () => {
    const r = buildBuyJobReport({
      results: [],
      fillerByEmail: new Map(),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toBe('all profiles failed');
  });
});

describe('buildBuyJobReport — winner selection (placed* fields)', () => {
  it('picks highest-cashback successful real result', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', placedCashbackPct: 4, orderId: '111-1' }),
        res({ email: 'b@x', status: 'completed', placedCashbackPct: 6, orderId: '111-2', placedPrice: '$50' }),
        res({ email: 'c@x', status: 'completed', placedCashbackPct: 3, orderId: '111-3' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.placedEmail).toBe('b@x');
    expect(r.placedCashbackPct).toBe(6);
    expect(r.placedOrderId).toBe('111-2');
    expect(r.placedPrice).toBe('$50');
  });

  it('breaks ties by first-appearance order', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'first@x', status: 'completed', placedCashbackPct: 6, orderId: '111-1' }),
        res({ email: 'second@x', status: 'completed', placedCashbackPct: 6, orderId: '111-2' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.placedEmail).toBe('first@x');
  });

  it('treats null placedCashbackPct as 0 for ranking', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'completed', placedCashbackPct: null, orderId: '111-1' }),
        res({ email: 'b@x', status: 'completed', placedCashbackPct: 5, orderId: '111-2' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.placedEmail).toBe('b@x');
  });

  it('does NOT pick dry-run results as winner', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'dry@x', status: 'completed', dryRun: true, placedCashbackPct: 9 }),
        res({ email: 'real@x', status: 'completed', dryRun: false, placedCashbackPct: 3, orderId: '111-1' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.placedEmail).toBe('real@x');
  });

  it('placed fields are null when no real success', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'a@x', status: 'failed', error: 'oos' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.placedEmail).toBeNull();
    expect(r.placedOrderId).toBeNull();
    expect(r.placedAt).toBeNull();
    expect(r.placedCashbackPct).toBeNull();
    expect(r.placedPrice).toBeNull();
  });
});

describe('buildBuyJobReport — purchases rows', () => {
  it('completed-real → awaiting_verification', () => {
    const r = buildBuyJobReport({
      results: [res({ email: 'a@x', status: 'completed', orderId: '111-1', placedQuantity: 3 })],
      fillerByEmail: new Map(),
    });
    expect(r.purchases).toHaveLength(1);
    expect(r.purchases![0]!.status).toBe('awaiting_verification');
    expect(r.purchases![0]!.purchasedCount).toBe(3);
    expect(r.purchases![0]!.orderId).toBe('111-1');
  });

  it('completed-dryrun → failed (BG must NOT schedule verify)', () => {
    const r = buildBuyJobReport({
      results: [res({ email: 'a@x', status: 'completed', dryRun: true })],
      fillerByEmail: new Map(),
    });
    expect(r.purchases![0]!.status).toBe('failed');
  });

  it('action_required → action_required', () => {
    const r = buildBuyJobReport({
      results: [res({ email: 'a@x', status: 'action_required', error: 'signed_out' })],
      fillerByEmail: new Map(),
    });
    expect(r.purchases![0]!.status).toBe('action_required');
    expect(r.purchases![0]!.error).toBe('signed_out');
  });

  it('failed → failed', () => {
    const r = buildBuyJobReport({
      results: [res({ email: 'a@x', status: 'failed', error: 'oos', stage: 'product_check' })],
      fillerByEmail: new Map(),
    });
    expect(r.purchases![0]!.status).toBe('failed');
    expect(r.purchases![0]!.error).toBe('oos');
    expect(r.purchases![0]!.stage).toBe('product_check');
  });

  it('viaFiller=true is included only on completed-real with filler-mode profile', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'filler@x', status: 'completed', orderId: '111-1' }),
        res({ email: 'single@x', status: 'completed', orderId: '111-2' }),
        res({ email: 'failed-filler@x', status: 'failed', error: 'oos' }),
        res({ email: 'dryrun-filler@x', status: 'completed', dryRun: true }),
      ],
      fillerByEmail: new Map([
        ['filler@x', true],
        ['failed-filler@x', true],
        ['dryrun-filler@x', true],
        ['single@x', false],
      ]),
    });
    const byEmail = new Map(r.purchases!.map((p) => [p.amazonEmail, p]));
    expect((byEmail.get('filler@x') as { viaFiller?: boolean }).viaFiller).toBe(true);
    expect((byEmail.get('single@x') as { viaFiller?: boolean }).viaFiller).toBeUndefined();
    expect((byEmail.get('failed-filler@x') as { viaFiller?: boolean }).viaFiller).toBeUndefined();
    expect((byEmail.get('dryrun-filler@x') as { viaFiller?: boolean }).viaFiller).toBeUndefined();
  });

  it('fillerOrderIds is included only when non-empty', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'has@x', status: 'completed', orderId: '111-1', fillerOrderIds: ['F-1', 'F-2'] }),
        res({ email: 'empty@x', status: 'completed', orderId: '111-2', fillerOrderIds: [] }),
      ],
      fillerByEmail: new Map(),
    });
    expect((r.purchases![0]! as { fillerOrderIds?: string[] }).fillerOrderIds).toEqual(['F-1', 'F-2']);
    expect((r.purchases![1]! as { fillerOrderIds?: string[] }).fillerOrderIds).toBeUndefined();
  });

  it('amazonPurchaseId is included only when set', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'pid@x', status: 'completed', orderId: '111-1', amazonPurchaseId: 'p-X' }),
        res({ email: 'no-pid@x', status: 'completed', orderId: '111-2', amazonPurchaseId: null }),
      ],
      fillerByEmail: new Map(),
    });
    expect((r.purchases![0]! as { amazonPurchaseId?: string }).amazonPurchaseId).toBe('p-X');
    expect((r.purchases![1]! as { amazonPurchaseId?: string }).amazonPurchaseId).toBeUndefined();
  });

  it('stage is included only when set (truthy)', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'with-stage@x', status: 'failed', error: 'X', stage: 'cashback_gate' }),
        res({ email: 'no-stage@x', status: 'failed', error: 'Y', stage: null }),
      ],
      fillerByEmail: new Map(),
    });
    expect((r.purchases![0]! as { stage?: string }).stage).toBe('cashback_gate');
    expect((r.purchases![1]! as { stage?: string }).stage).toBeUndefined();
  });

  it('preserves input order in purchases array', () => {
    const r = buildBuyJobReport({
      results: [
        res({ email: 'first@x', status: 'completed' }),
        res({ email: 'middle@x', status: 'failed', error: 'X' }),
        res({ email: 'last@x', status: 'action_required', error: 'Y' }),
      ],
      fillerByEmail: new Map(),
    });
    expect(r.purchases!.map((p) => p.amazonEmail)).toEqual(['first@x', 'middle@x', 'last@x']);
  });
});

describe('syntheticFailedResult', () => {
  it('returns a fully-shaped failed ProfileResult', () => {
    const r = syntheticFailedResult('victim@x', 'lock acquire failed');
    expect(r.email).toBe('victim@x');
    expect(r.status).toBe('failed');
    expect(r.error).toBe('lock acquire failed');
    expect(r.dryRun).toBe(false);
    expect(r.placedQuantity).toBe(0);
    expect(r.fillerOrderIds).toEqual([]);
    // every other optional field is null
    expect(r.orderId).toBeNull();
    expect(r.placedPrice).toBeNull();
    expect(r.placedCashbackPct).toBeNull();
    expect(r.placedAt).toBeNull();
    expect(r.stage).toBeNull();
    expect(r.amazonPurchaseId).toBeNull();
  });

  it('result feeds buildBuyJobReport without crashing', () => {
    // Regression guard: synthetic must satisfy buildBuyJobReport's
    // shape contract.
    const synth = syntheticFailedResult('victim@x', 'worker stopping');
    const r = buildBuyJobReport({ results: [synth], fillerByEmail: new Map() });
    expect(r.status).toBe('failed');
    expect(r.purchases).toHaveLength(1);
    expect(r.purchases![0]!.status).toBe('failed');
    expect(r.purchases![0]!.error).toBe('worker stopping');
  });
});
