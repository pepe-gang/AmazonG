import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { verifyOrder } from './verifyOrder.js';
import { shipTrackLinksFor, trackingIdFromShipTrack } from '../parsers/amazonTracking.js';
import type { FetchTrackingOutcome } from '../shared/types.js';

/**
 * Fetch carrier tracking codes for `orderId` on the profile whose session
 * owns `page`. First half reuses `verifyOrder` — bails early on an explicit
 * cancellation (terminal) or a transient verify failure (retry later).
 * When the order is active, scans the order-details page for every
 * `a[href*="ship-track"]` scoped to this order, navigates each, and reads
 * the tracking code from `.pt-delivery-card-trackingId`.
 *
 * Outcome guide (see FetchTrackingOutcome):
 *   tracked     — every shipment had a code
 *   partial     — some shipments had codes, some didn't (mid-ship)
 *   not_shipped — order is active but Amazon hasn't shipped anything yet
 *   retry       — verify errored or timed out (transient, BG reschedules)
 *   cancelled   — explicit "This order has been cancelled" marker
 */
export async function fetchTracking(
  page: Page,
  orderId: string,
): Promise<FetchTrackingOutcome> {
  const verify = await verifyOrder(page, orderId);
  if (verify.kind === 'cancelled') {
    return { kind: 'cancelled', reason: 'order was cancelled by Amazon' };
  }
  if (verify.kind === 'error') {
    return { kind: 'retry', reason: 'verify_error' };
  }
  if (verify.kind === 'timeout') {
    return { kind: 'retry', reason: 'verify_timeout' };
  }

  // verify.kind === 'active' — the page is on order-details. Enumerate
  // ship-track links scoped to THIS order (list pages leak other orders).
  const html = await page.content();
  const orderDoc = new JSDOM(html).window.document;
  const urls = shipTrackLinksFor(orderDoc, orderId);

  if (urls.length === 0) {
    return { kind: 'not_shipped' };
  }

  const trackingIds: string[] = [];
  let missing = 0;
  for (const url of urls) {
    const code = await readTrackingId(page, url);
    if (code) {
      trackingIds.push(code);
    } else {
      missing += 1;
    }
  }

  if (missing > 0 && trackingIds.length === 0) {
    // Every ship-track link existed but none surfaced a code — treat as
    // not_shipped (Amazon sometimes renders the Track button before the
    // carrier has issued a label).
    return { kind: 'not_shipped' };
  }
  if (missing > 0) {
    return { kind: 'partial', trackingIds };
  }
  return { kind: 'tracked', trackingIds };
}

async function readTrackingId(page: Page, url: string): Promise<string | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return null;
  }
  // Wait briefly for the tracking card to hydrate; don't fail hard if it
  // never appears — the fallback selector below handles some layouts.
  await page
    .waitForSelector('.pt-delivery-card-trackingId, .tracking-event-trackingId-text', {
      timeout: 10_000,
    })
    .catch(() => undefined);
  const html = await page.content();
  const doc = new JSDOM(html).window.document;
  return trackingIdFromShipTrack(doc);
}
