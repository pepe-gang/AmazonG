import type { BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NavigationError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { sanitizeProfileKey } from '../shared/sanitize.js';

export type DriverSession = {
  readonly profile: string;
  readonly context: BrowserContext;
  newPage(): Promise<Page>;
  goto(page: Page, url: string, opts?: { timeoutMs?: number }): Promise<void>;
  content(page: Page): Promise<string>;
  close(): Promise<void>;
};

export type DriverOptions = {
  userDataRoot: string;
  headless: boolean;
};

export async function openSession(profile: string, opts: DriverOptions): Promise<DriverSession> {
  const userDataDir = join(opts.userDataRoot, sanitizeProfileKey(profile));
  await mkdir(userDataDir, { recursive: true });

  // Dynamic import so playwright reads PLAYWRIGHT_BROWSERS_PATH at launch
  // time, not at module load time (ESM hoists static imports before the env
  // var is set in index.ts).
  const { chromium } = await import('playwright');

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: opts.headless,
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: [
        // Silences Chromium's WebAuthn / passkey conditional-UI dialogs that
        // Amazon's sign-in page triggers ("No passkeys available").
        '--disable-features=WebAuthenticationPasskeys,PasskeyAutofill,PasskeyFromAnotherDevice,WebAuthenticationConditionalUI',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|download new browsers/i.test(msg)) {
      const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '(not set)';
      throw new Error(
        `Chromium browser not found. PLAYWRIGHT_BROWSERS_PATH=${browsersPath}. ` +
        'The app may need to be reinstalled — download the latest DMG from the BetterBG setup guide.',
      );
    }
    throw err;
  }

  // esbuild (used by tsx for standalone scripts) emits `__name(fn, "label")`
  // wrappers around named functions to preserve their `.name` property for
  // stack traces. When those wrapped functions are serialized into a
  // `page.evaluate()` call, the browser context has no `__name` global and
  // throws `ReferenceError: __name is not defined`. Production Electron
  // builds don't emit this helper, but the shim is a safe no-op there, so
  // we install it unconditionally.
  await context.addInitScript(() => {
    const g = globalThis as { __name?: unknown };
    if (typeof g.__name === 'undefined') {
      g.__name = <T>(fn: T, _label?: string): T => fn;
    }
  });

  // Stub the WebAuthn JS APIs so Amazon's conditional-mediation call can't
  // surface the Chromium passkey picker even if the flag above misses it.
  await context.addInitScript(() => {
    const stubGet = () =>
      new Promise<null>((resolve) => {
        // resolve null so the site falls back to password login without
        // surfacing a credential-picker dialog
        setTimeout(() => resolve(null), 0);
      });
    try {
      if (navigator.credentials) {
        Object.defineProperty(navigator, 'credentials', {
          configurable: true,
          value: {
            get: stubGet,
            create: () => Promise.reject(new Error('credentials.create disabled')),
            store: () => Promise.reject(new Error('credentials.store disabled')),
            preventSilentAccess: () => Promise.resolve(),
          },
        });
      }
      if (typeof (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined') {
        const PKC = (window as unknown as { PublicKeyCredential: { isConditionalMediationAvailable?: () => Promise<boolean>; isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
        PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
        PKC.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      }
    } catch {
      // best effort — don't break pages if the stub fails
    }
  });

  // Block heavy resources Amazon ships on every PDP / /spc / cart nav
  // that AmazonG never reads:
  //   - image (PNG/JPEG/WebP/GIF): ~50-200 product+rec thumbnails per page
  //   - font: Amazon Ember web fonts (~200KB across weights)
  //   - media: video/audio (never autoplayed in checkout)
  //
  // Cuts ~3-5s off PDP and /spc hydration. SVGs are passed through —
  // they carry semantic icons (Prime badge sprites use background-image
  // PNG, but cashback radio labels and a few buy-box affordances use
  // <img src=".svg"> for the small mark next to the text).
  //
  // The visibility logic in scrapeProduct.runtimeVisibilityChecks reads
  // CSS box dimensions (getBoundingClientRect / getComputedStyle), not
  // image-derived layout, so blocking the sprite PNG doesn't collapse
  // the badge to 0×0 — the <i id="prime-badge"> element still has its
  // CSS-defined width/height. verifyTargetCashback / findCashbackPct
  // read DOM textContent for "% back"; no image dependency.
  //
  // Only browser-page requests pass through this handler. The
  // ctx.request HTTP-only paths (clearCart, search, cart-add, verify,
  // ship-track) use APIRequestContext, which is bypassed.
  //
  // Also block fire-and-forget telemetry / ad-system XHRs that fire on
  // every nav. Verified empirically (2026-05-05 via Playwright MCP):
  //   - fls-na.amazon.com: page-event beacons (img + xhr, response body
  //     unread by page JS)
  //   - unagi.amazon.com:  CSM/nexus client telemetry (beacon + xhr)
  //   - aax-us-iad / aax.amazon-adsystem.com: display-ad auction
  //   - dtm.amazon.com:    cross-domain measurement
  //   - cs.amazon.com:     customer-service widget bootstrap
  // None of these serve JS to the page (no script/link initiator),
  // none are referenced by buy-box DOM nodes, and aborting them
  // (fetch/XHR/sendBeacon/Image) raises zero JS errors on the live
  // PDP. ~16 requests blocked per PDP load on top of ~96 images.
  const BLOCKED_HOSTS =
    /^(?:fls-na|aax-us-iad|unagi|dtm|cs)\.amazon\.com$|^aax\.amazon-adsystem\.com$/i;
  let blockedImageCount = 0;
  let blockedFontCount = 0;
  let blockedMediaCount = 0;
  let blockedHostCount = 0;
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === 'font') {
      blockedFontCount++;
      return route.abort();
    }
    if (type === 'media') {
      blockedMediaCount++;
      return route.abort();
    }
    if (type === 'image' && !/\.svg(?:\?|#|$)/i.test(req.url())) {
      blockedImageCount++;
      return route.abort();
    }
    // Host-based block for telemetry + ad-system requests that come
    // through as xhr/fetch/beacon (so the type-based filters above
    // don't catch them). Wrapped in try/catch since malformed URLs
    // would throw on `new URL` and stall the request.
    try {
      const host = new URL(req.url()).hostname;
      if (BLOCKED_HOSTS.test(host)) {
        blockedHostCount++;
        return route.abort();
      }
    } catch {
      // fall through to continue on unparseable URL
    }
    return route.continue();
  });

  // Playwright's launchPersistentContext always boots with a single
  // about:blank tab. Headless mode never shows it, but in headed
  // mode every work tab the worker opens sits next to a stranded
  // blank, which the user (correctly) finds confusing. Capture the
  // initial blank now and prune it the first time `newPage` is
  // called — by then there's always at least one real page open,
  // so the context stays alive. We compare by reference rather than
  // url so a user who happens to open a manual about:blank tab
  // doesn't get it stomped on.
  const initialPages = context.pages();
  let initialBlank: Page | null =
    initialPages.length === 1 && initialPages[0]?.url() === 'about:blank'
      ? initialPages[0]
      : null;

  return {
    profile,
    context,
    async newPage() {
      const fresh = await context.newPage();
      if (initialBlank && !initialBlank.isClosed()) {
        // Best-effort prune. Errors swallowed: a failure here would
        // just leave the blank visible (the previous behavior),
        // never break the run.
        await initialBlank
          .close({ runBeforeUnload: false })
          .catch(() => undefined);
        initialBlank = null;
      }
      return fresh;
    },
    async goto(page, url, { timeoutMs = 30_000 } = {}) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      } catch (err) {
        throw new NavigationError(url, 'goto failed', err);
      }
    },
    async content(page) {
      return await page.content();
    },
    async close() {
      // Headed Chromium can stall context.close() when a beforeunload
      // dialog is showing, a download is mid-flight, or a credentials
      // prompt is blocking the renderer. Close each page with its own
      // runBeforeUnload=false pre-step so the dialogs are bypassed,
      // then race the final context.close() against a hard timeout so
      // a wedged Chromium can't hang the whole shutdown sequence.
      //
      // Headed Chromium on macOS can take 8-15s to fully exit after
      // a full buy flow (lots of tabs, cookie flush, window animations)
      // — 5s was too aggressive and left windows lingering. Bumped to
      // 20s; when the timeout does fire we log a warning so the
      // leftover window is traceable to a specific profile.
      const CLOSE_TIMEOUT_MS = 20_000;
      await Promise.allSettled(
        context.pages().map((p) => p.close({ runBeforeUnload: false })),
      );
      let timedOut = false;
      const t0 = Date.now();
      await Promise.race([
        context.close().catch((err) => {
          logger.warn('session.close.context.error', {
            profile,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, CLOSE_TIMEOUT_MS),
        ),
      ]);
      if (timedOut) {
        logger.warn('session.close.timeout', {
          profile,
          waitedMs: Date.now() - t0,
          note: 'context.close() did not complete within budget; window may linger',
        });
      } else {
        logger.info('session.close.ok', {
          profile,
          durationMs: Date.now() - t0,
          blockedImages: blockedImageCount,
          blockedFonts: blockedFontCount,
          blockedMedia: blockedMediaCount,
          blockedHosts: blockedHostCount,
        });
      }
    },
  };
}
