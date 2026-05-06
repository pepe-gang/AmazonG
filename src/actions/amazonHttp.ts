/**
 * Shared HTTP plumbing for Amazon endpoints we hit via Playwright's
 * `BrowserContext.request` (Node-side, cookies + User-Agent inherited
 * from the context). Used by clearCart + buyWithFillers + any future
 * hybrid HTTP path. Anything in here is browser-shape-agnostic — it's
 * meant to be importable from any Node-side action file.
 *
 * NOT importable from inside `page.evaluate(...)` callbacks — those
 * run in the browser context and have no access to Node imports. Keep
 * any in-page logic mirroring these constants in sync manually
 * (search call sites for CART_ADD_URL to find them).
 */

/**
 * Headers we set on every `context.request.{get,post}` call so the wire
 * shape looks like a real navigation. Cookies + User-Agent are inherited
 * from the BrowserContext automatically; these fill in the Accept /
 * Accept-Language pair that APIRequestContext doesn't auto-attach.
 */
export const HTTP_BROWSERY_HEADERS: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * The modern cart-add endpoint. Amazon's recommendation/carousel forms
 * POST here with a 5-field body (anti-csrftoken-a2z + items[0.base][asin]
 * + items[0.base][offerListingId] + items[0.base][quantity] + clientName).
 *
 * Discovered live: the legacy `/gp/product/handle-buy-box/...` endpoint
 * that the main `<form id="addToCart">` declares as its action is a
 * deprecated 404'er; the click-based UI works because Amazon's JS
 * submits via a different mechanism. This endpoint accepts the harvested
 * tokens directly and returns 200 + cart-page HTML on commit.
 *
 * The `ref=` portion is a tracking marker — Amazon doesn't validate it,
 * any string works. Using one of Amazon's own values for natural-looking
 * traffic.
 */
export const CART_ADD_URL =
  'https://www.amazon.com/cart/add-to-cart/ref=emc_s_m_5_i_atc_c';

export const CART_ADD_CLIENT_NAME = 'Aplus_BuyableModules_DetailPage';

/**
 * Amazon's BYG-Continue handler URL. A `page.goto` here reads the user's
 * server-side cart, spins up a fresh checkout session, and 302-redirects
 * to `/checkout/p/p-{purchaseId}/spc` with all cart items populated.
 * Replaces three navigation steps in the legacy click flow (cart-page
 * render + Proceed click + BYG interstitial click) with one nav.
 *
 * Used by both filler mode (buyWithFillers) and single-buy mode (buyNow)
 * after their respective HTTP cart-adds commit.
 */
export const SPC_ENTRY_URL =
  'https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1';

/**
 * Regex returns true when `page.url()` is anywhere inside Amazon's checkout
 * funnel. Matches the three URL shapes Amazon currently routes checkout
 * sessions through:
 *   - `/gp/buy/...`         (legacy)
 *   - `/checkout/p/...`     (Chewbacca SPC)
 *   - `/spc/...`            (newer SPC)
 *
 * Used to verify the SPC_ENTRY_URL shortcut actually landed on a checkout
 * page (vs. a fallback to /cart or BYG).
 */
export const SPC_URL_MATCH = /\/gp\/buy\/|\/checkout\/p\/|\/spc\//i;

/**
 * Regex that returns true if the given response body looks like a
 * successful cart-page render. A successful Amazon cart-add returns
 * either:
 *   - the full cart-page HTML (Subtotal / Your Shopping Cart markers)
 *   - a JSON cart-update payload (itemCount field)
 *   - a smart-wagon redirect (drawer-style mini cart)
 *
 * Bot challenges and 5xx gateways won't carry any of these markers, so
 * a `looksLikeCartResponse` miss is a reasonable signal to fall back.
 */
const CART_RESPONSE_RE =
  /sub\s*total|"itemCount"|added\s+to\s+(your\s+)?cart|your\s+(shopping\s+)?cart|smart-?wagon/i;

export function looksLikeCartResponse(text: string): boolean {
  return CART_RESPONSE_RE.test(text);
}

/** Same regex as a string, for embedding into `page.evaluate(...)`
 *  callbacks where imports aren't available. Keep in sync with
 *  CART_RESPONSE_RE above. */
export const CART_RESPONSE_RE_SOURCE = CART_RESPONSE_RE.source;

