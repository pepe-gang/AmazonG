import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BYG_BUTTON_SELECTOR,
  BYG_HEADER_SELECTOR,
  isBeforeYouGoInterstitial,
  parseOrderConfirmation,
  findCheckoutCashbackPct,
} from '@parsers/amazonCheckout';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../fixtures', name), 'utf8');
}

describe('parseOrderConfirmation', () => {
  it('reads order id from #orderId text', () => {
    const doc = docOf(`
      <html><body>
        <span id="orderId">113-1234567-1234567</span>
      </body></html>`);
    const r = parseOrderConfirmation(doc, 'https://www.amazon.com/gp/buy/thankyou');
    expect(r.orderId).toBe('113-1234567-1234567');
  });

  it('reads order id from data-order-id attribute', () => {
    const doc = docOf('<html><body><span data-order-id="114-7654321-7654321"></span></body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.orderId).toBe('114-7654321-7654321');
  });

  it('falls back to regex scan of body text', () => {
    const doc = docOf('<html><body>Your order #115-0001111-0001111 has been placed.</body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.orderId).toBe('115-0001111-0001111');
  });

  it('reads order id from URL query when DOM lacks it', () => {
    const doc = docOf('<html><body></body></html>');
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou?orderId=116-2223334-2223334',
    );
    expect(r.orderId).toBe('116-2223334-2223334');
  });

  it('returns null order id on unrelated page', () => {
    const doc = docOf('<html><body>Unrelated content</body></html>');
    expect(parseOrderConfirmation(doc, 'x').orderId).toBeNull();
  });

  it('extracts order total from od-subtotals block', () => {
    const doc = docOf(`
      <html><body>
        <div id="od-subtotals">
          <span class="a-color-price">$1,184.50</span>
        </div>
      </body></html>`);
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.finalPriceText).toContain('1,184.50');
    expect(r.finalPrice).toBe(1184.5);
  });

  it('falls back to Order total text in body', () => {
    const doc = docOf('<html><body>Order total: $24.99</body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.finalPriceText).toBe('$24.99');
    expect(r.finalPrice).toBe(24.99);
  });

  it('reads quantity from .checkout-quantity-badge', () => {
    const doc = docOf(`
      <html><body>
        <span class="a-color-secondary checkout-quantity-badge">3</span>
      </body></html>`);
    expect(parseOrderConfirmation(doc, 'x').quantity).toBe(3);
  });

  it('returns null quantity when badge is absent (qty=1 case)', () => {
    const doc = docOf('<html><body>Order placed, thanks!</body></html>');
    expect(parseOrderConfirmation(doc, 'x').quantity).toBeNull();
  });

  it('reads quantity from a real thankyou fixture (qty=3)', () => {
    const doc = docOf(fixture('thankyou-106-4510031-4901860.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-4510031-4901860',
    );
    expect(r.quantity).toBe(3);
  });

  it('returns null from a real thankyou fixture (qty=1, badge omitted)', () => {
    const doc = docOf(fixture('thankyou-106-3412656-3967431-qty1.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-3412656-3967431',
    );
    expect(r.quantity).toBeNull();
  });

  it('reads quantity from a real thankyou fixture (qty=5)', () => {
    const doc = docOf(fixture('thankyou-106-9503967-6167453-qty5.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-9503967-6167453',
    );
    expect(r.quantity).toBe(5);
  });
});

describe('isBeforeYouGoInterstitial', () => {
  it('detects the BYG "Need anything else?" page in a real fixture', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    expect(isBeforeYouGoInterstitial(doc)).toBe(true);
  });

  it('returns false on an unrelated page', () => {
    const doc = docOf('<html><body>Place your order</body></html>');
    expect(isBeforeYouGoInterstitial(doc)).toBe(false);
  });

  it('BYG_BUTTON_SELECTOR matches the Continue to checkout anchor in the fixture', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    const btn = doc.querySelector(BYG_BUTTON_SELECTOR);
    expect(btn).not.toBeNull();
    expect((btn?.textContent ?? '').trim()).toBe('Continue to checkout');
  });

  it('BYG_HEADER_SELECTOR matches the page header container', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    expect(doc.querySelector(BYG_HEADER_SELECTOR)).not.toBeNull();
  });
});

describe('findCheckoutCashbackPct', () => {
  it('returns the largest N% back found', () => {
    const doc = docOf('<html><body>Earn 10% back on this purchase. Prime members: 12% back</body></html>');
    expect(findCheckoutCashbackPct(doc)).toBe(12);
  });
  it('returns null when absent', () => {
    const doc = docOf('<html><body>no cashback here</body></html>');
    expect(findCheckoutCashbackPct(doc)).toBeNull();
  });
});
