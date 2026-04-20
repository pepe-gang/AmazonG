import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  shipTrackLinksFor,
  trackingIdFromShipTrack,
} from '@parsers/amazonTracking';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
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