/**
 * The three hidden inputs the modern `/cart/add-to-cart/ref=...` endpoint
 * needs from a PDP's `<form id="addToCart">`. Pure DOM read so it works
 * against either a JSDOM document (Node-side, from `ctx.request.get` or
 * `page.content()`) OR a Playwright `evaluate` shim that exposes the
 * same `document` API. Returns null on any missing field — caller treats
 * that as a fall-through to the click path.
 */
export type CartAddTokens = {
  csrf: string;
  offerListingId: string;
  asin: string;
};

export function extractCartAddTokens(doc: Document): CartAddTokens | null {
  const form = doc.getElementById('addToCart');
  if (!form) return null;
  const csrf = (
    form.querySelector('input[name="anti-csrftoken-a2z"]') as HTMLInputElement | null
  )?.value;
  const offerListingId =
    (form.querySelector('input[name="items[0.base][offerListingId]"]') as HTMLInputElement | null)
      ?.value ??
    (form.querySelector('input[name="offerListingID"]') as HTMLInputElement | null)?.value;
  const asin =
    (form.querySelector('input[name="items[0.base][asin]"]') as HTMLInputElement | null)?.value ??
    (form.querySelector('input[name="ASIN"]') as HTMLInputElement | null)?.value;
  if (!csrf || !offerListingId || !asin) return null;
  return { csrf, offerListingId, asin };
}

/**
 * Cart-add candidate harvested from a search-result card. Each Amazon
 * search-result `<form>` already carries `anti-csrftoken-a2z` +
 * `items[0.base][offerListingId]` + `items[0.base][asin]` (verified live
 * 2026-05-05). That means a single search-results HTML fetch yields
 * ~50 ready-to-add candidates without requiring a per-ASIN PDP fetch
 * to harvest tokens.
 */
export type SearchResultCandidate = {
  asin: string;
  offerListingId: string;
  /** Page-level CSRF — same value across every card on a given page. */
  csrf: string;
  /** Card-rendered "whole + fraction" price. Filtered against
   *  FILLER_MIN_PRICE / FILLER_MAX_PRICE in the caller. Null when the
   *  card is missing the standard `.a-price-whole` element (rare). */
  price: number | null;
  /** True when the card visibly bears a Prime badge. The search URL
   *  filter (`p_85:2470955011`) already restricts to Prime-eligible
   *  listings, but caller may double-check for resilience to Amazon
   *  drift. */
  isPrime: boolean;
};

/**
 * Extract every cart-add-ready candidate from a parsed search-results
 * Document. One Document → up to ~50 candidates per typical search
 * page; caller dedups across multiple terms.
 *
 * Returns an empty array on any parse mismatch — caller treats as a
 * search miss and tries the next term. Never throws.
 */
export function extractSearchResultCandidates(doc: Document): SearchResultCandidate[] {
  const cards = doc.querySelectorAll(
    '[data-asin][data-component-type="s-search-result"]',
  );
  const out: SearchResultCandidate[] = [];
  cards.forEach((card) => {
    const form = card.querySelector('form');
    if (!form) return;
    const asin = (
      form.querySelector('input[name="items[0.base][asin]"]') as HTMLInputElement | null
    )?.value;
    const offerListingId = (
      form.querySelector('input[name="items[0.base][offerListingId]"]') as HTMLInputElement | null
    )?.value;
    const csrf = (
      form.querySelector('input[name="anti-csrftoken-a2z"]') as HTMLInputElement | null
    )?.value;
    if (!asin || !offerListingId || !csrf) return;

    let price: number | null = null;
    const wholeEl = card.querySelector('.a-price-whole');
    const fracEl = card.querySelector('.a-price-fraction');
    if (wholeEl) {
      const whole =
        parseFloat((wholeEl.textContent || '').replace(/[^0-9]/g, '')) || 0;
      const frac = fracEl
        ? parseFloat('0.' + (fracEl.textContent || '').replace(/[^0-9]/g, ''))
        : 0;
      price = whole + frac;
    }

    const isPrime =
      card.querySelector('.s-prime') !== null ||
      card.querySelector('[aria-label*="Prime"]') !== null ||
      card.innerHTML.includes('a-icon-prime');

    out.push({ asin, offerListingId, csrf, price, isPrime });
  });
  return out;
}

/**
 * Build the `application/x-www-form-urlencoded` body for a multi-item
 * cart-add POST. Amazon's `/cart/add-to-cart/ref=...` endpoint accepts
 * any number of `items[N.base][...]` triplets in one POST (verified
 * live with 8 items; status 200, all 8 in cart).
 *
 * `clientName` defaults to the search-flow value (`EUIC_AddToCart_Search`)
 * because the typical batch caller harvests tokens from search results.
 * PDP-form callers can pass `Aplus_BuyableModules_DetailPage` instead.
 */
