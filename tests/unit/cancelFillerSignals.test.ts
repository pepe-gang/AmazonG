import { describe, test, expect } from 'vitest';
import {
  cancelFormResultToSignal,
  classifyOrderDetailsHtml,
  extractTrackingIdsFromOrderHtml,
  orderContainsAsin,
} from '../../src/actions/cancelFillerSignals';

// HTML fixtures inlined as strings — kept compact and shape-faithful
// to what Amazon actually serves on the order-details page. Each
// describes a real production state we've seen in logs / live probes.

const ALREADY_CANCELLED_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-9876543-1111111</div>
  <div data-component="cancelled" class="a-box-inner">
    <h4>This order has been cancelled</h4>
    <p>Your refund is on the way.</p>
  </div>
  <div data-component="shipments"></div>
</body></html>
`;

// Variant: empty data-component="cancelled" wrapper (Amazon renders
// this on EVERY order-details page even when the order isn't
// cancelled). Must not trigger the cancelled signal.
const EMPTY_CANCELLED_WRAPPER_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-1111111-1111111</div>
  <div data-component="cancelled"></div>
  <div data-component="shippedItem">Order is being prepared.</div>
  <div data-component="orderTotal">$24.99</div>
</body></html>
`;

const SHIPPED_WITH_CARRIER_CODE_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-2222222-3333333</div>
  <div data-component="shipmentTracking">
    Shipment 1 of 1
    <a href="/gp/your-account/ship-track?orderId=112-2222222-3333333">Track package</a>
    <span>Tracking ID: TBA123456789012</span>
  </div>
</body></html>
`;

const SHIPPED_LINK_NO_CODE_YET_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-2222222-3333344</div>
  <div data-component="shippedItem">
    <a href="/gp/your-account/ship-track?orderId=112-2222222-3333344">View shipment</a>
  </div>
</body></html>
`;

const UNABLE_TO_CANCEL_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-3333333-4444444</div>
  <div class="a-alert a-alert-error">
    Unable to cancel requested items. We apologize for the inconvenience.
    You can return the eligible items after they arrive for a refund.
  </div>
</body></html>
`;

const ORDER_NOT_FOUND_HTML = `
<!doctype html>
<html><body>
  <h1>We can't find that order</h1>
  <p>Please check your order number and try again.</p>
</body></html>
`;

const ORDER_NOT_FOUND_VARIANT_HTML = `
<!doctype html>
<html><body>
  <h1>We're unable to load your order details</h1>
</body></html>
`;

// "Indeterminate" — order is still cancellable but page doesn't have
// any of the obvious markers. Common when a buy is fresh and Amazon
// hasn't rendered shipment widgets yet.
const INDETERMINATE_FRESH_ORDER_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-4444444-5555555</div>
  <div data-component="orderTotal">$199.99</div>
  <div data-component="shippingAddress">123 Main St</div>
</body></html>
`;

const ORDER_WITH_TARGET_ASIN_HTML = `
<!doctype html>
<html><body>
  <div data-component="orderHeader">Order #112-5555555-6666666</div>
  <a href="/dp/B0DZ751XN6">View item</a>
  <a href="/gp/product/B0DZ751XN6">Buy again</a>
</body></html>
`;

describe('classifyOrderDetailsHtml', () => {
  test('order_already_cancelled — banner inside data-component=cancelled', () => {
    const r = classifyOrderDetailsHtml(ALREADY_CANCELLED_HTML);
    expect(r.signal).toBe('order_already_cancelled');
  });

  test('empty cancelled wrapper does NOT trigger cancelled signal', () => {
    // Amazon renders <div data-component="cancelled"></div> on EVERY
    // order-details page. Must only trigger on banner text inside.
    const r = classifyOrderDetailsHtml(EMPTY_CANCELLED_WRAPPER_HTML);
    expect(r.signal).not.toBe('order_already_cancelled');
  });

  test('order_shipped_detected — carrier code on page', () => {
    const r = classifyOrderDetailsHtml(SHIPPED_WITH_CARRIER_CODE_HTML);
    expect(r.signal).toBe('order_shipped_detected');
    expect(r.trackingIds).toEqual(['TBA123456789012']);
  });

  test('order_shipped_detected — ship-track link, no code yet', () => {
    const r = classifyOrderDetailsHtml(SHIPPED_LINK_NO_CODE_YET_HTML);
    expect(r.signal).toBe('order_shipped_detected');
    // No code yet — caller stays in pending_tracking and retries.
    expect(r.trackingIds).toBeUndefined();
  });

  test('cancel_unable — explicit refusal copy', () => {
    const r = classifyOrderDetailsHtml(UNABLE_TO_CANCEL_HTML);
    expect(r.signal).toBe('cancel_unable');
  });

  test('order_not_found — "we can\'t find that order"', () => {
    const r = classifyOrderDetailsHtml(ORDER_NOT_FOUND_HTML);
    expect(r.signal).toBe('order_not_found');
  });

  test('order_not_found — "unable to load your order details" variant', () => {
    const r = classifyOrderDetailsHtml(ORDER_NOT_FOUND_VARIANT_HTML);
    expect(r.signal).toBe('order_not_found');
  });

  test('indeterminate fresh order → transient_error (caller falls through to cancel form)', () => {
    const r = classifyOrderDetailsHtml(INDETERMINATE_FRESH_ORDER_HTML);
    expect(r.signal).toBe('transient_error');
  });

  test('not_found takes priority over cancelled marker (defense)', () => {
    // Pathological: error banner + cancelled wrapper. Should not_found
    // (the error indicates we can't trust anything else on the page).
    const html = ORDER_NOT_FOUND_HTML + ALREADY_CANCELLED_HTML;
    const r = classifyOrderDetailsHtml(html);
    expect(r.signal).toBe('order_not_found');
  });
});

