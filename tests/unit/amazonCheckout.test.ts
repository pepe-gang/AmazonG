import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BYG_BUTTON_SELECTOR,
  BYG_HEADER_SELECTOR,
  DELIVERY_OPTIONS_CHANGED_SELECTOR,
  isBeforeYouGoInterstitial,
  isDeliveryOptionsChangedBanner,
  isVerifyCardChallenge,
  parseOrderConfirmation,
  findCheckoutCashbackPct,
  readTargetCashbackFromDom,
  buildTitlePrefix,
  computeCashbackRadioPlans,
  findCancelItemsLinkOnOrderDetails,
} from '@parsers/amazonCheckout';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../fixtures', name), 'utf8');
}

describe('parseOrderConfirmation', () => {
  it('reads order id from #orderId text', () => {
    const doc = docOf(`
      <html><body>
        <span id="orderId">113-1234567-1234567</span>
      </body></html>`);
    const r = parseOrderConfirmation(doc, 'https://www.amazon.com/gp/buy/thankyou');
    expect(r.orderId).toBe('113-1234567-1234567');
  });

  it('reads order id from data-order-id attribute', () => {
    const doc = docOf('<html><body><span data-order-id="114-7654321-7654321"></span></body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.orderId).toBe('114-7654321-7654321');
  });

  it('falls back to regex scan of body text', () => {
    const doc = docOf('<html><body>Your order #115-0001111-0001111 has been placed.</body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.orderId).toBe('115-0001111-0001111');
  });

  it('reads order id from URL query when DOM lacks it', () => {
    const doc = docOf('<html><body></body></html>');
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou?orderId=116-2223334-2223334',
    );
    expect(r.orderId).toBe('116-2223334-2223334');
  });

  it('returns null order id on unrelated page', () => {
    const doc = docOf('<html><body>Unrelated content</body></html>');
    expect(parseOrderConfirmation(doc, 'x').orderId).toBeNull();
  });

  it('extracts order total from od-subtotals block', () => {
    const doc = docOf(`
      <html><body>
        <div id="od-subtotals">
          <span class="a-color-price">$1,184.50</span>
        </div>
      </body></html>`);
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.finalPriceText).toContain('1,184.50');
    expect(r.finalPrice).toBe(1184.5);
  });

  it('falls back to Order total text in body', () => {
    const doc = docOf('<html><body>Order total: $24.99</body></html>');
    const r = parseOrderConfirmation(doc, 'x');
    expect(r.finalPriceText).toBe('$24.99');
    expect(r.finalPrice).toBe(24.99);
  });

  it('reads quantity from .checkout-quantity-badge', () => {
    const doc = docOf(`
      <html><body>
        <span class="a-color-secondary checkout-quantity-badge">3</span>
      </body></html>`);
    expect(parseOrderConfirmation(doc, 'x').quantity).toBe(3);
  });

  it('returns null quantity when badge is absent (qty=1 case)', () => {
    const doc = docOf('<html><body>Order placed, thanks!</body></html>');
    expect(parseOrderConfirmation(doc, 'x').quantity).toBeNull();
  });

  it('reads quantity from a real thankyou fixture (qty=3)', () => {
    const doc = docOf(fixture('thankyou-106-4510031-4901860.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-4510031-4901860',
    );
    expect(r.quantity).toBe(3);
  });

  it('returns null from a real thankyou fixture (qty=1, badge omitted)', () => {
    const doc = docOf(fixture('thankyou-106-3412656-3967431-qty1.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-3412656-3967431',
    );
    expect(r.quantity).toBeNull();
  });

  it('reads quantity from a real thankyou fixture (qty=5)', () => {
    const doc = docOf(fixture('thankyou-106-9503967-6167453-qty5.html'));
    const r = parseOrderConfirmation(
      doc,
      'https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-9503967-6167453',
    );
    expect(r.quantity).toBe(5);
  });
});

describe('isBeforeYouGoInterstitial', () => {
  it('detects the BYG "Need anything else?" page in a real fixture', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    expect(isBeforeYouGoInterstitial(doc)).toBe(true);
  });

  it('returns false on an unrelated page', () => {
    const doc = docOf('<html><body>Place your order</body></html>');
    expect(isBeforeYouGoInterstitial(doc)).toBe(false);
  });

  it('BYG_BUTTON_SELECTOR matches the Continue to checkout anchor in the fixture', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    const btn = doc.querySelector(BYG_BUTTON_SELECTOR);
    expect(btn).not.toBeNull();
    expect((btn?.textContent ?? '').trim()).toBe('Continue to checkout');
  });

  it('BYG_HEADER_SELECTOR matches the page header container', () => {
    const doc = docOf(fixture('spc-byg-need-anything-else.html'));
    expect(doc.querySelector(BYG_HEADER_SELECTOR)).not.toBeNull();
  });
});

