import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractCartAddTokens } from '../../src/actions/amazonHttp';

const FIXTURES_DIR = join(__dirname, '../../fixtures/product');

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

describe('extractCartAddTokens', () => {
  it('returns null when no addToCart form is present', () => {
    const doc = docOf('<html><body></body></html>');
    expect(extractCartAddTokens(doc)).toBeNull();
  });

  it('returns null when csrf is missing', () => {
    const doc = docOf(`
      <html><body><form id="addToCart">
        <input name="items[0.base][asin]" value="B000000000" />
        <input name="items[0.base][offerListingId]" value="OFFER123" />
      </form></body></html>`);
    expect(extractCartAddTokens(doc)).toBeNull();
  });

  it('returns null when offerListingId is missing', () => {
    const doc = docOf(`
      <html><body><form id="addToCart">
        <input name="anti-csrftoken-a2z" value="csrftok" />
        <input name="items[0.base][asin]" value="B000000000" />
      </form></body></html>`);
    expect(extractCartAddTokens(doc)).toBeNull();
  });

  it('extracts all three fields from canonical input names', () => {
    const doc = docOf(`
      <html><body><form id="addToCart">
        <input name="anti-csrftoken-a2z" value="csrftok" />
        <input name="items[0.base][asin]" value="B000000000" />
        <input name="items[0.base][offerListingId]" value="OFFER123" />
      </form></body></html>`);
    const tokens = extractCartAddTokens(doc);
    expect(tokens).not.toBeNull();
    expect(tokens?.csrf).toBe('csrftok');
    expect(tokens?.asin).toBe('B000000000');
    expect(tokens?.offerListingId).toBe('OFFER123');
  });

  it('falls back to legacy ASIN / offerListingID input names', () => {
    const doc = docOf(`
      <html><body><form id="addToCart">
        <input name="anti-csrftoken-a2z" value="csrftok" />
        <input name="ASIN" value="B0LEGACY01" />
        <input name="offerListingID" value="LEGACYOFFER" />
      </form></body></html>`);
    const tokens = extractCartAddTokens(doc);
    expect(tokens?.asin).toBe('B0LEGACY01');
    expect(tokens?.offerListingId).toBe('LEGACYOFFER');
  });

  // The optimization in #1 reuses page.content() HTML in place of a
  // ctx.request.get(pdpUrl). Both routes deliver the SSR `<form id="addToCart">`
  // when the PDP has a buyable offer. Saved fixtures cover three real-world
  // shapes:
  //   - "buyable" PDPs: form + non-empty offerListingId → tokens MUST extract
  //   - "no-buyable-offer" PDPs (marketplace-only / see-all-offers shapes):
  //     form exists but offerListingId is empty → null is correct, the HTTP
  //     path falls through to the Buy-Now click fallback in the caller
  //   - CAPTCHA pages: no form at all → null is correct
  //
  // We pick the buyable shape by checking for a non-empty offerListingId
  // up front and only require token-extraction on those. This way, future
  // Amazon redesigns that DROP a field on buyable PDPs fail the test
  // loudly while non-buyable / CAPTCHA fixtures don't generate noise.
  describe('every saved PDP fixture: buyable → tokens extract; non-buyable → null', () => {
    const files = readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.html'));
    expect(files.length).toBeGreaterThan(0);

    function classify(html: string): 'buyable' | 'non-buyable' {
      // A PDP is "buyable" via HTTP-add iff its `<form id="addToCart">`
      // carries a non-empty offerListingId AND ASIN AND csrf. The whole
      // page can hold an empty offerListingID input INSIDE the form
      // alongside a populated one OUTSIDE — that's how Amazon renders
      // marketplace listings for products with no default seller.
      // Scope the classifier to inside the form so it mirrors the helper.
      const form = docOf(html).getElementById('addToCart');
      if (!form) return 'non-buyable';
      const off =
        (form.querySelector('input[name="items[0.base][offerListingId]"]') as HTMLInputElement | null)
          ?.value ??
        (form.querySelector('input[name="offerListingID"]') as HTMLInputElement | null)?.value ??
        '';
      return off.length > 0 ? 'buyable' : 'non-buyable';
    }

    for (const file of files) {
      const html = readFileSync(join(FIXTURES_DIR, file), 'utf8');
      const shape = classify(html);
      it(`(${shape}) ${file}`, () => {
        const tokens = extractCartAddTokens(docOf(html));
        if (shape === 'buyable') {
          expect(tokens, `tokens missing for buyable fixture ${file}`).not.toBeNull();
          expect(tokens?.csrf.length, 'csrf').toBeGreaterThan(40);
          expect(tokens?.offerListingId.length, 'offerListingId').toBeGreaterThan(40);
          // ASIN should match filename prefix (fixture names are <ASIN>.html)
          const fileAsin = file.replace(/\.html$/, '');
          expect(tokens?.asin).toBe(fileAsin);
        } else {
          // No buyable offer — the HTTP path correctly bails so the caller's
          // Buy-Now-click fallback kicks in. Returning anything non-null here
          // would mean we're about to POST an empty offerListingId and Amazon
          // would 400 (or worse, commit garbage).
          expect(tokens, `expected null for non-buyable ${file}`).toBeNull();
        }
      });
    }
  });
});
