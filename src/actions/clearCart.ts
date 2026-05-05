import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { logger } from '../shared/logger.js';
import { NavigationError } from '../shared/errors.js';
import { ACTIVE_CART_DELETE_SELECTOR as ACTIVE_CART_DELETE } from '../parsers/amazonCart.js';
import { HTTP_BROWSERY_HEADERS } from './amazonHttp.js';

const CART_URL = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

const OVERALL_DEADLINE_MS = 60_000;
const CLICK_TIMEOUT_MS = 10_000;
const ROW_DROP_TIMEOUT_MS = 15_000;

export type ClearCartResult =
  | { ok: true; wasEmpty: boolean; removed: number }
  | { ok: false; reason: 'click_failed' | 'click_no_effect' | 'deadline'; removed: number };

/**
 * Empty the user's active cart on Amazon (Saved for Later is left alone).
 * Safe to run on an already-empty cart.
 *
 * Two-tier path:
 *
 *  1. HTTP fast path. Fetch the cart HTML via `context.request.get`,
 *     JSDOM-parse for the active-cart line-item UUIDs, and POST one
 *     `submit.delete-active.<UUID>=Delete` per item to the same endpoint
 *     the cart's <form id="activeCartViewForm"> uses. Sequential, not
 *     parallel — Amazon's cart-server has a race when two delete POSTs
 *     hit at once (verified live: 4 parallel POSTs all returned 200 but
 *     only 2 items dropped). Sequential is still ~150ms per item, so an
 *     8-filler clear runs in ~1.5s vs ~10-30s on the click path.
 *
 *  2. Click-loop fallback. If the HTTP path fails for any reason (no
 *     csrf in the cart HTML, parse mismatch, non-200 from any delete),
 *     we fall through to the original click-then-wait-for-row-drop loop
 *     so worst-case behavior matches what shipped before this experiment.
 *     The old loop also handles edge cases the HTTP path doesn't try
 *     (e.g. partial deletes on flaky Amazon responses) by re-counting
 *     and re-clicking until the deadline.
 */