describe('findCheckoutCashbackPct', () => {
  it('returns the largest N% back found', () => {
    const doc = docOf('<html><body>Earn 10% back on this purchase. Prime members: 12% back</body></html>');
    expect(findCheckoutCashbackPct(doc)).toBe(12);
  });
  it('returns null when absent', () => {
    const doc = docOf('<html><body>no cashback here</body></html>');
    expect(findCheckoutCashbackPct(doc)).toBeNull();
  });
  it('reads 6% back from a real /spc fixture', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    expect(findCheckoutCashbackPct(doc)).toBe(6);
  });
});

describe('buildTitlePrefix', () => {
  it('returns the first 40 chars of a normalized title', () => {
    const title =
      'Apple 2025 MacBook Pro Laptop with Apple M5 chip with 10-core CPU';
    expect(buildTitlePrefix(title)).toBe('Apple 2025 MacBook Pro Laptop with Apple');
    expect(buildTitlePrefix(title)?.length).toBe(40);
  });
  it('strips quotes and backslashes for safe embedding', () => {
    expect(buildTitlePrefix('Foo "bar" \\baz')).toBe('Foo bar baz');
  });
  it('returns null for null input', () => {
    expect(buildTitlePrefix(null)).toBeNull();
  });
});

/**
 * Fixture: live Chewbacca /spc page captured 2026-04-23 for ASIN
 * B0FWD726XF (Apple 2025 MacBook Pro Laptop).
 *
 * Layout:
 *   - Target's shipping group has 3 delivery radios:
 *       • Fastest (next-1dc)         — 0% back
 *       • Standard (second)          — 0% back, currently CHECKED
 *       • Amazon Day (second-nominated-day) — 6% back, NOT checked
 *   - A second (non-target) shipping group with the same 6%-back option.
 *   - The target's ASIN does NOT appear in any <a href="..."> — Chewbacca
 *     strips it, so the title-prefix fallback is the only locator.
 *
 * The cashback gate's contract on this fixture is: "target found, but the
 * currently-selected radio is not a 6% option → pct=null → block the
 * order." `pickBestCashbackDelivery` must click Amazon Day first; only
 * after that click should pct=6 be reported.
 */
