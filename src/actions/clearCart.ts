import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
import { NavigationError } from '../shared/errors.js';

const CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

// Active Cart only — never touches Saved for Later. Amazon marks the active
// section with data-name="Active Cart"; the Delete input inside each line
// item submits an AJAX form that removes the row without a full reload.
const ACTIVE_CART_DELETE = '[data-name="Active Cart"] input[value="Delete"]';

const OVERALL_DEADLINE_MS = 60_000;
const CLICK_TIMEOUT_MS = 10_000;
const ROW_DROP_TIMEOUT_MS = 15_000;

export type ClearCartResult =
  | { ok: true; wasEmpty: boolean; removed: number }
  | { ok: false; reason: 'click_failed' | 'click_no_effect' | 'deadline'; removed: number };

/**
 * Navigate to the Amazon cart page and remove every active-cart line item
 * (Saved for Later is left alone). Safe to run on an already-empty cart —
 * it returns `{ ok: true, wasEmpty: true, removed: 0 }` without clicking
 * anything.
 *
 * Amazon's Delete button submits an AJAX form that shrinks the row list
 * without a full navigation. We click-then-wait-for-count-drop in a loop
 * so we don't race a still-animating row, and we bail after 60s total so
 * a stuck cart doesn't hang the whole checkout.
 */
export async function clearCart(
  page: Page,
  opts: { correlationId?: string } = {},
): Promise<ClearCartResult> {
  const cid = opts.correlationId;
  logger.info('step.clearCart.start', { url: CART_URL }, cid);

  try {
    await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    throw new NavigationError(CART_URL, 'goto failed', err);
  }

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  let removed = 0;

  while (Date.now() < deadline) {
    const before = await page.locator(ACTIVE_CART_DELETE).count().catch(() => 0);
    if (before === 0) {
      logger.info(
        'step.clearCart.done',
        { removed, wasEmpty: removed === 0 },
        cid,
      );
      return { ok: true, wasEmpty: removed === 0, removed };
    }

    try {
      await page
        .locator(ACTIVE_CART_DELETE)
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS });
    } catch {
      logger.warn('step.clearCart.click_failed', { removed, before }, cid);
      return { ok: false, reason: 'click_failed', removed };
    }

    const dropped = await page
      .waitForFunction(
        ({ sel, before: b }) => document.querySelectorAll(sel).length < b,
        { sel: ACTIVE_CART_DELETE, before },
        { timeout: ROW_DROP_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);

    if (!dropped) {
      logger.warn('step.clearCart.click_no_effect', { removed, before }, cid);
      return { ok: false, reason: 'click_no_effect', removed };
    }
    removed++;
  }

  logger.warn('step.clearCart.deadline', { removed }, cid);
  return { ok: false, reason: 'deadline', removed };
}
