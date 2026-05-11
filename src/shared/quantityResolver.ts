/**
 * Decide which qty value to record on a successful filler buy.
 *
 * Buy-time qty is BEST-EFFORT only. The verify phase (~10 min later)
 * re-reads qty from the order-details page via
 * `readQuantityFromOrderDetailsHtml` and submits `correctPurchasedCount`
 * to BG if it differs. So drift between buy-time and ground-truth is
 * self-correcting.
 *
 * Confirmation-page badge is NOT a source. We used to trust the
 * `<span class="checkout-quantity-badge">N</span>` on /gp/buy/thankyou
 * but the new Chewbacca layout renders a SINGLE consolidated badge per
 * shipping group on the thank-you page, NOT per-line-item. For a
 * filler buy fanned into 2+ orders, that badge can show "5" (a filler
 * group's item count) when the target's qty is actually 1. Removed
 * 2026-05-11 after live repro on order 112-3920218-6945066.
 *
 * Sources (declining authority):
 *   1. fromSpcDom — pre-place /spc-DOM read. Telemetry signal: when
 *      both this and cartAddTarget agree, we have high confidence.
 *      The Chewbacca /spc layout broke `.lineitem-container`-based
 *      readTargetQuantity (returns null), so this is often null today.
 *      Still useful as a sanity check for legacy /spc orderings.
 *   2. fromCartAddTarget — the qty we POSTed to cart-add. Reliable
 *      because cart-add either landed at this qty or failed loudly.
 */
export type QuantityWarn = "spc_disagrees" | null;

export function resolvePlacedQuantity(opts: {
  fromSpcDom: number | null;
  fromCartAddTarget: number;
}): { quantity: number; warn: QuantityWarn } {
  const { fromSpcDom, fromCartAddTarget } = opts;
  if (fromSpcDom !== null) {
    return {
      quantity: fromSpcDom,
      warn: fromSpcDom !== fromCartAddTarget ? "spc_disagrees" : null,
    };
  }
  return { quantity: fromCartAddTarget, warn: null };
}
