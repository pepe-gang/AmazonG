import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  asinsCommittedInResponse,
  buildBatchCartAddBody,
  extractSearchResultCandidates,
  SEARCH_CART_ADD_CLIENT_NAME,
} from '../../src/actions/amazonHttp';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

/** Mirror the structure Amazon renders for one search-result card. The
 *  `<form>` carries the same hidden-input set we observed live on
 *  2026-05-05; tests use this to drive `extractSearchResultCandidates`. */
function searchCardHtml(opts: {
  asin: string;
  offerListingId?: string;
  csrf?: string;
  price?: { whole: string; fraction: string };
  prime?: boolean;
}): string {
  const { asin, offerListingId = `OL_${asin}`, csrf = 'csrf123', price, prime = true } = opts;
  return `
    <div data-asin="${asin}" data-component-type="s-search-result">
      ${prime ? '<i class="a-icon-prime"></i>' : ''}
      ${
        price
          ? `<span class="a-price"><span class="a-price-whole">${price.whole}</span><span class="a-price-fraction">${price.fraction}</span></span>`
          : ''
      }
      <form action="/cart/add-to-cart">
        <input name="anti-csrftoken-a2z" value="${csrf}" />
        <input name="clientName" value="EUIC_AddToCart_Search" />
        <input name="items[0.base][asin]" value="${asin}" />
        <input name="items[0.base][offerListingId]" value="${offerListingId}" />
        <input name="items[0.base][quantity]" value="1" />
        <input name="merchantId" value="ATVPDKIKX0DER" />
      </form>
    </div>
  `;
}

describe('extractSearchResultCandidates', () => {
  it('returns [] when no search-result cards present', () => {
    const doc = docOf('<html><body></body></html>');
    expect(extractSearchResultCandidates(doc)).toEqual([]);
  });

  it('returns [] when card has no form', () => {
    const doc = docOf(
      '<html><body><div data-asin="B0X0X0X0X0" data-component-type="s-search-result"></div></body></html>',
    );
    expect(extractSearchResultCandidates(doc)).toEqual([]);
  });

  it('drops cards missing offerListingId', () => {
    const html = `<html><body>${searchCardHtml({
      asin: 'B0BAD00001',
      offerListingId: '',
    })}</body></html>`;
    expect(extractSearchResultCandidates(docOf(html))).toEqual([]);
  });

  it('extracts asin + offerListingId + csrf + price + prime from a single card', () => {
    const html = `<html><body>${searchCardHtml({
      asin: 'B01MTDK1UI',
      offerListingId: 'fWXwVv5u0Vcs6UJhritp5KIv',
      csrf: 'hCw4ZUkLdDsl7hLY+rdfAY1zwkqX4J',
      price: { whole: '24', fraction: '99' },
    })}</body></html>`;

    const out = extractSearchResultCandidates(docOf(html));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      asin: 'B01MTDK1UI',
      offerListingId: 'fWXwVv5u0Vcs6UJhritp5KIv',
      csrf: 'hCw4ZUkLdDsl7hLY+rdfAY1zwkqX4J',
      price: 24.99,
      isPrime: true,
      merchantId: 'ATVPDKIKX0DER',
    });
  });

  it('parses price=null when no .a-price-whole element rendered', () => {
    const html = `<html><body>${searchCardHtml({ asin: 'B0NOPRICE1' })}</body></html>`;
    const out = extractSearchResultCandidates(docOf(html));
    expect(out[0].price).toBeNull();
  });

  it('flags non-Prime cards via isPrime=false', () => {
    const html = `<html><body>${searchCardHtml({
      asin: 'B0NONPRIME',
      prime: false,
      price: { whole: '10', fraction: '00' },
    })}</body></html>`;
    const out = extractSearchResultCandidates(docOf(html));
    expect(out[0].isPrime).toBe(false);
  });

  it('extracts all candidates from a multi-card search page', () => {
    const html = `<html><body>
      ${searchCardHtml({ asin: 'B01MTDK1UI', price: { whole: '24', fraction: '99' } })}
      ${searchCardHtml({ asin: 'B08HRBMYV6', price: { whole: '49', fraction: '50' } })}
      ${searchCardHtml({ asin: 'B0F8KVSPGV', price: { whole: '79', fraction: '00' } })}
    </body></html>`;

    const out = extractSearchResultCandidates(docOf(html));
    expect(out.map((c) => c.asin)).toEqual(['B01MTDK1UI', 'B08HRBMYV6', 'B0F8KVSPGV']);
    expect(out.map((c) => c.price)).toEqual([24.99, 49.5, 79]);
  });
});

