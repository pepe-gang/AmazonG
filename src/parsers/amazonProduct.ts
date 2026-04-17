import type { ProductCondition, ProductInfo } from '../shared/types.js';

export function parseAmazonProduct(doc: Document, url: string): ProductInfo {
  const title = text(doc.querySelector('#productTitle'));

  const priceText = firstText(doc, [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '.priceToPay .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
  ]);
  const price = parsePrice(priceText);

  const cashbackPct = findCashbackPct(doc);

  const availabilityText = text(doc.querySelector('#availability'));
  const inStock = classifyInStock(doc, availabilityText);

  const condition = findCondition(doc);
  const shipsToAddress = findShipsToAddress(doc);
  const isPrime = findIsPrime(doc);
  const hasBuyNow = findHasBuyNow(doc);
  const buyBlocker = findBuyBlocker(doc);

  return {
    url,
    title,
    price,
    priceText,
    cashbackPct,
    inStock,
    availabilityText,
    condition,
    shipsToAddress,
    isPrime,
    hasBuyNow,
    buyBlocker,
  };
}

function text(node: Element | null): string | null {
  if (!node) return null;
  // Clone then strip script/style/noscript so unhydrated inline JS source
  // (e.g. Amazon's `P.when("A", "load").execute(...)` blocks inside
  // `#availability`) doesn't leak into the returned text.
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  const t = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

function firstText(doc: Document, selectors: string[]): string | null {
  for (const sel of selectors) {
    const t = text(doc.querySelector(sel));
    if (t) return t;
  }
  return null;
}

export function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/[\u00a0\s]/g, '').match(/\$?([\d,]+(?:\.\d{1,2})?)/);
  if (!m || !m[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function findCashbackPct(doc: Document): number | null {
  const candidates: string[] = [];
  doc.querySelectorAll('[id*="cashback" i], [class*="cashback" i], [data-feature-name*="cashback" i]').forEach((n) => {
    const t = n.textContent?.trim();
    if (t) candidates.push(t);
  });
  const body = doc.body?.textContent ?? '';
  candidates.push(body);

  let best: number | null = null;
  for (const c of candidates) {
    const re = /(\d{1,2})\s*%\s*back/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && (best === null || n > best)) best = n;
    }
    if (best !== null) break;
  }
  return best;
}

function classifyInStock(doc: Document, availabilityText: string | null): boolean {
  const t = (availabilityText ?? '').toLowerCase();
  if (!t) {
    return Boolean(doc.querySelector('#add-to-cart-button, #buy-now-button'));
  }
  if (/in stock/.test(t)) return true;
  if (/out of stock|currently unavailable|temporarily out of stock/.test(t)) return false;
  return Boolean(doc.querySelector('#add-to-cart-button, #buy-now-button'));
}

/**
 * Detect whether the listing is New / Used / Renewed. Returns null when
 * no clear signal is found — callers should treat null as "probably new"
 * rather than failing hard.
 */
export function findCondition(doc: Document): ProductCondition | null {
  const bodyText = (doc.body?.textContent ?? '').slice(0, 30000);

  // Amazon Renewed badge / heading
  if (/\bamazon\s+renewed\b/i.test(bodyText)) return 'renewed';
  if (/renewed\s+(by|products)/i.test(bodyText)) return 'renewed';

  // Explicit "Condition: Used" / "Condition: New" in the buybox or offer list
  const condMatch = /\bcondition\s*:\s*(new|used|renewed|refurbished)\b/i.exec(bodyText);
  if (condMatch && condMatch[1]) {
    const v = condMatch[1].toLowerCase();
    if (v === 'new') return 'new';
    if (v === 'used') return 'used';
    return 'renewed';
  }

  // Canonical / current URL heuristic: /offer-listing/ pages are per-seller
  // listings which often surface "Used - Good" etc.
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '';
  if (/\/offer-listing\//.test(canonical)) {
    if (/\bused\b\s*[-–]\s*(like new|very good|good|acceptable)/i.test(bodyText)) return 'used';
    if (/\brefurbished\b/i.test(bodyText)) return 'renewed';
  }

  return null;
}

/**
 * Detect whether Amazon is surfacing a "cannot ship to your address" block.
 * Returns false only on explicit shipping denial messages, true when a
 * working buy/add-to-cart button is present, and null when indeterminate.
 */
export function findShipsToAddress(doc: Document): boolean | null {
  const bodyText = (doc.body?.textContent ?? '').slice(0, 30000);

  const blockers = [
    /this item cannot be shipped/i,
    /this item (can't|does not|doesn't) ship/i,
    /we (do not|don't|cannot|can't) ship this/i,
    /not available for shipping to/i,
    /currently cannot ship to your selected location/i,
  ];
  for (const re of blockers) {
    if (re.test(bodyText)) return false;
  }

  const buyable = doc.querySelector(
    '#add-to-cart-button:not([disabled]), #buy-now-button:not([disabled])',
  );
  if (buyable) return true;

  return null;
}

