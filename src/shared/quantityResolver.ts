/**
 * Decide which qty value to record on a successful filler buy.
 *
 * Three sources, in declining order of authority:
 *   1. fromConfirmationBadge — `<span class="checkout-quantity-badge">N</span>`
 *      on the post-place thank-you page. Set by Amazon AFTER the order
 *      is created, so it reflects merged-line unit-counts correctly.
 *      Hidden by Amazon for qty=1, set for qty>1.
 *   2. fromSpcDom — pre-place /spc-DOM read. Fragile: returned the LINE
 *      count (1) instead of the unit count (2) when Amazon merged
 *      duplicate-SKU lines. This is the source that caused the
 *      original "filler buys all reporting purchasedCount=1" bug.
 *   3. fromCartAddTarget — the qty we POSTed to cart-add. Reliable
 *      because cart-add either landed at this qty or failed loudly.
 *
 * Resolution rules:
 *   - Badge present     → trust it. If /spc DOM disagrees, emit
 *                         'spc_disagrees' so we can monitor drift.
 *   - Badge absent on
 *     qty>1             → defense: badge SHOULD be present per Amazon's
 *                         current rendering. If it's missing, /spc has
 *                         the known under-counting bug — fall back to
 *                         the cart-add target (the qty we sent), NOT to
 *                         /spc. Emit 'badge_missing_on_multi' so any
 *                         future Amazon markup change becomes visible
 *                         in logs immediately.
 *   - Badge absent on
 *     qty=1             → expected (Amazon hides the badge at qty=1).
 *                         Use /spc DOM if available, else target.
 */
export type QuantityWarn =
  | "badge_missing_on_multi"
  | "spc_disagrees"
  | null;

export function resolvePlacedQuantity(opts: {
  fromConfirmationBadge: number | null;
  fromSpcDom: number | null;
  fromCartAddTarget: number;
}): { quantity: number; warn: QuantityWarn } {
  const { fromConfirmationBadge, fromSpcDom, fromCartAddTarget } = opts;

  if (fromConfirmationBadge != null) {
    const warn: QuantityWarn =
      fromSpcDom != null && fromSpcDom !== fromConfirmationBadge
        ? "spc_disagrees"
        : null;
    return { quantity: fromConfirmationBadge, warn };
  }

  if (fromCartAddTarget > 1) {
    return { quantity: fromCartAddTarget, warn: "badge_missing_on_multi" };
  }

  return { quantity: fromSpcDom ?? fromCartAddTarget, warn: null };
}
