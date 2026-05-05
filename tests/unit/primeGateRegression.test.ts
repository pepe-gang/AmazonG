import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findIsPrime, findHasBuyNow, findHasAddToCart } from '../../src/parsers/amazonProduct';
import { parseProductHtml } from '../../src/actions/scrapeProduct';
import { DEFAULT_CONSTRAINTS, verifyProductDetailed } from '../../src/parsers/productConstraints';

const FIX = join(
  __dirname,
  '../../fixtures/product-no-prime/inc-2026-05-05-ipad-no-prime.html',
);
const URL = 'https://www.amazon.com/dp/B0DZ77XYZA'; // synthetic — not used by parser

/**
 * INC-2026-05-05 (Prime gate) — user reported a non-Prime iPad order
 * placed despite the requirePrime gate. The saved /dp/ HTML for the
 * iPad has THREE #prime-badge nodes in markup but every one of them is
 * inside an inactive accordion subtree (parent celwidget carries
 * `data-csa-c-is-in-initial-active-row="false"`), so the static parser
 * correctly returns isPrime=false.
 *
 * The bug was that scrapeProduct's runtime visibility override
 * unconditionally upgraded the static parser's `false` to `true` when
 * the runtime check (bounding rect + computed style) saw a non-zero
 * rect on one of the inactive-row badges (Amazon's CSS doesn't always
 * collapse them). The runtime check doesn't know about the
 * inactive-accordion-row marker.
 *
 * Fix: scrapeProduct's reconcile() now treats `false` as authoritative
 * — runtime can confirm or upgrade `null`, but never upgrade `false`
 * to `true`. Plus productConstraints now treats `isPrime === null` as
 * a fail under requirePrime (was: pass as "indeterminate").
 */
/**
 * Companion fixture (REGR-2026-05-05): an actually-Prime iPad PDP that
 * an over-eager isHidden walk falsely treated as not-Prime. Both
 * fixtures share the same surface symptom (#prime-badge or
 * .a-icon-prime-with-text candidates with inactive-row markers on
 * ancestors), but distinguishable by WHICH ancestor slots carry the
 * marker:
 *
 *   - NO-PRIME (INC fixture): inactive marker sits on
 *     `usedAccordionRow` slots → genuine "alternate offer hidden by
 *     accordion" subtree.
 *   - IS-PRIME (REGR fixture): inactive marker sits on
 *     `desktop_qualifiedBuyBox` /
 *     `shippingMessageInsideBuyBox_feature_div` slots → those carry
 *     the marker as a template default but the contents ARE rendered.
 *
 * The fix narrows the isHidden walk to only treat the marker as
 * authoritative on slots whose names match accordion-row patterns
 * (e.g. *AccordionRow). Both fixtures must come out the right way.
 */
const REGR_IS_PRIME_FIX = join(
  __dirname,
  '../../fixtures/product-no-prime/REGR-2026-05-05-ipad-IS-prime.html',
);

describe('Prime gate regression — INC-2026-05-05 (non-Prime iPad placed an order)', () => {
  it('IS-PRIME companion fixture: parser returns isPrime=TRUE (visible badge in qualifiedBuyBox)', () => {
    const html = readFileSync(REGR_IS_PRIME_FIX, 'utf8');
    const doc = new JSDOM(html).window.document;
    expect(findIsPrime(doc)).toBe(true);
  });

  it('IS-PRIME companion fixture: verifyProductDetailed PASSES under default constraints', () => {
    const html = readFileSync(REGR_IS_PRIME_FIX, 'utf8');
    const info = parseProductHtml(html, URL);
    const constraints = { ...DEFAULT_CONSTRAINTS, maxPrice: 10_000 };
    const report = verifyProductDetailed(info, constraints);
    expect(report.ok, 'a real Prime listing must pass the gate').toBe(true);
  });

  it('static parser correctly returns isPrime=false on the saved fixture', () => {
    const html = readFileSync(FIX, 'utf8');
    const doc = new JSDOM(html).window.document;
    expect(findIsPrime(doc)).toBe(false);
  });

  it('static parser confirms this is a real PDP via #productTitle (the buy buttons happen to live in usedAccordionRow → visible:false is expected)', () => {
    const html = readFileSync(FIX, 'utf8');
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('#productTitle')).not.toBeNull();
    // The Buy Now / Add to Cart buttons in this fixture are inside the
    // alternate-offer `usedAccordionRow` subtree (not the active row),
    // so the static parser correctly treats them as hidden. The Prime
    // gate fires before the buy-button gate in verifyProductDetailed,
    // so this fixture still rejects with reason=not_prime.
  });

  it('parseProductHtml → ProductInfo carries isPrime=false', () => {
    const html = readFileSync(FIX, 'utf8');
    const info = parseProductHtml(html, URL);
    expect(info.isPrime).toBe(false);
  });

  it('verifyProductDetailed REJECTS with reason=not_prime under default constraints', () => {
    const html = readFileSync(FIX, 'utf8');
    const info = parseProductHtml(html, URL);
    // Use a generous price cap so the only failure surface is Prime.
    const constraints = { ...DEFAULT_CONSTRAINTS, maxPrice: 10_000 };
    const report = verifyProductDetailed(info, constraints);
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe('not_prime');
    }
  });

  it('STRICT: indeterminate isPrime (null) ALSO fails under requirePrime', () => {
    // Synthetic info — simulates an unusual scrape state where neither
    // static nor runtime could determine Prime status. Before the fix
    // this passed as "indeterminate (assumed ok)". After: hard fail.
    const info = {
      asin: 'B0XXXXXXXX',
      title: 'Test',
      url: URL,
      price: 100,
      condition: 'new' as const,
      inStock: true,
      shipsToAddress: true,
      isPrime: null,
      hasBuyNow: true,
      hasAddToCart: true,
      isSignedIn: true,
      cashbackPct: null,
      buyBlocker: null,
    };
    const report = verifyProductDetailed(info, { ...DEFAULT_CONSTRAINTS, maxPrice: 10_000 });
    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.reason).toBe('not_prime');
    }
  });

  it('STRICT: only isPrime=true passes the Prime gate', () => {
    const baseInfo = {
      asin: 'B0XXXXXXXX',
      title: 'Test',
      url: URL,
      price: 100,
      condition: 'new' as const,
      inStock: true,
      shipsToAddress: true,
      hasBuyNow: true,
      hasAddToCart: true,
      isSignedIn: true,
      cashbackPct: null,
      buyBlocker: null,
    };
    const c = { ...DEFAULT_CONSTRAINTS, maxPrice: 10_000 };
    expect(verifyProductDetailed({ ...baseInfo, isPrime: true }, c).ok).toBe(true);
    expect(verifyProductDetailed({ ...baseInfo, isPrime: false }, c).ok).toBe(false);
    expect(verifyProductDetailed({ ...baseInfo, isPrime: null }, c).ok).toBe(false);
  });
});
