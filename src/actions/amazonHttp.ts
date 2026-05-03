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