describe('readTargetCashbackFromDom (MacBook /spc fixture)', () => {
  const ASIN = 'B0FWD726XF';
  const TITLE =
    'Apple 2025 MacBook Pro Laptop with Apple M5 chip with 10-core CPU and 10-core GPU';

  it('locates the MacBook row via title fallback (no ASIN in any href)', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    // Precondition: there genuinely is no /dp/<asin> anchor.
    expect(doc.querySelector(`a[href*="${ASIN}"]`)).toBeNull();

    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    expect(hit.found).toBe(true);
  });

  it('walks up to the correct shipping-group scope (Arriving + % back)', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');

    expect(hit.groupFound).toBe(true);
    // Scope must contain the target's own delivery options (3 radios in
    // this fixture). If the scope is too narrow we'd see 0 checked radios.
    expect(hit.checkedRadioCount).toBe(1);
    // Scope is scoped to the target's group — NOT the whole page. The
    // other shipping group's 6% option should NOT appear twice.
    expect(hit.scopeMatches.length).toBeGreaterThan(0);
    expect(hit.scopeMatches.some((m) => /6\s*%\s*back/i.test(m))).toBe(true);
  });

  it('detects that 6% is AVAILABLE in the target group (bodyMatches + scopeMatches)', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');

    expect(hit.bodyMatches.some((m) => /6\s*%\s*back/i.test(m))).toBe(true);
    expect(hit.scopeMatches.some((m) => /6\s*%\s*back/i.test(m))).toBe(true);
  });

  it('BLOCKS the order: currently-checked radio is Standard (no % back), pct=null', () => {
    // The whole point of the gate: even though the scope CONTAINS "6% back",
    // the actually-selected delivery option does NOT earn cashback. Placing
    // the order now would give 0%, not 6%. The caller treats pct=null as a
    // hard failure, which is the safety invariant the user asked for.
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');

    expect(hit.pct).toBeNull();
    expect(hit.selectedLabel).toMatch(/Standard/i);
    expect(hit.selectedLabel ?? '').not.toMatch(/%\s*back/i);
  });

  it('reports pct=6 once the Amazon Day (6% back) radio is the checked one', () => {
    // Simulate what pickBestCashbackDelivery does: flip the checked state
    // from Standard → Amazon Day in the target's shipping group. After the
    // click, the gate must pass with pct=6.
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const MACBOOK_GROUP =
      'miq://document:1.0/Ordering/amazon:1.0/Unit:1.0/106-4769208-4621834:29c5bcd2-051b-4068-93c5-805128ac6872';
    const groupRadios = Array.from(
      doc.querySelectorAll(
        `input[type="radio"][name="${MACBOOK_GROUP}"]`,
      ),
    ) as HTMLInputElement[];
    expect(groupRadios).toHaveLength(3);
    for (const r of groupRadios) {
      r.checked = false;
      r.removeAttribute('checked');
    }
    const amazonDay = groupRadios.find((r) => r.value === 'second-nominated-day');
    if (!amazonDay) throw new Error('Amazon Day radio not found in MacBook group');
    amazonDay.checked = true;
    amazonDay.setAttribute('checked', '');

    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');
    expect(hit.pct).toBe(6);
    expect(hit.selectedLabel).toMatch(/Amazon Day/i);
    expect(hit.selectedLabel).toMatch(/6\s*%\s*back/i);
  });

  it('returns found=false with diagnostics when the target is nowhere on the page', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, 'B0XXXXXXXX', 'Totally Fake Product Title Here XYZ');
    if (hit.found) throw new Error('target should not be found');
    expect(hit.diag.asinInBody).toBe(false);
    expect(hit.diag.titleInBody).toBe(false);
    expect(hit.diag.totalLinks).toBeGreaterThan(0);
  });
});

describe('computeCashbackRadioPlans (MacBook /spc fixture)', () => {
  const MACBOOK_GROUP =
    'miq://document:1.0/Ordering/amazon:1.0/Unit:1.0/106-4769208-4621834:29c5bcd2-051b-4068-93c5-805128ac6872';
  const OTHER_GROUP =
    'miq://document:1.0/Ordering/amazon:1.0/Unit:1.0/106-4769208-4621834:0ec222d7-598a-4208-8a90-3e6f31448a7a';

  it('plans a click on the 6% Amazon Day radio in the MacBook shipping group', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);

    const macbookPlan = plans.find((p) => p.name === MACBOOK_GROUP);
    expect(macbookPlan).toBeDefined();
    expect(macbookPlan!.pickedPct).toBe(6);
    expect(macbookPlan!.value).toBe('second-nominated-day');
    expect(macbookPlan!.currentPct).toBe(0);
    expect(macbookPlan!.currentValue).toBe('second');
    expect(macbookPlan!.label).toMatch(/Amazon Day/i);
    expect(macbookPlan!.label).toMatch(/6\s*%\s*back/i);
  });

  it('also plans a click in the other shipping group (both default to 0%)', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);

    const otherPlan = plans.find((p) => p.name === OTHER_GROUP);
    expect(otherPlan).toBeDefined();
    expect(otherPlan!.pickedPct).toBe(6);
    expect(otherPlan!.value).toBe('second-nominated-day');
  });

  it('returns exactly 2 plans (one per delivery-option group) on this fixture', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);
    expect(plans.length).toBe(2);
  });

  it('plans nothing when the 6%-back radio is ALREADY checked in each group', () => {
    // Flip BOTH groups so Amazon Day is already selected. Picker should
    // be a no-op in that state — mirrors the post-click steady state.
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    for (const groupName of [MACBOOK_GROUP, OTHER_GROUP]) {
      const group = Array.from(
        doc.querySelectorAll(`input[type="radio"][name="${groupName}"]`),
      ) as HTMLInputElement[];
      for (const r of group) {
        r.checked = false;
        r.removeAttribute('checked');
      }
      const six = group.find((r) => r.value === 'second-nominated-day');
      if (!six) throw new Error(`missing 6% radio in group ${groupName}`);
      six.checked = true;
      six.setAttribute('checked', '');
    }
    const plans = computeCashbackRadioPlans(doc, 6);
    expect(plans).toEqual([]);
  });

  it('plans nothing when minPct is higher than any available option', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 10);
    expect(plans).toEqual([]);
  });

  it('skips address/payment radio groups', () => {
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);
    // None of the plans should target payment/address radios — their
    // names match the exclusion regex.
    const addrOrPay = plans.filter((p) =>
      /destinationSubmissionUrl|paymentMethodForUrl|paymentMethod|ship-to-this|addressRadio/i.test(
        p.name,
      ),
    );
    expect(addrOrPay).toEqual([]);
  });
});

