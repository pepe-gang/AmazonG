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

/**
 * Selector for Amazon's "Your delivery options have changed due to your
 * updated purchase options. Please select a new delivery option to
 * proceed." error banner. Rare post-Place-Order state: Amazon re-renders
 * /spc, wipes the delivery radio we picked, and surfaces this message at
 * `[data-messageid="selectDeliveryOptionMessage"]`. Amazon only emits the
 * attribute when the message is actively displayed, so presence is a
 * reliable signal (no visibility walk needed).
 *
 * Recovery contract: re-run the cashback-delivery picker, click Place
 * Order again. Bounded to one retry at the runtime callsite.
 */
export const DELIVERY_OPTIONS_CHANGED_SELECTOR =
  '[data-messageid="selectDeliveryOptionMessage"]';

/** True iff /spc is showing the "delivery options changed" error banner. */
export function isDeliveryOptionsChangedBanner(doc: Document): boolean {
  return doc.querySelector(DELIVERY_OPTIONS_CHANGED_SELECTOR) !== null;
}

/** Shared title-prefix builder. Chewbacca's /spc strips ASINs from the DOM,
 *  so target-row lookups fall back to matching the product title. First
 *  ~40 chars is usually unique; strip quotes/backslashes so the substring
 *  is safe to embed as a literal in a selector or regex. */
