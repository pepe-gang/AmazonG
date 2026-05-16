import { describe, expect, it } from 'vitest';
import { htmlToDocument } from '../../src/shared/jsdom.js';
import {
  asinsCommittedInResponse,
  extractSearchResultCandidates,
  looksLikeCartResponse,
} from '../../src/actions/amazonHttp';

/**
 * Tests for the pure helpers in `amazonHttp.ts` that previously had no
 * coverage. Pinning behavior so we can refactor / extend the file
 * without regressing the contract.
 */

function docOf(html: string): Document {
  return htmlToDocument(html);
}

describe('looksLikeCartResponse', () => {
  it('matches when "Subtotal" appears (typical cart-page header)', () => {
    expect(looksLikeCartResponse('<div>Subtotal: $5</div>')).toBe(true);
    // Whitespace tolerance per regex (`sub\s*total`).
    expect(looksLikeCartResponse('Sub total')).toBe(true);
    expect(looksLikeCartResponse('SUBTOTAL')).toBe(true); // case-insensitive
  });

  it('matches JSON itemCount payload', () => {
    expect(looksLikeCartResponse('{"itemCount": 3}')).toBe(true);
  });

  it('matches "Added to (your) cart" smart-wagon copy', () => {
    expect(looksLikeCartResponse('<span>Added to your cart</span>')).toBe(true);
    expect(looksLikeCartResponse('Added to cart')).toBe(true);
  });

  it('matches "Your Shopping Cart" / "Your Cart" header', () => {
    expect(looksLikeCartResponse('<h1>Your Shopping Cart</h1>')).toBe(true);
    expect(looksLikeCartResponse('Your Cart')).toBe(true);
  });

  it('matches "smart-wagon" (drawer-style mini cart)', () => {
    expect(looksLikeCartResponse('<div class="smart-wagon">')).toBe(true);
    expect(looksLikeCartResponse('smartwagon')).toBe(true);
  });

  it('returns false on empty / unrelated HTML', () => {
    expect(looksLikeCartResponse('')).toBe(false);
    expect(looksLikeCartResponse('<html><body>Hello world</body></html>')).toBe(false);
    expect(looksLikeCartResponse('Sorry, something went wrong')).toBe(false);
  });

  it('returns false on captcha / robot-check pages', () => {
    expect(looksLikeCartResponse('Type the characters you see')).toBe(false);
    expect(looksLikeCartResponse('errors.amazon.com')).toBe(false);
  });
});

describe('asinsCommittedInResponse', () => {
  const html = `
    <div class="cart">
      <div data-asin="B0DZ77D5HL">iPad row</div>
      <div data-asin='B0GR1J6T45'>MacBook row</div>
      <div data-asin="B0BFC7WQ6R">Echo row</div>
    </div>
  `;

  it('returns the subset of requested ASINs that appear in response', () => {
    const r = asinsCommittedInResponse(html, [
      'B0DZ77D5HL',
      'B0GR1J6T45',
      'B0NOTPRESENT',
    ]);
    expect(r.sort()).toEqual(['B0DZ77D5HL', 'B0GR1J6T45']);
  });

  it('matches both single- and double-quoted attribute syntax', () => {
    expect(asinsCommittedInResponse(html, ['B0GR1J6T45'])).toEqual(['B0GR1J6T45']);
    expect(asinsCommittedInResponse(html, ['B0DZ77D5HL'])).toEqual(['B0DZ77D5HL']);
  });

  it('returns empty array when no requested ASIN appears', () => {
    expect(asinsCommittedInResponse(html, ['B0NOPE12345'])).toEqual([]);
  });

  it('returns empty array when requested list is empty', () => {
    expect(asinsCommittedInResponse(html, [])).toEqual([]);
  });

  it('preserves the order of requestedAsins (not the response order)', () => {
    const r = asinsCommittedInResponse(html, [
      'B0BFC7WQ6R',
      'B0DZ77D5HL',
      'B0GR1J6T45',
    ]);
    expect(r).toEqual(['B0BFC7WQ6R', 'B0DZ77D5HL', 'B0GR1J6T45']);
  });

  it('does not false-match on substrings (B0XX shouldn\'t match B0XXY)', () => {
    const subHtml = '<div data-asin="B0DZ77D5HL2">extended</div>';
    expect(asinsCommittedInResponse(subHtml, ['B0DZ77D5HL'])).toEqual([]);
  });

  it('escapes regex-special characters in ASIN (defensive)', () => {
    // Real ASINs are [A-Z0-9]{10} with no special chars, but the helper
    // should still escape defensively in case of a bad input.
    const weirdHtml = '<div data-asin="B0.DZ.X">x</div>';
    expect(asinsCommittedInResponse(weirdHtml, ['B0.DZ.X'])).toEqual(['B0.DZ.X']);
    // The literal-dot input shouldn't false-match B0XDZAX (where . matched as wildcard).
    expect(asinsCommittedInResponse('<div data-asin="B0XDZAX">y</div>', ['B0.DZ.X'])).toEqual([]);
  });
});

