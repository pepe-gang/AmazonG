import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import {
  isPaymentRevisionRequired,
  readQuantityFromOrderDetailsHtml,
} from '../parsers/amazonCheckout.js';
import { HTTP_BROWSERY_HEADERS } from './amazonHttp.js';

export type VerifyOrderOutcome =
  | {
      kind: 'active';
      orderId: string;
      /** Amazon's payment-method charge failed and the order is parked
       *  in a "Revise Payment" state. Order is still active and CAN
       *  proceed once the customer fixes payment, so the outcome stays
       *  `active`; this flag exists for the caller to emit a warning
       *  log so the row's diagnostics surface "needs payment revision"
       *  instead of looking quietly stuck-pending. */
      paymentRevisionRequired?: boolean;
      /** Total quantity of the target item in this order, scraped from
       *  the order-details page line-item listing. Null when the page
       *  layout doesn't expose qty in a recognized shape. The verify
       *  caller forwards this to BG as `purchasedCount` so a buy-time
       *  reporting bug (e.g. /spc-DOM-read returning 1 when Amazon
       *  actually placed 2) gets corrected on the next verify pass. */
      placedQuantity?: number | null;
    }
  | { kind: 'cancelled'; orderId: string }
  | { kind: 'timeout'; orderId: string }
  | { kind: 'error'; orderId: string; message: string };


/**
 * Decide whether an order is active, cancelled, or indeterminate by
 * fetching its order-details HTML directly via `context.request.get`.
 *
 * Replaces the prior `page.goto(...) + 15s polling on body.innerText`
 * approach with a single ~1s HTTP request. Same cookies + UA inherited
 * from the BrowserContext via APIRequestContext (same path clearCart
 * and addFillerViaHttp use). Saves 5-14s per verify.
 *
 * Detection logic — verified live 2026-05-04 against 7 active + 3
 * cancelled real orders:
 *
 *  1. Cancellation: `<div data-component="cancelled" ...>` is on
 *     EVERY order-details page, but its inner content only carries
 *     "This order has been cancelled" when the order is actually
 *     cancelled. Empty / placeholder content otherwise. The regex
 *     below scopes to "marker AND text within the same div" and
 *     correctly disambiguated 7/7 in our test set.
 *
 *  2. Active: orderId rendered in body + at least one order-section
 *     keyword (subtotal / total / items ordered / arriving / shipped).
 *     Same pair the previous in-page polling used; just runs over
 *     `document.body.textContent` from the parsed HTML instead of
 *     `body.innerText` from a live DOM. The textContent shape is a
 *     superset of innerText; the keyword regex is order-of-magnitude
 *     tolerant.
 *
 *  3. Error pages: Amazon's "We're unable to load your order" /
 *     "Sorry, something went wrong" messages are server-rendered
 *     boilerplate, not JS-injected. Same regex catches them in
 *     either render path.
 *
 *  4. Payment-revision: pure-parser check via
 *     `isPaymentRevisionRequired(doc)` from amazonCheckout.ts —
 *     unchanged, just runs against JSDOM's parsed Document instead
 *     of `await page.content()` + JSDOM.
 *
 * The `page` parameter is still required (callers pass it for the
 * APIRequestContext + cookie sharing). No browser tab is opened by
 * this function — saves the page.goto's tab-acquire + DOM-hydration
 * overhead entirely.
 *
 * On HTTP/network failure: returns `{ kind: 'error', message }` so
 * the caller can decide between retry and surface-as-failure.
 *
 * See `docs/research/amazon-pipeline.md` for the full empirical
 * research behind this implementation.
 */
export async function verifyOrder(
  page: Page,
  orderId: string,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyOrderOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;

  let res;
  try {
    res = await page.context().request.get(url, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: timeoutMs,
    });
  } catch (err) {
    return {
      kind: 'error',
      orderId,
      message: `fetch threw: ${String(err).slice(0, 180)}`,
    };
  }
  if (!res.ok()) {
    return {
      kind: 'error',
      orderId,
      message: `HTTP ${res.status()}`,
    };
  }

  let html: string;
  try {
    html = await res.text();
  } catch (err) {
    return {
      kind: 'error',
      orderId,
      message: `body read failed: ${String(err).slice(0, 180)}`,
    };
  }

  // 1. Error pages — server-rendered boilerplate, regex same as the
  //    previous in-page polling path.
  const errMatch = html.match(
    /(We(?:'|’)re unable to load your order(?: details)?[^.\n<]*\.?|We can(?:'|’)t (?:find|display|retrieve) (?:that|this|your) order[^.\n<]*\.?|Sorry,?\s*something went wrong[^.\n<]*\.?)/i,
  );
  if (errMatch) {
    return { kind: 'error', orderId, message: errMatch[0].replace(/\s+/g, ' ').trim().slice(0, 200) };
  }

  // 2. Cancellation — scoped match against EITHER of two known
  //    Amazon container markers (verified against real captures):
  //      - data-component="cancelledOrderBanner"  ← current/2026 layout;
  //         the empty `data-component="cancelled"` div is also rendered
  //         but has no inner text, so we have to look for the Banner.
  //      - data-component="cancelled"             ← older layout where
  //         the cancellation copy DID render inside the cancelled div
  //         (kept for back-compat with any A/B variant still serving it).
  //    Both must contain "This order has been cancelled" within 3000
  //    chars of the opening tag — the text is the safety belt against
  //    matching an unrelated future div that happens to share the
  //    component name.
  const cancelledScopedRe =
    /<div[^>]+data-component=["'](?:cancelledOrderBanner|cancelled)["'][^>]*>[\s\S]{0,3000}?This order has been cancell?ed/i;
  if (cancelledScopedRe.test(html)) {
    return { kind: 'cancelled', orderId };
  }

  // 3. Active — orderId rendered in body + at least one order-section
  //    keyword. Use JSDOM's textContent so the keyword scan only sees
  //    rendered text (matches the previous body.innerText behavior).
  const doc = new JSDOM(html).window.document;
  const orderIdRendered = html.includes(orderId);
  const bodyText = (doc.body?.textContent ?? '').replace(/\s+/g, ' ');
  const hasOrderContent =
    /(subtotal|order\s*total|items?\s*ordered|order\s*placed|delivery|shipped\s+on|arriving)/i.test(
      bodyText,
    );
  if (!orderIdRendered || !hasOrderContent) {
    return { kind: 'timeout', orderId };
  }

  // 4. Active path — also check for the "Payment revision needed" state.
  //    Amazon doesn't cancel the order when a card declines; it parks it
  //    with a Revise Payment button. Order stays `active` (it can still
  //    ship once payment is fixed), but we surface the flag so the
  //    caller can emit a warning log.
  const paymentRevisionRequired = isPaymentRevisionRequired(doc);
  // Read placed qty from the order details page. Used by the verify
  // caller to forward `purchasedCount` to BG, which corrects any
  // buy-time reporting bug retroactively.
  const placedQuantity = readQuantityFromOrderDetailsHtml(html);
  const base = { kind: 'active' as const, orderId };
  return {
    ...base,
    ...(paymentRevisionRequired ? { paymentRevisionRequired: true } : {}),
    ...(placedQuantity !== null ? { placedQuantity } : {}),
  };
}