/**
 * Fixture: live /spc captured 2026-04-23 for ASIN B0F3GWXLTS (Single
 * mode buy). The bot had already clicked Place Order once with the 6%
 * Amazon Day radio selected. Instead of navigating to /thankyou, Amazon
 * re-rendered /spc with an error banner and WIPED the prior delivery
 * selection:
 *
 *   "Your delivery options have changed due to your updated purchase
 *    options. Please select a new delivery option to proceed."
 *
 * Adversarial properties pinned by this fixture:
 *   - `[data-messageid="selectDeliveryOptionMessage"]` is the stable
 *     marker — it only appears when the banner is actively shown.
 *   - The single delivery group has 2 radios (`next-1dc` + 6%-back
 *     `second-nominated-day`) and NEITHER is checked — Amazon reset the
 *     selection. Any parser that assumed "there's always a default
 *     checked radio" would mis-report currentPct here.
 *   - Recovery contract: computeCashbackRadioPlans(doc, 6) must still
 *     plan a click on `second-nominated-day`, so the runtime can re-pick
 *     + re-submit without any special-case code for the wiped state.
 */
describe('isDeliveryOptionsChangedBanner (delivery-options-changed fixture)', () => {
  it('detects the banner on the real fixture', () => {
    const doc = docOf(fixture('spc-delivery-options-changed-B0F3GWXLTS.html'));
    expect(isDeliveryOptionsChangedBanner(doc)).toBe(true);
  });

  it('returns false on the MacBook /spc fixture (no banner — negative control)', () => {
    // If the selector drifted to match any purchase-level message in the
    // SSR template, this happy-path /spc would false-positive and the
    // runtime would enter recovery on every order. Pin the negative.
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    expect(isDeliveryOptionsChangedBanner(doc)).toBe(false);
  });

  it('returns false on an unrelated page', () => {
    const doc = docOf('<html><body>Place your order</body></html>');
    expect(isDeliveryOptionsChangedBanner(doc)).toBe(false);
  });

  it('DELIVERY_OPTIONS_CHANGED_SELECTOR matches the real banner element', () => {
    // Runtime helper and parser share this constant — drifting one
    // without the other would silently disable recovery. Pin the pair.
    const doc = docOf(fixture('spc-delivery-options-changed-B0F3GWXLTS.html'));
    const el = doc.querySelector(DELIVERY_OPTIONS_CHANGED_SELECTOR);
    expect(el).not.toBeNull();
    expect((el?.textContent ?? '').replace(/\s+/g, ' ')).toMatch(
      /delivery options have changed/i,
    );
  });
});

/**
 * Fixture: live /spc capture where Amazon, instead of rendering the Place
 * Order button, parked us at the PMTS card-address-challenge ("Verify your
 * card") interstitial — a payment-side fraud check triggered by a recent
 * shipping-address change. The buy is unrecoverable from the worker's
 * side; the detector only exists to surface a clearer error than the
 * generic "Place Order button never appeared in 30s" 30s-timeout fallback.
 *
 * Markup signature (relevant fragment from the fixture):
 *
 *   <span class="pmts-cc-address-challenge pmts-cc-address-challenge-form">
 *     <div class="a-box a-alert a-alert-info ...">
 *       <h4 class="a-alert-heading">Verify your card</h4>
 *       ...
 *     </div>
 *     <input ... name="0h_PU_..._addCreditCardNumber" ...>
 *     <button aria-label="Verify card" ...>Verify card</button>
 *   </span>
 */
