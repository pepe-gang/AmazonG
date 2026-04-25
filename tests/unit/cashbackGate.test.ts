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
    it('passes with the page reading when present, ignoring the floor', () => {
      // 5% on the page; floor is 6 (would normally fail strict), but
      // permissive accounts skip the floor entirely.
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 5,
          requireMinCashback: false,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 5, fellBackToDefault: false });
    });

    it('passes with the page reading even when it is 0', () => {
      // A real 0% reading is not the same as "Amazon didn't render a
      // line". Trust the page reading as-is — no fallback substitution.
      expect(
        evaluateCashbackGate({
          pageCashbackPct: 0,
          requireMinCashback: false,
          minCashbackPct: 6,
        }),
      ).toEqual({ kind: 'pass', cashbackPct: 0, fellBackToDefault: false });
    });

    it('substitutes DEFAULT_MISSING_CASHBACK_PCT when page reading is null', () => {
      // The crux of the feature: Amazon doesn't show a "% back" line
      // (e.g. the active payment card doesn't qualify for the visible
      // promo) but the order still earns the implicit baseline. Record
      // 5% so the dashboard isn't blank.
      expect(
        evaluateCashbackGate({
          pageCashbackPct: null,
          requireMinCashback: false,
          minCashbackPct: 6,
        }),
      ).toEqual({
        kind: 'pass',
        cashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
        fellBackToDefault: true,
      });
      expect(DEFAULT_MISSING_CASHBACK_PCT).toBe(5);
    });
  });

  describe('against a real /spc fixture', () => {
    it('lets a permissive account proceed when /spc only offers 5% back', () => {
      // Fixture: a real /spc page captured from a "5% only" deal — the
      // page renders a "5% back" line but no 6%/8% option. With the
      // strict gate (floor=6) this fails because 5 < 6; with a
      // permissive account it should pass and record 5%, so the buy
      // goes through and the dashboard reflects the actual rate.
      const html = fixture('spc-no-cashback-line-amex.html');
      const doc = new JSDOM(html).window.document;
      const pageCashbackPct = findCashbackPct(doc);
      expect(pageCashbackPct).toBe(5);

      const strict = evaluateCashbackGate({
        pageCashbackPct,
        requireMinCashback: true,
        minCashbackPct: 6,
      });
      expect(strict.kind).toBe('fail');
      if (strict.kind === 'fail') {
        expect(strict.reason).toBe('cashback 5%');
      }

      const permissive = evaluateCashbackGate({
        pageCashbackPct,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(permissive).toEqual({
        kind: 'pass',
        cashbackPct: 5,
        fellBackToDefault: false,
      });
    });

    it('substitutes 5% for a permissive account when /spc has no "% back" line at all', () => {
      // Synthetic null input (Amazon didn't render a cashback line —
      // e.g. selected payment card disqualified from the visible
      // promo). The permissive path defaults to 5%.
      const v = evaluateCashbackGate({
        pageCashbackPct: null,
        requireMinCashback: false,
        minCashbackPct: 6,
      });
      expect(v).toEqual({
        kind: 'pass',
        cashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
        fellBackToDefault: true,
      });
    });
  });
});
