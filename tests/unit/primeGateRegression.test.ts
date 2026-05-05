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
describe('Prime gate regression — INC-2026-05-05 (non-Prime iPad placed an order)', () => {
  it('static parser correctly returns isPrime=false on the saved fixture', () => {
    const html = readFileSync(FIX, 'utf8');
    const doc = new JSDOM(html).window.document;
    expect(findIsPrime(doc)).toBe(false);
  });

  it('static parser sees the buy buttons (so this is a real PDP, not an error page)', () => {
    const html = readFileSync(FIX, 'utf8');
    const doc = new JSDOM(html).window.document;
    expect(findHasBuyNow(doc)).toBe(true);
    expect(findHasAddToCart(doc)).toBe(true);
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
