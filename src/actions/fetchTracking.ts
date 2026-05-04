import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { verifyOrder } from './verifyOrder.js';
import { shipTrackLinksFor, trackingIdFromShipTrack } from '../parsers/amazonTracking.js';
import type { FetchTrackingOutcome } from '../shared/types.js';
import { HTTP_BROWSERY_HEADERS } from './amazonHttp.js';

/**
 * Fetch carrier tracking codes for `orderId` on the profile whose session
 * owns `page`. First half reuses `verifyOrder` — bails early on an explicit
 * cancellation (terminal) or a transient verify failure (retry later).
 * When the order is active, fetches the order-details page, scans for every
 * `a[href*="ship-track"]` scoped to this order, and reads the tracking
 * code from each via parallel HTTP requests.
 *
 * Both verify and ship-track lookups now go through `ctx.request.get`
 * (APIRequestContext) instead of `page.goto`. Cookies + UA inherited from
 * the BrowserContext, same path clearCart and addFillerViaHttp use. Saves
 * 25-29s on a typical 3-shipment buy compared to the previous sequential
 * page.goto loop.
 *
 * Verified live 2026-05-04 against shipped + open orders in the user's
 * account; existing parsers `shipTrackLinksFor` and `trackingIdFromShipTrack`
 * work unchanged on JSDOM-parsed Documents (matches the page.content() shape
 * they were originally written for).
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

  // verify.kind === 'active' — fetch the order-details HTML so we can
  // enumerate ship-track links scoped to THIS order (list pages leak
  // other orders' links into the same DOM).
  const paymentRevisionRequired = verify.paymentRevisionRequired === true;
  const ctx = page.context();
  const orderDetailsUrl = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
  let orderHtml: string;
  try {
    const res = await ctx.request.get(orderDetailsUrl, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
    if (!res.ok()) return { kind: 'retry', reason: 'verify_error' };
    orderHtml = await res.text();
  } catch {
    return { kind: 'retry', reason: 'verify_error' };
  }
  const orderDoc = new JSDOM(orderHtml).window.document;
  const urls = shipTrackLinksFor(orderDoc, orderId);

  if (urls.length === 0) {
    return { kind: 'not_shipped', ...(paymentRevisionRequired ? { paymentRevisionRequired } : {}) };
  }

  // Parallel ship-track fetches. APIRequestContext shares cookies +
  // user-agent with the BrowserContext, so each request looks just like
  // a real navigation. Per-fetch timeout is 15s — Amazon's edge typically
  // returns ship-track HTML in 300-800ms; a stuck shipment that times
  // out gets counted as "missing" and the outcome falls through to
  // partial / not_shipped.
  const results = await Promise.allSettled(
    urls.map(async (url) => readTrackingIdViaHttp(page, url)),
  );
  const trackingIds: string[] = [];
  let missing = 0;
  for (const r of results) {
    const code = r.status === 'fulfilled' ? r.value : null;
    if (code) trackingIds.push(code);
    else missing += 1;
  }

  if (missing > 0 && trackingIds.length === 0) {
    // Every ship-track link existed but none surfaced a code — treat as
    // not_shipped (Amazon sometimes renders the Track button before the
    // carrier has issued a label).
    return { kind: 'not_shipped', ...(paymentRevisionRequired ? { paymentRevisionRequired } : {}) };
  }
  if (missing > 0) {
    return { kind: 'partial', trackingIds, ...(paymentRevisionRequired ? { paymentRevisionRequired } : {}) };
  }
  return { kind: 'tracked', trackingIds, ...(paymentRevisionRequired ? { paymentRevisionRequired } : {}) };
}

/**
 * HTTP-fetch a /gp/your-account/ship-track URL and extract the carrier
 * tracking ID via the existing pure parser. Returns null when no code
 * is rendered yet (Amazon hasn't handed the package to USPS/UPS) or
 * when the request fails — caller treats null as "missing" and the
 * outcome falls through to partial / not_shipped.
 *
 * Replaces the previous `page.goto + waitForSelector + page.content()`
 * which cost 1-3s nav + up to 10s hydration wait per shipment; this
 * path returns in ~300-800ms with no browser tab navigation.
 */
async function readTrackingIdViaHttp(page: Page, url: string): Promise<string | null> {
  try {
    const res = await page.context().request.get(url, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
    if (!res.ok()) return null;
    const html = await res.text();
    const doc = new JSDOM(html).window.document;
    return trackingIdFromShipTrack(doc);
  } catch {
    return null;
  }
}
