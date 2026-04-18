import type { Page } from 'playwright';

export type VerifyOrderOutcome =
  | { kind: 'active'; orderId: string }
  | { kind: 'cancelled'; orderId: string }
  | { kind: 'timeout'; orderId: string }
  | { kind: 'error'; orderId: string; message: string };

/**
 * Open Amazon's order-details page for `orderId` on the already-loaded
 * `page` (which should belong to the profile that placed the order) and
 * decide whether the order is active, cancelled, or indeterminate.
 *
 * Mirrors old AutoG `driveVerifyOrder`'s 15s polling check — looks for
 * an explicit "This order has been cancelled." marker first, then falls
 * back to the order-id appearing in body text as proof the order exists
 * and is still active.
 */
export async function verifyOrder(
  page: Page,
  orderId: string,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyOrderOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);

  type EvalResult =
    | { kind: 'active' }
    | { kind: 'cancelled' }
    | { kind: 'timeout' }
    | { kind: 'error'; message: string };

  const result = await page
    .evaluate(
      ({ targetOrderId, deadlineMs }): Promise<EvalResult> => {
        return new Promise<EvalResult>((resolve) => {
          const deadline = Date.now() + deadlineMs;
          const tick = () => {
            const text = (document.body && document.body.innerText) || '';

            // Amazon's "We're unable to load your order details" / similar
            // error pages mean the page rendered but the order data didn't
            // come through. Treat as a terminal unexpected error rather
            // than letting the polling time out.
            const errMatch = text.match(
              /(We(?:'|\u2019)re unable to load your order(?: details)?[^.\n]*\.?|We can(?:'|\u2019)t (?:find|display|retrieve) (?:that|this|your) order[^.\n]*\.?|Sorry,?\s*something went wrong[^.\n]*\.?)/i,
            );
            if (errMatch) {
              return resolve({ kind: 'error', message: errMatch[0].trim().slice(0, 200) });
            }

            // Cancellation marker — Amazon uses both "cancelled" (UK) and
            // "canceled" (US) across templates. Trailing punctuation varies.
            if (/This order has been cancell?ed\b/i.test(text)) {
              return resolve({ kind: 'cancelled' });
            }
            // Active: order-details page has hydrated and shows this order.
            // The orderId reliably appears in the page HTML (data attrs,
            // hidden spans) even when it's not in body.innerText on the
            // newer SPA-style layout. Pair it with a "Subtotal" / "Order
            // Total" / "Items Ordered" signal so we don't false-positive
            // on a still-loading page that just has the URL in a script tag.
            const html = document.documentElement.innerHTML || '';
            const orderIdRendered = html.includes(targetOrderId);
            const hasOrderContent =
              /(subtotal|order\s*total|items?\s*ordered|order\s*placed|delivery|shipped\s+on|arriving)/i.test(
                text,
              );
            if (orderIdRendered && hasOrderContent) {
              return resolve({ kind: 'active' });
            }
            if (Date.now() > deadline) return resolve({ kind: 'timeout' });
            setTimeout(tick, 300);
          };
          tick();
        });
      },
      { targetOrderId: orderId, deadlineMs: timeoutMs },
    )
    .catch(() => ({ kind: 'timeout' as const }));

  if (result.kind === 'error') {
    return { kind: 'error', orderId, message: result.message };
  }
  return { kind: result.kind, orderId };
}