describe('buildBatchCartAddBody', () => {
  it('builds the documented batch-POST shape for one item', () => {
    const body = buildBatchCartAddBody('csrf123', [
      { asin: 'B01MTDK1UI', offerListingId: 'OL_B01MTDK1UI' },
    ]);

    expect(body.get('anti-csrftoken-a2z')).toBe('csrf123');
    expect(body.get('clientName')).toBe(SEARCH_CART_ADD_CLIENT_NAME);
    expect(body.get('items[0.base][asin]')).toBe('B01MTDK1UI');
    expect(body.get('items[0.base][offerListingId]')).toBe('OL_B01MTDK1UI');
    expect(body.get('items[0.base][quantity]')).toBe('1');
  });

  it('indexes each item under items[N.base] for batch commits', () => {
    const body = buildBatchCartAddBody('c', [
      { asin: 'A0', offerListingId: 'OL_A0' },
      { asin: 'A1', offerListingId: 'OL_A1' },
      { asin: 'A2', offerListingId: 'OL_A2' },
    ]);

    expect(body.get('items[0.base][asin]')).toBe('A0');
    expect(body.get('items[1.base][asin]')).toBe('A1');
    expect(body.get('items[2.base][asin]')).toBe('A2');
  });

  it('clamps per-item quantity to [1, 99]', () => {
    const body = buildBatchCartAddBody('c', [
      { asin: 'A', offerListingId: 'O', quantity: 0 },
      { asin: 'B', offerListingId: 'O', quantity: 5 },
      { asin: 'C', offerListingId: 'O', quantity: 999 },
    ]);
    expect(body.get('items[0.base][quantity]')).toBe('1');
    expect(body.get('items[1.base][quantity]')).toBe('5');
    expect(body.get('items[2.base][quantity]')).toBe('99');
  });

  it('honors clientName override (e.g. PDP path uses Aplus_BuyableModules_DetailPage)', () => {
    const body = buildBatchCartAddBody('c', [{ asin: 'A', offerListingId: 'O' }], {
      clientName: 'Aplus_BuyableModules_DetailPage',
    });
    expect(body.get('clientName')).toBe('Aplus_BuyableModules_DetailPage');
  });
});

describe('asinsCommittedInResponse', () => {
  it('returns the subset of asins echoed back as data-asin="..." in the response', () => {
    const html = `<div data-asin="A01"></div><span data-asin="A02"></span>`;
    expect(asinsCommittedInResponse(html, ['A01', 'A02', 'A03'])).toEqual(['A01', 'A02']);
  });

  it('matches both single- and double-quoted attribute syntax', () => {
    const html = `<div data-asin='A01'></div><div data-asin="A02"></div>`;
    expect(asinsCommittedInResponse(html, ['A01', 'A02'])).toEqual(['A01', 'A02']);
  });

  it('returns [] when no requested ASIN appears in the response', () => {
    const html = `<div data-asin="OTHER"></div>`;
    expect(asinsCommittedInResponse(html, ['A01', 'A02'])).toEqual([]);
  });

  it('escapes regex metacharacters in the ASIN (defense — ASINs are alnum but be safe)', () => {
    // No real ASINs contain `.` but we accept the input verbatim and
    // shouldn't false-match if Amazon ever expanded the alphabet.
    const html = `<div data-asin="A.B"></div>`;
    expect(asinsCommittedInResponse(html, ['AXB'])).toEqual([]);
    expect(asinsCommittedInResponse(html, ['A.B'])).toEqual(['A.B']);
  });
});
