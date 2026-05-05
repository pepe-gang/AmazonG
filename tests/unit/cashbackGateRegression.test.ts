import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTargetCashbackFromDom } from '../../src/parsers/amazonCheckout';
import {
  DEFAULT_MISSING_CASHBACK_PCT,
  evaluateCashbackGate,
} from '../../src/shared/cashbackGate';

const FIX = join(__dirname, '../../fixtures/spc');

function docOf(file: string): Document {
  return new JSDOM(readFileSync(join(FIX, file), 'utf8')).window.document;
}

/**
 * INC-2026-05-05 regression — the iPad target's checked delivery radio
 * was Standard ("Friday, May 8") with NO "% back" in its label. The
 * iPad's specific shipping group had no Amazon Day option at all.
 *
 * Before the fix:
 *   - The group walk skipped past the iPad's own group (no "% back" in
 *     its scope) and kept walking outward until it found a wider
 *     ancestor that contained both the iPad's group AND the fillers'
 *     group.
 *   - The fillers' group had a "6% back" radio checked.
 *   - Parser falsely returned `pct: 6` for the iPad.
 *   - Strict gate passed. Order placed at the iPad's actual 5%
 *     (Standard, no Amazon Day uplift). 1% on a $1,250 order = ~$12.50
 *     of real money lost per order.
 *
 * After the fix:
 *   - Walk stops at the innermost Arriving+radio ancestor (the iPad's
 *     own group), regardless of whether it contains "% back".
 *   - Iphpad group has no "% back" radio → `pct: null`.
 *   - Strict gate fails: cashback missing.
 *   - Permissive gate (with 6% floor) also fails because the
 *     substitute default (5%) is below the floor.
 */
describe('cashback gate regression — INC-2026-05-05 (iPad target without Amazon Day)', () => {
  const FILE = 'inc-2026-05-05-ipad-target-no-amazon-day.html';
  const TARGET_ASIN = 'B0DZ77D5HL';
  const TARGET_TITLE = 'Apple iPad 11-inch: A16 chip, 11-inch Model';

  it('parser scopes to iPad’s own shipping group and returns pct=null when no % back radio is in scope', () => {
    const hit = readTargetCashbackFromDom(docOf(FILE), TARGET_ASIN, TARGET_TITLE);
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.pct, 'iPad selected std-us with no "% back" in label → must be null, NOT a borrowed % from a sibling group').toBeNull();
    // Sanity: scope SHOULD contain "Arriving" but the % readings (if
    // any) inside the scope should not include a 6 because the iPad's
    // own group has no Amazon Day option.
    expect(hit.scopeMatches.some((m) => /6\s*%/i.test(m))).toBe(false);
  });

  it('strict gate (requireMinCashback=true) fails with "cashback missing"', () => {
    const hit = readTargetCashbackFromDom(docOf(FILE), TARGET_ASIN, TARGET_TITLE);
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    const verdict = evaluateCashbackGate({
      pageCashbackPct: hit.pct,
      requireMinCashback: true,
      minCashbackPct: 6,
    });
    expect(verdict.kind).toBe('fail');
    if (verdict.kind === 'fail') {
      expect(verdict.reason).toMatch(/cashback missing/i);
    }
  });

  it('permissive gate (requireMinCashback=false) STILL fails when 6% floor > 5% default substitute', () => {
    const hit = readTargetCashbackFromDom(docOf(FILE), TARGET_ASIN, TARGET_TITLE);
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(DEFAULT_MISSING_CASHBACK_PCT).toBeLessThan(6);
    const verdict = evaluateCashbackGate({
      pageCashbackPct: hit.pct,
      requireMinCashback: false,
      minCashbackPct: 6,
    });
    expect(verdict.kind, 'permissive substitute (5%) is below the 6% floor — must NOT pass').toBe('fail');
  });

  it('permissive gate at 5% floor still passes (substitute = floor exactly)', () => {
    const hit = readTargetCashbackFromDom(docOf(FILE), TARGET_ASIN, TARGET_TITLE);
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    const verdict = evaluateCashbackGate({
      pageCashbackPct: hit.pct,
      requireMinCashback: false,
      minCashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
    });
    expect(verdict.kind).toBe('pass');
  });
});

/**
 * Cross-check the existing healthy fixture still passes after the
 * walk-narrowing change. The fillers-macbook-checked-6pct fixture has
 * Amazon Day checked in the macbook's own shipping group, so the
 * narrower walk still finds the 6% radio in scope.
 */
describe('cashback gate — healthy fixture still detects 6% correctly after walk narrowing', () => {
  it('fillers + macbook 6% (target group has Amazon Day radio checked)', () => {
    const ASIN = 'B0FWD726XF';
    const hit = readTargetCashbackFromDom(
      docOf('fillers-macbook-B0FWD726XF-checked-6pct.html'),
      ASIN,
      'Apple 2025 MacBook Pro Laptop with Apple M5 chip with 10-core CPU and 10-core GPU',
    );
    expect(hit.found).toBe(true);
    if (!hit.found) return;
    expect(hit.pct).toBe(6);
  });
});