describe('isVerifyCardChallenge (verify-your-card fixture)', () => {
  it('detects the PMTS verify-card challenge on the real fixture', () => {
    const doc = docOf(fixture('spc-verify-your-card.html'));
    expect(isVerifyCardChallenge(doc)).toBe(true);
  });

  it('returns false on a happy-path /spc (no challenge — negative control)', () => {
    // If either the form-class selector or the heading regex drifted into
    // matching unrelated /spc markup, every healthy buy would falsely fail
    // with "Verify your card". Pin the negative against a real /spc fixture.
    const doc = docOf(fixture('spc-macbook-B0FWD726XF-6pct.html'));
    expect(isVerifyCardChallenge(doc)).toBe(false);
  });

  it('returns false on an unrelated page', () => {
    const doc = docOf('<html><body>Place your order</body></html>');
    expect(isVerifyCardChallenge(doc)).toBe(false);
  });

  it('requires BOTH the challenge form wrapper AND the heading', () => {
    // The wrapper class alone (without the active "Verify your card"
    // heading) should NOT trip the detector — Amazon ships PMTS scaffold
    // markup in non-challenge states too.
    const wrapperOnly = docOf(
      '<html><body><span class="pmts-cc-address-challenge-form"></span></body></html>',
    );
    expect(isVerifyCardChallenge(wrapperOnly)).toBe(false);

    // Conversely, the heading text alone (without the PMTS wrapper) is
    // ambiguous — could appear in promo copy or unrelated alert content.
    const headingOnly = docOf(
      '<html><body><h4 class="a-alert-heading">Verify your card</h4></body></html>',
    );
    expect(isVerifyCardChallenge(headingOnly)).toBe(false);
  });
});

/**
 * Fixture: live /spc captured 2026-04-23 for a FILLERS cart. Target is the
 * MacBook (B0FWD726XF) sharing one shipping group with 9 filler items —
 * all 10 delivered together. The 6% Amazon Day radio is ALREADY the
 * checked one, so the only thing the gate has to do is read pct=6 and
 * let Place Order proceed.
 *
 * Adversarial properties pinned by this fixture (regressions would turn
 * "see 6%, place order" into "see 6%, spuriously trip BG1/BG2 toggle,
 * fail to place"):
 *
 *   1) MacBook's title expander contains a promotional "Get 6% back with
 *      your Prime Visa" line — RIGHT NEXT TO the target's title node.
 *      That subtree has NO delivery radios; the shared delivery group is
 *      further up the tree at `#row-item-block-panel`. A scope-walk that
 *      stops on any ancestor mentioning "Arriving + % back" will anchor
 *      onto that description subtree, see zero checked radios, and
 *      return pct=null → the bot then runs a pointless BG1/BG2 toggle.
 *
 *   2) The shared shipping-group container's visible text runs > 30k
 *      chars (10 line items + metadata). A stingy MAX_SCOPE_CHARS cap
 *      would break out of the walk before reaching it and fall back to
 *      the tiny title span — same null-pct outcome.
 *
 * If this test ever starts failing with pct=null + scopeChars≈3000, the
 * scope-walk's radio-required + widened-cap invariants have regressed.
 */
