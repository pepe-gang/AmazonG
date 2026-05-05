import type { Page } from 'playwright';
import { JSDOM } from 'jsdom';
import type { DriverSession } from '../browser/driver.js';
import { NavigationError } from '../shared/errors.js';
import { parseAmazonProduct } from '../parsers/amazonProduct.js';
import type { ProductInfo } from '../shared/types.js';

/**
 * Navigate `page` to the product URL and parse it. After this returns,
 * `page` stays on the product page so a downstream action (like buyNow)
 * can continue on the same tab without re-navigating.
 *
 * Some signals — notably the visible Prime badge — are unreliable from
 * static HTML alone because Amazon's `data-csa-c-is-in-initial-active-row`
 * attribute is inconsistent across product templates. For those, we run
 * an extra runtime visibility check on `page` and override the static
 * parser's result.
 */
export async function scrapeProduct(page: Page, url: string): Promise<ProductInfo> {
  await loadProductPage(page, url);
  const html = await page.content();
  const info = parseProductHtml(html, url);
  // Reconcile the static parser with the runtime visibility check.
  //
  // The static parser knows about Amazon's `data-csa-c-is-in-initial-active-row="false"`
  // "inactive accordion row" marker, which means a subtree is rendered
  // in markup but logically hidden. The runtime check doesn't know
  // about this marker — it only looks at aok-hidden ancestors, bounding
  // rects, and computed styles. Some inactive-accordion subtrees DO
  // render with non-zero bounding rects (Amazon's CSS doesn't always
  // collapse them), which means the runtime check sees them as
  // "visible" while the static parser correctly treats them as hidden.
  //
  // INC-2026-05-05: a non-Prime iPad PDP had three #prime-badge nodes,
  // all flagged by the static parser as hidden (parent celwidget had
  // the inactive-row marker). The runtime check called one visible
  // because its bounding rect was non-zero. The override blindly
  // flipped isPrime from `false` (static) to `true` (runtime). Verify
  // passed. Order placed for a non-Prime item.
  //
  // Conservative reconciliation rule:
  //   - false (from EITHER source) wins. We never upgrade `false` → `true`.
  //   - Runtime can promote `null` (static was indeterminate) up to
  //     `true` or `false`.
  //   - Runtime can downgrade `true` → `false` (e.g. static parser
  //     thought a candidate was visible but the live DOM disagrees).
  //
  // This trades occasional false-negatives (real Prime listing where
  // the static parser excluded the badge erroneously) for correctness
  // on the non-Prime case. False-negatives surface as "not_prime"
  // verify failures the user can rerun; false-positives place real
  // money at non-Prime delivery.
  const runtime = await runtimeVisibilityChecks(page).catch(() => null);
  if (runtime) {
    info.isPrime = reconcile(info.isPrime, runtime.isPrime);
    info.hasBuyNow = reconcile(info.hasBuyNow, runtime.hasBuyNow);
    info.hasAddToCart = reconcile(info.hasAddToCart, runtime.hasAddToCart);
    info.isSignedIn = reconcile(info.isSignedIn, runtime.isSignedIn);
  }
  return info;
}

/**
 * Conservative-AND for boolean visibility flags. False wins. Runtime can
 * promote null to true/false but cannot upgrade false → true. See the
 * INC-2026-05-05 commentary in scrapeProduct above for the full
 * rationale.
 */
function reconcile(staticValue: boolean | null, runtimeValue: boolean | null): boolean | null {
  if (staticValue === false || runtimeValue === false) return false;
  if (staticValue === null) return runtimeValue;
  return staticValue;
}

type RuntimeChecks = {
  isPrime: boolean | null;
  hasBuyNow: boolean | null;
  hasAddToCart: boolean | null;
  isSignedIn: boolean | null;
};

