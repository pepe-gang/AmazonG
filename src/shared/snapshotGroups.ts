export const SNAPSHOT_ERROR_GROUPS = [
  { id: 'price_exceeded', label: 'Price exceeds max' },
  { id: 'out_of_stock', label: 'Out of stock' },
  { id: 'address_mismatch', label: 'Address not found' },
  { id: 'address_stuck', label: 'Address picker failed' },
  { id: 'cashback_low', label: 'Cashback below minimum' },
  { id: 'cashback_toggle', label: 'BG name toggle failed' },
  { id: 'buy_button', label: 'Buy Now button issue' },
  { id: 'place_order', label: 'Place Order failed' },
  { id: 'confirm_stuck', label: 'Confirmation page stuck' },
  { id: 'checkout_price', label: 'Checkout price unreadable' },
  { id: 'condition_blocked', label: 'Item condition rejected' },
  { id: 'shipping_blocked', label: 'Shipping / Prime issue' },
  { id: 'verify_failed', label: 'Order verification error' },
] as const;

export type ErrorGroupId = (typeof SNAPSHOT_ERROR_GROUPS)[number]['id'];

/**
 * Classify an error message into one of the known error groups.
 * Returns null for unrecognised messages.
 */
export function classifyError(error: string): ErrorGroupId | null {
  const e = error.toLowerCase();

  if (/exceeds (max|retail cap) \$/.test(error) || /exceeds max \$/.test(e)) return 'price_exceeded';
  if (e.includes('not in stock') || e.includes('out of stock') || e.includes('currently unavailable') || e.includes('item_unavailable')) return 'out_of_stock';
  if (e.includes('no saved address starts with') || e.includes('no allowed prefixes configured')) return 'address_mismatch';
  if (e.includes('address picker') || e.includes('address submitted but') || e.includes('deliver button persisted') || e.includes('change-address link not found') || e.includes('did not re-render')) return 'address_stuck';
  if (e.includes('name-toggle')) return 'cashback_toggle';
  if (/cashback \d/.test(e) || e.includes('cashback missing')) return 'cashback_low';
  if (e.includes('buy-now button never appeared') || e.includes('buy now button is not available') || e.includes('failed to click buy now')) return 'buy_button';
  if (e.includes('no place order button') || e.includes('failed to click place order')) return 'place_order';
  if (e.includes('pending order page') || e.includes('confirmation url never loaded')) return 'confirm_stuck';
  if (e.includes('could not read item price on /spc')) return 'checkout_price';
  if (e.includes('listing is used') || e.includes('listing is amazon renewed')) return 'condition_blocked';
  if (e.includes('cannot ship') || e.includes('not prime-eligible')) return 'shipping_blocked';
  if (e.startsWith('verify:')) return 'verify_failed';

  return null;
}

/**
 * Whether we should capture a snapshot for this error, given the current
 * settings. Returns true when capture is enabled and the error's group
 * is in the selected set (or the set is empty = capture all).
 */
export function shouldCapture(
  error: string,
  snapshotOnFailure: boolean,
  snapshotGroups: string[],
): boolean {
  if (!snapshotOnFailure) return false;
  if (snapshotGroups.length === 0) return true;
  const group = classifyError(error);
  if (!group) return false;
  return snapshotGroups.includes(group);
}