export async function clearCart(
  page: Page,
  opts: { correlationId?: string } = {},
): Promise<ClearCartResult> {
  const cid = opts.correlationId;
  logger.info('step.clearCart.start', { url: CART_URL }, cid);

  // 1. HTTP fast path — no tab navigation.
  const http = await clearCartViaHttp(page);
  if (http.kind === 'ok') {
    logger.info(
      'step.clearCart.http.ok',
      {
        removed: http.removed,
        wasEmpty: http.wasEmpty,
        cartFetchMs: http.cartFetchMs,
        deletesMs: http.deletesMs,
        totalMs: http.totalMs,
      },
      cid,
    );
    return { ok: true, wasEmpty: http.wasEmpty, removed: http.removed };
  }
  logger.info(
    'step.clearCart.http.fallback',
    { reason: http.reason, ...(http.status != null ? { status: http.status } : {}) },
    cid,
  );

  // 2. Click-loop fallback — original pre-experiment path.
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

type HttpClearResult =
  | {
      kind: 'ok';
      removed: number;
      wasEmpty: boolean;
      cartFetchMs: number;
      deletesMs: number;
      totalMs: number;
    }
  | { kind: 'failed'; reason: string; status?: number };

/**
 * HTTP-only preflight version of `clearCart`. Same shape as the public
 * `ClearCartResult` but exposes the HTTP fast path WITHOUT the click-
 * loop fallback. Designed to be fired in parallel with `scrapeProduct`
 * — both share the BrowserContext but the HTTP path doesn't navigate
 * the visible tab, so they can run concurrently without racing.
 *
 * Caller (pollAndScrape) workflow:
 *
 *   const preflight = clearCartHttpOnly(page, cid);   // fire, don't await
 *   const info = await scrapeProduct(page, productUrl);  // tab nav
 *   const cleared = await preflight;
 *   if (!cleared.ok) {
 *     // HTTP failed — run full clearCart (with click-loop fallback)
 *     // sequentially. Page is already on PDP (scrape completed); the
 *     // click-loop's page.goto('/cart') is the only nav happening so
 *     // there's no race.
 *     const fallback = await clearCart(page, { correlationId: cid });
 *     ...
 *   }
 *
 * Returns the same `ClearCartResult` shape so the caller doesn't need
 * to translate. Never throws.
 */
export async function clearCartHttpOnly(
  page: Page,
  opts: { correlationId?: string } = {},
): Promise<ClearCartResult> {
  const cid = opts.correlationId;
  logger.info('step.clearCart.preflight.start', { url: CART_URL }, cid);
  const http = await clearCartViaHttp(page);
  if (http.kind === 'ok') {
    logger.info(
      'step.clearCart.preflight.ok',
      {
        removed: http.removed,
        wasEmpty: http.wasEmpty,
        cartFetchMs: http.cartFetchMs,
        deletesMs: http.deletesMs,
        totalMs: http.totalMs,
      },
      cid,
    );
    return { ok: true, wasEmpty: http.wasEmpty, removed: http.removed };
  }
  logger.info(
    'step.clearCart.preflight.fail',
    { reason: http.reason, ...(http.status != null ? { status: http.status } : {}) },
    cid,
  );
  // Translate HTTP failure into the public ClearCartResult fail shape.
  // Use 'click_no_effect' so callers see this as a soft-fail (matches
  // what the click-loop returns when it can't make progress) and route
  // to the sequential fallback.
  return { ok: false, reason: 'click_no_effect', removed: 0 };
}

/**
 * HTTP-only clear. Returns `kind:'ok'` on success (including the empty-
 * cart case) or `kind:'failed'` with a reason that the caller can
 * forward to the click-loop fallback. Does NOT throw.
 *
 * Why sequential: Amazon's cart-server races on parallel deletes —
 * verified live: posting 4 deletes via Promise.all returned 4×200 but
 * only 2 items actually dropped. Each delete likely reissues UUIDs for
 * remaining items, so a parallel POST targets a stale slot. Sequential
 * (one POST, await, next) is reliable and still ~150ms per item.
 */
async function clearCartViaHttp(page: Page): Promise<HttpClearResult> {
  const ctx = page.context();
  const t0 = Date.now();

  // 1. Cart HTML fetch.
  let cartRes;
  try {
    cartRes = await ctx.request.get(CART_URL, {
      headers: HTTP_BROWSERY_HEADERS,
      timeout: 15_000,
    });
  } catch (err) {
    return {
      kind: 'failed',
      reason: 'cart_fetch_threw:' + String(err).slice(0, 80),
    };
  }
  if (!cartRes.ok()) {
    return {
      kind: 'failed',
      reason: 'cart_http_error',
      status: cartRes.status(),
    };
  }
  let cartHtml: string;
  try {
    cartHtml = await cartRes.text();
  } catch {
    return { kind: 'failed', reason: 'cart_body_read_threw' };
  }
  const cartFetchMs = Date.now() - t0;

  // 2. Parse for csrf + action + every active-cart UUID.
  const doc = new JSDOM(cartHtml).window.document;
  const form = doc.getElementById('activeCartViewForm');
  if (!form) return { kind: 'failed', reason: 'no_activeCartViewForm' };
  const csrf = (
    form.querySelector('input[name="anti-csrftoken-a2z"]') as HTMLInputElement | null
  )?.value;
  if (!csrf) return { kind: 'failed', reason: 'no_csrf' };
  const action = form.getAttribute('action');
  if (!action) return { kind: 'failed', reason: 'no_form_action' };

  // Specifically target submit.delete-active.* — Saved-for-Later items
  // use submit.delete-saved-for-later.* and we leave those alone.
  const uuids = Array.from(
    doc.querySelectorAll<HTMLInputElement>('input[name^="submit.delete-active."]'),
  )
    .map((el) => el.getAttribute('name')?.replace(/^submit\.delete-active\./, '') ?? '')
    .filter((u) => u.length > 0);

  if (uuids.length === 0) {
    // Cart already empty — nothing to do.
    return {
      kind: 'ok',
      removed: 0,
      wasEmpty: true,
      cartFetchMs,
      deletesMs: 0,
      totalMs: Date.now() - t0,
    };
  }

  // 3. Sequential single-delete POSTs.
  const postUrl = new URL(action, 'https://www.amazon.com').toString();
  const tDel = Date.now();
  for (const uuid of uuids) {
    const body = new URLSearchParams();
    body.append('anti-csrftoken-a2z', csrf);
    body.append(`submit.delete-active.${uuid}`, 'Delete');
    let postRes;
    try {
      postRes = await ctx.request.post(postUrl, {
        headers: {
          ...HTTP_BROWSERY_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: CART_URL,
          Origin: 'https://www.amazon.com',
        },
        data: body.toString(),
        timeout: 15_000,
      });
    } catch (err) {
      return {
        kind: 'failed',
        reason: 'delete_threw:' + String(err).slice(0, 80),
      };
    }
    if (!postRes.ok()) {
      return {
        kind: 'failed',
        reason: 'delete_http_error',
        status: postRes.status(),
      };
    }
  }
  const deletesMs = Date.now() - tDel;

  return {
    kind: 'ok',
    removed: uuids.length,
    wasEmpty: false,
    cartFetchMs,
    deletesMs,
    totalMs: Date.now() - t0,
  };
}
