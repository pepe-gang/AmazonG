import { describe, expect, it } from 'vitest';
import {
  checkProductConstraints,
  type Constraints,
} from '@parsers/productConstraints';
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

const DEFAULT: Constraints = {
  maxPrice: null,
  requireInStock: true,
  requireNew: true,
  requireShipping: true,
  requirePrime: false,
  requireBuyNow: true,
};

describe('checkProductConstraints', () => {
  it('passes when everything is fine and no price cap', () => {
    expect(checkProductConstraints(info(), DEFAULT)).toEqual({ ok: true });
  });

  it('fails when out of stock and inStock required', () => {
    const r = checkProductConstraints(info({ inStock: false, availabilityText: 'Currently unavailable.' }), DEFAULT);
    expect(r).toEqual({
      ok: false,
      reason: 'oos',
      detail: 'Currently unavailable.',
    });
  });

  it('passes OOS when inStock is not required', () => {
    const r = checkProductConstraints(
      info({ inStock: false }),
      { ...DEFAULT, requireInStock: false },
    );
    expect(r).toEqual({ ok: true });
  });

  it('fails on price > maxPrice', () => {
    const r = checkProductConstraints(info({ price: 30, priceText: '$30.00' }), {
      ...DEFAULT,
      maxPrice: 25,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('price_too_high');
      expect(r.detail).toContain('$30.00');
      expect(r.detail).toContain('$25.00');
    }
  });

  it('passes when price is exactly maxPrice', () => {
    const r = checkProductConstraints(info({ price: 25 }), { ...DEFAULT, maxPrice: 25 });
    expect(r).toEqual({ ok: true });
  });

  it('fails with price_unknown when price is null and maxPrice set', () => {
    const r = checkProductConstraints(info({ price: null, priceText: null }), {
      ...DEFAULT,
      maxPrice: 50,
    });
    expect(r).toEqual({
      ok: false,
      reason: 'price_unknown',
      detail: 'Out of stock',
    });
  });

  it('allows null price when maxPrice is not set', () => {
    const r = checkProductConstraints(info({ price: null }), DEFAULT);
    expect(r).toEqual({ ok: true });
  });

  it('rejects used condition when requireNew', () => {
    const r = checkProductConstraints(info({ condition: 'used' }), DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('used_condition');
  });

  it('rejects renewed condition when requireNew', () => {
    const r = checkProductConstraints(info({ condition: 'renewed' }), DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('renewed_condition');
  });

  it('allows null condition when requireNew (treats as probably new)', () => {
    const r = checkProductConstraints(info({ condition: null }), DEFAULT);
    expect(r).toEqual({ ok: true });
  });

  it('allows used when requireNew is false', () => {
    const r = checkProductConstraints(info({ condition: 'used' }), {
      ...DEFAULT,
      requireNew: false,
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects when shipsToAddress is false and shipping required', () => {
    const r = checkProductConstraints(info({ shipsToAddress: false }), DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wont_ship');
  });

  it('allows null shipsToAddress when requireShipping', () => {
    const r = checkProductConstraints(info({ shipsToAddress: null }), DEFAULT);
    expect(r).toEqual({ ok: true });
  });

  it('short-circuits on first failure (oos beats price)', () => {
    const r = checkProductConstraints(
      info({ inStock: false, price: 999 }),
      { ...DEFAULT, maxPrice: 10 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oos');
  });

  it('rejects non-Prime when requirePrime', () => {
    const r = checkProductConstraints(info({ isPrime: false }), {
      ...DEFAULT,
      requirePrime: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_prime');
  });

  it('allows null isPrime when requirePrime (treats unknown as pass)', () => {
    const r = checkProductConstraints(info({ isPrime: null }), {
      ...DEFAULT,
      requirePrime: true,
    });
    expect(r).toEqual({ ok: true });
  });

  it('allows non-Prime when requirePrime is false', () => {
    const r = checkProductConstraints(info({ isPrime: false }), DEFAULT);
    expect(r).toEqual({ ok: true });
  });

  it('rejects when Buy Now is missing and requireBuyNow', () => {
    const r = checkProductConstraints(info({ hasBuyNow: false }), DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_buy_now');
  });

  it('reports quantity_limit when blocker text mentions it', () => {
    const r = checkProductConstraints(
      info({ hasBuyNow: false, buyBlocker: 'Quantity limit met for this seller.' }),
      DEFAULT,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('quantity_limit');
      expect(r.detail).toBe('Quantity limit met for this seller.');
    }
  });

  it('reports quantity_limit even when inStock is false (quantity-limit beats oos)', () => {
    const r = checkProductConstraints(
      info({
        inStock: false,
        availabilityText: null,
        hasBuyNow: false,
        buyBlocker: 'Quantity limit met for this seller.',
      }),
      DEFAULT,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('quantity_limit');
  });

  it('uses buyBlocker as detail for generic no_buy_now', () => {
    const r = checkProductConstraints(
      info({ hasBuyNow: false, buyBlocker: 'Please choose a size before continuing.' }),
      DEFAULT,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no_buy_now');
      expect(r.detail).toBe('Please choose a size before continuing.');
    }
  });

  it('allows null hasBuyNow when requireBuyNow (treats unknown as pass)', () => {
    const r = checkProductConstraints(info({ hasBuyNow: null }), DEFAULT);
    expect(r).toEqual({ ok: true });
  });

  it('allows missing Buy Now when requireBuyNow is false', () => {
    const r = checkProductConstraints(info({ hasBuyNow: false }), {
      ...DEFAULT,
      requireBuyNow: false,
    });
    expect(r).toEqual({ ok: true });
  });
});
