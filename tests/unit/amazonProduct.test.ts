import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAmazonProduct,
  parsePrice,
  findCashbackPct,
  findCondition,
  findShipsToAddress,
  findIsPrime,
  findHasBuyNow,
  findBuyBlocker,
} from '@parsers/amazonProduct';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

describe('parsePrice', () => {
  it('parses plain dollars', () => {
    expect(parsePrice('$12.99')).toBe(12.99);
  });
  it('parses with thousands', () => {
    expect(parsePrice('$1,299.00')).toBe(1299);
  });
  it('handles NBSP and surrounding whitespace', () => {
    expect(parsePrice('\u00a0 $12.99 ')).toBe(12.99);
  });
  it('returns null for empty/bad', () => {
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice('free')).toBeNull();
  });
});

describe('findCashbackPct', () => {
  it('finds 8% back in body', () => {
    const doc = docOf('<html><body><div>Earn 8% back at checkout!</div></body></html>');
    expect(findCashbackPct(doc)).toBe(8);
  });
  it('prefers highest match', () => {
    const doc = docOf('<html><body>3% back for some, 10% back for prime</body></html>');
    expect(findCashbackPct(doc)).toBe(10);
  });
  it('returns null when absent', () => {
    const doc = docOf('<html><body>no rewards here</body></html>');
    expect(findCashbackPct(doc)).toBeNull();
  });
});

describe('findCondition', () => {
  it('detects Amazon Renewed', () => {
    const doc = docOf('<html><body>Amazon Renewed · Certified refurbished</body></html>');
    expect(findCondition(doc)).toBe('renewed');
  });
  it('detects explicit Condition: Used', () => {
    const doc = docOf('<html><body>Condition: Used - Very Good</body></html>');
    expect(findCondition(doc)).toBe('used');
  });
  it('detects explicit Condition: New', () => {
    const doc = docOf('<html><body>Condition: New</body></html>');
    expect(findCondition(doc)).toBe('new');
  });
  it('returns null when no condition signal is present', () => {
    const doc = docOf('<html><body>Generic product page text</body></html>');
    expect(findCondition(doc)).toBeNull();
  });
  it('detects used on an offer-listing canonical URL with Used - Good', () => {
    const doc = docOf(`
      <html><head>
        <link rel="canonical" href="https://amazon.com/gp/offer-listing/B0XYZ">
      </head><body>Used - Good condition</body></html>`);
    expect(findCondition(doc)).toBe('used');
  });
});

describe('findShipsToAddress', () => {
  it('returns false when Amazon says it cannot ship', () => {
    const doc = docOf(
      '<html><body>This item cannot be shipped to your selected location.</body></html>',
    );
    expect(findShipsToAddress(doc)).toBe(false);
  });
  it('returns false on "we do not ship this" variants', () => {
    const doc = docOf('<html><body>We do not ship this item internationally.</body></html>');
    expect(findShipsToAddress(doc)).toBe(false);
  });
  it('returns true when a buyable button is present and no blocker', () => {
    const doc = docOf('<html><body><button id="buy-now-button">Buy Now</button></body></html>');
    expect(findShipsToAddress(doc)).toBe(true);
  });
  it('returns null when buy button is disabled and no blocker', () => {
    const doc = docOf('<html><body><button id="buy-now-button" disabled></button></body></html>');
    expect(findShipsToAddress(doc)).toBeNull();
  });
});

