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
  //   - telemetry / ad-system hosts (fls-na, unagi, aax-us-iad, dtm,
  //     cs.amazon.com, aax.amazon-adsystem) — fire-and-forget beacons +
  //     XHRs. Empirically verified (2026-05-05) to never serve JS to the
  //     page and to never feed buy-box DOM.
  //
  // Implementation note (CDP migration, see pass-5 research doc):
  // Previously this used context.route('**/*', cb) which IPCs Node↔
  // Chromium per request — every one of ~250+ sub-resources per PDP
  // pays ~1-3ms each, even passes through. CDP Network.setBlockedURLs
  // configures Chromium's network layer ONCE; matching URLs drop
  // pre-renderer with zero per-request IPC. Saves ~500-2000ms per
  // PDP nav on top of the bandwidth/render savings the block intent
  // already provides.
  //
  // SVGs are passed through (no .svg pattern). Buy-box layout is
  // CSS-driven; runtimeVisibilityChecks reads getBoundingClientRect /
  // getComputedStyle which don't depend on image-derived layout. Prime
  // badges (#prime-badge .a-icon-prime) use a background-image sprite
  // that gets blocked here — the <i> element still has its CSS-defined
  // 53×15px box, so isVisible() still returns true. Empirically
  // verified on iPad B0DZ751XN6 + Echo Spot B0BFC7WQ6R.
  //
  // Only browser-page requests pass through CDP. The ctx.request HTTP-
  // only paths (clearCart, search, cart-add, verify, ship-track) use
  // APIRequestContext, a separate request infrastructure that bypasses
  // page-level interception entirely.
  //
  // Per-category counters (blockedImages/Fonts/Media/Hosts) were
  // dropped: the only CDP event carrying URLs is requestWillBeSent,
  // which fires for every request and re-introduces the per-request
  // IPC cost the migration eliminates. We track total blocks via
  // loadingFailed (fires only on blocked + actually-failed requests,
  // ~100/PDP — affordable). For deeper diagnostics, re-enable the
  // requestWillBeSent listener temporarily.
  const BLOCKED_URL_PATTERNS = [
    // Image extensions (covers query-string variants via trailing *).
    // SVG intentionally absent — keeps semantic icons available for
    // any DOM element that depends on them. (Buy-box doesn't, but
    // future-proofing this is cheap.)
    '*.png*', '*.jpg*', '*.jpeg*', '*.webp*', '*.gif*', '*.bmp*', '*.ico*',
    // Font extensions
    '*.woff*', '*.ttf*', '*.otf*', '*.eot*',
    // Media extensions
    '*.mp4*', '*.webm*', '*.mp3*', '*.wav*', '*.ogg*', '*.m3u8*',
    // Telemetry / ad-system hosts (full URL globs; CDP `*` matches any
    // chars including slashes). All empirically verified to not feed
    // buy-box DOM and not serve JS to the page.
    '*://fls-na.amazon.com/*',
    '*://unagi.amazon.com/*',
    '*://unagi-na.amazon.com/*',                    // NA-region telemetry (~299ms)
    '*://aax-us-iad.amazon.com/*',
    '*://aax-us-east-retail-direct.amazon.com/*',   // ad auction
    '*://dtm.amazon.com/*',
    '*://cs.amazon.com/*',
    '*://aax.amazon-adsystem.com/*',
    '*://s.amazon-adsystem.com/*',                  // display ads (~427ms)
    '*://ara.paa-reporting-advertising.amazon/*',   // ad reporting (~207ms)
    '*://pagead2.googlesyndication.com/*',          // Google ads
    '*://d2lbyuknrhysf9.cloudfront.net/*',          // ad-asset CloudFront
    // In-page widgets that fire on PDP (verified empirically) and never
    // feed buy-box DOM. Skipped here (suspect for filler-mode /spc
    // regression — investigate separately):
    //   - cross_border_interstitial_sp/render (FIRES ON /spc per probe)
    //   - cart/ewc/* (mini-cart preview)
    //   - cart/add-to-cart/patc-template* + get-cart-items* (cart widgets)
    '*://www.amazon.com/rufus/cl/*',                // Rufus AI chat (~850ms)
    '*://www.amazon.com/dram/renderLazyLoaded*',    // recommendations (~630ms)
    '*://www.amazon.com/acp/cr-media-carousel/*',   // review images
  ];
  let blockedTotal = 0;
  const attachCdpBlocking = async (page: Page): Promise<void> => {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS });
      cdp.on('Network.loadingFailed', (ev) => {
        if (ev.errorText === 'net::ERR_BLOCKED_BY_CLIENT') {
          blockedTotal++;
        }
      });
    } catch (err) {
      // CDP attach failed — page loads normally without blocking.
      // Worst case: more CPU/bandwidth used, no functional break.
      // Logged once per failed page so production traffic surfaces it.
      logger.warn('driver.cdp.block.attach.failed', {
        profile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Attach to every page that exists OR is created in this context.
  // The 'page' event fires for newPage() AND popup-opened tabs but NOT
  // for the initial about:blank that launchPersistentContext spawns —
  // so we attach to current pages explicitly + listen for future ones.
  for (const p of context.pages()) {
    void attachCdpBlocking(p);
  }
  context.on('page', (p) => {
    void attachCdpBlocking(p);
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
          blockedTotal,
        });
      }
    },
  };
}
