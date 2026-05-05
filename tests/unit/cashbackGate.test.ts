import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findCashbackPct } from '../../src/parsers/amazonProduct.js';
import {
  DEFAULT_MISSING_CASHBACK_PCT,
  evaluateCashbackGate,
} from '../../src/shared/cashbackGate.js';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../fixtures', name), 'utf8');
}

describe('evaluateCashbackGate', () => {
  describe('strict (requireMinCashback=true)', () => {
    it('passes when page reading meets the floor exactly', () => {
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 6,
          requireMinCashback: true,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 6, fellBackToDefault: false });
    });

    it('passes when page reading exceeds the floor', () => {
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 8,
          requireMinCashback: true,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 8, fellBackToDefault: false });
    });

    it('fails when page reading is below the floor', () => {
      const v = evaluateCashbackGate({
        pageCashbackPct: 5,
        requireMinCashback: true,
        minCashbackPct: 6,
      });
      expect(v.kind).toBe('fail');
      if (v.kind === 'fail') {
        expect(v.cashbackPct).toBe(5);
        expect(v.reason).toBe('cashback 5%');
      }
    });

    it('fails with `cashback missing` when page has no reading', () => {
      const v = evaluateCashbackGate({
        pageCashbackPct: null,
        requireMinCashback: true,
        minCashbackPct: 6,
      });
      expect(v.kind).toBe('fail');
      if (v.kind === 'fail') {
        expect(v.cashbackPct).toBeNull();
        expect(v.reason).toBe('cashback missing');
      }
    });
  });

  describe('permissive (requireMinCashback=false)', () => {
    // Updated 2026-05-05 (INC-2026-05-05) — permissive mode used to
    // pass any reading regardless of floor, which let an iPad order
    // place at 5% under a 6% floor (the parser handed back 6 from a
    // sibling group's radio, but the actual selected delivery on the
    // target was Standard at 5%; even if the parser had been honest,
    // permissive mode would have accepted 5 < 6). Permissive mode now
    // hard-fails when the reading (or the substitute default) is below
    // the floor. It still skips the BG1/BG2 retry path — that's what
    // the flag was originally for.

    it('passes when page reading meets or exceeds the floor', () => {
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 6,
          requireMinCashback: false,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 6, fellBackToDefault: false });
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 8,
          requireMinCashback: false,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 8, fellBackToDefault: false });
    });

    it('FAILS when the page reading is below the floor (was: passed before INC-2026-05-05)', () => {
      const v = evaluateCashbackGate({
        pageCashbackPct: 5,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(v.kind).toBe('fail');
      if (v.kind === 'fail') {
        expect(v.cashbackPct).toBe(5);
        expect(v.reason).toMatch(/5%.*6%/);
      }
    });

    it('FAILS when the page reading is 0 and floor is 6', () => {
      const v = evaluateCashbackGate({
        pageCashbackPct: 0,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(v.kind).toBe('fail');
    });

    it('substitutes DEFAULT_MISSING_CASHBACK_PCT (5) when page reading is null AND floor is ≤ 5', () => {
      // Amazon didn't render a "% back" line. Permissive mode falls
      // back to the implicit 5% baseline through the user's underlying
      // card. Only safe to pass when the floor allows it.
      expect(
        evaluateCashbackGate({
          pageCashbackPct: null,
          requireMinCashback: false,
          minCashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
        }),
      ).toEqual({
        kind: 'pass',
        cashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
        fellBackToDefault: true,
      });
      expect(DEFAULT_MISSING_CASHBACK_PCT).toBe(5);
    });

    it('FAILS when page reading is null AND floor is above the substitute default', () => {
      const v = evaluateCashbackGate({
        pageCashbackPct: null,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(v.kind).toBe('fail');
      if (v.kind === 'fail') {
        expect(v.cashbackPct).toBeNull();
        expect(v.reason).toMatch(/permissive default.*5%.*floor.*6%/i);
      }
    });
  });

  describe('against a real /spc fixture', () => {
    it('a permissive account on a 5% deal STILL fails at a 6% floor (INC-2026-05-05 fix)', () => {
      // Fixture: a real /spc page captured from a "5% only" deal — the
      // page renders a "5% back" line but no 6%/8% option. Both strict
      // and permissive modes must fail here because 5 < 6.
      const html = fixture('spc/no-cashback-line-amex.html');
      const doc = new JSDOM(html).window.document;
      const pageCashbackPct = findCashbackPct(doc);
      expect(pageCashbackPct).toBe(5);

      const strict = evaluateCashbackGate({
        pageCashbackPct,
        requireMinCashback: true,
        minCashbackPct: 6,
      });
      expect(strict.kind).toBe('fail');

      const permissive = evaluateCashbackGate({
        pageCashbackPct,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(permissive.kind).toBe('fail');
    });

    it('a permissive account on a 5% deal passes when its floor is also 5%', () => {
      const html = fixture('spc/no-cashback-line-amex.html');
      const doc = new JSDOM(html).window.document;
      const pageCashbackPct = findCashbackPct(doc);

      const v = evaluateCashbackGate({
        pageCashbackPct,
        requireMinCashback: false,
        minCashbackPct: 5,
      });
      expect(v).toEqual({ kind: 'pass', cashbackPct: 5, fellBackToDefault: false });
    });
  });
});
