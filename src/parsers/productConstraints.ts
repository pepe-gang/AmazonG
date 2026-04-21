import type { ProductInfo } from '../shared/types.js';

export type Constraints = {
  maxPrice: number | null;
  requireInStock: boolean;
  requireNew: boolean;
  requireShipping: boolean;
  requirePrime: boolean;
  requireBuyNow: boolean;
};

export type VerifyReason =
  | 'oos'
  | 'price_too_high'
  | 'price_unknown'
  | 'used_condition'
  | 'renewed_condition'
  | 'wont_ship'
  | 'not_prime'
  | 'no_buy_now'
  | 'quantity_limit';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyReason; detail: string };

export type CheckName =
  | 'inStock'
  | 'price'
  | 'condition'
  | 'shipping'
  | 'prime'
  | 'buyNow';

export type CheckStep = {
  name: CheckName;
  pass: boolean;
  skipped?: boolean;
  observed: string;
  expected: string;
  reason?: VerifyReason;
  detail?: string;
};

export type VerifyReport = {
  ok: boolean;
  reason?: VerifyReason;
  detail?: string;
  steps: CheckStep[];
};

export const DEFAULT_CONSTRAINTS: Omit<Constraints, 'maxPrice'> = {
  requireInStock: true,
  requireNew: true,
  requireShipping: true,
  requirePrime: true, // visible ✓prime badge required (matches AutoG buy-flow expectation)
  requireBuyNow: true, // must actually be buyable right now
};

/**
 * Dollar slack on maxPrice comparisons. Only applied when the cap is
 * ≥ $100 — BG typically sends whole-dollar caps (e.g. $399.00) and
 * Amazon prices end in .99 / .95, so a strict `price <= cap` would
 * reject a $399.99 buy against a $399 cap over 99 cents. For cheap
 * items (cap < $100) we keep strict comparison — a $1 gap is a
 * meaningful percentage of a $20 item and usually a signal the deal
 * is mispriced or stale.
 */
export function effectivePriceTolerance(cap: number): number {
  return cap >= 100 ? 1.0 : 0;
}

/**
 * Runs every configured check in order and returns a full report of each
 * step's outcome (pass/fail/skipped). Use this when you want granular
 * logging of "which checks ran and which fired a failure" — the workflow
 * emits one log line per step so users can see the whole evaluation.
 *
 * Short-circuits on the first failure (downstream checks are not run),
 * matching the behavior of checkProductConstraints.
 */