/**
 * Detect whether this listing displays the visible Amazon Prime badge
 * (the orange-checkmark "prime" badge shown in the buy-box / delivery area).
 *
 * Amazon uses different markup depending on the product template:
 *   1. `#prime-badge` — the canonical buy-box Prime icon on most pages.
 *   2. `.a-icon-prime-with-text` — wrapper with an "X-Day" delivery label.
 *
 * A bare `.a-icon-prime` elsewhere (e.g. `<span class="badge-slot aok-hidden">`)
 * is ignored — those produce false positives.
 *
 * Any candidate that lives inside an `aok-hidden` ancestor or an inactive
 * accordion row/feature slot is skipped.
 */
export function findIsPrime(doc: Document): boolean | null {
  const candidates = doc.querySelectorAll('#prime-badge, .a-icon-prime-with-text');
  for (const el of candidates) {
    if (!isHidden(el)) return true;
  }

  const hasProductUi =
    doc.querySelector('#productTitle') &&
    doc.querySelector('#add-to-cart-button, #buy-now-button');
  if (hasProductUi) return false;

  return null;
}

// Slots that are outer accordion *containers*, not rows. They carry
// `data-csa-c-is-in-initial-active-row="false"` as a template attribute on
// the wrapper — which does NOT mean the children are hidden.
const ACCORDION_CONTAINER_SLOTS = new Set([
  'accordionRows',
  'desktop_accordion',
  'desktop_buybox',
  'offer_display_content',
  'apex_desktop',
  'apex_dp_center_column',
]);

function isHidden(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const cls = node.classList;
    if (cls && (cls.contains('aok-hidden') || cls.contains('a-hidden'))) return true;
    const slot = node.getAttribute?.('data-csa-c-slot-id');
    if (
      slot &&
      !ACCORDION_CONTAINER_SLOTS.has(slot) &&
      node.getAttribute?.('data-csa-c-is-in-initial-active-row') === 'false'
    ) {
      // A concrete accordion row or feature slot marked inactive → hidden.
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * Extract Amazon's human-readable reason the buy-box is blocked, if one is
 * being shown. Returns null when nothing specific was found.
 *
 * Known feature-div signals:
 *   #quantityLimitExhaustionAOD_feature_div — "Quantity limit met for this seller."
 *   #outOfStock_feature_div                 — "Currently unavailable"
 */
export function findBuyBlocker(doc: Document): string | null {
  const selectors = [
    '#quantityLimitExhaustionAOD_feature_div',
    '#outOfStock_feature_div',
  ];
  // Buy-blocker widgets often carry `data-csa-c-is-in-initial-active-row="false"`
  // even when they're visibly rendered — the attribute is a template default,
  // not a visibility signal for these feature divs. Only treat the widget as
  // hidden if a real aok-hidden ancestor is present.
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el || hasAokHiddenAncestor(el)) continue;
    const msg = extractBlockerText(el);
    if (msg) return msg;
  }
  return null;
}

function hasAokHiddenAncestor(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    const cls = node.classList;
    if (cls && (cls.contains('aok-hidden') || cls.contains('a-hidden'))) return true;
    node = node.parentElement;
  }
  return false;
}

function extractBlockerText(el: Element): string | null {
  // Amazon usually renders the short human message in a small info span.
  const candidates = el.querySelectorAll(
    '.a-size-mini, .a-color-error, .a-color-price, .a-alert-content',
  );
  for (const c of candidates) {
    const t = c.textContent?.trim().replace(/\s+/g, ' ');
    if (t && t.length > 0 && t.length < 200) return t;
  }
  // Fallback: collapse the full text and return it if short enough.
  const all = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (all.length > 0 && all.length < 200) return all;
  return null;
}

/**
 * Detect whether the product page is offering a working "Buy Now" button.
 * Variation-required listings often render a title/price but no Buy Now
 * until the shopper picks a size/color — we treat those as unbuyable.
 *
 * Returns true when a Buy Now button is visible and enabled.
 * Returns false when we clearly have product UI but no enabled Buy Now.
 * Returns null when the page appears unhydrated (no title at all).
 */
export function findHasBuyNow(doc: Document): boolean | null {
  const candidates = doc.querySelectorAll(
    '#buy-now-button, input[name="submit.buy-now"], #buyNow_feature_div button',
  );
  for (const el of candidates) {
    if (isHidden(el)) continue;
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    return true;
  }

  // If we clearly have a product page, a missing Buy Now means something is
  // blocking the purchase (variation not picked, sold out, region-restricted).
  if (doc.querySelector('#productTitle')) return false;

  return null;
}