export function buildTitlePrefix(targetTitle: string | null): string | null {
  return targetTitle !== null
    ? targetTitle.replace(/\s+/g, ' ').trim().slice(0, 40).replace(/["'\\]/g, '')
    : null;
}

/** Diagnostic fields collected on every cashback read. Mirrors the
 *  `CashbackDiag` type consumed by the caller in `buyWithFillers.ts`. */
export type CashbackDiag = {
  groupFound: boolean;
  walkDepth: number;
  scopeChars: number;
  scopeMatches: string[];
  bodyMatches: string[];
  scopeStart: string;
  checkedRadioCount: number;
  selectedLabel: string | null;
};

export type CashbackHit =
  | {
      found: false;
      diag: {
        totalLinks: number;
        asinInBody: boolean;
        titleSearched: string | null;
        titleInBody: boolean;
        url: string;
      };
    }
  | ({
      found: true;
      pct: number | null;
      scopeEnd: string;
    } & CashbackDiag);

/** Rendered-text reader: walks text nodes inside `el`, skipping
 *  `<script>/<style>/<noscript>/<template>` subtrees. Real browsers get
 *  this for free via `innerText`; JSDOM has no `innerText`, so we use this
 *  helper unconditionally so production and fixture tests agree on the
 *  text they're reading. Output is whitespace-normalized. */
function visibleText(el: Element): string {
  const doc = el.ownerDocument;
  if (!doc) return '';
  // Numeric constants used instead of NodeFilter.* so the helper stays
  // self-contained (NodeFilter is not a Node global in all runtimes).
  const SHOW_TEXT = 4;
  const FILTER_REJECT = 2;
  const FILTER_ACCEPT = 1;
  const walker = doc.createTreeWalker(el, SHOW_TEXT, {
    acceptNode(node: Node): number {
      let p: Element | null = (node as Text).parentElement;
      while (p && p !== doc.body && p !== doc.documentElement) {
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
          return FILTER_REJECT;
        }
        p = p.parentElement;
      }
      return FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  let n: Node | null;
  while ((n = walker.nextNode()) !== null) {
    parts.push((n as Text).textContent ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** A single (name, value) radio to click to upgrade cashback. Returned by
 *  `computeCashbackRadioPlans` — the runtime picker turns each plan into
 *  a Playwright click via `input[name="…"][value="…"]`. */
export type CashbackRadioPlan = {
  /** HTML `name` attribute — Amazon uses the shipping-group id as the
   *  name, so one plan per group. Excludes anonymous radios. */
  name: string;
  /** HTML `value` of the target radio (e.g. "second-nominated-day"). */
  value: string;
  /** Trimmed label text (first 120 chars) — for diag/logging only. */
  label: string;
  /** Cashback % of the radio we want to pick. */
  pickedPct: number;
  /** Cashback % of the radio currently checked in this group (0 if the
   *  default is non-cashback). */
  currentPct: number;
  /** HTML `value` of the currently-checked radio (for logging). */
  currentValue: string | null;
};

/**
 * Pure decision helper for the cashback-delivery picker. Groups all
 * non-address/non-payment radios by `name`, finds the option with the
 * highest "N% back" label, and returns a plan when that option:
 *   (a) meets `minPct`, AND
 *   (b) is strictly better than the currently-checked option in the group.
 *
 * Groups with only one radio are skipped (nothing to pick). Anonymous
 * radios (no `name` attr) are skipped too — we can't target them
 * reliably in a selector, and they're not delivery radios anyway.
 *
 * The runtime picker in `buyNow.ts` consumes these plans and clicks each
 * via a Playwright locator (which re-queries the DOM on each action, so
 * stale references across Amazon's re-renders don't matter).
 */
export function computeCashbackRadioPlans(
  doc: Document,
  minPct: number,
): CashbackRadioPlan[] {
  const radios = Array.from(
    doc.querySelectorAll('input[type="radio"]'),
  ) as HTMLInputElement[];
  const eligible = radios.filter(
    (r) =>
      !/destinationSubmissionUrl|paymentMethodForUrl|paymentMethod|ship-to-this|addressRadio/i.test(
        r.name || r.id || '',
      ),
  );
  type Opt = { r: HTMLInputElement; label: string; pct: number };
  const byName = new Map<string, Opt[]>();
  for (const r of eligible) {
    if (!r.name) continue;
    const key = r.name;
    if (!byName.has(key)) byName.set(key, []);
    const card = r.closest('label, .a-radio, [role="radio"]') ?? (r.parentElement as Element | null);
    const label = card ? visibleText(card) : '';
    const m = label.match(/(\d{1,2})\s*%\s*back/i);
    byName.get(key)!.push({
      r,
      label,
      pct: m ? Number(m[1]) : 0,
    });
  }
  const plans: CashbackRadioPlan[] = [];
  for (const [name, opts] of byName.entries()) {
    if (opts.length < 2) continue;
    const best = opts.reduce((a, b) => (b.pct > a.pct ? b : a));
    const current = opts.find((o) => o.r.checked);
    const currentPct = current?.pct ?? 0;
    if (best.pct >= minPct && best.pct > currentPct) {
      plans.push({
        name,
        value: best.r.value,
        label: best.label.slice(0, 120),
        pickedPct: best.pct,
        currentPct,
        currentValue: current?.r.value ?? null,
      });
    }
  }
  return plans;
}

/**
 * Pure DOM reader for "what cashback % applies to the target line item's
 * currently-selected delivery option?" — extracted so fixture tests can
 * pin the scope-walk + checked-radio behavior. Returns `pct: number` when
 * the target's selected radio has an "N% back" label, or `pct: null` when
 * the target's group offers cashback but the selected (default) radio is
 * non-cashback. Callers treat `pct: null` as a hard failure, which is why
 * the delivery picker has to click the 6% radio BEFORE this runs.
 *
 * Signature: `(doc, asin, title)`. The full `title` is accepted (not a
 * pre-built prefix) to match how callers have the product info handy.
 */
export function readTargetCashbackFromDom(
  doc: Document,
  asin: string,
  title: string | null,
): CashbackHit {
  const titlePrefix = buildTitlePrefix(title);

  // Step 1: locate by ASIN in href (classic /spc).
  let link: Element | null = doc.querySelector(`a[href*="${asin}"]`);

  // Step 1.5: hidden testid pin. Chewbacca /spc renders a hidden
  // `<span data-testid="Item_asin_N_N_N" class="aok-hidden">ASIN</span>`
  // inside each line-item card. It's the most reliable anchor we have
  // because Amazon STRIPS /dp/<asin> hrefs on the checkout page AND
  // short line-item titles don't match long PDP titles via the
  // startsWith heuristic. Use it before falling back to the title
  // walk — one exact-text match on a stable data-testid beats a
  // fuzzy prefix search.
  let testidMatch: Element | null = null;
  if (!link) {
    const spans = doc.querySelectorAll<HTMLElement>('[data-testid^="Item_asin_"]');
    for (const s of spans) {
      if ((s.textContent ?? '').trim() === asin) {
        testidMatch = s;
        break;
      }
    }
  }

  // Step 1b: title-prefix fallback. Used only when href + testid both
  // miss. Bidirectional prefix match (shared prefix of shorter length)
  // so PDP titles that are LONGER than the /spc line-item text still
  // match — e.g. PDP says "Nintendo Switch 2 System Bundle with Mario
  // Kart" but /spc line-item is truncated to "Nintendo Switch 2 System".
  let titleMatch: Element | null = null;
  if (!link && !testidMatch && titlePrefix && titlePrefix.length > 5) {
    const needle = titlePrefix.toLowerCase();
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, null);
    let n: Node | null;
    while ((n = walker.nextNode()) !== null) {
      const txt = ((n as Text).textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt.length < 6) continue;
      const k = Math.min(needle.length, txt.length);
      if (k >= 6 && txt.slice(0, k) === needle.slice(0, k)) {
        titleMatch = (n as Text).parentElement;
        break;
      }
    }
  }

  const anchor = link ?? testidMatch ?? titleMatch;
  if (!anchor) {
    const bodyText = visibleText(doc.body);
    return {
      found: false,
      diag: {
        totalLinks: doc.querySelectorAll('a').length,
        asinInBody: bodyText.includes(asin),
        titleSearched: titlePrefix ?? null,
        titleInBody: titlePrefix
          ? bodyText.toLowerCase().includes(titlePrefix.toLowerCase())
          : false,
        url: doc.defaultView?.location?.href ?? '',
      },
    };
  }

  // Step 2: walk up to the enclosing shipping group. The correct scope
  // contains BOTH the items list ("Arriving …") AND the delivery radios
  // with cashback labels ("N% back"). A MAX_SCOPE_CHARS cap stops the
  // walk from swallowing the whole page.
  //
  // Two invariants that bit us in the wild:
  //   1) Large fillers carts (10+ items in one shared shipping group) can
  //      push the delivery-group container well past 15k chars of visible
  //      text. Cap must be generous enough to contain it.
  //   2) The Amazon Day *description* subtree sitting next to the target
  //      title also mentions "6% back" as promotional copy but contains
  //      NO radio inputs. Walking only on "Arriving + % back" would stop
  //      at that description and Step 3 would then find zero checked
  //      radios → pct=null → false gate failure even though the correct
  //      6% radio IS checked further up the tree. So the walk additionally
  //      requires the ancestor to contain at least one radio.
  const MAX_SCOPE_CHARS = 200_000;
  let group: Element | null = null;
  let fallbackGroup: Element | null = null;
  let el: Element | null = anchor.parentElement;
  let depth = 0;
  while (el && el !== doc.body && depth < 20) {
    const text = visibleText(el);
    if (text.length > MAX_SCOPE_CHARS) break;
    if (text.length > 200) {
      const hasArriving = /\bArriving\b/i.test(text);
      const hasPctBack = /%\s*back\b/i.test(text);
      const hasRadio = el.querySelector('input[type="radio"]') !== null;
      if (hasArriving && hasPctBack && hasRadio) {
        group = el;
        break;
      }
      if (hasArriving && hasRadio && !fallbackGroup) fallbackGroup = el;
    }
    el = el.parentElement;
    depth++;
  }
  const scope: Element =
    group ?? fallbackGroup ?? (anchor.parentElement as Element | null) ?? anchor;

  // Step 3: read "% back" from the CHECKED radio's label only. Reading any
  // "% back" in scope was too loose: Amazon shows "6% back" as the label
  // of an UNSELECTED option (the default is 0%), and a loose scan passes
  // while the placed order gets 0%. What matters is the checked radio.
  const checkedRadios = Array.from(
    scope.querySelectorAll('input[type="radio"]'),
  ) as HTMLInputElement[];
  const relevantChecked = checkedRadios
    .filter((r) => r.checked)
    .filter(
      (r) =>
        !/destinationSubmissionUrl|paymentMethodForUrl|paymentMethod|ship-to-this|addressRadio/i.test(
          r.name || r.id || '',
        ),
    );
  let selectedPct: number | null = null;
  let selectedLabel: string | null = null;
  for (const r of relevantChecked) {
    const card =
      r.closest('label, .a-radio, [role="radio"]') ??
      (r.parentElement as Element | null);
    const label = card ? visibleText(card) : '';
    const m = label.match(/(\d{1,2})\s*%\s*back/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 99) {
        if (selectedPct === null || n > selectedPct) {
          selectedPct = n;
          selectedLabel = label.slice(0, 120);
        }
      }
    } else if (selectedLabel === null) {
      selectedLabel = label.slice(0, 120);
    }
  }

  // Step 4: diagnostics — all "% back" in scope and page-wide. Used by the
  // caller's log payload to disambiguate "no cashback option on this
  // group" from "radio not clicked".
  const text = visibleText(scope);
  const bodyText = visibleText(doc.body);
  const bodyMatches = bodyText.match(/\d{1,2}\s*%\s*back/gi) ?? [];
  const scopeMatches = text.match(/\d{1,2}\s*%\s*back/gi) ?? [];

  return {
    found: true,
    pct: selectedPct,
    selectedLabel,
    checkedRadioCount: relevantChecked.length,
    groupFound: group !== null,
    walkDepth: depth,
    scopeChars: text.length,
    bodyMatches: bodyMatches.slice(0, 8),
    scopeMatches: scopeMatches.slice(0, 8),
    scopeStart: text.slice(0, 200),
    scopeEnd: text.slice(Math.max(0, text.length - 200)),
  };
}
