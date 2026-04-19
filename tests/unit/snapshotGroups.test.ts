import { describe, it, expect } from 'vitest';
import { classifyError, shouldCapture } from '@shared/snapshotGroups';

describe('classifyError', () => {
  // price_exceeded
  it.each([
    '$24.99 exceeds max $19.99',
    'checkout price $50.00 exceeds retail cap $40.00',
  ])('classifies "%s" as price_exceeded', (msg) => {
    expect(classifyError(msg)).toBe('price_exceeded');
  });

  // out_of_stock
  it.each([
    'product not in stock',
    'Out of stock',
    'This item is currently unavailable',
    'item_unavailable',
  ])('classifies "%s" as out_of_stock', (msg) => {
    expect(classifyError(msg)).toBe('out_of_stock');
  });

  // address_mismatch
  it.each([
    'no saved address starts with an allowed prefix (saw: 123 Main St)',
    'no allowed prefixes configured — cannot locate address to edit',
  ])('classifies "%s" as address_mismatch', (msg) => {
    expect(classifyError(msg)).toBe('address_mismatch');
  });

  // address_stuck
  it.each([
    'address picker did not load',
    'address submitted but did not redirect back to /spc',
    'Deliver button persisted after 5 clicks',
    'change-address link not found on /spc',
    'after address change, /spc did not re-render',
  ])('classifies "%s" as address_stuck', (msg) => {
    expect(classifyError(msg)).toBe('address_stuck');
  });

  // cashback_toggle
  it.each([
    'name-toggle: no_use_button',
    'name-toggle: submitted but did not return to /spc',
  ])('classifies "%s" as cashback_toggle', (msg) => {
    expect(classifyError(msg)).toBe('cashback_toggle');
  });

  // cashback_low
  it.each([
    'cashback 3%',
    'cashback missing',
  ])('classifies "%s" as cashback_low', (msg) => {
    expect(classifyError(msg)).toBe('cashback_low');
  });

  // buy_button
  it.each([
    'buy-now button never appeared',
    'Buy Now button is not available (variation required or unavailable)',
    'failed to click Buy Now',
  ])('classifies "%s" as buy_button', (msg) => {
    expect(classifyError(msg)).toBe('buy_button');
  });

  // place_order
  it.each([
    'no Place Order button selector matched',
    'failed to click Place Order',
  ])('classifies "%s" as place_order', (msg) => {
    expect(classifyError(msg)).toBe('place_order');
  });

  // confirm_stuck
  it.each([
    'pending order page persisted after 3 re-click attempts',
    'confirmation URL never loaded',
  ])('classifies "%s" as confirm_stuck', (msg) => {
    expect(classifyError(msg)).toBe('confirm_stuck');
  });

  // checkout_price
  it('classifies checkout price parse failure', () => {
    expect(classifyError('could not read item price on /spc (no price candidates found across known layouts)')).toBe('checkout_price');
  });

  // condition_blocked
  it.each([
    'listing is Used',
    'listing is Amazon Renewed',
  ])('classifies "%s" as condition_blocked', (msg) => {
    expect(classifyError(msg)).toBe('condition_blocked');
  });

  // shipping_blocked
  it.each([
    'item cannot ship to the account address',
    'item is not Prime-eligible',
  ])('classifies "%s" as shipping_blocked', (msg) => {
    expect(classifyError(msg)).toBe('shipping_blocked');
  });

  // verify_failed
  it.each([
    'verify: timed out reading order-details for 123-456',
    'verify: unexpected order-details error — page not found',
  ])('classifies "%s" as verify_failed', (msg) => {
    expect(classifyError(msg)).toBe('verify_failed');
  });

  // unrecognised
  it('returns null for unrecognised error', () => {
    expect(classifyError('something totally unexpected happened')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(classifyError('')).toBeNull();
  });
});

describe('shouldCapture', () => {
  it('returns false when snapshotOnFailure is off', () => {
    expect(shouldCapture('Out of stock', false, [])).toBe(false);
  });

  it('returns true for any error when enabled with empty groups (= all)', () => {
    expect(shouldCapture('Out of stock', true, [])).toBe(true);
    expect(shouldCapture('$24.99 exceeds max $19.99', true, [])).toBe(true);
  });

  it('captures unrecognised errors when groups is empty (= all)', () => {
    expect(shouldCapture('weird unknown error', true, [])).toBe(true);
  });

  it('returns true when error group matches selected groups', () => {
    expect(shouldCapture('Out of stock', true, ['out_of_stock', 'price_exceeded'])).toBe(true);
  });

  it('returns false when error group is not in selected groups', () => {
    expect(shouldCapture('Out of stock', true, ['price_exceeded'])).toBe(false);
  });

  it('returns false for unrecognised error when specific groups are selected', () => {
    expect(shouldCapture('weird unknown error', true, ['price_exceeded'])).toBe(false);
  });
});
