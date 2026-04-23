/**
 * Pure DOM helpers for Amazon's cart page. Shared between the runtime
 * `clearCart` action (which uses the selector with a Playwright locator)
 * and fixture tests (which call the pure functions against jsdom).
 *
 * Invariant: every selector/function scopes to `[data-name="Active Cart"]`.
 * Amazon's Saved-for-Later section is marked `[data-name="Saved Cart"]`
 * and is a sibling — if we scoped loosely we'd accidentally delete items
 * the user explicitly parked for later. Several fixture tests pin this.
 */

/** Selector for delete buttons inside the ACTIVE cart only. One button
 *  per line item; clicking submits Amazon's AJAX remove-from-cart form. */
export const ACTIVE_CART_DELETE_SELECTOR =
  '[data-name="Active Cart"] input[value="Delete"]';

/** Number of active-cart line items eligible for deletion. `clearCart`
 *  uses this as the loop's termination condition. */
export function countActiveCartDeleteButtons(doc: Document): number {
  return doc.querySelectorAll(ACTIVE_CART_DELETE_SELECTOR).length;
}

/**
 * True iff `asin` is in the ACTIVE cart (ignores Saved-for-Later).
 * Tries `[data-asin]` first, falls back to a `/dp/<asin>` or
 * `/gp/product/<asin>` link inside the active-cart container — some
 * Amazon layouts drop the `data-asin` attribute on the line-item row.
 *
 * When `asin` is null, returns true if ANY active-cart row is present
 * (we don't know what to look for — any row means "at least something
 * landed in the cart" which is the Buy-Now-committed signal the caller
 * uses as a fallback).
 */
export function isTargetInActiveCart(doc: Document, asin: string | null): boolean {
  if (!asin) {
    return (
      doc.querySelectorAll('[data-name="Active Cart"] [data-asin]').length > 0
    );
  }
  const rows = doc.querySelectorAll(
    `[data-name="Active Cart"] [data-asin="${asin}"]`,
  );
  if (rows.length > 0) return true;
  const links = doc.querySelectorAll(
    `[data-name="Active Cart"] a[href*="/dp/${asin}"], [data-name="Active Cart"] a[href*="/gp/product/${asin}"]`,
  );
  return links.length > 0;
}
