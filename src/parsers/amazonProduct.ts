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
  const hasAddToCart = findHasAddToCart(doc);
  const isSignedIn = findIsSignedIn(doc);
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
    hasAddToCart,
    isSignedIn,
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
 * Detect whether this listing displays the visible Amazon Prime badge.
 *
 * Amazon uses two interchangeable buy-box markup patterns:
 *   1. `#prime-badge` — bare icon, used by some active-row layouts (verified
 *      live: B0DZ751XN6's active newAccordionRow_0 contains `<i id="prime-badge">`).
 *   2. `.a-icon-prime-with-text` — icon + delivery-time wrapper ("✓prime Two-Day"),
 *      used by other active-row layouts (verified live: REGR-2026-05-05-ipad-IS-prime
 *      fixture's qualifiedBuyBox).
 *
 * Both selectors are valid Prime signals. The reliability comes from
 * `isHidden`'s walk: any candidate inside an alternate-offer accordion-row
 * subtree (slot/id matching `accordionRow` substring, with the
 * accordion-row ancestor's `data-csa-c-is-in-initial-active-row` not "true")
 * is skipped.
 *
 * Bare `.a-icon-prime` icons (without `#prime-badge` id and without the
 * `-with-text` wrapper) are ignored — they appear in unrelated contexts
 * (badge slots, navigation, etc.) and produce false positives.
 *
 * INC-2026-05-05: a non-Prime iPad listing carried `#prime-badge` icons
 * INSIDE `usedAccordionRow` subtrees (alternate-offer previews). The
 * pre-fix isHidden walk relied on `data-csa-c-is-in-initial-active-row`
 * markers that Amazon sets as template defaults on container slots —
 * unreliable. The new walk uses the accordion-row name pattern + the
 * marker as an active-row exception, which separates this case from the
 * companion REGR-2026-05-05-ipad-IS-prime fixture (where the visible
 * Prime badge sits in qualifiedBuyBox with no accordion-row ancestor).
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

// Detection rule for "this candidate is inside Amazon's alternate-offer
// accordion subtree" (Used/New/Refurbished alternate rows that aren't
// the user-selected active offer).
//
// Signal: any ancestor whose `data-csa-c-slot-id` or `id` contains the
// substring "accordionRow" — except the framework container
// `accordionRows` (plural), which is just the wrapper around all rows
// and doesn't say anything about visibility on its own.
//
// Active-row exception: if the accordion-row ancestor carries
// `data-csa-c-is-in-initial-active-row="true"`, it IS the currently-
// selected row and its contents ARE visible — keep walking up but
// don't mark hidden. This is what makes the synthetic test
// "newAccordionRow_0 active inside accordionRows framework" pass.
// Any other state (marker="false" OR marker absent) → hidden.
//
// History:
//   1. Pre-2026-05-05: trusted the inactive marker with a small
//      whitelist of "container" slots. False positives — visible Prime
//      badges nested inside desktop_qualifiedBuyBox (which carries the
//      marker as a template default) were treated as hidden.
//   2. 2026-05-05 attempt 1: inverted to a slot-name pattern + marker.
//      Missed the case where the accordion identity is on the `id`
//      rather than the slot (apex_desktop_usedAccordionRow).
//   3. 2026-05-05 attempt 2: substring match on slot OR id, dropped
//      the marker. Broke the synthetic test where an active inner row
//      lives inside an outer accordion framework.
//   4. 2026-05-05 attempt 3 (this version): substring match on slot OR
//      id, with the active-marker exception so an explicitly-active
//      row stays visible.
//
// Verified against:
//   - IS-PRIME REGR fixture: no ancestor matches → not hidden → returns true.
//   - NO-PRIME INC fixture: usedAccordionRow ancestors with no marker
//     OR marker=false → hidden → returns false.
//   - Synthetic newAccordionRow_0 active inside accordionRows: the
//     individual row is marker="true" (active) → not hidden via the
//     exception; outer accordionRows is the framework container →
//     ignored → walk completes → returns true.
const ACCORDION_ROW_RE = /accordionRow/i;

function isAccordionRowFrameworkContainer(name: string): boolean {
  return name.toLowerCase() === 'accordionrows';
}

function isHidden(el: Element): boolean {
  let node: Element | null = el;
  // Tracks whether we passed through an inactive (or marker-less)
  // accordion-row ancestor during the walk. Settled at the end: only
  // mark hidden if we never saw an explicit active-row marker.
  let sawInactiveAccordionRow = false;
  while (node) {
    const cls = node.classList;
    if (cls && (cls.contains('aok-hidden') || cls.contains('a-hidden'))) return true;
    const slot = node.getAttribute?.('data-csa-c-slot-id') ?? '';
    const id = (node as Element).id ?? '';
    const slotMatchesRow = ACCORDION_ROW_RE.test(slot) && !isAccordionRowFrameworkContainer(slot);
    const idMatchesRow = ACCORDION_ROW_RE.test(id) && !isAccordionRowFrameworkContainer(id);
    if (slotMatchesRow || idMatchesRow) {
      const marker = node.getAttribute?.('data-csa-c-is-in-initial-active-row');
      if (marker === 'true') {
        // Explicit active row anywhere in the chain proves the
        // candidate's row IS the user-selected current offer. Visible.
        return false;
      }
      // marker === 'false' OR no marker present → potential hidden.
      // Continue walking — an inner ancestor's active=true would have
      // already returned, so anything we record here is unconfirmed
      // hidden until the walk completes.
      sawInactiveAccordionRow = true;
    }
    node = node.parentElement;
  }
  return sawInactiveAccordionRow;
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

/**
 * Add-to-Cart fallback detector. Some PDPs (Echo Dot, certain Prime
 * exclusives) hide Buy Now and only expose Add to Cart — see
 * fixtures/echo-dot-no-buy-now. We treat those as buyable via the
 * cart route. Mirrors findHasBuyNow's visibility/disabled checks so a
 * cart button that's there but greyed out doesn't false-positive.
 */
export function findHasAddToCart(doc: Document): boolean | null {
  const candidates = doc.querySelectorAll(
    '#add-to-cart-button, input[name="submit.add-to-cart"]',
  );
  for (const el of candidates) {
    if (isHidden(el)) continue;
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    return true;
  }
  if (doc.querySelector('#productTitle')) return false;
  return null;
}

/**
 * Read the account-area nav line to decide whether the session is signed
 * in. Amazon renders "Hello, sign in" for guests and "Hello, <name>"
 * once the at-main cookie is recognized — same selector loginAmazon's
 * probeSignedInState uses on amazon.com home. Returns null when the nav
 * isn't on this page (rare error pages strip the global header).
 */
export function findIsSignedIn(doc: Document): boolean | null {
  const el = doc.querySelector('#nav-link-accountList-nav-line-1');
  if (!el) return null;
  const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!txt) return null;
  if (/^hello,?\s*sign in$/i.test(txt)) return false;
  return true;
}