export function verifyProductDetailed(
  info: ProductInfo,
  c: Constraints,
): VerifyReport {
  const steps: CheckStep[] = [];

  // Special-case: a known "quantity limit met" blocker surfaces a specific
  // reason and short-circuits before every other check — the item isn't oos,
  // the account just can't buy more. Reported under the buyNow step.
  const blocker = info.buyBlocker?.trim() ?? null;
  if (blocker && /quantity\s+limit/i.test(blocker)) {
    const step: CheckStep = {
      name: 'buyNow',
      pass: false,
      observed: blocker,
      expected: 'buyable',
      reason: 'quantity_limit',
      detail: blocker,
    };
    steps.push(step);
    return { ok: false, reason: 'quantity_limit', detail: blocker, steps };
  }

  // 1. In stock
  if (c.requireInStock) {
    const pass = info.inStock;
    const step: CheckStep = {
      name: 'inStock',
      pass,
      observed: info.inStock
        ? info.availabilityText ?? 'in stock'
        : info.availabilityText ?? 'not in stock',
      expected: 'in stock',
      ...(pass
        ? {}
        : {
            reason: 'oos' as VerifyReason,
            detail: info.availabilityText ?? 'product not in stock',
          }),
    };
    steps.push(step);
    if (!pass) return { ok: false, reason: step.reason, detail: step.detail, steps };
  } else {
    steps.push({ name: 'inStock', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  // 2. Price
  if (c.maxPrice !== null) {
    const cap = c.maxPrice;
    if (info.price === null) {
      const step: CheckStep = {
        name: 'price',
        pass: false,
        observed: 'parse failed',
        expected: `≤ $${cap.toFixed(2)}`,
        reason: 'price_unknown',
        // No parseable price element on the PDP almost always means the
        // listing is OOS — Amazon hides the price block when the buy box
        // is in its "Currently unavailable" state. Surface this as the
        // user-friendly "Out of stock" rather than a parser-flavored msg.
        detail: 'Out of stock',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    const tol = effectivePriceTolerance(cap);
    const pass = info.price <= cap + tol;
    const expected =
      tol > 0
        ? `≤ $${cap.toFixed(2)} (+$${tol.toFixed(2)} tol)`
        : `≤ $${cap.toFixed(2)}`;
    const step: CheckStep = {
      name: 'price',
      pass,
      observed: info.priceText ?? `$${info.price}`,
      expected,
      ...(pass
        ? {}
        : {
            reason: 'price_too_high' as VerifyReason,
            detail:
              tol > 0
                ? `${info.priceText ?? `$${info.price}`} exceeds max $${cap.toFixed(2)} (+$${tol.toFixed(2)} tolerance)`
                : `${info.priceText ?? `$${info.price}`} exceeds max $${cap.toFixed(2)}`,
          }),
    };
    steps.push(step);
    if (!pass) return { ok: false, reason: step.reason, detail: step.detail, steps };
  } else {
    steps.push({ name: 'price', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  // 3. Condition
  if (c.requireNew) {
    const cond = info.condition;
    if (cond === 'used') {
      const step: CheckStep = {
        name: 'condition',
        pass: false,
        observed: 'used',
        expected: 'new',
        reason: 'used_condition',
        detail: 'listing is Used',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    if (cond === 'renewed') {
      const step: CheckStep = {
        name: 'condition',
        pass: false,
        observed: 'renewed',
        expected: 'new',
        reason: 'renewed_condition',
        detail: 'listing is Amazon Renewed',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    steps.push({
      name: 'condition',
      pass: true,
      observed: cond ?? 'new (no used/renewed signal)',
      expected: 'new',
    });
  } else {
    steps.push({ name: 'condition', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  // 4. Shipping
  if (c.requireShipping) {
    if (info.shipsToAddress === false) {
      const step: CheckStep = {
        name: 'shipping',
        pass: false,
        observed: 'cannot ship to address',
        expected: 'ships to address',
        reason: 'wont_ship',
        detail: 'item cannot ship to the account address',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    steps.push({
      name: 'shipping',
      pass: true,
      observed: info.shipsToAddress === true ? 'ships to address' : 'no shipping blocker detected',
      expected: 'ships to address',
    });
  } else {
    steps.push({ name: 'shipping', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  // 5. Prime
  if (c.requirePrime) {
    if (info.isPrime === false) {
      const step: CheckStep = {
        name: 'prime',
        pass: false,
        observed: 'no visible prime badge',
        expected: 'prime badge',
        reason: 'not_prime',
        detail: 'item is not Prime-eligible',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    steps.push({
      name: 'prime',
      pass: true,
      observed: info.isPrime === true ? 'prime badge visible' : 'indeterminate (assumed ok)',
      expected: 'prime badge',
    });
  } else {
    steps.push({ name: 'prime', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  // 6. Buy Now available
  if (c.requireBuyNow) {
    if (info.hasBuyNow === false) {
      const step: CheckStep = {
        name: 'buyNow',
        pass: false,
        observed: blocker ?? 'no buy-now button',
        expected: 'buy-now button',
        reason: 'no_buy_now',
        detail: blocker ?? 'Buy Now button is not available (variation required or unavailable)',
      };
      steps.push(step);
      return { ok: false, reason: step.reason, detail: step.detail, steps };
    }
    steps.push({
      name: 'buyNow',
      pass: true,
      observed: info.hasBuyNow === true ? 'buy-now button ready' : 'indeterminate (assumed ok)',
      expected: 'buy-now button',
    });
  } else {
    steps.push({ name: 'buyNow', pass: true, skipped: true, observed: '-', expected: 'n/a' });
  }

  return { ok: true, steps };
}

export function checkProductConstraints(
  info: ProductInfo,
  c: Constraints,
): VerifyResult {
  // A known, specific buy-blocker (e.g. "Quantity limit met for this seller")
  // should report its real reason instead of a generic oos — the item is
  // physically in stock, the account just can't buy more.
  const blocker = info.buyBlocker?.trim() ?? null;
  if (blocker && /quantity\s+limit/i.test(blocker)) {
    return { ok: false, reason: 'quantity_limit', detail: blocker };
  }

  if (c.requireInStock && !info.inStock) {
    return {
      ok: false,
      reason: 'oos',
      detail: info.availabilityText ?? 'Out of stock',
    };
  }

  if (c.maxPrice !== null) {
    if (info.price === null) {
      return { ok: false, reason: 'price_unknown', detail: 'Out of stock' };
    }
    const tol = effectivePriceTolerance(c.maxPrice);
    if (info.price > c.maxPrice + tol) {
      return {
        ok: false,
        reason: 'price_too_high',
        detail:
          tol > 0
            ? `${info.priceText ?? `$${info.price}`} exceeds max $${c.maxPrice.toFixed(2)} (+$${tol.toFixed(2)} tolerance)`
            : `${info.priceText ?? `$${info.price}`} exceeds max $${c.maxPrice.toFixed(2)}`,
      };
    }
  }

  if (c.requireNew) {
    if (info.condition === 'used') {
      return { ok: false, reason: 'used_condition', detail: 'listing is Used' };
    }
    if (info.condition === 'renewed') {
      return { ok: false, reason: 'renewed_condition', detail: 'listing is Amazon Renewed' };
    }
    // null or 'new' → pass (null = no negative signal detected)
  }

  if (c.requireShipping && info.shipsToAddress === false) {
    return {
      ok: false,
      reason: 'wont_ship',
      detail: 'item cannot ship to the account address',
    };
  }

  if (c.requirePrime && info.isPrime === false) {
    return {
      ok: false,
      reason: 'not_prime',
      detail: 'item is not Prime-eligible',
    };
  }

  if (c.requireBuyNow && info.hasBuyNow === false) {
    return {
      ok: false,
      reason: 'no_buy_now',
      detail:
        blocker ?? 'Buy Now button is not available (variation required or unavailable)',
    };
  }

  return { ok: true };
}
