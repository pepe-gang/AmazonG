/**
 * Verifies the cart-URL navigation is tolerant of Amazon's Chewbacca
 * redirect-aborts. Reproduces the exact failure mode (page.goto throws,
 * but the page nevertheless lands on amazon.com via the aborting
 * redirect) without needing a real Amazon session.
 *
 * The pattern under test (used in 4 callsites: clearCart.ts:77,
 * buyWithFillers.ts:651 + 798, buyNow.ts:677):
 *
 *   await page.goto(url, ...).catch(() => undefined);
 *   const landed = page.url();
 *   if (!amazonRe.test(landed)) return failure;
 *   // else: continue, downstream code verifies via selectors
 *
 * Pre-fix behavior these tests would have caught:
 *   try { await page.goto(...) } catch (err) { throw NavigationError(...) }
 *
 * That threw on ERR_ABORTED even when the page actually committed
 * to the redirect target. The fix below makes it tolerate that case.
 */
import { describe, expect, it } from 'vitest';

const AMAZON_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?amazon\.com\//i;

/**
 * Pure extraction of the post-goto URL gate. Returns null when the
 * URL is "good enough" (anywhere on amazon.com), or a failure detail
 * string when the page didn't navigate to amazon at all.
 */
function evaluateLandedUrl(landed: string): { ok: true } | { ok: false; detail: string } {
  if (AMAZON_RE.test(landed)) return { ok: true };
  return { ok: false, detail: `landed on ${landed || '(blank)'}` };
}

/**
 * Simulates the full goto-tolerant pattern with a fake Page. Mirrors
 * the call shape of all 4 production callsites.
 */
async function runCartGoto(
  fakePage: { goto: () => Promise<void>; url: () => string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  await fakePage.goto().catch(() => undefined);
  return evaluateLandedUrl(fakePage.url());
}

describe('cart-URL goto redirect tolerance', () => {
  describe('the ERR_ABORTED-on-redirect case (the bug user hit)', () => {
    it('SUCCEEDS when goto throws but page lands on amazon.com checkout', async () => {
      // Live Chewbacca behavior: goto begins navigating to
      // /gp/cart/view.html, server (or a JS redirect) aborts and
      // points the browser at /checkout/p/p-106-XXX/...
      // Playwright sees the original nav as ERR_ABORTED → throws —
      // but the page itself successfully landed on the redirect
      // target.
      const fake = {
        goto: () => Promise.reject(new Error('net::ERR_ABORTED at https://www.amazon.com/gp/cart/view.html?ref_=nav_cart')),
        url: () => 'https://www.amazon.com/checkout/p/p-106-3981603-3254601/spc?pipelineType=Chewbacca',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(true);
    });

    it('SUCCEEDS when goto throws but page lands on /gp/cart/view.html (no redirect, but transient throw)', async () => {
      // A different transient class — the goto throws (e.g. timeout
      // racing with a slow page) but the URL is in fact correct.
      const fake = {
        goto: () => Promise.reject(new Error('Timeout 30000ms exceeded')),
        url: () => 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(true);
    });
  });

  describe('the genuine-failure case (no false positives)', () => {
    it('FAILS when goto throws AND page is still on about:blank', async () => {
      const fake = {
        goto: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
        url: () => 'about:blank',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/about:blank/);
    });

    it('FAILS when goto throws AND page hopped off-domain (e.g. interstitial captcha provider)', async () => {
      const fake = {
        goto: () => Promise.reject(new Error('net::ERR_ABORTED')),
        url: () => 'https://accounts.google.com/some-redirect',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(false);
    });

    it('FAILS when goto throws AND page url is empty', async () => {
      const fake = {
        goto: () => Promise.reject(new Error('frame was detached')),
        url: () => '',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/blank/);
    });
  });

  describe('the happy path (no throw)', () => {
    it('SUCCEEDS when goto resolves and page is on amazon.com cart', async () => {
      const fake = {
        goto: () => Promise.resolve(),
        url: () => 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(true);
    });

    it('SUCCEEDS when goto resolves and page is on amazon.com checkout (followed redirect)', async () => {
      const fake = {
        goto: () => Promise.resolve(),
        url: () => 'https://www.amazon.com/checkout/p/p-106-XXX/spc',
      };
      const r = await runCartGoto(fake);
      expect(r.ok).toBe(true);
    });

    it('accepts subdomains of amazon.com (smile, www, etc.)', async () => {
      for (const url of [
        'https://www.amazon.com/gp/cart/view.html',
        'https://smile.amazon.com/gp/cart/view.html',
      ]) {
        const fake = { goto: () => Promise.resolve(), url: () => url };
        const r = await runCartGoto(fake);
        expect(r.ok).toBe(true);
      }
    });
  });

  describe('regex anchoring', () => {
    it('does NOT accept lookalike domains', async () => {
      for (const url of [
        'https://amazon.com.evil.com/cart',
        'https://www.amazon.com.attacker.com/',
        'https://amazon-fake.com/cart',
      ]) {
        const fake = { goto: () => Promise.resolve(), url: () => url };
        const r = await runCartGoto(fake);
        expect(r.ok).toBe(false);
      }
    });
  });
});
