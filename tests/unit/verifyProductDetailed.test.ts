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
    expect(names).toEqual(['inStock', 'condition', 'shipping', 'buyNow']);
    for (const s of report.steps.filter((x) => !x.skipped)) expect(s.pass).toBe(true);
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
    expect(report.steps.map((s) => s.name)).toEqual(['inStock']);
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
      expected: '≤ $400.00',
      reason: 'price_too_high',
    });
  });

  it('reports quantity_limit before running any other check', () => {
    const report = verifyProductDetailed(
      info({ buyBlocker: 'Quantity limit met for this seller.', hasBuyNow: false }),
      defaults,
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('quantity_limit');
    expect(report.steps.map((s) => s.name)).toEqual(['buyNow']);
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
