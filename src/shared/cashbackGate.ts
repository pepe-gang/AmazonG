/**
 * Pure evaluator for the cashback gate that guards Place Order.
 *
 * Two account modes, driven by `AmazonAccount.requireMinCashback` on
 * BG (toggled per account from AmazonG's Accounts page):
 *
 *   - Strict (`requireMinCashback: true`, the default):
 *       Enforce the configured floor. If the page's `% back` reading
 *       is null or below the floor, return a `fail` verdict. The
 *       buy flow then runs the BG1/BG2 name-toggle workaround and
 *       re-evaluates; if still under, the buy aborts at
 *       `cashback_gate`.
 *
 *   - Permissive (`requireMinCashback: false`):
 *       Skip the gate. Always pass. If Amazon doesn't render a
 *       `% back` line on /spc (e.g. the active payment card doesn't
 *       qualify for the visible promo), substitute
 *       `DEFAULT_MISSING_CASHBACK_PCT`. The substituted value flows
 *       through `BuyResult.cashbackPct` → BG's status report →
 *       `AutoBuyPurchase.placedCashbackPct`, so the dashboard shows
 *       5% rather than "—" for these orders.
 *
 * Centralizing this in one pure helper means buyNow.ts and
 * buyWithFillers.ts agree on the rule and the unit tests can drive
 * every branch with a fixture HTML — no Playwright needed.
 */

/**
 * Domain fact: when Amazon's /spc page doesn't show a "N% back" line
 * for a permissive-account purchase, the order still earns 5%
 * cashback through the user's underlying card/program. Substituted
 * into BuyResult.cashbackPct so the recorded value isn't null.
 *
 * Hardcoded for now — exposed as a per-account setting later if
 * different users settle on different baselines.
 */
export const DEFAULT_MISSING_CASHBACK_PCT = 5;

export type CashbackGateInput = {
  /** Result of `findCashbackPct(doc)` against the live /spc page. */
  pageCashbackPct: number | null;
  /** Per-account toggle. False = permissive (skip gate, default null to 5). */
  requireMinCashback: boolean;
  /** Floor used when the gate is enforced. Typically 6. */
  minCashbackPct: number;
};

export type CashbackGateVerdict =
  | {
      kind: 'pass';
      /** What to record on `BuyResult.cashbackPct` and report to BG.
       *  Equal to the page reading when present, otherwise the
       *  default-missing fallback for permissive accounts. */
      cashbackPct: number;
      /** True when `cashbackPct` came from the missing-default rather
       *  than the live page. Useful for logs / diagnostics. */
      fellBackToDefault: boolean;
    }
  | {
      kind: 'fail';
      /** Pass-through of the page reading (null if Amazon didn't show
       *  a line). Caller emits this to its `error` field unchanged. */
      cashbackPct: number | null;
      /** Human-readable reason in the same shape `buyNow` already uses
       *  for `cashback_gate` failures. */
      reason: string;
    };

export function evaluateCashbackGate(input: CashbackGateInput): CashbackGateVerdict {
  const { pageCashbackPct, requireMinCashback, minCashbackPct } = input;
  if (!requireMinCashback) {
    // Permissive accounts substitute DEFAULT_MISSING_CASHBACK_PCT (5)
    // when /spc didn't render a "% back" line. That substitution is
    // ONLY safe when the floor is ≤ the substitute — otherwise we'd
    // pass a buy at 5% under a 6% floor, costing 1% in real money.
    // INC-2026-05-05: the iPad order placed at 5% under a 6% floor
    // because permissive mode unconditionally passed.
    if (pageCashbackPct === null) {
      if (DEFAULT_MISSING_CASHBACK_PCT < minCashbackPct) {
        return {
          kind: 'fail',
          cashbackPct: null,
          reason: `cashback missing (permissive default ${DEFAULT_MISSING_CASHBACK_PCT}% < floor ${minCashbackPct}%)`,
        };
      }
      return {
        kind: 'pass',
        cashbackPct: DEFAULT_MISSING_CASHBACK_PCT,
        fellBackToDefault: true,
      };
    }
    // Page reading present — even permissive mode must not pass below
    // the floor. The "skip the gate" framing in the original docstring
    // referred to the BG1/BG2 retry path; the floor itself is non-
    // negotiable.
    if (pageCashbackPct < minCashbackPct) {
      return {
        kind: 'fail',
        cashbackPct: pageCashbackPct,
        reason: `cashback ${pageCashbackPct}% (below ${minCashbackPct}% floor)`,
      };
    }
    return { kind: 'pass', cashbackPct: pageCashbackPct, fellBackToDefault: false };
  }
  if (pageCashbackPct === null) {
    return { kind: 'fail', cashbackPct: null, reason: 'cashback missing' };
  }
  if (pageCashbackPct < minCashbackPct) {
    return { kind: 'fail', cashbackPct: pageCashbackPct, reason: `cashback ${pageCashbackPct}%` };
  }
  return { kind: 'pass', cashbackPct: pageCashbackPct, fellBackToDefault: false };
}