describe('findIsPrime', () => {
  it('returns true when .a-icon-prime-with-text badge is visible', () => {
    const doc = docOf(`
      <html><body>
        <i class="a-icon-wrapper a-icon-prime-with-text">
          <i class="a-icon a-icon-prime"></i><span>prime</span>
        </i>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(true);
  });

  it('returns false when only a hidden .a-icon-prime exists (badge-slot aok-hidden)', () => {
    // Mirrors B0GQVDGCD2's DOM: icon is present but in an aok-hidden slot
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Slow-ship Prime Item</span>
        <button id="buy-now-button">Buy Now</button>
        <span class="badge-slot aok-hidden">
          <i class="a-icon a-icon-prime a-icon-small"></i>
        </span>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('ignores bare .a-icon-prime without the badge-with-text wrapper', () => {
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Product</span>
        <button id="buy-now-button">Buy Now</button>
        <i class="a-icon a-icon-prime"></i>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('ignores badge if wrapped in aok-hidden ancestor', () => {
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Product</span>
        <button id="buy-now-button">Buy Now</button>
        <div class="aok-hidden">
          <i class="a-icon-prime-with-text"><i class="a-icon a-icon-prime"></i>prime</i>
        </div>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('ignores badge inside an inactive accordion row (used variation)', () => {
    // Mirrors the Echo Spot case: the Prime badge lives in the Used accordion
    // row which is not the active selection.
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Product</span>
        <button id="buy-now-button">Buy Now</button>
        <div data-csa-c-slot-id="usedAccordionRow" data-csa-c-is-in-initial-active-row="false">
          <i class="a-icon-prime-with-text"><i class="a-icon a-icon-prime"></i>prime</i>
        </div>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('treats the outer accordionRows container as non-hiding (active-row is a template attr)', () => {
    // Badge lives in the active (new) row; outer container has active=false
    // as a template attribute but shouldn't flag everything as hidden.
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Product</span>
        <button id="buy-now-button">Buy Now</button>
        <div data-csa-c-slot-id="accordionRows" data-csa-c-is-in-initial-active-row="false">
          <div data-csa-c-slot-id="newAccordionRow_0" data-csa-c-is-in-initial-active-row="true">
            <i class="a-icon-prime-with-text"><i class="a-icon a-icon-prime"></i>prime</i>
          </div>
        </div>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(true);
  });

  it('rejects Prime on the real B0BFC7WQ6R fixture (badges only in used accordion)', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0BFC7WQ6R.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    expect(findIsPrime(docOf(html))).toBe(false);
  });

  it('returns false when product UI exists but no Prime badge', () => {
    const doc = docOf(`
      <html><body>
        <span id="productTitle">Third Party Product</span>
        <button id="buy-now-button">Buy Now</button>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('returns null when page has no product UI (captcha / empty)', () => {
    const doc = docOf('<html><body><div>unrelated content</div></body></html>');
    expect(findIsPrime(doc)).toBeNull();
  });

  it('detects Prime via #prime-badge', () => {
    const doc = docOf(`
      <html><body>
        <span id="productTitle">X</span>
        <button id="buy-now-button">Buy</button>
        <span id="priceBadging_feature_div">
          <i id="prime-badge" class="a-icon a-icon-prime" aria-label="prime"></i>
        </span>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(true);
  });

  // Updated 2026-05-05 (REGR-2026-05-05): the previous expectation
  // ("inactive=false on a feature slot means hidden") was based on a
  // narrow Amazon layout. Real-world PDP captures show
  // deliveryPriceBadging_feature_div carries the inactive marker as a
  // template default while the contents ARE visible — see the
  // REGR-2026-05-05-ipad-IS-prime fixture. The marker alone is not a
  // reliable visibility signal; only the accordion-row pattern is
  // (slot/id matching `accordionRow`, with active-marker exception).
  it('treats #prime-badge in deliveryPriceBadging_feature_div as visible (template-default marker, not actually hidden)', () => {
    const doc = docOf(`
      <html><body>
        <span id="productTitle">X</span>
        <button id="buy-now-button">Buy</button>
        <div data-csa-c-slot-id="deliveryPriceBadging_feature_div" data-csa-c-is-in-initial-active-row="false">
          <i id="prime-badge" class="a-icon a-icon-prime" aria-label="prime"></i>
        </div>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(true);
  });

  it('ignores #prime-badge inside an alternate-offer accordion row (REGR-2026-05-05)', () => {
    // The companion of the test above: deliveryPriceBadging_feature_div
    // wrapped INSIDE an `apex_desktop_usedAccordionRow` subtree IS
    // hidden (we're in the alternate-offer preview). This is the real
    // failure mode the INC-2026-05-05 incident exposed.
    const doc = docOf(`
      <html><body>
        <span id="productTitle">X</span>
        <button id="buy-now-button">Buy</button>
        <div id="apex_desktop_usedAccordionRow">
          <div data-csa-c-slot-id="deliveryPriceBadging_feature_div" data-csa-c-is-in-initial-active-row="false">
            <i id="prime-badge" class="a-icon a-icon-prime" aria-label="prime"></i>
          </div>
        </div>
      </body></html>`);
    expect(findIsPrime(doc)).toBe(false);
  });

  it('detects Prime on the real B0FWD1MS82 fixture (visible badge)', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0FWD1MS82.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    expect(findIsPrime(docOf(html))).toBe(true);
  });

  it('detects Prime on the real B0DZ751XN6 fixture (#prime-badge in active buybox)', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0DZ751XN6.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    expect(findIsPrime(docOf(html))).toBe(true);
  });

  it('rejects Prime on the real B0GQVDGCD2 fixture (icon hidden in badge-slot)', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0GQVDGCD2.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    expect(findIsPrime(docOf(html))).toBe(false);
  });
});

describe('findHasBuyNow', () => {
  it('returns true for a standard #buy-now-button', () => {
    const doc = docOf('<html><body><button id="buy-now-button">Buy Now</button></body></html>');
    expect(findHasBuyNow(doc)).toBe(true);
  });
  it('returns true for Amazon native input[name="submit.buy-now"]', () => {
    const doc = docOf('<html><body><input name="submit.buy-now" type="submit" /></body></html>');
    expect(findHasBuyNow(doc)).toBe(true);
  });
  it('returns false when button is disabled', () => {
    const doc = docOf(
      '<html><body><span id="productTitle">X</span><button id="buy-now-button" disabled></button></body></html>',
    );
    expect(findHasBuyNow(doc)).toBe(false);
  });
  it('returns false when button is aria-disabled', () => {
    const doc = docOf(
      '<html><body><span id="productTitle">X</span><button id="buy-now-button" aria-disabled="true"></button></body></html>',
    );
    expect(findHasBuyNow(doc)).toBe(false);
  });
  it('returns false when productTitle exists but no Buy Now (variation required)', () => {
    const doc = docOf('<html><body><span id="productTitle">Multi-Variation Item</span></body></html>');
    expect(findHasBuyNow(doc)).toBe(false);
  });
  it('returns null when page has no product title (captcha / empty)', () => {
    const doc = docOf('<html><body><div>unrelated</div></body></html>');
    expect(findHasBuyNow(doc)).toBeNull();
  });
  it('ignores Buy Now hidden by aok-hidden ancestor', () => {
    const doc = docOf(
      '<html><body><span id="productTitle">X</span><div class="aok-hidden"><button id="buy-now-button">Buy</button></div></body></html>',
    );
    expect(findHasBuyNow(doc)).toBe(false);
  });
});

describe('findBuyBlocker', () => {
  it('extracts "Quantity limit met for this seller" from feature div', () => {
    const doc = docOf(`
      <html><body>
        <div id="quantityLimitExhaustionAOD_feature_div">
          <div>
            <i class="a-icon a-icon-info"></i>
            <span class="a-size-mini"> Quantity limit met for this seller. </span>
          </div>
        </div>
      </body></html>`);
    expect(findBuyBlocker(doc)).toBe('Quantity limit met for this seller.');
  });

  it('returns null when no known blocker div is present', () => {
    const doc = docOf('<html><body><span id="productTitle">OK</span></body></html>');
    expect(findBuyBlocker(doc)).toBeNull();
  });

  it('extracts from the real B0DZ75TN5F fixture', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0DZ75TN5F.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    const got = findBuyBlocker(docOf(html));
    expect(got).toMatch(/quantity\s+limit/i);
  });

  it('extracts from B0CD1JTBSC even though the widget is active=false', () => {
    const path = join(process.cwd(), 'fixtures', 'product', 'B0CD1JTBSC.html');
    if (!existsSync(path)) return;
    const html = readFileSync(path, 'utf8');
    const got = findBuyBlocker(docOf(html));
    expect(got).toMatch(/quantity\s+limit/i);
  });
});

