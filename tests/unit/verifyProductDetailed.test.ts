import { describe, expect, it } from 'vitest';
import { verifyProductDetailed } from '@parsers/productConstraints';
import type { ProductInfo } from '@shared/types';

function info(overrides: Partial<ProductInfo> = {}): ProductInfo {
  return {
    url: 'https://amazon.com/dp/TEST',
    title: 'Test',
    price: 19.99,
    priceText: '$19.99',
    cashbackPct: null,
    inStock: true,
    availabilityText: 'In Stock',
    condition: null,
    shipsToAddress: true,
    isPrime: true,
    hasBuyNow: true,
    hasAddToCart: true,
    isSignedIn: true,
    buyBlocker: null,
    ...overrides,
  };
}

const defaults = {
  maxPrice: null as number | null,
  requireInStock: true,
  requireNew: true,
  requireShipping: true,
  requirePrime: false,
  requireBuyNow: true,
};

describe('verifyProductDetailed', () => {
  it('reports a pass step for every enabled check when all pass', () => {
    const report = verifyProductDetailed(info(), defaults);
    expect(report.ok).toBe(true);
    const names = report.steps.filter((s) => !s.skipped).map((s) => s.name);
    expect(names).toEqual(['signedIn', 'inStock', 'condition', 'shipping', 'buyNow']);
    for (const s of report.steps.filter((x) => !x.skipped)) expect(s.pass).toBe(true);
  });

  it('fails fast with signed_out when isSignedIn is false, even if downstream checks would also fail', () => {
    // Signed-out sessions cause Amazon to drop the Prime badge AND Buy Now
    // button. We must surface "signed out" as the cause, not "not_prime"
    // or "no_buy_now" — those are downstream symptoms.
    const report = verifyProductDetailed(
      info({ isSignedIn: false, isPrime: false, hasBuyNow: false, hasAddToCart: false }),
      { ...defaults, requirePrime: true },
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('signed_out');
    expect(report.steps.map((s) => s.name)).toEqual(['signedIn']);
  });

  it('marks price as skipped when no maxPrice set', () => {
    const report = verifyProductDetailed(info(), defaults);
    expect(report.steps.find((s) => s.name === 'price')?.skipped).toBe(true);
  });

  it('short-circuits after the first failure (oos before price)', () => {
    const report = verifyProductDetailed(
      info({ inStock: false, price: 999 }),
      { ...defaults, maxPrice: 10 },
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('oos');
    // No 'price' step should appear — we stopped at the inStock failure.
    // signedIn always runs first as a precondition.
    expect(report.steps.map((s) => s.name)).toEqual(['signedIn', 'inStock']);
  });

  it('allows price up to $1 over the cap (Amazon .99 pricing pattern)', () => {
    const report = verifyProductDetailed(
      info({ price: 399.99, priceText: '$399.99' }),
      { ...defaults, maxPrice: 399 },
    );
    expect(report.ok).toBe(true);
    const priceStep = report.steps.find((s) => s.name === 'price');
    expect(priceStep?.pass).toBe(true);
  });

  it('rejects price more than $1 over the cap', () => {
    const report = verifyProductDetailed(
      info({ price: 400.01, priceText: '$400.01' }),
      { ...defaults, maxPrice: 399 },
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('price_too_high');
  });

  it('applies NO tolerance when cap is below $100 (strict comparison)', () => {
    // $50.99 vs $50 cap — for cheap items we want strict, no slack.
    const report = verifyProductDetailed(
      info({ price: 50.99, priceText: '$50.99' }),
      { ...defaults, maxPrice: 50 },
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('price_too_high');
  });

  it('exact-match on sub-$100 caps still passes', () => {
    const report = verifyProductDetailed(
      info({ price: 50, priceText: '$50.00' }),
      { ...defaults, maxPrice: 50 },
    );
    expect(report.ok).toBe(true);
  });

  it('records observed vs expected on a price fail', () => {
    const report = verifyProductDetailed(info({ price: 500, priceText: '$500.00' }), {
      ...defaults,
      maxPrice: 400,
    });
    const priceStep = report.steps.find((s) => s.name === 'price');
    expect(priceStep).toMatchObject({
      pass: false,
      observed: '$500.00',
      expected: '≤ $400.00 (+$1.00 tol)',
      reason: 'price_too_high',
    });
  });

  it('reports quantity_limit before running any other check', () => {
    const report = verifyProductDetailed(
      info({
        buyBlocker: 'Quantity limit met for this seller.',
        hasBuyNow: false,
        hasAddToCart: false,
      }),
      defaults,
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('quantity_limit');
    // signedIn precedes the quantity-limit short-circuit; quantity_limit
    // is reported under buyNow as before.
    expect(report.steps.map((s) => s.name)).toEqual(['signedIn', 'buyNow']);
  });

  it('logs a prime step when requirePrime is on', () => {
    const report = verifyProductDetailed(info({ isPrime: false }), {
      ...defaults,
      requirePrime: true,
    });
    expect(report.ok).toBe(false);
    const primeStep = report.steps.find((s) => s.name === 'prime');
    expect(primeStep?.pass).toBe(false);
    expect(primeStep?.reason).toBe('not_prime');
  });
});