export type BatchCartAddItem = {
  asin: string;
  offerListingId: string;
  quantity?: number;
};

export const SEARCH_CART_ADD_CLIENT_NAME = 'EUIC_AddToCart_Search';

export function buildBatchCartAddBody(
  csrf: string,
  items: readonly BatchCartAddItem[],
  opts: { clientName?: string } = {},
): URLSearchParams {
  const body = new URLSearchParams();
  body.append('anti-csrftoken-a2z', csrf);
  body.append('clientName', opts.clientName ?? SEARCH_CART_ADD_CLIENT_NAME);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const qty = Math.max(1, Math.min(99, Math.round(it.quantity ?? 1)));
    body.append(`items[${i}.base][asin]`, it.asin);
    body.append(`items[${i}.base][offerListingId]`, it.offerListingId);
    body.append(`items[${i}.base][quantity]`, String(qty));
  }
  return body;
}

/**
 * Streaming PDP fetch — bails early once the `<form id="addToCart">`
 * is fully captured. Saves ~990ms per fetch on a real ~2MB PDP body
 * because the form lives in the first ~25% of the body and the trailing
 * 1.5MB (recommendations / Rufus / footer / lazy-load) carries nothing
 * AmazonG reads (verified pass-5 empirical, 2026-05-05).
 *
 * Bypasses Playwright's APIRequestContext (no streaming API exposed)
 * and uses Node 18+ native `fetch`. Cookies are copied from the
 * BrowserContext at fetch time; User-Agent matches driver.ts so the
 * request looks identical to ctx.request paths on the wire.
 *
 * Returns null on any error (network failure, non-2xx, body-read
 * exception, or no `</form>` found within the safety cap). Caller
 * falls back to ctx.request.get for those cases.
 *
 * Use only on PDP `/dp/<asin>` URLs where the parser will run
 * extractCartAddTokens on the result. Don't use for /spc — pass-5
 * showed the server batches the body so streaming saves nothing
 * there. Don't use for /your-account/order-details either — those
 * are smaller bodies where the cancel-mid-flight overhead exceeds
 * the saving.
 */
const PDP_STREAM_SAFETY_CAP_BYTES = 600 * 1024;
const PDP_STREAM_TIMEOUT_MS = 15_000;
// Match the UA pinned in driver.ts so the wire shape is identical
// to ctx.request.get paths. Update both places in lockstep.
const PDP_STREAM_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function pdpHttpFetchStreaming(
  ctx: import('playwright').BrowserContext,
  pdpUrl: string,
): Promise<string | null> {
  const cookies = await ctx.cookies(pdpUrl).catch(() => []);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  let response: Response;
  try {
    response = await fetch(pdpUrl, {
      headers: {
        ...HTTP_BROWSERY_HEADERS,
        'User-Agent': PDP_STREAM_USER_AGENT,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(PDP_STREAM_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok || !response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let html = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });

      // Bail once <form id="addToCart"> is fully captured (open + close).
      // extractCartAddTokens reads only fields inside that form — once
      // we've seen its </form>, every token the parser needs is in our
      // buffer. The buy-box typically renders by byte ~506K of a 2MB
      // body (pass-5 measurement), so this cancel fires well before the
      // safety cap.
      const formStart = html.indexOf('id="addToCart"');
      if (formStart >= 0 && html.indexOf('</form>', formStart) >= 0) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (html.length >= PDP_STREAM_SAFETY_CAP_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    return null;
  }
  return html + decoder.decode();
}

/**
 * Phantom-commit guard for batch responses. The single-item add already
 * checks `data-asin="<ASIN>"` in the response HTML; the batch version
 * runs the same check per-ASIN and returns the subset that landed.
 *
 * Live observation 2026-05-05: every successful batch returned the
 * cart-page HTML with every requested ASIN's `data-asin="..."` present.
 * If Amazon ever silently drops one (rare in our PDP testing), we
 * return only the committed ASINs and the caller decides whether the
 * remaining count is acceptable.
 */
export function asinsCommittedInResponse(
  responseHtml: string,
  requestedAsins: readonly string[],
): string[] {
  return requestedAsins.filter((asin) => {
    const escaped = asin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`data-asin=["']${escaped}["']`).test(responseHtml);
  });
}
