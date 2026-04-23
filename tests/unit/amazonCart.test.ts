import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_CART_DELETE_SELECTOR,
  countActiveCartDeleteButtons,
  isTargetInActiveCart,
} from '@parsers/amazonCart';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../../fixtures', name), 'utf8');
}

/**
 * Fixture: live Amazon Shopping Cart page captured 2026-04-23.
 *
 * Layout:
 *   - Active Cart (`[data-name="Active Cart"]`) with 10 line items
 *   - Saved for Later (`[data-name="Saved Cart"]`) with 10 line items
 *   - B0FWD726XF (MacBook) is in BOTH sections — active AND saved.
 *     This is the key adversarial property: any selector that doesn't
 *     scope to Active Cart would falsely treat the saved copy as
 *     "in cart" and skip the Buy Now step, or worse delete it.
 */
describe('countActiveCartDeleteButtons (cart fixture)', () => {
  it('counts exactly the 10 Active-Cart delete buttons', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(countActiveCartDeleteButtons(doc)).toBe(10);
  });

  it('ignores the 10 Saved-for-Later delete buttons', () => {
    // Sanity: the page has 20 delete buttons in total (10 Active + 10 Saved).
    // The parser must only count Active. If this ever equals 20, the
    // clearCart loop would wipe out items the user parked for later.
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    const totalDeletes = doc.querySelectorAll('input[value="Delete"]').length;
    expect(totalDeletes).toBe(20);
    expect(countActiveCartDeleteButtons(doc)).toBe(10);
    expect(countActiveCartDeleteButtons(doc)).toBeLessThan(totalDeletes);
  });

  it('returns 0 on an empty cart (no Active section)', () => {
    const doc = docOf('<html><body><div>Your cart is empty</div></body></html>');
    expect(countActiveCartDeleteButtons(doc)).toBe(0);
  });

  it('exports a single source-of-truth selector string', () => {
    // clearCart.ts imports this same constant for its Playwright locator —
    // if anyone drifts the selector, both the runtime and the tests break
    // together, which is the point.
    expect(ACTIVE_CART_DELETE_SELECTOR).toBe(
      '[data-name="Active Cart"] input[value="Delete"]',
    );
  });
});

describe('isTargetInActiveCart (cart fixture)', () => {
  const TARGET_IN_BOTH = 'B0FWD726XF'; // MacBook — in Active AND Saved
  const TARGET_ACTIVE_ONLY = 'B07V6TD58J'; // only in Active
  const TARGET_SAVED_ONLY = 'B0FC5FJZ9Z'; // only in Saved
  const TARGET_ABSENT = 'B0XXXXXXXX';

  it('returns true when ASIN is in the Active section', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(isTargetInActiveCart(doc, TARGET_ACTIVE_ONLY)).toBe(true);
  });

  it('returns true when ASIN is in BOTH Active and Saved — scoped hit still counts', () => {
    // The MacBook is in both sections. The function must find it via
    // the Active scope, not "anywhere on the page".
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(isTargetInActiveCart(doc, TARGET_IN_BOTH)).toBe(true);
  });

  it('returns FALSE when ASIN is ONLY in Saved-for-Later (critical safety)', () => {
    // This is the test that protects against "user saved the item for
    // later → Buy Now step was skipped → no target actually in cart at
    // checkout → 0% cashback charge" bugs.
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(isTargetInActiveCart(doc, TARGET_SAVED_ONLY)).toBe(false);
  });

  it('returns false for an ASIN that does not exist on the page', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(isTargetInActiveCart(doc, TARGET_ABSENT)).toBe(false);
  });

  it('returns true (any-row fallback) when asin is null and Active has items', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    expect(isTargetInActiveCart(doc, null)).toBe(true);
  });

  it('returns false when asin is null and Active is empty', () => {
    const doc = docOf(
      '<html><body><div data-name="Saved Cart"><div data-asin="B0ONLYSAVED">x</div></div></body></html>',
    );
    // Null-asin mode must NOT fall through to Saved Cart.
    expect(isTargetInActiveCart(doc, null)).toBe(false);
  });

  it('falls back to /dp/<asin> link when data-asin is absent on the row', () => {
    // Some Amazon A/B layouts drop `data-asin` on the line-item row.
    // The parser must still find the target via its product link.
    const doc = docOf(`
      <html><body>
        <div data-name="Active Cart">
          <div class="sc-list-item">
            <a href="/Apple-MacBook/dp/B0FWD726XF?ref_=cart">MacBook</a>
            <input type="submit" value="Delete" />
          </div>
        </div>
      </body></html>
    `);
    expect(isTargetInActiveCart(doc, 'B0FWD726XF')).toBe(true);
  });

  it('also accepts /gp/product/<asin> as the fallback link form', () => {
    const doc = docOf(`
      <html><body>
        <div data-name="Active Cart">
          <div><a href="/gp/product/B07ABCDEFG">x</a></div>
        </div>
      </body></html>
    `);
    expect(isTargetInActiveCart(doc, 'B07ABCDEFG')).toBe(true);
  });
});

describe('clearCart logical walkthrough (cart fixture)', () => {
  // clearCart's Playwright side is a goto + click-and-wait loop; we
  // can't execute the real page.click here. But we CAN prove the loop's
  // termination + progress invariants hold on the fixture: the parser
  // counts 10 deletions to perform, and the count monotonically drops
  // to 0 as each Active row is removed from the DOM.
  it('reports 10 → 0 as Active rows are removed one-by-one', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      counts.push(countActiveCartDeleteButtons(doc));
      // Simulate a successful delete: drop the first Active row.
      const firstRow =
        doc.querySelector(
          '[data-name="Active Cart"] [data-asin]',
        ) ?? null;
      if (firstRow?.parentElement) {
        firstRow.parentElement.removeChild(firstRow);
      } else {
        break;
      }
    }
    // Expect a strictly non-increasing sequence ending at 0 within the
    // 10 iterations the Active section should take.
    expect(counts[0]).toBe(10);
    expect(counts[10]).toBe(0);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it('leaves Saved-for-Later untouched after Active is emptied', () => {
    const doc = docOf(fixture('cart-mixed-active-saved.html'));
    const savedBefore = doc.querySelectorAll(
      '[data-name="Saved Cart"] [data-asin]',
    ).length;
    // Drop every Active row.
    for (;;) {
      const row = doc.querySelector(
        '[data-name="Active Cart"] [data-asin]',
      );
      if (!row) break;
      row.parentElement?.removeChild(row);
    }
    expect(countActiveCartDeleteButtons(doc)).toBe(0);
    const savedAfter = doc.querySelectorAll(
      '[data-name="Saved Cart"] [data-asin]',
    ).length;
    expect(savedAfter).toBe(savedBefore);
  });
});