async function runtimeVisibilityChecks(page: Page): Promise<RuntimeChecks> {
  return page.evaluate(() => {
    function isVisible(el: Element): boolean {
      // aok-hidden / a-hidden ancestor → hidden
      let n: Element | null = el;
      while (n) {
        const cls = n.classList;
        if (cls && (cls.contains('aok-hidden') || cls.contains('a-hidden'))) return false;
        n = n.parentElement;
      }
      // Bounding rect must be non-zero (rendered with size)
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      // Computed style on element + ancestors
      let m: Element | null = el;
      while (m) {
        const cs = getComputedStyle(m as HTMLElement);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          return false;
        }
        m = m.parentElement;
      }
      return true;
    }

    const hasProductUi = !!document.querySelector('#productTitle');

    // isPrime — any visible #prime-badge or .a-icon-prime-with-text
    let isPrime: boolean | null = null;
    const primeCandidates = Array.from(
      document.querySelectorAll<HTMLElement>('#prime-badge, .a-icon-prime-with-text'),
    );
    if (primeCandidates.some(isVisible)) {
      isPrime = true;
    } else if (hasProductUi) {
      isPrime = false;
    }

    // hasBuyNow — visible & enabled Buy Now button
    let hasBuyNow: boolean | null = null;
    const buyCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#buy-now-button, input[name="submit.buy-now"], #buyNow_feature_div button',
      ),
    );
    const buyVisible = buyCandidates.some((el) => {
      if (!isVisible(el)) return false;
      if (el.hasAttribute('disabled')) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    });
    if (buyVisible) {
      hasBuyNow = true;
    } else if (hasProductUi) {
      hasBuyNow = false;
    }

    // hasAddToCart — visible & enabled Add to Cart button. Same
    // visibility/disabled gating as Buy Now so a greyed-out button
    // doesn't read as a usable fallback.
    let hasAddToCart: boolean | null = null;
    const cartCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#add-to-cart-button, input[name="submit.add-to-cart"]',
      ),
    );
    const cartVisible = cartCandidates.some((el) => {
      if (!isVisible(el)) return false;
      if (el.hasAttribute('disabled')) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      return true;
    });
    if (cartVisible) {
      hasAddToCart = true;
    } else if (hasProductUi) {
      hasAddToCart = false;
    }

    // isSignedIn — read the account-area greeting. "Hello, sign in" =
    // signed out; anything else (including "Hello, <name>") = signed in.
    // Null when the global header isn't on this page.
    let isSignedIn: boolean | null = null;
    const navAccount = document.querySelector('#nav-link-accountList-nav-line-1');
    if (navAccount) {
      const txt = (navAccount.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (txt) isSignedIn = !/^hello,?\s*sign in$/i.test(txt);
    }

    return { isPrime, hasBuyNow, hasAddToCart, isSignedIn };
  });
}

/**
 * Convenience for one-shot scrapes (scripts, fixture capture). Opens its
 * own page, scrapes, and closes — does NOT leave the page on screen for
 * a follow-up action. The worker workflow uses scrapeProduct(page, url)
 * directly to share its page with buyNow.
 */
export async function fetchProductHtml(session: DriverSession, url: string): Promise<string> {
  const page = await session.newPage();
  try {
    await loadProductPage(page, url);
    return await page.content();
  } finally {
    await page.close();
  }
}

/**
 * Internal: navigate `page` to `url` and wait for the buy-box to hydrate.
 * Used by both scrapeProduct (in-workflow) and fetchProductHtml (scripts).
 */
async function loadProductPage(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    throw new NavigationError(url, 'goto failed', err);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  // Amazon's buy-box widgets render client-side after domcontentloaded.
  // Wait for one of the known terminal states (buy button, OOS widget,
  // quantity-limit widget, "see all offers" button) OR a real availability
  // string (not unhydrated JS source) before snapshotting. 10s cap so we
  // still return *something* if Amazon is slow.
  await page
    .waitForFunction(
      () => {
        if (
          document.querySelector(
            '#buy-now-button, #outOfStock_feature_div, #quantityLimitExhaustionAOD_feature_div, #buybox-see-all-buying-choices',
          )
        ) {
          return true;
        }
        const avail = document.querySelector('#availability');
        if (avail) {
          const clone = avail.cloneNode(true) as Element;
          clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
          const t = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t.length > 0 && t.length < 300) return true;
        }
        return false;
      },
      { timeout: 10_000 },
    )
    .catch(() => {
      // Give up waiting — we'll parse whatever rendered so far.
    });
}

export function parseProductHtml(html: string, url: string): ProductInfo {
  const dom = new JSDOM(html);
  return parseAmazonProduct(dom.window.document, url);
}
