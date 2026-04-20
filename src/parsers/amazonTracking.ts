/**
 * Pure parsers for Amazon's tracking surfaces. Two functions:
 *
 *   shipTrackLinksFor(doc, orderId) — scans an order-details page for every
 *     `a[href*="ship-track"]` scoped to the given orderId, returns
 *     absolute URLs. Scoping is important because Your-Orders LIST pages
 *     can leak other orders' links into the same DOM.
 *
 *   trackingIdFromShipTrack(doc) — reads `.pt-delivery-card-trackingId` on
 *     a ship-track page, strips the "Tracking ID: " prefix, returns the
 *     raw carrier code (USPS digits, UPS 1Z…, etc.) or null when the
 *     selector is missing.
 */

const TRACKING_PREFIX_RE = /^\s*tracking\s*id\s*:?\s*/i;

export function shipTrackLinksFor(doc: Document, orderId: string): string[] {
  const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="ship-track"]'));
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const a of links) {
    const href = a.getAttribute('href');
    if (!href) continue;
    // Resolve relative → absolute using amazon.com as base so this works
    // inside jsdom (no `location`) and in the browser alike.
    let abs: string;
    try {
      abs = new URL(href, 'https://www.amazon.com/').toString();
    } catch {
      continue;
    }
    let params: URLSearchParams;
    try {
      params = new URL(abs).searchParams;
    } catch {
      continue;
    }
    if (params.get('orderId') !== orderId) continue;
    // De-dupe identical URLs (Amazon sometimes renders two buttons per
    // shipment — e.g. header + inline on the same card).
    const key = `${params.get('shipmentId') ?? ''}|${params.get('packageIndex') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(abs);
  }
  return urls;
}

export function trackingIdFromShipTrack(doc: Document): string | null {
  // Primary: `.pt-delivery-card-trackingId` — the header card on the
  // track page. Fallback: `.tracking-event-trackingId-text` — inside
  // the "tracking events" modal/container (same text content).
  const candidates = [
    '.pt-delivery-card-trackingId',
    '.tracking-event-trackingId-text',
  ];
  for (const sel of candidates) {
    const el = doc.querySelector(sel);
    const raw = el?.textContent?.trim();
    if (!raw) continue;
    const code = raw.replace(TRACKING_PREFIX_RE, '').trim();
    if (code.length === 0) continue;
    return code;
  }
  return null;
}
