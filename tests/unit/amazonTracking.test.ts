import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shipTrackLinksFor,
  trackingIdFromShipTrack,
} from '@parsers/amazonTracking';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../fixtures', name), 'utf8');
}

describe('shipTrackLinksFor', () => {
  it('returns empty when page has no ship-track links', () => {
    const doc = docOf('<html><body>Arriving tomorrow. <a href="/other">nope</a></body></html>');
    expect(shipTrackLinksFor(doc, '114-9211854-9833032')).toEqual([]);
  });

  it('scopes links by the target orderId (rejects leakage from list pages)', () => {
    const doc = docOf(`
      <html><body>
        <a href="/gp/your-account/ship-track?orderId=114-9211854-9833032&shipmentId=P76PypV9l&packageIndex=0">Track</a>
        <a href="/gp/your-account/ship-track?orderId=111-0000000-0000001&shipmentId=Xxxx&packageIndex=0">Track (other)</a>
      </body></html>`);
    const urls = shipTrackLinksFor(doc, '114-9211854-9833032');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('shipmentId=P76PypV9l');
  });

  it('returns all shipments for a multi-shipment order', () => {
    const doc = docOf(`
      <html><body>
        <a href="/gp/your-account/ship-track?orderId=114-9211854-9833032&shipmentId=P76PypV9l&packageIndex=0">Track</a>
        <a href="/gp/your-account/ship-track?orderId=114-9211854-9833032&shipmentId=PW6DypV9l&packageIndex=0">Track</a>
        <a href="/gp/your-account/ship-track?orderId=114-9211854-9833032&shipmentId=PtYCsBV2l&packageIndex=0">Track</a>
      </body></html>`);
    const urls = shipTrackLinksFor(doc, '114-9211854-9833032');
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => new URL(u).searchParams.get('shipmentId'))).toEqual([
      'P76PypV9l',
      'PW6DypV9l',
      'PtYCsBV2l',
    ]);
  });

  it('dedupes identical shipment+packageIndex pairs (Amazon renders duplicate buttons)', () => {
    const doc = docOf(`
      <html><body>
        <a href="/gp/your-account/ship-track?orderId=114-1&shipmentId=PA&packageIndex=0">Track</a>
        <a href="/gp/your-account/ship-track?orderId=114-1&shipmentId=PA&packageIndex=0">Track (duplicate header button)</a>
      </body></html>`);
    expect(shipTrackLinksFor(doc, '114-1')).toHaveLength(1);
  });

  it('resolves relative hrefs against amazon.com', () => {
    const doc = docOf(`
      <html><body>
        <a href="/gp/your-account/ship-track?orderId=1&shipmentId=PA&packageIndex=0">Track</a>
      </body></html>`);
    const urls = shipTrackLinksFor(doc, '1');
    expect(urls[0]).toMatch(/^https:\/\/www\.amazon\.com\//);
  });
});

describe('trackingIdFromShipTrack', () => {
  it('reads USPS 22-digit code from .pt-delivery-card-trackingId', () => {
    const doc = docOf(`
      <html><body>
        <div class="pt-delivery-card-trackingId">Tracking ID: 9361289716362666629389</div>
      </body></html>`);
    expect(trackingIdFromShipTrack(doc)).toBe('9361289716362666629389');
  });

  it('reads UPS 1Z code with mixed alphanumerics', () => {
    const doc = docOf(`
      <html><body>
        <div class="pt-delivery-card-trackingId">Tracking ID: 1ZC6046APW03824590</div>
      </body></html>`);
    expect(trackingIdFromShipTrack(doc)).toBe('1ZC6046APW03824590');
  });

  it('falls back to .tracking-event-trackingId-text when primary is missing', () => {
    const doc = docOf(`
      <html><body>
        <div class="tracking-event-trackingId-text">Tracking ID: 9339589716362692296489</div>
      </body></html>`);
    expect(trackingIdFromShipTrack(doc)).toBe('9339589716362692296489');
  });

  it('returns null when no tracking selector is present', () => {
    const doc = docOf('<html><body>No tracking yet.</body></html>');
    expect(trackingIdFromShipTrack(doc)).toBeNull();
  });

  it('returns null when the selector is present but empty', () => {
    const doc = docOf('<html><body><div class="pt-delivery-card-trackingId">Tracking ID:</div></body></html>');
    expect(trackingIdFromShipTrack(doc)).toBeNull();
  });

  it('handles case-insensitive prefix variants', () => {
    const doc = docOf('<html><body><div class="pt-delivery-card-trackingId">TRACKING ID  9361289716362679790250</div></body></html>');
    expect(trackingIdFromShipTrack(doc)).toBe('9361289716362679790250');
  });
});

