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
