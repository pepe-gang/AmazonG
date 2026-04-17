import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  parseOrderConfirmation,
  findCheckoutCashbackPct,
} from '@parsers/amazonCheckout';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
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