/**
 * "Order received" page — what Amazon shows after clicking the Track
 * button on an order whose carrier handoff is queued or just happened
 * but no tracking number has been issued yet. Real fixture captured
 * from a live order. fetchTracking treats this case as `not_shipped`
 * so BG re-schedules another fetch_tracking job ~6h later.
 *
 * Why this fixture matters: the page contains hundreds of `1Z…`-like
 * substrings (script content, internal element IDs, telemetry tags)
 * that look superficially like UPS tracking codes. The parser must
 * NOT be tempted by any of them — only the explicit
 * `.pt-delivery-card-trackingId` / `.tracking-event-trackingId-text`
 * containers count, and neither exists on this page.
 */
describe('Track page — Order received (no tracking ID yet)', () => {
  const html = fixture('track/order-received.html');
  const doc = docOf(html);
  const orderId = '111-7958411-8853030';

  it('trackingIdFromShipTrack returns null — no carrier code yet', () => {
    // Crucial: must NOT pick up any of the 1Z-like noise strings on
    // the page. Only the explicit selectors count, and they're absent.
    expect(trackingIdFromShipTrack(doc)).toBeNull();
  });

  it('shipTrackLinksFor only returns links scoped to this order (no leakage from page noise)', () => {
    // The Track page does carry a self-referencing ship-track link
    // scoped to this order's id — that's expected. What matters is
    // that the parser ONLY returns links matching this orderId,
    // ignoring everything else on a 2.7 MB page full of unrelated
    // anchor tags. Defensive: makes sure the regex doesn't widen.
    const urls = shipTrackLinksFor(doc, orderId);
    for (const u of urls) {
      expect(u).toContain(`orderId=${orderId}`);
    }
  });

  it('shipTrackLinksFor returns nothing when scoped to an unrelated orderId', () => {
    // Pump in an unrelated orderId — the parser should drop every
    // link on the page since none of them match. Closes out the
    // negative case so we don't accidentally start matching loosely.
    expect(shipTrackLinksFor(doc, '000-0000000-0000000')).toEqual([]);
  });

  it('page text contains the "Order received" status (positive marker)', () => {
    // Locks in the signal so future regressions can distinguish
    // "page loaded but no code yet" from "page errored out / network".
    const text = doc.body?.textContent ?? '';
    expect(text).toMatch(/Order received/);
  });

  it('reflects the orderId scoped to this fixture (sanity)', () => {
    // The fixture's URL parameters carry orderID=111-7958411-8853030.
    // Confirm that's still findable in the page so callers can rely on
    // the orderId match for diagnostics.
    expect(html).toContain(`orderID=${orderId}`);
  });
});

/**
 * Track page — "Arriving Wednesday" / progress-bar variant. Same
 * functional state as "Order received" (carrier hasn't issued a code
 * yet) but Amazon renders a richer view: a multi-step progress bar
 * (Shipped / Out for delivery / Delivered, all `aria-label="...:
 * Incomplete"`) plus an arrival-day estimate. Both pages flow
 * through the same `not_shipped` outcome in fetchTracking — the
 * parser doesn't distinguish them and shouldn't.
 *
 * What this fixture catches that the "Order received" one doesn't:
 *   - Page contains the literal strings "Shipped", "Out for delivery",
 *     "Delivered" inside aria-labels of the progress widget. A naive
 *     status detector that matched on those words alone would
 *     mis-classify this page as already-delivered. The parser must
 *     ignore those labels.
 */
describe('Track page — Arriving (progress bar, no tracking ID)', () => {
  const html = fixture('track/arriving-no-tracking.html');
  const doc = docOf(html);
  const orderId = '111-2108184-9854645';

  it('trackingIdFromShipTrack returns null — carrier code not issued yet', () => {
    expect(trackingIdFromShipTrack(doc)).toBeNull();
  });

  it('shipTrackLinksFor only returns links scoped to this orderId', () => {
    const urls = shipTrackLinksFor(doc, orderId);
    for (const u of urls) {
      expect(u).toContain(`orderId=${orderId}`);
    }
  });

  it('shipTrackLinksFor returns nothing when scoped to an unrelated orderId', () => {
    expect(shipTrackLinksFor(doc, '000-0000000-0000000')).toEqual([]);
  });

  it('progress-bar steps are all marked "Incomplete" (positive marker for not-shipped state)', () => {
    // The aria-labels on the Shipped/Out-for-delivery/Delivered
    // steps include "Incomplete" while none of those stages have
    // been reached. Locks in the signal so future regressions can
    // distinguish "in-progress not-shipped" from "actually delivered".
    expect(html).toContain('Shipped: Incomplete');
    expect(html).toContain('Out for delivery: Incomplete');
    expect(html).toContain('Delivered: Incomplete');
  });

  it('reflects the orderId scoped to this fixture (sanity)', () => {
    expect(html).toContain(`orderID=${orderId}`);
  });
});