describe('readTargetCashbackFromDom (fillers-cart /spc fixture, 6% already checked)', () => {
  const ASIN = 'B0FWD726XF';
  const TITLE =
    'Apple 2025 MacBook Pro Laptop with Apple M5 chip with 10-core CPU and 10-core GPU';

  it('returns pct=6 — the currently-checked Amazon Day radio is read correctly', () => {
    // Top-level contract: if this passes the gate lets Place Order run.
    const doc = docOf(fixture('spc-fillers-macbook-B0FWD726XF-checked-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');
    expect(hit.pct).toBe(6);
    expect(hit.selectedLabel).toMatch(/6\s*%\s*back/i);
    expect(hit.selectedLabel).toMatch(/Amazon Day/i);
  });

  it('walk reaches the shared shipping-group container (has delivery radios)', () => {
    const doc = docOf(fixture('spc-fillers-macbook-B0FWD726XF-checked-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, ASIN, TITLE);
    if (!hit.found) throw new Error('target must be found');
    expect(hit.groupFound).toBe(true);
    // The cart has exactly 2 delivery radios (Fastest + Amazon Day), one
    // checked. If the scope anchored onto the description-only subtree
    // instead, this would be 0.
    expect(hit.checkedRadioCount).toBe(1);
    // Scope is the shipping group, not the whole page. Other random
    // "% back" text on the page (upsell banner, 5% base rewards line)
    // shouldn't pollute scopeMatches with extra hits.
    expect(hit.scopeMatches.length).toBeGreaterThan(0);
    expect(hit.scopeMatches.some((m) => /6\s*%\s*back/i.test(m))).toBe(true);
  });

  it('computeCashbackRadioPlans is a no-op — 6% radio is already selected', () => {
    // With the recovery/picker logic downstream: if this returns a plan,
    // the bot would try to re-click the same radio it's already on,
    // churning for no reason.
    const doc = docOf(fixture('spc-fillers-macbook-B0FWD726XF-checked-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);
    expect(plans).toEqual([]);
  });
});

/**
 * Fixture: live /spc captured 2026-04-23 for a SPLIT-shipping fillers cart.
 * Target is B0F3GWXLTS ("Nintendo Switch 2 System") bundled with 9 fillers.
 * Amazon split the cart into TWO shipping groups because one filler
 * (BalanceFrom Gymnastics Mat B0722VRW3V) ships via a different carrier:
 *
 *   Group A — BalanceFrom mat alone: 1 radio ("Second US D2D Dom",
 *     already checked). NO Amazon Day option → 0% cashback for this item.
 *   Group B — target + 8 other fillers: 3 radios (next-1dc, second,
 *     second-nominated-day). The 6%-back Amazon Day radio is already
 *     the checked one.
 *
 * Adversarial properties pinned by this fixture:
 *
 *   1) Target lives in Group B (shared with 8 fillers). The scope-walk
 *      from the target's title must anchor onto Group B's shipping
 *      container (~30k chars of visible text, contains 3 radios), NOT
 *      creep up further to the page-wide scope that also includes Group
 *      A. Doing so would double-count checked radios (2 instead of 1)
 *      and could mis-report the selected label.
 *
 *   2) Filler B0722VRW3V is in a DIFFERENT shipping group that has no
 *      cashback option. The parser can still report pct=6 when asked
 *      about this ASIN because the scope walk widens to include Group
 *      B — this is by design for the page-level read (the order DOES
 *      earn 6% on that shipping group), but fixture test 3 pins that
 *      the filler's own group has only one radio option and no
 *      cashback available in isolation.
 *
 *   3) Place Order button exists and is NOT disabled — the gate
 *      shouldn't be triggering a BG1/BG2 toggle on this page. If the
 *      target read returns pct=null here, the bot would run a pointless
 *      retry even though 6% is ALREADY selected and Place Order is
 *      ready to click.
 */
describe('readTargetCashbackFromDom (split-shipping fillers cart, 6% checked)', () => {
  const TARGET_ASIN = 'B0F3GWXLTS';
  const TARGET_TITLE = 'Nintendo Switch 2 System';
  const FILLER_SOLO_ASIN = 'B0722VRW3V';
  const FILLER_SOLO_TITLE = 'BalanceFrom 10x4 Feet 4-Panel Folding Gymnastics Mat';

  it('returns pct=6 for the target (Switch 2 in Group B with Amazon Day checked)', () => {
    // Core contract. If this returns null/undefined, the bot would
    // spuriously trip the BG1/BG2 toggle even though 6% is already met.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    const hit = readTargetCashbackFromDom(doc, TARGET_ASIN, TARGET_TITLE);
    if (!hit.found) throw new Error('target must be found');
    expect(hit.pct).toBe(6);
    expect(hit.selectedLabel).toMatch(/6\s*%\s*back/i);
    expect(hit.selectedLabel).toMatch(/Amazon Day/i);
    expect(hit.groupFound).toBe(true);
    // Scope should be Group B only — one checked radio (the 6% one).
    // If the walk overshoots to a page-wide scope, this would be 2
    // (also picking up Group A's "Second US D2D Dom" checked radio).
    expect(hit.checkedRadioCount).toBe(1);
  });

  it('computeCashbackRadioPlans is a no-op — 6% is already the checked option in Group B', () => {
    // Guards against a regression where the picker re-clicks an already
    // selected radio and stalls the checkout in a re-render loop.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    const plans = computeCashbackRadioPlans(doc, 6);
    expect(plans).toEqual([]);
  });

  it('the sole-group filler (BalanceFrom Mat) has only a non-cashback "Second US D2D Dom" option', () => {
    // Document Amazon's split: one filler ships on a service that
    // doesn't participate in the 6%-back offer. This fixture captures
    // the full adversarial layout — useful context when the scope-walk
    // behavior is reviewed later.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    const SOLO_GROUP =
      'miq://document:1.0/Ordering/amazon:1.0/Unit:1.0/106-0716602-1613867:35aece34-45a4-4e0a-9887-c5354d0fd1b5';
    const soloRadios = Array.from(
      doc.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${SOLO_GROUP}"]`,
      ),
    );
    expect(soloRadios).toHaveLength(1);
    expect(soloRadios[0]!.value).toBe('Second US D2D Dom');
    expect(soloRadios[0]!.checked).toBe(true);
    // Sanity: even though the filler's group has no cashback option
    // locally, the parser still lets this ASIN read through to a scope
    // that includes Group B — that's by design (the scope walk widens
    // until it finds radios + "% back"). The test guards the split
    // layout itself, not the filler's cashback read.
    expect(readTargetCashbackFromDom(doc, FILLER_SOLO_ASIN, FILLER_SOLO_TITLE).found).toBe(true);
  });

  it('anchors on the hidden testid span when the PDP title is LONGER than the /spc line-item', () => {
    // This is the failure mode that caused the bot to wrongly trip
    // BG1/BG2 on this fixture. PDP `#productTitle` often has a longer
    // canonical form than the /spc line-item text — e.g. PDP:
    //   "Nintendo Switch 2 System Bundle with Mario Kart World and Carrying Case"
    // /spc line-item:
    //   "Nintendo Switch 2 System"
    //
    // Under the old `text.startsWith(needle)` match, `needle` (40-char
    // PDP prefix) was longer than `text` (24-char /spc line-item), so
    // startsWith always returned false and the anchor was never found.
    // With the testid fallback AND the shorter-shared-prefix match,
    // the parser now locates the target regardless.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    const LONG_PDP_TITLE =
      'Nintendo Switch 2 System Bundle with Mario Kart World and Carrying Case';
    const hit = readTargetCashbackFromDom(doc, TARGET_ASIN, LONG_PDP_TITLE);
    if (!hit.found) throw new Error('target must be found with a longer PDP title');
    expect(hit.pct).toBe(6);
  });

  it('anchors via testid even when title is null (Chewbacca strips hrefs too)', () => {
    // Worst-case row: `info.title` came back null from the PDP scrape
    // AND there are no /dp/<asin> hrefs (Chewbacca). Historical
    // behavior was `found: false → gate fails → BG1/BG2 toggle`. The
    // testid pin now saves this case.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    // Sanity: confirm no /dp/<asin> anchor exists (pin the Chewbacca
    // property that motivates the testid fallback).
    expect(doc.querySelector(`a[href*="${TARGET_ASIN}"]`)).toBeNull();

    const hit = readTargetCashbackFromDom(doc, TARGET_ASIN, null);
    if (!hit.found) throw new Error('target must be found via testid even when title is null');
    expect(hit.pct).toBe(6);
  });

  it('Place Order button is visible and enabled (not the disabled blocker variant)', () => {
    // If the bot ever skipped Place Order here, it wasn't because the
    // button wasn't clickable. Pin that the live button is present so
    // a regression that accidentally routed to the blocker variant
    // (aok-hidden + disabled) fails a parser-level test instead of a
    // silent "why didn't it click" production bug.
    const doc = docOf(fixture('spc-fillers-split-switch2-B0F3GWXLTS-6pct.html'));
    const live = doc.querySelector<HTMLElement>(
      '#submitOrderButtonId:not(.aok-hidden) input[name="placeYourOrder1"]:not([disabled])',
    );
    expect(live).not.toBeNull();
  });
});

describe('computeCashbackRadioPlans (delivery-options-changed fixture)', () => {
  const WIPED_GROUP =
    'miq://document:1.0/Ordering/amazon:1.0/Unit:1.0/106-5019644-4701066:0793db16-b02f-406a-ae84-eaf8fe2bda77';

  it('none of the group radios are pre-checked — Amazon wiped the prior selection', () => {
    // This is the precondition that makes recovery necessary. If this
    // ever regresses to "1 checked", a future caller might assume the
    // wiped state is the normal post-click state and skip re-picking.
    const doc = docOf(fixture('spc-delivery-options-changed-B0F3GWXLTS.html'));
    const groupRadios = Array.from(
      doc.querySelectorAll(
        `input[type="radio"][name="${WIPED_GROUP}"]`,
      ),
    ) as HTMLInputElement[];
    expect(groupRadios.length).toBeGreaterThanOrEqual(2);
    const checked = groupRadios.filter((r) => r.checked);
    expect(checked).toHaveLength(0);
  });

  it('plans a click on the 6% Amazon Day radio in the wiped group', () => {
    // The recovery action the runtime will execute. Same plan shape as
    // the happy-path MacBook fixture — the wiped state doesn't require
    // any special-case parser code.
    const doc = docOf(fixture('spc-delivery-options-changed-B0F3GWXLTS.html'));
    const plans = computeCashbackRadioPlans(doc, 6);
    const plan = plans.find((p) => p.name === WIPED_GROUP);
    expect(plan).toBeDefined();
    expect(plan!.pickedPct).toBe(6);
    expect(plan!.value).toBe('second-nominated-day');
    // currentPct=0 because nothing is checked; currentValue=null per the
    // CashbackRadioPlan contract when the group has no selection.
    expect(plan!.currentPct).toBe(0);
    expect(plan!.currentValue).toBeNull();
    expect(plan!.label).toMatch(/6\s*%\s*back/i);
  });

  it('plans nothing once the 6% radio has been re-selected (post-recovery state)', () => {
    // Simulate what the runtime recovery does after pickBestCashbackDelivery
    // clicks the radio: the banner's still DOM-present until the next
    // render, but the radio is now checked. The cashback picker must be
    // a no-op in that state so the second Place Order click isn't
    // preceded by a pointless re-click of the same radio.
    const doc = docOf(fixture('spc-delivery-options-changed-B0F3GWXLTS.html'));
    const amazonDay = doc.querySelector<HTMLInputElement>(
      `input[type="radio"][name="${WIPED_GROUP}"][value="second-nominated-day"]`,
    );
    if (!amazonDay) throw new Error('Amazon Day radio not found in fixture');
    amazonDay.checked = true;
    amazonDay.setAttribute('checked', '');

    const plans = computeCashbackRadioPlans(doc, 6);
    expect(plans.find((p) => p.name === WIPED_GROUP)).toBeUndefined();
  });
});

describe('findCancelItemsLinkOnOrderDetails', () => {
  it('finds the Cancel items link on a real order-details fixture', () => {
    // Real order-details page captured for filler order 114-2706026-4049019
    // — the case where the direct cancel-items URL silently failed but
    // the order-details page still exposes a "Cancel items" link.
    const doc = docOf(fixture('order-details-cancellable-filler.html'));
    const r = findCancelItemsLinkOnOrderDetails(doc);
    expect(r.cancelHref).not.toBeNull();
    expect(r.cancelHref).toMatch(
      /\/progress-tracker\/package\/preship\/cancel-items\?orderID=114-2706026-4049019/,
    );
    // Real fixture has empty `<div data-component="cancelled">` template
    // scaffolding but no actual cancellation copy — must not be flagged.
    expect(r.alreadyCancelled).toBe(false);
  });

  it('returns null when no cancel link is present (already shipped)', () => {
    const doc = docOf(`
      <html><body>
        <a href="/gp/your-account/ship-track?orderId=123">Track package</a>
        <a href="/review/review-your-purchases?asins=ABC">Write a product review</a>
      </body></html>
    `);
    const r = findCancelItemsLinkOnOrderDetails(doc);
    expect(r.cancelHref).toBeNull();
    expect(r.alreadyCancelled).toBe(false);
  });

  it('detects already-cancelled banner', () => {
    const doc = docOf(`
      <html><body>
        <div data-component="cancelled">This order has been cancelled.</div>
      </body></html>
    `);
    const r = findCancelItemsLinkOnOrderDetails(doc);
    expect(r.alreadyCancelled).toBe(true);
    expect(r.cancelHref).toBeNull();
  });

  it('falls back to text match when href is unrecognized', () => {
    const doc = docOf(`
      <html><body>
        <a href="/some/other/path?orderID=999">Cancel items</a>
      </body></html>
    `);
    const r = findCancelItemsLinkOnOrderDetails(doc);
    expect(r.cancelHref).toBe('/some/other/path?orderID=999');
  });
});