describe('parseAmazonProduct', () => {
  it('extracts a minimal shape', () => {
    const html = `
      <html><body>
        <span id="productTitle">  Test Product  </span>
        <div id="corePriceDisplay_desktop_feature_div">
          <span class="a-price"><span class="a-offscreen">$19.99</span></span>
        </div>
        <div id="availability"><span>In Stock</span></div>
        <div>Earn 6% back on this purchase</div>
        <button id="buy-now-button">Buy Now</button>
      </body></html>`;
    const info = parseAmazonProduct(docOf(html), 'https://amazon.com/dp/TEST');
    expect(info.title).toBe('Test Product');
    expect(info.price).toBe(19.99);
    expect(info.priceText).toContain('19.99');
    expect(info.inStock).toBe(true);
    expect(info.cashbackPct).toBe(6);
    expect(info.url).toBe('https://amazon.com/dp/TEST');
    expect(info.condition).toBeNull();
    expect(info.shipsToAddress).toBe(true);
  });

  it('strips unhydrated script source from availability text', () => {
    const html = `
      <html><body>
        <span id="productTitle">Partially Loaded</span>
        <div id="availability">
          <script>P.when("A", "load").execute("aod-assets-loaded", function(A){ var x = 1; });</script>
          <span>In Stock</span>
        </div>
      </body></html>`;
    const info = parseAmazonProduct(docOf(html), 'x');
    expect(info.availabilityText).toBe('In Stock');
    expect(info.inStock).toBe(true);
  });

  it('marks out of stock correctly', () => {
    const html = `
      <html><body>
        <span id="productTitle">OOS Item</span>
        <div id="availability"><span>Currently unavailable.</span></div>
      </body></html>`;
    const info = parseAmazonProduct(docOf(html), 'x');
    expect(info.inStock).toBe(false);
    expect(info.price).toBeNull();
  });

  it('falls back to buy-button presence when no availability text', () => {
    const htmlYes = '<html><body><button id="buy-now-button"></button></body></html>';
    const htmlNo = '<html><body></body></html>';
    expect(parseAmazonProduct(docOf(htmlYes), 'x').inStock).toBe(true);
    expect(parseAmazonProduct(docOf(htmlNo), 'x').inStock).toBe(false);
  });

  it('passes through renewed condition', () => {
    const html = `
      <html><body>
        <span id="productTitle">Renewed Item</span>
        <div>Amazon Renewed product</div>
      </body></html>`;
    expect(parseAmazonProduct(docOf(html), 'x').condition).toBe('renewed');
  });

  it('parses isPrime on minimal Prime-badge HTML', () => {
    const html = `
      <html><body>
        <span id="productTitle">Prime Item</span>
        <i class="a-icon-wrapper a-icon-prime-with-text">
          <i class="a-icon a-icon-prime"></i><span>prime</span>
        </i>
        <button id="buy-now-button">Buy Now</button>
      </body></html>`;
    const info = parseAmazonProduct(docOf(html), 'x');
    expect(info.isPrime).toBe(true);
  });

  it('reports isPrime=false when product UI exists but no Prime markers', () => {
    const html = `
      <html><body>
        <span id="productTitle">Non-Prime Third Party</span>
        <button id="buy-now-button">Buy Now</button>
      </body></html>`;
    expect(parseAmazonProduct(docOf(html), 'x').isPrime).toBe(false);
  });
});
