import type { OrderConfirmation } from '../shared/types.js';
import { parsePrice, findCashbackPct } from './amazonProduct.js';

/**
 * Extract the order id + final price from Amazon's "thank you" / confirmation
 * page. Works for both `/gp/buy/thankyou/handlers/display.html` and the newer
 * `/gp/buy/thankyou` path.
 */
export function parseOrderConfirmation(doc: Document, currentUrl: string): OrderConfirmation {
  const orderId =
    readOrderIdFromDom(doc) ?? readOrderIdFromUrl(currentUrl) ?? null;

  const finalPriceText = readFinalPriceText(doc);
  const finalPrice = parsePrice(finalPriceText);

  const quantity = readQuantityFromDom(doc);

  return { orderId, finalPriceText, finalPrice, quantity };
}

/**
 * Amazon's thankyou page renders a small badge over each line-item's
 * thumbnail: `<span class="checkout-quantity-badge">3</span>`. Absent for
 * qty=1 (Amazon hides it). For single-product orders (our case) there's
 * at most one badge; take the first numeric one we find.
 */
function readQuantityFromDom(doc: Document): number | null {
  const badges = Array.from(doc.querySelectorAll('.checkout-quantity-badge'));
  for (const b of badges) {
    const n = parseInt((b.textContent ?? '').trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function readOrderIdFromDom(doc: Document): string | null {
  // Post-order pages surface the id in several places depending on A/B:
  //   <span id="orderId">113-1234567-1234567</span>
  //   <span data-order-id="..."></span>
  //   text "Order #113-..." in the confirmation heading
  const byId = doc.querySelector('#orderId, [data-order-id]');
  if (byId) {
    const data = byId.getAttribute('data-order-id');
    if (data && isOrderIdShape(data)) return data;
    const t = byId.textContent?.trim();
    if (t && isOrderIdShape(t)) return t;
  }

  const body = doc.body?.textContent ?? '';
  const m = body.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  return m?.[1] ?? null;
}

function readOrderIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const q = parsed.searchParams.get('orderId') ?? parsed.searchParams.get('purchaseId');
    if (q && isOrderIdShape(q)) return q;
  } catch {
    // ignore invalid url
  }
  return null;
}

function isOrderIdShape(s: string): boolean {
  return /^\d{3}-\d{7}-\d{7}$/.test(s.trim());
}

function readFinalPriceText(doc: Document): string | null {
  // Confirmation page "Order total:" selectors we've seen in the wild.
  const selectors = [
    '#od-subtotals .a-color-price',
    '#od-subtotals [data-hook*="total" i] .a-color-price',
    '.order-total .a-color-price',
    '#subtotals-marketplace-table [data-hook*="grand-total" i]',
    '[data-hook="grand-total"]',
    // Pre-order checkout page total (we may read on checkout too)
    '#subtotals .grand-total-price',
    '#submitOrderButtonId .grand-total-price',
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const t = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (t && /\d/.test(t)) return t;
  }
  // Fall back to scanning text near "Order total" / "Grand Total"
  const body = (doc.body?.textContent ?? '').replace(/\s+/g, ' ');
  const m = body.match(/(?:order\s*total|grand\s*total)\s*[:\-]?\s*(\$[\d,]+\.\d{2})/i);
  return m?.[1] ?? null;
}

/**
 * Read the cashback percentage as shown on the checkout page. Amazon
 * typically surfaces the offer here even when it's absent from the product
 * page. Same regex strategy as the product-page parser.
 */
export function findCheckoutCashbackPct(doc: Document): number | null {
  return findCashbackPct(doc);
}

/**
 * Selectors for Amazon's "Before You Go" (BYG) upsell interstitial that
 * sometimes appears between Proceed-to-Checkout and /spc. Title is
 * "Need anything else?" with a "Continue to checkout" button that
 * forwards to /spc when clicked. Exported as constants so the runtime
 * locator and the parser test share one source of truth.
 */
export const BYG_HEADER_SELECTOR = '#before-you-go-header';
export const BYG_BUTTON_SELECTOR = 'a[name="checkout-byg-ptc-button"]';

/** True iff the page is the BYG "Need anything else?" interstitial. */
export function isBeforeYouGoInterstitial(doc: Document): boolean {
  return doc.querySelector(BYG_HEADER_SELECTOR) !== null;
}