describe('extractSearchResultCandidates', () => {
  function searchCardHtml({
    asin,
    csrf = 'csrf-1',
    offerListingId = 'olid-' + asin,
    priceWhole = '12',
    priceFraction = '99',
    isPrime = true,
    merchantId = 'ATVPDKIKX0DER',
    omit,
  }: {
    asin: string;
    csrf?: string;
    offerListingId?: string;
    priceWhole?: string;
    priceFraction?: string;
    isPrime?: boolean;
    merchantId?: string | null;
    omit?: 'asin' | 'offerListingId' | 'csrf';
  }): string {
    const inputs: string[] = [];
    if (omit !== 'csrf') inputs.push(`<input name="anti-csrftoken-a2z" value="${csrf}">`);
    if (omit !== 'asin') inputs.push(`<input name="items[0.base][asin]" value="${asin}">`);
    if (omit !== 'offerListingId') inputs.push(`<input name="items[0.base][offerListingId]" value="${offerListingId}">`);
    if (merchantId !== null) inputs.push(`<input name="merchantId" value="${merchantId}">`);
    return `
      <div data-asin="${asin}" data-component-type="s-search-result">
        ${isPrime ? '<i class="a-icon-prime" aria-label="Prime"></i>' : ''}
        <span class="a-price-whole">${priceWhole}</span>
        <span class="a-price-fraction">${priceFraction}</span>
        <form>${inputs.join('')}</form>
      </div>
    `;
  }

  it('extracts a single buyable candidate', () => {
    const doc = docOf(`<html><body>${searchCardHtml({ asin: 'B0DZ77D5HL' })}</body></html>`);
    const r = extractSearchResultCandidates(doc);
    expect(r).toHaveLength(1);
    const c = r[0]!;
    expect(c.asin).toBe('B0DZ77D5HL');
    expect(c.csrf).toBe('csrf-1');
    expect(c.offerListingId).toBe('olid-B0DZ77D5HL');
    expect(c.price).toBeCloseTo(12.99, 2);
    expect(c.isPrime).toBe(true);
    expect(c.merchantId).toBe('ATVPDKIKX0DER');
  });

  it('extracts multiple candidates and preserves DOM order', () => {
    const html = ['B0AAA00001', 'B0BBB00002', 'B0CCC00003']
      .map((asin) => searchCardHtml({ asin }))
      .join('');
    const doc = docOf(`<html><body>${html}</body></html>`);
    const r = extractSearchResultCandidates(doc);
    expect(r.map((c) => c.asin)).toEqual(['B0AAA00001', 'B0BBB00002', 'B0CCC00003']);
  });

  it('skips cards missing required token (asin / offerListingId / csrf)', () => {
    const html =
      searchCardHtml({ asin: 'B0OK1', omit: 'csrf' }) +
      searchCardHtml({ asin: 'B0OK2', omit: 'offerListingId' }) +
      searchCardHtml({ asin: 'B0OK3', omit: 'asin' }) +
      searchCardHtml({ asin: 'B0OK4' });
    const doc = docOf(`<html><body>${html}</body></html>`);
    const r = extractSearchResultCandidates(doc);
    // Only the fully-tokened card should land.
    expect(r.map((c) => c.asin)).toEqual(['B0OK4']);
  });

  it('handles missing price gracefully (price stays null)', () => {
    // Card without .a-price-whole.
    const doc = docOf(`
      <html><body>
        <div data-asin="B0NOPRC" data-component-type="s-search-result">
          <form>
            <input name="anti-csrftoken-a2z" value="csrf">
            <input name="items[0.base][asin]" value="B0NOPRC">
            <input name="items[0.base][offerListingId]" value="olid">
          </form>
        </div>
      </body></html>
    `);
    const r = extractSearchResultCandidates(doc);
    expect(r).toHaveLength(1);
    expect(r[0]!.price).toBeNull();
  });

  it('handles missing fraction (price = whole only)', () => {
    const doc = docOf(`
      <html><body>
        <div data-asin="B0NOFRAC" data-component-type="s-search-result">
          <span class="a-price-whole">42</span>
          <form>
            <input name="anti-csrftoken-a2z" value="csrf">
            <input name="items[0.base][asin]" value="B0NOFRAC">
            <input name="items[0.base][offerListingId]" value="olid">
          </form>
        </div>
      </body></html>
    `);
    const r = extractSearchResultCandidates(doc);
    expect(r[0]!.price).toBeCloseTo(42, 2);
  });

  it('returns null merchantId when merchantId input is absent', () => {
    const doc = docOf(`<html><body>${searchCardHtml({ asin: 'B0NOMERCH', merchantId: null })}</body></html>`);
    const r = extractSearchResultCandidates(doc);
    expect(r).toHaveLength(1);
    expect(r[0]!.merchantId).toBeNull();
  });

  it('detects prime via .s-prime, [aria-label*="Prime"], or innerHTML "a-icon-prime"', () => {
    const variants = [
      `<div data-asin="B0PRIME01" data-component-type="s-search-result"><i class="s-prime"></i><form><input name="anti-csrftoken-a2z" value="c"><input name="items[0.base][asin]" value="B0PRIME01"><input name="items[0.base][offerListingId]" value="o"></form></div>`,
      `<div data-asin="B0PRIME02" data-component-type="s-search-result"><i aria-label="Prime"></i><form><input name="anti-csrftoken-a2z" value="c"><input name="items[0.base][asin]" value="B0PRIME02"><input name="items[0.base][offerListingId]" value="o"></form></div>`,
      `<div data-asin="B0PRIME03" data-component-type="s-search-result"><i class="a-icon-prime"></i><form><input name="anti-csrftoken-a2z" value="c"><input name="items[0.base][asin]" value="B0PRIME03"><input name="items[0.base][offerListingId]" value="o"></form></div>`,
    ].join('');
    const doc = docOf(`<html><body>${variants}</body></html>`);
    const r = extractSearchResultCandidates(doc);
    expect(r).toHaveLength(3);
    for (const c of r) expect(c.isPrime).toBe(true);
  });

  it('returns empty array when document has no search-result cards', () => {
    const doc = docOf('<html><body><h1>nothing here</h1></body></html>');
    expect(extractSearchResultCandidates(doc)).toEqual([]);
  });

  it('skips cards without data-component-type="s-search-result"', () => {
    // Other [data-asin] elements exist on Amazon (cart, recommendations,
    // etc.). They must NOT be treated as search candidates.
    const doc = docOf(`
      <html><body>
        <div data-asin="B0RECOM01">recommendation, no s-search-result</div>
        ${searchCardHtml({ asin: 'B0SEARC01' })}
      </body></html>
    `);
    const r = extractSearchResultCandidates(doc);
    expect(r.map((c) => c.asin)).toEqual(['B0SEARC01']);
  });
});