describe('orderContainsAsin', () => {
  test('detects /dp/ASIN link', () => {
    expect(orderContainsAsin(ORDER_WITH_TARGET_ASIN_HTML, 'B0DZ751XN6')).toBe(true);
  });
  test('detects /gp/product/ASIN link', () => {
    const html = '<a href="/gp/product/B0BFC7WQ6R">Re-buy</a>';
    expect(orderContainsAsin(html, 'B0BFC7WQ6R')).toBe(true);
  });
  test('different ASIN not present → false', () => {
    expect(orderContainsAsin(ORDER_WITH_TARGET_ASIN_HTML, 'B099999999')).toBe(false);
  });
  test('empty/missing target → false (defensive — caller short-circuits)', () => {
    expect(orderContainsAsin(ORDER_WITH_TARGET_ASIN_HTML, '')).toBe(false);
  });
  test('regex-special chars in ASIN are escaped (defense — ASINs are alphanumeric IRL)', () => {
    // Even if a malformed asin reached here, regex injection mustn't
    // happen.
    expect(orderContainsAsin(ORDER_WITH_TARGET_ASIN_HTML, '.*')).toBe(false);
  });
  test('case-insensitive match (Amazon sometimes lowercases in URLs)', () => {
    const html = '<a href="/dp/b0dz751xn6">View</a>';
    expect(orderContainsAsin(html, 'B0DZ751XN6')).toBe(true);
  });
});

describe('extractTrackingIdsFromOrderHtml', () => {
  test('Amazon Logistics TBA pattern', () => {
    const ids = extractTrackingIdsFromOrderHtml(SHIPPED_WITH_CARRIER_CODE_HTML);
    expect(ids).toContain('TBA123456789012');
  });

  test('UPS 1Z pattern', () => {
    const html = `<p>Tracking ID: 1Z999AA10123456784</p>`;
    expect(extractTrackingIdsFromOrderHtml(html)).toContain('1Z999AA10123456784');
  });

  test('USPS 9-prefix pattern (long enough to disambiguate from FedEx)', () => {
    const html = `<p>Tracking: 9405511206213057143657</p>`;
    expect(extractTrackingIdsFromOrderHtml(html)).toContain('9405511206213057143657');
  });

  test('empty when no tracking present', () => {
    expect(extractTrackingIdsFromOrderHtml(INDETERMINATE_FRESH_ORDER_HTML)).toEqual([]);
  });

  test('dedupes when same id appears in multiple shipment widgets', () => {
    const html = `
      <span>Tracking ID: TBA123456789012</span>
      <span>Tracking ID: TBA123456789012</span>
    `;
    expect(extractTrackingIdsFromOrderHtml(html)).toEqual(['TBA123456789012']);
  });
});

describe('cancelFormResultToSignal', () => {
  test('ok=true → cancel_confirmed', () => {
    expect(cancelFormResultToSignal(true)).toBe('cancel_confirmed');
  });
  test('ok=false + "unable to cancel" → cancel_unable', () => {
    expect(cancelFormResultToSignal(false, 'Amazon refused: unable to cancel requested items')).toBe(
      'cancel_unable',
    );
  });
  test('ok=false + "not on cancel-items page" → null (ambiguous, caller probes further)', () => {
    expect(cancelFormResultToSignal(false, 'not on cancel-items page after navigation — order likely already cancelled or shipped')).toBeNull();
  });
  test('ok=false + generic error → transient_error', () => {
    expect(cancelFormResultToSignal(false, 'Request Cancellation submit button not found')).toBe(
      'transient_error',
    );
  });
  test('ok=false + missing reason → transient_error', () => {
    expect(cancelFormResultToSignal(false)).toBe('transient_error');
  });
});
