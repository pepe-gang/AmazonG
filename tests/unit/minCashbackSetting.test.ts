import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCashbackGate } from '../../src/shared/cashbackGate.js';

/**
 * Feature: user-configurable minimum cashback % (Settings → "Minimum
 * cashback %"). The gate evaluator was already parametric on
 * `minCashbackPct`; these tests pin the two behaviors the feature
 * relies on:
 *   1. The gate honors an arbitrary floor (not just the old hardcoded 6).
 *   2. loadSettings persists + clamps the value the UI writes.
 */

describe('custom cashback floor gates at the configured number', () => {
  // The Prime Day scenario from the feature request: user sets 8%.
  const floor = 8;

  it('rejects readings below the custom floor (7% < 8%)', () => {
    for (const requireMinCashback of [true, false]) {
      const v = evaluateCashbackGate({
        pageCashbackPct: 7,
        requireMinCashback,
        minCashbackPct: floor,
      });
      expect(v.kind).toBe('fail');
      if (v.kind === 'fail') expect(v.cashbackPct).toBe(7);
    }
  });

  it('passes at exactly the custom floor (8% == 8%)', () => {
    expect(
      evaluateCashbackGate({
        pageCashbackPct: 8,
        requireMinCashback: true,
        minCashbackPct: floor,
      }),
    ).toEqual({ kind: 'pass', cashbackPct: 8, fellBackToDefault: false });
  });

  it('passes above the custom floor (9%, 10% >= 8%)', () => {
    for (const pct of [9, 10]) {
      expect(
        evaluateCashbackGate({
          pageCashbackPct: pct,
          requireMinCashback: true,
          minCashbackPct: floor,
        }).kind,
      ).toBe('pass');
    }
  });

  it('a 6% deal that USED to pass now fails once the floor is raised to 8%', () => {
    // Before this feature the floor was hardcoded at 6, so a 6% deal
    // passed. Raising the floor must now reject it.
    expect(
      evaluateCashbackGate({
        pageCashbackPct: 6,
        requireMinCashback: true,
        minCashbackPct: 6,
      }).kind,
    ).toBe('pass');
    expect(
      evaluateCashbackGate({
        pageCashbackPct: 6,
        requireMinCashback: true,
        minCashbackPct: 8,
      }).kind,
    ).toBe('fail');
  });

  it('floor of 0 disables the gate (any non-null reading passes)', () => {
    for (const pct of [0, 1, 6]) {
      expect(
        evaluateCashbackGate({
          pageCashbackPct: pct,
          requireMinCashback: true,
          minCashbackPct: 0,
        }).kind,
      ).toBe('pass');
    }
  });
});

// loadSettings reads electron's userData dir; point it at a temp dir.
const h = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));

describe('loadSettings persists + clamps minCashbackPct', () => {
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), 'amazong-settings-'));
  });
  afterEach(() => {
    rmSync(h.dir, { recursive: true, force: true });
  });

  async function writeAndLoad(minCashbackPct: unknown) {
    writeFileSync(
      join(h.dir, 'settings.json'),
      JSON.stringify({ minCashbackPct }),
      'utf8',
    );
    const { loadSettings } = await import('../../src/main/settings.js');
    return loadSettings();
  }

  it('round-trips a valid user value (8)', async () => {
    const s = await writeAndLoad(8);
    expect(s.minCashbackPct).toBe(8);
  });

  it('clamps a value above the 30% ceiling', async () => {
    const s = await writeAndLoad(999);
    expect(s.minCashbackPct).toBe(30);
  });

  it('clamps a negative value up to 0', async () => {
    const s = await writeAndLoad(-5);
    expect(s.minCashbackPct).toBe(0);
  });

  it('falls back to the default (6) on a NaN / garbage value', async () => {
    const s = await writeAndLoad('not-a-number');
    expect(s.minCashbackPct).toBe(6);
  });

  it('uses the default (6) when the field is absent', async () => {
    writeFileSync(join(h.dir, 'settings.json'), JSON.stringify({}), 'utf8');
    const { loadSettings } = await import('../../src/main/settings.js');
    const s = await loadSettings();
    expect(s.minCashbackPct).toBe(6);
  });
});
