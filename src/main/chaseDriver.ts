import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import type { ChaseAccountSnapshot } from '../shared/types.js';
import { chaseProfileDir, chaseSessionStatePath } from './chaseProfiles.js';
import { getChaseCredentials } from './chaseCredentials.js';
import {
  isChaseAuthPromptUrl,
  parseInProcessPaymentsFromHtml,
  parsePendingChargesFromHtml,
} from './chaseScrape.js';
import { STAGE_C_IN_PAGE_HELPERS_SRC } from './chaseStageCInPageHelpers.js';
import {
  mapBillpayActivitiesToInProcess,
  mapPaymentDetailToInProcess,
  type StageCBillpayActivity,
  type StageCPaymentDetail,
} from './chaseStageCMapping.js';
import { validateStageCOverviewShape } from './chaseStageCSentinel.js';
import type { ChasePaymentEntry } from '../shared/types.js';

export type ChaseSession = {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

/**
 * Redact a Chase cardAccountId for log payloads. Combined with a
 * user-chosen profile label, the full 9-digit account id is identifying
 * — not the card number per se, but enough to pin a record to a person
 * in any leaked debug log. Pass-4 audit #9. Last 4 digits is the
 * standard banking redaction.
 */
function redactCardId(id: string): string {
  if (!id) return '';
  return id.length <= 4 ? id : `…${id.slice(-4)}`;
}

export type ChaseRedeemResult =
  | {
      ok: true;
      /** Chase confirmation reference, e.g. "SC13-VNNNG-KCKH". Empty
       *  string when the redemption posted but the success-page scrape
       *  couldn't locate it (the credit still posts; only display
       *  text is missing). */
      orderNumber: string;
      /** Dollar amount applied as statement credit, e.g. "$704.73".
       *  Empty if not scrapable. */
      amount: string;
      /** Original textbox value at submit time — what the user
       *  effectively asked Chase to redeem. e.g. "$704.73". */
      pointsRedeemed: string;
    }
  | {
      ok: false;
      /** kind:'no_points' is informational ("nothing to redeem"), not
       *  an actual failure — the renderer surfaces it in a neutral
       *  banner. kind:'error' is anything else and renders red. */
      kind: 'no_points' | 'error';
      reason: string;
    };

/**
 * Open a Chrome window for one Chase profile. The user-data dir at
 * userData/chase-profiles/{id}/ is the durable session store —
 * Playwright's launchPersistentContext writes cookies, localStorage,
 * IndexedDB, and any "remember this device" flags Chase sets in
 * there, and they survive both context.close() (after a successful
 * login probe) and the app process exiting. Next launch reuses the
 * same dir, Chase reads the cookies, and the user usually skips
 * straight to the dashboard without retyping credentials. They'll
 * only re-2FA when Chase decides the session has expired or they're
 * on a new device — same as the chase.com web UX.
 *
 * Notable differences from the Amazon driver:
 *
 *   - headless defaults to false (the whole point of the manual login
 *     flow is the user typing credentials). Background flows can opt
 *     into headless via the option flag once the session is warm.
 *   - No WebAuthn stubs. Chase uses passkeys / security keys for
 *     MFA, and the Amazon driver's stubs would block them.
 *   - Default user agent — don't spoof. Banks fingerprint UAs and a
 *     custom one is more likely to trigger extra challenges than to
 *     evade them.
 */
export type ChaseSessionOptions = {
  /**
   * When true, every page in the session gets an injected fixed
   * banner that auto-shows whenever the URL is the post-login
   * dashboard overview. Tells the user to click into their Amazon
   * card to finish the link flow. Used by the login handler — not
   * by the redeem-rewards flow (where the banner would just be
   * noise since there's nothing to click for the user).
   */
  showLinkAmazonBanner?: boolean;
};

export async function openChaseSession(
  profileId: string,
  options: ChaseSessionOptions = {},
): Promise<ChaseSession> {
  const userDataDir = chaseProfileDir(profileId);
  await mkdir(userDataDir, { recursive: true });

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    // --disable-blink-features=AutomationControlled hides the Blink
    // "automation controlled" flag that bot detectors check via CDP.
    // Without it, Chase's automation-detection refuses to issue
    // persistent session cookies — net effect is "session never
    // saves." Other args skip first-launch interstitials so a fresh
    // userDataDir comes up clean.
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  // navigator.webdriver === true in Playwright-launched Chrome even
  // visible. Banking sites flag it; the stub is cheap and harmless.
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch {
      // best-effort — some pages freeze the property
    }
  });

  // CDP URL blocklist for Chase. Mirrors the Amazon driver's pattern
  // (src/browser/driver.ts:140-263). Pass-4 + pass-7 research +
  // empirical capture (2026-05-08) vetted every entry as safe — none
  // touch Akamai Bot Manager's sensor pipeline (which lives at
  // secure.chase.com/auth/fcc/adaptive + _abck/bm_* cookies) or any
  // load-bearing SPA JS/CSS bundles.
  //
  // Total estimated saving: ~250KB bandwidth + 30+ XHRs eliminated
  // from hydration contention window per fetch + ~100-300ms wall-clock.
  //
  // DO NOT add to this list:
  //   secure.chase.com/svc/wl/auth/*  Akamai sensor lifeline
  //   secure.chase.com/auth/fcc/*     Akamai sensor lifeline
  //   asset.chase.com/*               JS bundles (SPA won't render)
  //   static.chase.com/content/pq/*   CMS page fragments
  //   static.chasecdn.com/splitio/*   Feature-flag SDK (SPA throws on miss)
  //   chaseloyalty.chase.com/public/* Loyalty SPA bundles
  //   chaseloyalty.chase.com/rest/common/*  Loyalty config
  //   chaseloyalty.chase.com/rest/cash-back/*  Redemption form data
  //   secure.chase.com/svc/rl/.../dashboard/module/list  Stage B
  //   secure.chase.com/svc/rr/.../rewards/v2/summary/list  Stage B
  //   secure.chase.com/svc/rr/.../menu/list  keepalive ping target
  const BLOCKED_URL_PATTERNS_CHASE = [
    // ────── Already shipped, verified blocked via empirical capture ──────
    // Akamai mPulse RUM config endpoint. Separate product from Akamai
    // Bot Manager. Fires at +53ms (early hydration).
    '*://c.go-mpulse.net/*',
    // Companion mPulse host serving the actual boomerang.js library
    // (~60KB × 2 fires = ~120KB). The c.go-mpulse block above kills
    // the config init but boomerang.js itself loads from s2.go-mpulse;
    // blocking both completes the mPulse uninstall.
    '*://s2.go-mpulse.net/*',
    // Chase self-hosted Adobe Analytics ingestion. 16+ fire-and-forget
    // beacons per fetch, all 0-byte responses, fires throughout the
    // +157-3063ms contention window.
    '*://analytics.chase.com/*',
    // Recommendations beacons. Fires post-data XHRs, so blocking
    // has near-zero wall-clock cost, just cleans the tail.
    '*://reco.chase.com/*',

    // ────── Tier 1 — analytics/RUM/decoration (zero risk) ──────
    // Google Fonts (Open Sans woff2). Decorative typography only;
    // Chase has system-font fallbacks that look fine. ~85KB saved
    // (14KB × 6 fires).
    '*://fonts.gstatic.com/*',
    // Chase Offers ad images. ~10KB; AmazonG never displays.
    '*://chaseoffers.chase.com/*',
    // Adobe Tag Manager extensions library.
    '*://www.chase.com/apps/chase/clientlibs/foundation/tagmanagerextensions.js',
    // Adobe Analytics reporting library.
    '*://www.chase.com/apps/chase/clientlibs/foundation/scripts/Reporting.js',
    // CCPA reporting percentage config.
    '*://www.chase.com/etc/chase/appsconfig/clientconfig.ccpa*',
    // Feedback survey widget (UI Voice of Customer).
    '*://www.chase.com/etc/designs/chase-ux/clientlibs/chase-ux/js/survey/*',
    // NOT blocking `/apps/services/tagmanager/*` — empirical 2026-05-08
    // user report after I shipped that block: 2/4 parallel cards
    // failed to fetch in-process payments. The activity page fires
    // `/apps/services/tagmanager/cpo/payBills/creditCardPayment/
    // creditCardPaymentActivity`, and despite the response being just
    // a 42-byte tag-manager ID, blocking it appears to gate the
    // SPA's payments-module init on some race-condition path.
    // Removed pre-emptively until we can isolate exactly which
    // tagmanager subpath is safe (probably none on the activity
    // page; possibly safe on /summary). Saves nearly nothing
    // anyway — these responses are 42-byte beacons.
    // 1×1 analytics tracking pixel.
    '*://secure.chase.com/events/analytics/public/v1/cc.gif',
    // chaseloyalty-side analytics wrapper.
    '*://chaseloyalty.chase.com/web-analytics/*',

    // ────── Tier 2 — decorative imagery (zero render risk) ──────
    // Credit-card-art renderings (PNG previews of the Chase card face).
    '*://*.chasecdn.com/content/services/rendition/image.*/unified-assets/digital-cards/*',
    // Marketing illustrations + DAM (Digital Asset Management) graphics.
    '*://sites.chase.com/content/dam/*',
    // Marketing image renditions on sites.chase.com.
    '*://sites.chase.com/content/services/rendition/*',
    // Chase brand logos (decorative, multiple variants).
    '*://*.chasecdn.com/content/dam/unified-assets/logo/*',
    // Cookie consent banner config (we never display the banner).
    '*://www.chase.com/content/dam/consent-banner/*',
  ];
  const attachCdpBlocking = async (p: Page): Promise<void> => {
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS_CHASE });
    } catch (err) {
      // CDP attach failed — page loads normally without blocking.
      // Worst case: more bandwidth used, no functional break.
      logger.warn('chase.cdp.block.attach.failed', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  for (const existingPage of context.pages()) {
    void attachCdpBlocking(existingPage);
  }
  context.on('page', (newPage) => {
    void attachCdpBlocking(newPage);
  });

  // Full-capture mode: when AUTOG_CHASE_FULL_CAPTURE=1, log every
  // request + response (ALL resource types — xhr, fetch, image, font,
  // script, stylesheet, document, etc.) across the entire context.
  // Used to audit blocklist candidates: tells us exactly what fires on
  // each Chase page so we can identify load-bearing vs noise URLs.
  // Different from AUTOG_CHASE_XHR_CAPTURE (which only logs xhr/fetch
  // and only on the snapshot fetch path).
  if (process.env.AUTOG_CHASE_FULL_CAPTURE === '1') {
    void attachChaseFullCapture(context, profileId);
  }

  // Restore cookies + origin storage from the previous session, if
  // any. launchPersistentContext's SQLite store drops session
  // cookies on close — but Chase issues auth as session cookies —
  // so without this restore the user effectively starts logged out
  // every relaunch. We capture full storageState() to disk before
  // close (see ChaseSession.close below) and feed it back here.
  // Cookies idempotently overwrite anything Chromium already
  // restored from its own store.
  //
  // Origin localStorage matters for "remember this device": Chase
  // stores its long-lived device-trust token there (not in cookies),
  // so without restoring it every fresh session looks like a new
  // device → Chase forces re-auth. We use addInitScript per-origin
  // so the values are bootstrapped before any of Chase's own
  // scripts run, with a `getItem`-guard so we don't clobber values
  // Chase has updated within the live session.
  try {
    const raw = await readFile(chaseSessionStatePath(profileId), 'utf8');
    const state = JSON.parse(raw) as {
      cookies?: Array<Parameters<BrowserContext['addCookies']>[0][number]>;
      origins?: Array<{
        origin: string;
        localStorage?: Array<{ name: string; value: string }>;
      }>;
    };
    // Restore EVERY cookie from the snapshot, including Akamai's
    // bot-management cookies (_abck, bm_sz, ak_bmsc, bm_sv).
    //
    // History: pass-3 research hypothesized that filtering out the
    // Akamai cookies would help — the theory was that the embedded
    // sensor digest in _abck might mismatch a new Chromium process's
    // TLS state and cause invalidation. We shipped a filter on
    // 2026-05-07 to test the hypothesis. **Empirically it made
    // sessions WORSE** — the user reported re-auth within ~20 min
    // of session start (vs. previously next-day). Reverted.
    //
    // The likely real story: Akamai's cookies rotate continuously
    // during a live session and our auto-save persists the most
    // recent values. Restoring them on the next launch keeps the
    // device-trust signal intact even if the embedded digest is a
    // few minutes stale — Chase/Akamai accept the staleness for a
    // window. Removing the cookies forced Akamai to mint fresh on
    // every launch, which appears to mark the session as "new
    // device" and shortens its TTL.
    //
    // The "session works yesterday, dead today" issue we were
    // trying to fix is probably just normal Chase server-side
    // session expiry, not anything we control client-side. Live
    // with it.
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
    }
    let restoredKeys = 0;
    const initParts: string[] = [];
    for (const origin of state.origins ?? []) {
      if (!origin.localStorage || origin.localStorage.length === 0) continue;
      const setStmts = origin.localStorage
        .map((item) => {
          // Guard: only set if missing. Chase may have updated this
          // key earlier in the live session and we don't want to
          // roll it back to the on-disk snapshot's stale value.
          return (
            `if (localStorage.getItem(${JSON.stringify(item.name)}) === null) ` +
            `localStorage.setItem(${JSON.stringify(item.name)}, ${JSON.stringify(
              item.value,
            )});`
          );
        })
        .join('');
      restoredKeys += origin.localStorage.length;
      initParts.push(
        `if (location.origin === ${JSON.stringify(origin.origin)}) { ` +
          `try { ${setStmts} } catch (e) { /* private mode / quota */ } ` +
          `}`,
      );
    }
    if (initParts.length > 0) {
      await context.addInitScript({ content: initParts.join('\n') });
    }
    logger.info('chase.session.stateRestored', {
      profileId,
      cookies: state.cookies?.length ?? 0,
      origins: state.origins?.length ?? 0,
      localStorageKeys: restoredKeys,
    });
  } catch (err) {
    // No state file yet (first launch) or unparseable. Either way,
    // fall through — Chromium's own persistence handles the rest.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('chase.session.stateRestore.error', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Diagnostic snapshot at session open. Three signals to triangulate
  // session-persistence problems:
  //
  //   filesInDir       0 across runs → the userDataDir is being recreated
  //                    empty on every launch (filesystem / app.setName /
  //                    permissions issue). >0 = Chrome's profile is
  //                    actually surviving on disk.
  //   cookiesAtOpen    0 after a successful prior login → cookies
  //                    aren't reaching the SQLite store. Chrome wrote
  //                    session-only cookies that got dropped, or the
  //                    flush didn't happen before app exit.
  //   userDataDir      visible in the log so the user can ls + verify
  //                    it's the same path across runs (sanity check
  //                    that app.getPath('userData') is stable).
  try {
    const [cookies, files] = await Promise.all([
      context.cookies(),
      readdir(userDataDir).catch(() => [] as string[]),
    ]);
    logger.info('chase.session.open', {
      profileId,
      userDataDir,
      cookiesAtOpen: cookies.length,
      filesInDir: files.length,
    });
  } catch {
    logger.info('chase.session.open', { profileId, userDataDir });
  }

  if (options.showLinkAmazonBanner) {
    // Init script runs in every page (and every navigation that
    // triggers a fresh document load) inside this context. We
    // attach a self-managing banner that shows / hides based on
    // location.href so the user gets guidance exactly when they
    // need it — on the dashboard overview — and never sees it
    // anywhere else (sign-in page, MFA challenge, the card summary
    // they're navigating to). Pure DOM manipulation, no cookie
    // reads, no network — minimum surface inside a sensitive bank
    // origin.
    await context.addInitScript(() => {
      const BANNER_ID = '__amazong_chase_link_banner';
      const OVERVIEW_RE = /\/dashboard#\/dashboard\/overview/;

      const ensure = (): void => {
        if (document.getElementById(BANNER_ID)) return;
        if (!document.body) return;
        const el = document.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'status');
        el.innerHTML =
          '<div style="font-weight:600;margin-bottom:4px">AmazonG &middot; almost there</div>' +
          '<div style="opacity:0.85">Click into your Amazon credit card below to finish linking. AmazonG will close this window automatically once it sees the card&rsquo;s summary page.</div>';
        el.style.cssText = [
          'position:fixed',
          'top:16px',
          'left:50%',
          'transform:translateX(-50%)',
          'z-index:2147483647',
          'background:linear-gradient(135deg,#1d4ed8 0%,#4f46e5 100%)',
          'color:#fff',
          'padding:12px 18px',
          'border-radius:10px',
          'font-family:system-ui,-apple-system,sans-serif',
          'font-size:13px',
          'line-height:1.4',
          'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
          'border:1px solid rgba(255,255,255,0.15)',
          'max-width:460px',
          'text-align:center',
          'pointer-events:none', // can't intercept clicks on Chase UI
        ].join(';');
        document.body.appendChild(el);
      };

      const update = (): void => {
        ensure();
        const el = document.getElementById(BANNER_ID);
        if (!el) return;
        el.style.display = OVERVIEW_RE.test(location.href) ? '' : 'none';
      };

      // Set up after the DOM is parseable. document.body is null
      // when the init script runs in <head>, so wait for it.
      if (document.body) {
        update();
      } else {
        document.addEventListener('DOMContentLoaded', update, { once: true });
      }
      // Hash routes don't fire framenavigated reliably on the main
      // process side, but in-page hashchange / popstate / pushState-
      // chained navigations are observable from JS. Plus a low-rate
      // poll as a last-resort safety net (some SPAs swap content
      // without any of the above firing).
      window.addEventListener('hashchange', update);
      window.addEventListener('popstate', update);
      setInterval(update, 750);
    });
  }

  // Reuse the initial about:blank tab Playwright opens with the
  // persistent context rather than spawning a second one alongside it.
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  return {
    context,
    page,
    close: async () => {
      // Dump full storageState to disk BEFORE close — this is the
      // critical persistence path. context.cookies() returns the
      // live in-memory cookie jar (session + persistent both);
      // storageState() also captures origin localStorage. Writing
      // to a JSON file keeps everything around session cookies
      // included, which Chromium's own SQLite would otherwise
      // drop on close. The next openChaseSession call reads this
      // file and re-injects via addCookies.
      try {
        await context.storageState({
          path: chaseSessionStatePath(profileId),
          // Capture IndexedDB too — Playwright defaults to cookies +
          // localStorage only and silently drops IDB. If Chase persists
          // ANY device-trust JWT or auth state in IDB, the missing
          // capture would force a re-mint on every relaunch. Cheap
          // insurance even if unused.
          indexedDB: true,
        });
      } catch (err) {
        logger.warn('chase.session.stateSave.error', {
          profileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Sanity check log — how many cookies Chase issued to this
      // context. If 0 after a login flow, the user didn't actually
      // finish signing in (or anti-bot detection rejected cookies).
      try {
        const cookies = await context.cookies();
        logger.info('chase.session.cookies', {
          profileId,
          count: cookies.length,
        });
      } catch {
        // context might already be closing — non-fatal.
      }
      // Brief grace period before close. Some Chromium builds
      // batch cookie writes to the persistent SQLite store on a
      // short interval; tearing the context down within
      // milliseconds of the last navigation can drop the tail.
      // 500ms is plenty for a flush and barely perceptible to the
      // user.
      await new Promise((r) => setTimeout(r, 500));
      // Best-effort — context.close() can throw if the user closed
      // the window already, but the caller has nothing useful to do
      // with that error so swallow it.
      await context.close().catch((err) => {
        logger.warn('chase.session.close.error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  };
}

/**
 * Save a screenshot of the current page to userData/chase-snapshot-debug/
 * for after-the-fact triage when a snapshot scrape comes back empty.
 * Best-effort — silently swallows any error (often because the page is
 * mid-navigation when we try). Filename includes profile id + ISO
 * timestamp so we can match it to the warn log line.
 */
async function captureSummaryDebugSnapshot(
  page: Page,
  profileId: string,
): Promise<void> {
  const dir = join(app.getPath('userData'), 'chase-snapshot-debug');
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${profileId}-${ts}.png`);
  // Viewport-only screenshot. Full-page would re-render off-screen
  // content (which on Chase's heavy SPA can scroll for thousands of
  // pixels of marketing modules) and cost an extra 100-300ms. The
  // recon-bar + any auth-prompt overlay we're trying to diagnose are
  // both above the fold; viewport is enough.
  await page.screenshot({ path: file });
  logger.info('chase.snapshot.debugCaptured', { profileId, file });
}

/**
 * Periodic + navigation-driven storageState save for the user-driven
 * windows (Pay my Balance, Open Rewards). Solves "Chase keeps logging
 * out" — those flows let the user close the Chrome window directly,
 * which fires context.on('close') AFTER the context is torn down,
 * which means session.close()'s storageState dump is too late. Without
 * this, every cookie/localStorage update Chase makes during the
 * session is lost on close (Chromium's SQLite drops session cookies,
 * and our JSON snapshot stays at whatever it was on the previous
 * graceful close).
 *
 * Strategy:
 *   - Hook page.framenavigated (mainframe only) so we save on every
 *     real navigation. Coalesced to 2s so login redirect storms don't
 *     thrash the disk.
 *   - 60s safety-net interval for the user-idles-on-one-page case.
 *
 * Returns a teardown function the caller MUST call when the session
 * is being closed (otherwise the interval keeps firing against a
 * closed context, which is harmless but spams logs).
 */
export function attachSessionAutoSave(
  session: ChaseSession,
  profileId: string,
): () => void {
  let stopped = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = async (): Promise<void> => {
    if (stopped) return;
    try {
      await session.context.storageState({
        path: chaseSessionStatePath(profileId),
        // Same IDB-capture rationale as openChaseSession's close-time
        // dump above — Playwright's default storageState skips IDB,
        // which would silently drop any device-trust state Chase keeps
        // there. Capture it so the next session restore is complete.
        indexedDB: true,
      });
    } catch {
      // Context closed mid-save — fine, the teardown will fire
      // momentarily. Swallow so we don't surface noise.
    }
  };
  const scheduleSave = (): void => {
    if (saveTimer || stopped) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, 2_000);
  };
  const onFrameNavigated = (frame: { parentFrame: () => unknown | null }): void => {
    // Mainframe only — Chase's login form lives in an iframe and
    // its internal navigations are noise we don't need to save on.
    if (frame.parentFrame() === null) scheduleSave();
  };
  session.page.on('framenavigated', onFrameNavigated);
  const interval = setInterval(() => void flush(), 60_000);
  return () => {
    stopped = true;
    if (saveTimer) clearTimeout(saveTimer);
    clearInterval(interval);
    try {
      session.page.off('framenavigated', onFrameNavigated);
    } catch {
      // page might already be gone
    }
  };
}

/**
 * Fully-automated cash-back redemption. Converts every available
 * rewards point on the profile's tracked card into a statement
 * credit on the same card. Window stays visible the entire time so
 * the user can watch the flow and step in if Chase decides to
 * 2FA-challenge — we don't headless this on purpose.
 *
 * Mirrors the manual Chase web flow exactly:
 *   1. /home?AI={id}              set active card
 *   2. /cash-back                 open the redemption form (Chase
 *                                 pre-fills the dollar textbox with
 *                                 the max balance, so we never type
 *                                 a number — we just confirm the
 *                                 leftmost statement-credit checkbox)
 *   3. click Continue             → /cash-back/confirm
 *   4. click Submit               → /cash-back/success
 *   5. scrape order number + amount from the success page
 *
 * Per the user's directive ("no matter the card number, always click
 * the leftmost card"), the checkbox locator is scoped to the
 * "Redeem for a statement credit" group and picks index 0 — works
 * across cards regardless of which card number Chase shows.
 */
export async function redeemAllToStatementCredit(
  profileId: string,
  cardAccountId: string,
): Promise<ChaseRedeemResult> {
  const session = await openChaseSession(profileId);
  // Resilience to force-quits — see fetchChaseAccountSnapshot for why.
  const stopAutoSave = attachSessionAutoSave(session, profileId);
  let result: ChaseRedeemResult;
  try {
    result = await runRedeemFlow(session.page, profileId, cardAccountId);
  } catch (err) {
    result = {
      ok: false,
      kind: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.ok) {
    logger.info('chase.redeem.ok', {
      profileId,
      cardAccountId: redactCardId(cardAccountId),
      pointsRedeemed: result.pointsRedeemed,
      amount: result.amount,
      orderNumber: result.orderNumber,
    });
  } else {
    logger.warn('chase.redeem.failed', {
      profileId,
      cardAccountId: redactCardId(cardAccountId),
      reason: result.reason,
    });
  }
  // Brief pause so the user can read the success/error screen
  // before the window vanishes. 2.5s feels intentional, not jittery.
  await new Promise((r) => setTimeout(r, 2_500));
  stopAutoSave();
  await session.close();
  return result;
}

/**
 * Outcome of an auto-login attempt:
 *   - 'ok'              we filled creds and Chase let us in
 *   - 'otp_required'    Chase landed us on an OTP / identity-
 *                       verification page; user has to step in
 *   - 'no_login_form'   the page never showed a recognizable login
 *                       form (already signed in, or unknown layout)
 *   - 'error'           selectors couldn't be found / Sign in
 *                       didn't resolve / wrong password
 */
export type ChaseAutoLoginOutcome =
  | { kind: 'ok' }
  | { kind: 'otp_required' }
  | { kind: 'no_login_form' }
  | { kind: 'error'; reason: string };

/**
 * Fill Chase's username + password form using saved credentials,
 * tick "Remember username", click Sign in, wait for navigation
 * away from the logon screen. Returns a structured outcome so
 * callers can decide whether to retry the higher-level flow
 * (`ok`), bail and ask the user to step in (`otp_required`), or
 * surface an error.
 *
 * The form lives inside an `<iframe id="logonbox">` on
 * secure.chase.com — the parent document only carries chrome.
 * Selectors discovered via MCP inspection:
 *   #userId-input-field-input    (text input, name=username)
 *   #password-input-field-input  (password input, name=password)
 *   #rememberMe                  (checkbox — "Remember username")
 *   #signin-button               (submit)
 */
export async function attemptChaseAutoLogin(
  page: Page,
  creds: { username: string; password: string },
): Promise<ChaseAutoLoginOutcome> {
  // The login form ships in two layouts:
  //   1. Inside an iframe#logonbox overlay (typical when Chase
  //      keeps the SPA on /dashboard/overview and pops a modal).
  //   2. On a full /logon page with the form directly in the
  //      parent document (typical for first-time / cold loads
  //      that bounced through the redirect).
  // We try iframe first (more common in steady-state); if that
  // doesn't resolve quickly, fall back to the parent document.
  // Both layouts use the same field ids.
  type Scope = {
    locator: (sel: string) => ReturnType<Page['locator']>;
    waitForLogonGone: () => Promise<void>;
  };
  // Race the two layouts instead of probing sequentially — Chase
  // serves the full-page /logon variant on cold loads where no
  // iframe will ever appear, so a sequential probe wastes the full
  // iframe-timeout before trying the direct selector. Promise.any
  // resolves with the first FULFILLED probe (rejections are
  // ignored), and only throws if both reject — exactly the
  // semantics we want. 10s upper bound covers Chase's slowest
  // observed cold-render.
  let winner: 'iframe' | 'direct';
  try {
    winner = await Promise.any([
      page
        .locator('iframe#logonbox')
        .waitFor({ state: 'attached', timeout: 10_000 })
        .then(() => 'iframe' as const),
      page
        .locator('#userId-input-field-input')
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => 'direct' as const),
    ]);
  } catch {
    return { kind: 'no_login_form' };
  }
  let scope: Scope;
  if (winner === 'iframe') {
    const frame = page.frameLocator('iframe#logonbox');
    scope = {
      locator: (sel) => frame.locator(sel) as unknown as ReturnType<Page['locator']>,
      // Iframe layout — success = iframe detaches.
      waitForLogonGone: () =>
        page
          .locator('iframe#logonbox')
          .waitFor({ state: 'detached', timeout: 30_000 }),
    };
  } else {
    scope = {
      locator: (sel) => page.locator(sel),
      // Full-page layout — success = URL leaves /logon.
      waitForLogonGone: () =>
        page.waitForURL(
          (url) => !/\/logon/i.test(url.toString()),
          { timeout: 30_000 },
        ),
    };
  }

  const userField = scope.locator('#userId-input-field-input');
  const passField = scope.locator('#password-input-field-input');
  try {
    await userField.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    logger.warn('chase.autoLogin.usernameNotVisible');
    return { kind: 'no_login_form' };
  }

  // Clear + type per-character. Typing instead of fill() because
  // Chase has anti-paste handlers, and per-character delays make
  // bot-detection scoring more lenient. Skip the clear when:
  //   - Chase has already pre-filled the right username (via
  //     "Remember username") — fill('') can re-populate via
  //     autofill listener and waste keystrokes
  //   - The field is already empty (typical on a fresh /logon nav)
  //     — CMD+A + Backspace on an empty field is two CDP round-trips
  //     of pure overhead, ~100ms
  try {
    const currentUser = await userField.inputValue({ timeout: 2_000 }).catch(() => '');
    if (currentUser !== creds.username) {
      await userField.click({ force: true, timeout: 5_000 });
      // Only clear when there's actually something to clear —
      // saves ~100ms on the typical fresh-nav case where the
      // field is empty.
      if (currentUser.length > 0) {
        await userField.press('ControlOrMeta+a').catch(() => undefined);
        await userField.press('Backspace').catch(() => undefined);
      }
      await userField.type(creds.username, { delay: 35 });
      logger.info('chase.autoLogin.typedUsername', {
        usernameLen: creds.username.length,
        clearSkipped: currentUser.length === 0,
      });
    } else {
      logger.info('chase.autoLogin.usernamePrefilled');
    }
    await passField.waitFor({ state: 'visible', timeout: 5_000 });
    await passField.click({ force: true, timeout: 5_000 });
    // Same empty-field-skip optimization for password. Password
    // fields are almost always empty on a fresh /logon nav, so
    // this saves ~100ms in the typical case.
    const currentPass = await passField.inputValue({ timeout: 1_500 }).catch(() => '');
    if (currentPass.length > 0) {
      await passField.press('ControlOrMeta+a').catch(() => undefined);
      await passField.press('Backspace').catch(() => undefined);
    }
    await passField.type(creds.password, { delay: 35 });
    logger.info('chase.autoLogin.typedPassword', {
      passwordLen: creds.password.length,
      clearSkipped: currentPass.length === 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('chase.autoLogin.fillError', { error: msg });
    return {
      kind: 'error',
      reason: `Could not fill login fields: ${msg}`,
    };
  }

  // Tick "Remember username". Best-effort — keeps the username
  // pre-filled on the next /logon bounce.
  //
  // Tight timeouts: this whole block is best-effort decoration on
  // the auto-login path. If Chase ships a UI variant without the
  // checkbox (or it takes >300ms to attach), bailing fast is much
  // better than burning seconds. Was 1500ms (probe) + 3000ms × 2
  // (check + click fallback) = up to 7.5s of auto-login time on
  // checkbox-absent variants. Now: 300ms attach probe + 800ms
  // check, only ~1s upper bound.
  try {
    const rememberMe = scope.locator('#rememberMe');
    const attached = await rememberMe
      .waitFor({ state: 'attached', timeout: 300 })
      .then(() => true)
      .catch(() => false);
    if (attached) {
      const already = await rememberMe.isChecked({ timeout: 500 }).catch(() => false);
      if (!already) {
        await rememberMe.check({ force: true, timeout: 800 }).catch(() =>
          rememberMe.click({ force: true, timeout: 800 }).catch(() => undefined),
        );
      }
    }
  } catch {
    // best-effort — proceed even if the checkbox isn't there
  }

  // Click Sign in.
  try {
    await scope
      .locator('#signin-button')
      .click({ force: true, timeout: 5_000 });
    logger.info('chase.autoLogin.signinClicked');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('chase.autoLogin.signinClickFailed', { error: msg });
    return {
      kind: 'error',
      reason: `Could not click Sign in: ${msg}`,
    };
  }

  // Wait for the logon overlay/page to go away. The condition
  // differs per layout — scope.waitForLogonGone abstracts it.
  try {
    await scope.waitForLogonGone();
    logger.info('chase.autoLogin.logonGone');
  } catch {
    logger.warn('chase.autoLogin.logonStillPresent', { url: page.url() });
    // logon still present — fall through to the post-checks below
  }

  // If the parent URL now matches an auth-prompt pattern (Chase
  // pushed us into identity-verification etc), we need the user.
  if (isChaseAuthPromptUrl(page.url())) {
    return { kind: 'otp_required' };
  }
  // If the iframe is still present after the wait, surface that
  // as a credential / OTP issue so the user knows to step in.
  const stillThere = await page
    .locator('iframe#logonbox')
    .count()
    .catch(() => 0);
  if (stillThere > 0) {
    return {
      kind: 'error',
      reason:
        "Sign-in submitted but Chase's logon overlay is still up — credentials may be wrong, or Chase wants OTP. Click Login on the Bank panel and finish manually.",
    };
  }
  return { kind: 'ok' };
}

/**
 * Common recovery path used by every background automation
 * (snapshot, redeem, pay) when a navigation lands on Chase's
 * /logon (session expired) or 2FA prompt URL. If we have saved
 * credentials AND we're on /logon, run attemptChaseAutoLogin and
 * report back. Otherwise (no creds, OTP-style URL, login failed)
 * return a structured reason the caller surfaces to the user.
 *
 * Headless concern: when the OS keychain returns OTP-required
 * after auto-login, the user has no visible window to clear it
 * in. We surface that explicitly so the renderer can prompt them
 * to flip headless off and click Login manually.
 */
export type ChaseAuthRecovery =
  | { recovered: true }
  | { recovered: false; reason: string; otpRequired?: boolean };

export async function maybeAutoLoginAndContinue(
  page: Page,
  profileId: string,
): Promise<ChaseAuthRecovery> {
  // Two possible "auth needed" states:
  //   1. URL itself is /logon, /identity-verification, etc.
  //   2. URL is /dashboard/* but Chase has overlaid a #logonbox
  //      iframe asking us to re-auth. This is the more common case
  //      after a session expires — the SPA stays on the dashboard
  //      hash route, just with a modal overlay.
  // Settle window: Chase sometimes flips between /dashboard and
  // /logon during the redirect dance and the iframe takes a beat
  // to attach. Poll for ~1.5s before concluding "nothing to do".
  const detectAuthSignal = async (): Promise<{
    urlIndicatesAuth: boolean;
    overlayPresent: boolean;
  }> => ({
    urlIndicatesAuth: isChaseAuthPromptUrl(page.url()),
    overlayPresent:
      (await page.locator('iframe#logonbox').count().catch(() => 0)) > 0,
  });
  // Pre-fetch creds in parallel with the auth-signal probe. Keychain
  // access on macOS can take 50-200ms; doing it during the 1.5s
  // settle window means by the time we know we need creds, they're
  // already in hand. On the hot path (no auth signal), the cred read
  // is wasted work — but it's a single keychain read, not network,
  // and it's overlapped with a wall-clock wait we'd be doing anyway.
  const credsPromise = getChaseCredentials(profileId).catch(() => null);
  let { urlIndicatesAuth, overlayPresent } = await detectAuthSignal();
  if (!urlIndicatesAuth && !overlayPresent) {
    // Brief poll — Chase's logon overlay can take a second to attach
    // after the navigation reports complete.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const sig = await detectAuthSignal();
      if (sig.urlIndicatesAuth || sig.overlayPresent) {
        urlIndicatesAuth = sig.urlIndicatesAuth;
        overlayPresent = sig.overlayPresent;
        break;
      }
    }
  }
  if (!urlIndicatesAuth && !overlayPresent) {
    // Not actually on a logon / OTP page — nothing to recover from.
    return { recovered: true };
  }
  logger.info('chase.autoLogin.signal', {
    profileId,
    urlIndicatesAuth,
    overlayPresent,
    url: page.url(),
  });
  const creds = await credsPromise;
  if (!creds) {
    return {
      recovered: false,
      reason: 'Session expired or 2FA needed — re-login from the Bank panel and try again.',
    };
  }
  // If the URL is an OTP / identity-verification path (no iframe
  // expected, just a full Chase page), we can't auto-fill — user
  // must step in.
  if (urlIndicatesAuth && !/\/logon/i.test(page.url()) && !overlayPresent) {
    return {
      recovered: false,
      otpRequired: true,
      reason: 'Chase needs identity verification. Click Login on the Bank panel and complete the prompt manually.',
    };
  }
  const outcome = await attemptChaseAutoLogin(page, creds);
  switch (outcome.kind) {
    case 'ok':
      return { recovered: true };
    case 'otp_required':
      return {
        recovered: false,
        otpRequired: true,
        reason: 'Chase asked for OTP / identity verification after auto-login. Click Login on the Bank panel and complete the prompt manually.',
      };
    case 'no_login_form':
      return {
        recovered: false,
        reason: "Auto-login couldn't find Chase's login form. Click Login on the Bank panel.",
      };
    case 'error':
      return {
        recovered: false,
        reason: `Auto-login failed: ${outcome.reason}`,
      };
  }
}

/**
 * Short, slightly-randomized pause that makes the navigation
 * sequence look less robotic. Chase's loyalty SPA scores the
 * SSO → /home → /cash-back rhythm as automation when it happens
 * sub-second; one settle pause per hop pushes us back into the
 * "human-paced" envelope. Randomized so a fingerprint can't lock
 * onto a fixed cadence.
 */
async function pacingPause(): Promise<void> {
  const ms = 900 + Math.floor(Math.random() * 600);
  await new Promise((r) => setTimeout(r, ms));
}

async function runRedeemFlow(
  page: Page,
  profileId: string,
  cardAccountId: string,
): Promise<ChaseRedeemResult> {
  // Two-hop SSO. The persistent context's saved cookies live on
  // secure.chase.com (where the user actually authenticated);
  // chaseloyalty.chase.com is a separate subdomain that mints its
  // own session via SSO redirect. Going straight to loyalty would
  // show the login form even on a fully-valid secure session.
  //
  // `waitUntil: 'load'` (instead of 'domcontentloaded') gives the
  // SPA bundle time to finish initial hydration before we navigate
  // again — Chase's anti-automation appears to flag back-to-back
  // navigations that fire before the prior page is fully alive.
  await page.goto('https://secure.chase.com/web/auth/dashboard', {
    waitUntil: 'load',
    timeout: 30_000,
  });
  {
    const recovery = await maybeAutoLoginAndContinue(page, profileId);
    if (!recovery.recovered) {
      return { ok: false, kind: 'error', reason: recovery.reason };
    }
  }
  await pacingPause();

  // Direct nav to /cash-back?AI=... — the prior /home?AI=... step is
  // skippable. Empirical confirmation via Playwright MCP (2026-05-08,
  // see docs/research/chase-mcp-direct-fetch-2026-05-08.md): navigating
  // straight to /cash-back loads /rest/cash-back/redemption-info
  // correctly without first hitting /home. Saves the 3-5s loyalty-home
  // hydration round-trip per redeem. The AI query param scopes the
  // loyalty session to the right card (Chase's loyalty SPA reads it
  // synchronously to pick the active card context).
  await page.goto(
    `https://chaseloyalty.chase.com/cash-back?AI=${encodeURIComponent(cardAccountId)}`,
    { waitUntil: 'load', timeout: 30_000 },
  );

  // Best-effort cookie-banner dismissal — Chase shows a fixed-top
  // privacy notice on first loyalty visits per session. It doesn't
  // block clicks (banner is above the form, not over it), but
  // dismissing keeps screenshots cleaner.
  await page
    .getByRole('button', { name: /close icon/i })
    .first()
    .click({ timeout: 1_500 })
    .catch(() => undefined);

  // Wait for the redemption form's dollar textbox to become visible.
  // This is the canonical "form rendered" signal — without it, we'd
  // proceed to the checkbox click on a shell page (just the Chase
  // decorative arc) and time out with a confusing message. Failing
  // here gives the user actionable advice instead.
  try {
    await page
      .locator('input.mds-text-input__input--hero')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    return {
      ok: false,
      kind: 'error',
      reason:
        "Cash-back form didn't render. Chase may have logged the loyalty session out or be asking for step-up auth. Try Login on the Bank panel and run Redeem Rewards again.",
    };
  }

  // Read the pre-filled max amount. The visible textbox is custom
  // (MDS shadow component), but Playwright's CSS selectors pierce
  // open shadow roots so the class match still resolves.
  let pointsRedeemed = '';
  try {
    pointsRedeemed = await page
      .locator('input.mds-text-input__input--hero')
      .first()
      .inputValue({ timeout: 10_000 });
  } catch {
    pointsRedeemed = '';
  }
  // Bail when there's nothing to redeem. Chase pre-fills the max,
  // so an empty / $0.00 value means a zero balance.
  const numeric = pointsRedeemed.replace(/[^\d.]/g, '');
  if (!numeric || /^0+(\.0+)?$/.test(numeric)) {
    return {
      ok: false,
      kind: 'no_points',
      reason: 'This card has 0 points available — nothing to redeem.',
    };
  }

  // Tick the leftmost statement-credit card. Try a chain of
  // increasingly broad selectors so we're tolerant of Chase
  // markup drift between the captured fixture and any future UI
  // tweak. First strategy whose locator attaches in the DOM wins.
  //
  //   1. role-named scoping: the original "Redeem for a statement
  //      credit" group + its first checkbox. Most specific —
  //      preferred when Chase keeps the accessible name.
  //   2. DOM class anchor: the first .selectable-tile__input on
  //      the page. The redeem-to-card tile renders before any
  //      deposit-account tiles, so the *first* match is the right
  //      one even without scoping.
  //   3. checkbox-text fallback: any checkbox whose accessible
  //      name contains "CREDIT CARD" — handles the case where
  //      Chase renames the group but keeps per-card labels.
  const candidates: Locator[] = [
    page
      .getByRole('group', { name: /Redeem for a statement credit/i })
      .getByRole('checkbox')
      .first(),
    page.locator('input.selectable-tile__input').first(),
    page.getByRole('checkbox', { name: /CREDIT CARD/i }).first(),
  ];
  // Race the candidates instead of trying them one-by-one. Sequential
  // probes pay 5s per miss, so a markup drift that only matches
  // candidate #3 cost 10s of dead wait. Promise.any resolves with the
  // first FULFILLED probe (rejections are ignored). 10s upper bound
  // covers the same total wall-clock as the old sequential 3×5s but
  // resolves much earlier on the common path.
  let checkbox: Locator;
  try {
    checkbox = await Promise.any(
      candidates.map((c) =>
        c.waitFor({ state: 'attached', timeout: 10_000 }).then(() => c),
      ),
    );
  } catch {
    return {
      ok: false,
      kind: 'error',
      reason:
        'Could not locate the statement-credit card on the redemption page. Try again with the headless toggle off so you can see what Chase is showing.',
    };
  }

  // Skip the click if the box is already checked — happens when
  // Chase pre-selects the only available card, or when a prior
  // abandoned redemption left the form mid-flow. Continue still
  // enables either way.
  const alreadyChecked = await checkbox.isChecked({ timeout: 2_000 }).catch(() => false);
  if (!alreadyChecked) {
    try {
      // force:true bypasses Playwright's "is anything on top of this
      // element?" check. Chase's sticky <mds-navigation-bar> sits
      // over the redemption form on this viewport and intercepts
      // every retry of a normal click — Playwright will retry until
      // it times out, never landing the click. Force-clicking
      // dispatches the click event directly on the underlying
      // checkbox, which is exactly what we want: the form sees
      // the same event a real user click would generate, and
      // Continue enables. We then sanity-check via isChecked() and
      // fall back to dispatchEvent if the click silently no-op'd
      // (rare but cheap insurance).
      await checkbox.click({ force: true, timeout: 10_000 });
      const stuck = !(await checkbox.isChecked({ timeout: 2_000 }).catch(() => true));
      if (stuck) {
        await checkbox.dispatchEvent('click').catch(() => undefined);
      }
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        reason: `Could not select statement-credit card: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  // Continue → confirm screen. Same nav-overlay reasoning as the
  // checkbox above: force:true so the click lands even when the
  // sticky header is hovering over the button's hit area.
  await pacingPause();
  try {
    await page
      .getByRole('button', { name: /^continue$/i })
      .click({ force: true, timeout: 10_000 });
    await page.waitForURL(/\/cash-back\/confirm/i, { timeout: 30_000 });
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      reason: `Continue step failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Submit → success screen.
  await pacingPause();
  try {
    await page
      .getByRole('button', { name: /^submit$/i })
      .click({ force: true, timeout: 10_000 });
    await page.waitForURL(/\/cash-back\/success/i, { timeout: 60_000 });
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      reason: `Submit step failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Scrape success-page details. Format:
  //   "...keep your order number SC13-VNNNG-KCKH for reference."
  //   <p>$704.73</p>
  //   <p>to CREDIT CARD (...XXXX)</p>
  let orderNumber = '';
  let amount = '';
  try {
    const bodyText =
      (await page.locator('main').first().textContent({ timeout: 10_000 })) ?? '';
    const orderMatch = bodyText.match(/order number\s+([A-Z0-9-]+)/i);
    if (orderMatch?.[1]) orderNumber = orderMatch[1];
    const amountMatch = bodyText.match(/\$\s*[\d,]+\.\d{2}/);
    if (amountMatch?.[0]) amount = amountMatch[0].replace(/\s+/g, '');
  } catch {
    // Best-effort. Redemption succeeded even if we can't read the
    // confirmation strings.
  }

  return { ok: true, orderNumber, amount, pointsRedeemed };
}

export type ChaseSnapshotFetchResult =
  | { ok: true; snapshot: ChaseAccountSnapshot }
  | { ok: false; reason: string };

/**
 * One-shot scrape of a profile's rewards points + current credit
 * balance. Mirrors what the Bank tab card displays — opens the
 * persistent context, hits the two pages we already know how to
 * navigate (secure.chase.com summary + chaseloyalty home), pulls
 * the displayed values out of page.content() with the pure parsers
 * in chaseScrape.ts, and closes.
 *
 * Window stays visible for the same reason the redeem flow does:
 * Chase 2FA challenges occasionally pop here, and we'd rather the
 * user see + complete them than have a silent timeout.
 *
 * 90s wall-clock deadline — each individual step has its own ~30s
 * selector wait, so without a hard cap a single fetch could spin
 * for 2+ minutes before bailing. 90s is generous for cold loads
 * plus auto-login, tight enough to give the user a clear error
 * before they think it's stuck forever.
 */
export async function fetchChaseAccountSnapshot(
  profileId: string,
  cardAccountId: string,
): Promise<ChaseSnapshotFetchResult> {
  return raceWithTimeout(
    runFetch(profileId, cardAccountId),
    90_000,
    'Snapshot fetch timed out after 90s.',
  );
}

function raceWithTimeout(
  work: Promise<ChaseSnapshotFetchResult>,
  ms: number,
  reason: string,
): Promise<ChaseSnapshotFetchResult> {
  return Promise.race([
    work,
    new Promise<ChaseSnapshotFetchResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason }), ms),
    ),
  ]);
}

async function runFetch(
  profileId: string,
  cardAccountId: string,
): Promise<ChaseSnapshotFetchResult> {
  const session = await openChaseSession(profileId);
  // Auto-save state on every navigation + 60s safety net so a force-quit
  // (cmd-Q while the fetch is mid-flight) doesn't lose the session
  // cookies Chase rotated during this run. session.close() in the
  // finally block writes one more time, but that only fires on graceful
  // exits; this catches the kill case.
  const stopAutoSave = attachSessionAutoSave(session, profileId);
  // Research-mode XHR logger. When AUTOG_CHASE_XHR_CAPTURE=1, write every
  // request + response (URL, status, content-type, headers, JSON body)
  // to research-logs/chase-xhr-<profileId>-<ts>.jsonl. Used to identify
  // new endpoints (e.g., the in-process payments endpoint we haven't
  // captured yet) when planning future Stage B+ extensions.
  const stopXhrCapture =
    process.env.AUTOG_CHASE_XHR_CAPTURE === '1'
      ? await attachChaseXhrCapture(session.page, profileId)
      : null;
  // Stage B: passive XHR interception. Empirical capture (see
  // docs/research/chase-xhr-capture-findings-2026-05-07.md) confirmed
  // four of the five fields the snapshot fetch reads come from two
  // JSON XHRs Chase's SPA fires on the summary page hydration:
  //
  //   /svc/rl/accounts/secure/v1/dashboard/module/list   →
  //     .cache[*].response.detail.{currentBalance, availableCredit,
  //                                 pendingChargesAmount}
  //   /svc/rr/accounts/secure/card/rewards/v2/summary/list →
  //     .cardRewardsSummary[*].currentRewardsBalance
  //
  // Listening for these instead of waiting for SPA hydration to paint
  // selectors (a) gets typed numeric values instead of regex-parsed
  // dollar strings, (b) lets us drop the chaseloyalty.chase.com
  // cross-domain SSO bounce entirely (rewards now ride the same
  // secure.chase.com session as everything else), and (c) returns a
  // few seconds earlier per fetch because we resolve as soon as JSON
  // arrives instead of after the DOM is fully painted.
  //
  // Listener attaches BEFORE any nav so the early hydration XHRs are
  // never missed. Detach in the finally to avoid leaking handlers
  // when the same context is reused (it isn't currently, but the
  // pattern keeps future context-pool work safe).
  const xhrJson: { dashboard: unknown; rewards: unknown } = {
    dashboard: null,
    rewards: null,
  };
  const onResponse = async (resp: import('playwright').Response): Promise<void> => {
    const url = resp.url();
    if (xhrJson.dashboard === null && url.includes('/svc/rl/accounts/secure/v1/dashboard/module/list')) {
      try {
        xhrJson.dashboard = await resp.json();
      } catch {
        // body unreadable / malformed JSON — fall back to DOM scrape
      }
    } else if (
      xhrJson.rewards === null &&
      url.includes('/svc/rr/accounts/secure/card/rewards/v2/summary/list')
    ) {
      try {
        xhrJson.rewards = await resp.json();
      } catch {
        // ditto
      }
    }
  };
  const responseListener = (r: import('playwright').Response): void => {
    void onResponse(r);
  };
  session.page.on('response', responseListener);

  try {
    const { page } = session;
    let creditBalance = '';
    let pendingCharges = '';
    let availableCredit = '';
    let pointsBalance = '';
    let inProcessPayments: ChasePaymentEntry[] = [];
    let lockStatus: string | undefined;
    let autoPayEnrolled: boolean | undefined;
    // Source flags drive the Stage B fallback decisions further down:
    // when Stage C provided the value, the slow DOM-scrape path is
    // skipped; when Stage C failed, fall through to the legacy nav +
    // scrape so we don't ship blanks.
    let stageCInProcessSourced = false;
    let stageCPendingSourced = false;

    // 1) Card summary page — fires both Stage B XHRs during hydration.
    try {
      await page.goto(
        `https://secure.chase.com/web/auth/dashboard#/dashboard/summary/${encodeURIComponent(
          cardAccountId,
        )}/CARD/BAC`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      {
        const recovery = await maybeAutoLoginAndContinue(page, profileId);
        if (!recovery.recovered) {
          return { ok: false, reason: recovery.reason };
        }
      }
      // Wait for both Stage B XHRs to land (typed JSON path) OR for
      // the recon-bar selector to render (DOM-scrape fallback). The
      // race resolves on whichever wins. 6s ceiling: empirical capture
      // showed both XHRs land within ~3-5s on a healthy session; if
      // they haven't fired by 6s, Chase is most likely rate-limiting
      // (parallel-fetch failure mode) and we should bail to DOM
      // fallback fast instead of eating a long wait BEFORE the
      // selector wait even starts. Bumped down from 15s after a
      // 4-way parallel fetch on 2026-05-07 stalled 3 of 4 cards
      // because the long XHR poll compounded on top of rate-limited
      // hydration.
      const xhrsLandedDeadline = Date.now() + 6_000;
      while (
        (xhrJson.dashboard === null || xhrJson.rewards === null) &&
        Date.now() < xhrsLandedDeadline
      ) {
        await page.waitForTimeout(150);
      }

      // Stage B happy path: extract from typed JSON.
      const detailFromCache = extractDashboardDetail(xhrJson.dashboard, cardAccountId);
      if (detailFromCache) {
        creditBalance = formatChaseDollarAmount(detailFromCache.currentBalance);
        availableCredit = formatChaseDollarAmount(detailFromCache.availableCredit);
      }
      const pointsFromXhr = extractRewardsBalance(xhrJson.rewards, cardAccountId);
      if (pointsFromXhr !== null) {
        pointsBalance = formatChasePointsAmount(pointsFromXhr);
      }
      logger.info('chase.snapshot.stageB.xhrs', {
        profileId,
        cardAccountId: redactCardId(cardAccountId),
        dashboardArrived: xhrJson.dashboard !== null,
        rewardsArrived: xhrJson.rewards !== null,
        detailExtracted: detailFromCache !== null,
        pointsExtracted: pointsFromXhr !== null,
      });

      // Stage C — fired EARLY (before any DOM scrape) so its
      // pendingChargesAmount + paymentDetail + lockStatus +
      // autoPayEnrolled can short-circuit the slow DOM-scrape paths.
      // Sentinel: only fires when Stage B's listener already captured
      // the SPA's first dashboard XHR (proves _abck is post-hydration
      // per pass-7 round-1).
      //
      // Empirically (Playwright MCP, 2026-05-08): overview + etu
      // parallel batch returns 200 in ~609ms and totalPendingChargeAmount
      // matches the DOM "Pending charges:" line exactly — replacing the
      // 5-7s DOM-scrape wait + parse on the happy path.
      //
      // Disabled by AUTOG_CHASE_DISABLE_STAGE_C=1.
      const stageCEnabled =
        process.env.AUTOG_CHASE_DISABLE_STAGE_C !== '1' && xhrJson.dashboard !== null;
      const stageC = stageCEnabled ? await fetchStageCOverview(page, cardAccountId) : null;
      if (stageC && stageC.ok) {
        if (stageC.lockStatus !== null) lockStatus = stageC.lockStatus;
        if (stageC.autoPayEnrolled !== null) autoPayEnrolled = stageC.autoPayEnrolled;
        // Prefer the multi-row billpay/card/payment/list result; fall
        // back to the one-slot paymentDetail summary if billpay failed.
        // Both are typed JSON; either way we skip the activity-page nav
        // + DOM scrape Stage B fallback path further down.
        const billpayMapped =
          stageC.billpayActivities !== null
            ? mapBillpayActivitiesToInProcess(stageC.billpayActivities)
            : null;
        inProcessPayments =
          billpayMapped !== null ? billpayMapped : mapPaymentDetailToInProcess(stageC.paymentDetail);
        stageCInProcessSourced = true;
        if (stageC.pendingChargesAmount !== null) {
          pendingCharges =
            stageC.pendingChargesAmount > 0
              ? formatChaseDollarAmount(stageC.pendingChargesAmount)
              : '';
          stageCPendingSourced = true;
        }
        logger.info('chase.snapshot.stageC.ok', {
          profileId,
          cardAccountId: redactCardId(cardAccountId),
          hasPaymentDetail: stageC.paymentDetail !== null,
          inProcessFromBillpay: billpayMapped !== null,
          inProcessFromStageC: inProcessPayments.length,
          pendingFromStageC: stageC.pendingChargesAmount,
          lockStatus: lockStatus ?? null,
          autoPayEnrolled: autoPayEnrolled ?? null,
        });
      } else if (stageC) {
        logger.info('chase.snapshot.stageC.fallback', {
          profileId,
          cardAccountId: redactCardId(cardAccountId),
          reason: stageC.reason,
        });
      }

      // Pending-charges DOM scrape — only runs when Stage C didn't
      // supply totalPendingChargeAmount (kill switch on, sentinel never
      // fired, etu fetch failed). The 5s "Pending charges:" wait used
      // to fire on EVERY refresh; with Stage C it's a rare fallback.
      //
      // Two-stage wait pattern preserved for the fallback path:
      //   1. Wait for the recon bar balance — proves activity tile
      //      started rendering.
      //   2. Wait for the literal "Pending charges:" text — that
      //      sub-element hydrates a few React ticks AFTER the recon
      //      bar.
      // Cards with zero pending charges don't render the line at all,
      // so the wait times out and we proceed.
      if (!stageCPendingSourced) {
        try {
          await page
            .locator('.activity-tile__recon-bar-balance')
            .first()
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(() => undefined);
          await page
            .locator('text=/Pending charges:/i')
            .first()
            .waitFor({ state: 'visible', timeout: 5_000 })
            .catch(() => undefined);
          const fullHtml = await page.content();
          pendingCharges = parsePendingChargesFromHtml(fullHtml);
        } catch {
          // page closed mid-read — pendingCharges stays empty
        }
      }

      // Stage B fallback: if the JSON path didn't yield balance or
      // available, fall back to locator-direct DOM scrape for those
      // two fields. Zero-risk insurance against Chase shipping a new
      // SPA that breaks the JSON shape.
      const needDomFallback = !creditBalance || !availableCredit;
      if (needDomFallback) {
        logger.info('chase.snapshot.stageB.domFallback', {
          profileId,
          cardAccountId: redactCardId(cardAccountId),
          missingBalance: !creditBalance,
          missingAvailable: !availableCredit,
        });
        const reconBar = page.locator('.activity-tile__recon-bar-balance').first();
        await reconBar
          .waitFor({ state: 'visible', timeout: 30_000 })
          .catch(() => undefined);
        const [balanceText, availableText] = await Promise.all([
          reconBar.textContent({ timeout: 5_000 }).catch(() => null),
          page
            .locator('[data-testid="availableCreditWithTransferBalance"]')
            .first()
            .textContent({ timeout: 5_000 })
            .catch(() => null),
        ]);
        if (!creditBalance) {
          creditBalance = balanceText?.trim().match(/-?\$[\d,]+\.\d{2}/)?.[0] ?? '';
        }
        if (!availableCredit) {
          availableCredit = availableText?.trim().match(/\$[\d,]+\.\d{2}/)?.[0] ?? '';
        }
      }

      if (!creditBalance) {
        // Both XHR + DOM fallback missed — diagnostic log + screenshot.
        logger.warn('chase.snapshot.summaryNoBalance', {
          profileId,
          cardAccountId: redactCardId(cardAccountId),
          url: page.url(),
        });
        await captureSummaryDebugSnapshot(page, profileId).catch(() => undefined);
      }
    } catch (err) {
      logger.warn('chase.snapshot.summaryError', {
        profileId,
        cardAccountId: redactCardId(cardAccountId),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2) Stage B fallback for in-process payments — runs when Stage C
    //    (above, fired right after the XHR poll) didn't source them
    //    (kill-switch on, sentinel never fired, fetch failed, JSON
    //    shape drift). Same activity-page nav + DOM scrape as before.
    //    The kept-alive Stage B path means Stage C can be turned off
    //    in the field without losing in-process-payment coverage.
    if (!stageCInProcessSourced) {
      try {
        await page.goto(
          `https://secure.chase.com/web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-${encodeURIComponent(
            cardAccountId,
          )};payeeType=CREDIT_CARD`,
          { waitUntil: 'domcontentloaded', timeout: 30_000 },
        );
        const activityTbody = page.locator('tbody.activityRow').first();
        await activityTbody
          .waitFor({ state: 'visible', timeout: 30_000 })
          .catch(() => undefined);
        const activityHtml = await activityTbody.innerHTML({ timeout: 5_000 }).catch(() => '');
        inProcessPayments = parseInProcessPaymentsFromHtml(activityHtml);
      } catch (err) {
        logger.warn('chase.snapshot.activityError', {
          profileId,
          cardAccountId: redactCardId(cardAccountId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The chaseloyalty.chase.com nav that used to live here is GONE —
    // points balance now comes from /svc/rr/accounts/secure/card/rewards/v2/summary/list
    // on the same secure.chase.com summary-page hydration as everything
    // else (see Stage B XHR listener above). Saves the cross-domain
    // SSO bounce (~4-9s per fetch). The DOM-fallback path above only
    // fills the recon-bar fields; points has no DOM fallback because
    // we no longer visit the loyalty page. If the rewards XHR ever
    // stops firing, pointsBalance will be empty and the renderer will
    // show an em-dash — annoying but not silent corruption.

    // Credit balance is the load-bearing field — Chase shows it on
    // every card-summary page (even fully-paid-off cards display
    // "$0.00"), so an empty string means the summary scrape silently
    // failed (recon-bar selector wait timed out, anti-bot stall,
    // 2FA challenge, etc.). Failing here prevents persisting a
    // half-snapshot that would otherwise look successful in the UI
    // (em-dash for balance, real values for pts + pending + payments)
    // and surfaces an actionable error banner instead.
    // Note: "$0.00" is a valid scraped value — only literal empty
    // strings indicate a missed scrape.
    if (!creditBalance) {
      logger.warn('chase.snapshot.balanceMissing', {
        profileId,
        cardAccountId: redactCardId(cardAccountId),
        url: page.url(),
        hasPoints: !!pointsBalance,
        hasPending: !!pendingCharges,
        inProcessCount: inProcessPayments.length,
      });
      return {
        ok: false,
        reason:
          "Couldn't read credit balance from Chase — likely a parallel-fetch rate-limit or expired session. Try refreshing this card alone, or sign in again.",
      };
    }
    logger.info('chase.snapshot.ok', {
      profileId,
      cardAccountId: redactCardId(cardAccountId),
      pointsBalance,
      creditBalance,
      pendingCharges,
      availableCredit,
      inProcessCount: inProcessPayments.length,
      stageCInProcessSourced,
      lockStatus: lockStatus ?? null,
      autoPayEnrolled: autoPayEnrolled ?? null,
    });
    return {
      ok: true,
      snapshot: {
        pointsBalance,
        creditBalance,
        pendingCharges,
        availableCredit,
        inProcessPayments,
        lockStatus,
        autoPayEnrolled,
        fetchedAt: new Date().toISOString(),
      },
    };
  } finally {
    try {
      session.page.off('response', responseListener);
    } catch {
      // page may already be gone
    }
    stopAutoSave();
    if (stopXhrCapture) await stopXhrCapture();
    await session.close();
  }
}

/**
 * Keep a Chase user-facing window's session warm by firing a small
 * authenticated XHR on a jittered 4-6 minute cadence. Chase's idle
 * timer (~10-11 min on consumer banking, per public sources) is reset
 * by any successful authenticated `/svc/` POST — so periodically firing
 * the smallest one available extends the session as long as the
 * window is open.
 *
 * Endpoint: `POST /svc/rr/accounts/secure/v1/menu/list` — returns the
 * side-nav menu (small payload, idempotent, fired by the SPA naturally
 * on dashboard view). Same TLS + connection pool + cookies as a real
 * SPA XHR (transport-indistinguishable, per pass-2 round-2 research).
 *
 * Skips firing when `document.visibilityState !== 'visible'` so a
 * minimized / backgrounded tab doesn't keep beating without the
 * visibility signal Akamai's sensor cross-references.
 *
 * Returns a teardown function that the caller MUST invoke when the
 * window is being closed (mirrors attachSessionAutoSave). Safe to
 * call multiple times.
 */
export function attachChaseKeepalive(
  session: ChaseSession,
  profileId: string,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const skip = await session.page
        .evaluate(() => document.visibilityState !== 'visible')
        .catch(() => true);
      if (!skip) {
        const status = await session.page
          .evaluate(async () => {
            try {
              const r = await fetch('/svc/rr/accounts/secure/v1/menu/list', {
                method: 'POST',
                credentials: 'include',
                headers: {
                  // Confirmed required headers from MaxxRK chaseinvest-api +
                  // empirical AmazonG capture: x-jpmc-csrf-token is the
                  // literal string "NONE" for same-origin SPA XHRs.
                  'x-jpmc-csrf-token': 'NONE',
                  'x-jpmc-channel': 'id=C30',
                  'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                  accept: 'application/json, text/plain, */*',
                },
              });
              return r.status;
            } catch {
              return null;
            }
          })
          .catch(() => null);
        logger.info('chase.keepalive.fired', { profileId, status });
      }
    } catch {
      // page closed or context torn down — teardown will fire shortly
    }
    schedule();
  };

  const schedule = (): void => {
    if (stopped) return;
    // 4-6 min jittered: under Chase's reported ~10 min idle ceiling
    // with margin, but not so frequent that periodic-tick cadence
    // becomes a bot-shape signal on its own.
    const ms = (4 + Math.random() * 2) * 60_000;
    timer = setTimeout(() => void tick(), ms);
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Comprehensive network capture across the entire Chase context.
 * Logs every request + response with full metadata (resource type,
 * URL, status, content-type, body length, mime, page-URL it fired
 * from). Output: research-logs/chase-full-<profileId>-<ts>.jsonl.
 *
 * Used for blocklist auditing — tells us which URLs are noise (could
 * be blocked) vs load-bearing (would break the SPA if blocked). The
 * smaller AUTOG_CHASE_XHR_CAPTURE mode only logs xhr/fetch on the
 * snapshot fetch's main page; full capture covers EVERY page in the
 * context (Pay flyout, Open Rewards window, redemption flow) and
 * EVERY resource type so we see the complete traffic profile.
 *
 * Anti-bot impact: zero — passive observation only, no requests
 * issued by us.
 */
async function attachChaseFullCapture(
  context: BrowserContext,
  profileId: string,
): Promise<void> {
  const { mkdir, appendFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.cwd(), 'research-logs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `chase-full-${profileId}-${ts}.jsonl`);
  await writeFile(file, '');
  logger.info('chase.fullCapture.start', { profileId, file });

  const append = (ev: unknown): void => {
    void appendFile(file, JSON.stringify(ev) + '\n').catch(() => undefined);
  };

  const attachToPage = (page: Page): void => {
    page.on('request', (req) => {
      append({
        ts: Date.now(),
        event: 'request',
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        pageUrl: page.url(),
      });
    });
    page.on('response', (resp) => {
      const req = resp.request();
      const headers = resp.headers();
      append({
        ts: Date.now(),
        event: 'response',
        url: resp.url(),
        status: resp.status(),
        resourceType: req.resourceType(),
        contentType: headers['content-type'] ?? '',
        contentLength: headers['content-length'] ?? '',
        pageUrl: page.url(),
      });
    });
    page.on('requestfailed', (req) => {
      append({
        ts: Date.now(),
        event: 'requestfailed',
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText ?? null,
        pageUrl: page.url(),
      });
    });
  };

  for (const existing of context.pages()) attachToPage(existing);
  context.on('page', attachToPage);
}

/**
 * Pull the per-card detail object out of the dashboard/module/list
 * JSON response. Chase's SPA caches the per-card detail call inside
 * the module-list response under a top-level `cache` array — each
 * entry is a `{url, request, response}` triple matching what the
 * downstream module would have fetched. We look for the entry whose
 * request.selectorId matches our cardAccountId. Returns null when
 * the JSON shape doesn't match (Chase shipped a new SPA, or the
 * card has no detail entry yet).
 */
type ChaseCardDetail = {
  currentBalance: number;
  availableCredit: number;
  pendingChargesAmount?: number;
};

function extractDashboardDetail(json: unknown, cardAccountId: string): ChaseCardDetail | null {
  if (!json || typeof json !== 'object') return null;
  const cache = (json as { cache?: unknown }).cache;
  if (!Array.isArray(cache)) return null;
  for (const entry of cache) {
    if (!entry || typeof entry !== 'object') continue;
    const request = (entry as { request?: { selectorId?: unknown } }).request;
    if (!request || String(request.selectorId) !== cardAccountId) continue;
    const response = (entry as { response?: { detail?: unknown } }).response;
    const detail = response?.detail;
    if (!detail || typeof detail !== 'object') continue;
    const d = detail as Record<string, unknown>;
    if (typeof d.currentBalance !== 'number') continue;
    if (typeof d.availableCredit !== 'number') continue;
    return {
      currentBalance: d.currentBalance,
      availableCredit: d.availableCredit,
      pendingChargesAmount:
        typeof d.pendingChargesAmount === 'number' ? d.pendingChargesAmount : undefined,
    };
  }
  return null;
}

/**
 * Pull the rewards points balance for the card from the
 * /svc/rr/accounts/secure/card/rewards/v2/summary/list response.
 * Chase returns one entry per card under cardRewardsSummary; we
 * pick the entry matching our cardAccountId. Returns null on shape
 * mismatch.
 */
function extractRewardsBalance(json: unknown, cardAccountId: string): number | null {
  if (!json || typeof json !== 'object') return null;
  const summary = (json as { cardRewardsSummary?: unknown }).cardRewardsSummary;
  if (!Array.isArray(summary)) return null;
  const idNum = Number(cardAccountId);
  for (const row of summary) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { accountId?: unknown; currentRewardsBalance?: unknown; balance?: unknown };
    if (Number(r.accountId) !== idNum) continue;
    if (typeof r.currentRewardsBalance === 'number') return r.currentRewardsBalance;
    if (typeof r.balance === 'number') return r.balance;
  }
  return null;
}

/**
 * Format a Chase JSON dollar number to the same string shape the
 * UI used to scrape from the recon bar. Negative values get a "-"
 * prefix before the "$" (Chase's recon bar renders "-$1,105.68"
 * for credit balances). Two decimal places, comma-grouped.
 */
function formatChaseDollarAmount(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format a Chase JSON points integer to the "<n,nnn> pts" string
 * shape the loyalty page used to render. Matches the prior parser's
 * output so the renderer's display logic doesn't need to change.
 */
function formatChasePointsAmount(num: number): string {
  return `${num.toLocaleString('en-US')} pts`;
}

type StageCOverviewResult =
  | {
      ok: true;
      paymentDetail: StageCPaymentDetail | null;
      lockStatus: string | null;
      autoPayEnrolled: boolean | null;
      /** Pending-charges sum from the etu-transactions endpoint's
       *  totalPendingChargeAmount field. Empirically verified
       *  2026-05-08 to match Chase's own "Pending charges:" recon-bar
       *  line exactly. NULL when the etu fetch failed (caller falls
       *  back to DOM scrape). */
      pendingChargesAmount: number | null;
      /** Multi-row in-process payments from the billpay/card/payment/list
       *  endpoint's paymentActivities[]. Primary source for in-process
       *  payments; supersedes the one-slot paymentDetail summary above.
       *  NULL when the billpay fetch failed (caller falls back to
       *  paymentDetail mapping). Empirically verified 2026-05-08 —
       *  see docs/research/chase-billpay-payment-list-empirical-2026-05-08.md. */
      billpayActivities: StageCBillpayActivity[] | null;
    }
  | { ok: false; reason: string };

/**
 * Stage C: direct-fetch hybrid for the snapshot path.
 *
 * Fires TWO endpoints in parallel via page.evaluate AFTER Stage B's
 * listener has captured the SPA's natural first dashboard XHR (per
 * pass-7 round-1, that's our sentinel that _abck is post-hydration
 * and Stage C is safe to fire):
 *
 *   1. /svc/rl/.../dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD
 *      → balance, available credit, paymentDetail (in-process payments),
 *        creditCardLockStatus, autoPayEnrolled
 *
 *   2. /svc/rr/.../etu-transactions/v4/accounts/transactions?digital-account-identifier=N&record-count=50
 *      → totalPendingChargeAmount (replaces today's "Pending charges:"
 *        DOM scrape — empirically verified 2026-05-08 to match Chase's
 *        recon-bar line exactly, where the dashboard JSON's
 *        pendingChargesAmount field reads 0 even when DOM shows
 *        non-zero — see `docs/research/chase-pending-charges-empirical-2026-05-08.md`)
 *
 * Promise.allSettled inside the evaluate body so a partial failure
 * still returns useful data: if etu fails but overview succeeded,
 * we return overview data + pendingChargesAmount=null and the caller
 * falls back to DOM scrape for pending charges only. If overview
 * fails entirely, we return ok:false and the caller falls all the
 * way through to Stage B today's path.
 *
 * Falls through silently to Stage B path on overview failure
 * (sentinel timeout, JSON shape drift, Akamai 403, network error,
 * fetch timeout).
 *
 * Anti-bot posture is identical to Stage B's listener path: same
 * Chromium TLS, same cookies, same headers Chase emits naturally on
 * its own SPA-fired XHR. Empirical via Playwright MCP (2026-05-08):
 * 3-fetch parallel batch (overview + rewards + etu) returned 200 in
 * ~609ms from inside an authed page.
 *
 * Disabled when AUTOG_CHASE_DISABLE_STAGE_C=1 (kill switch).
 */
async function fetchStageCOverview(
  page: Page,
  cardAccountId: string,
): Promise<StageCOverviewResult> {
  const requestId = randomUUID();
  const etuRequestId = randomUUID();
  const billpayRequestId = randomUUID();
  // Inline PR1's tested helpers (single source of truth) into the
  // page.evaluate body. String form so we control body/header
  // serialization without Playwright's stringify-and-arg dance.
  // Three fetches in Promise.allSettled — partial failure still
  // returns useful data; the caller maps each missing piece to its
  // own fallback (DOM scrape for pending charges, paymentDetail
  // mapping for in-process, etc).
  const etuUrl =
    `/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/etu-transactions/v4/accounts/transactions` +
    `?digital-account-identifier=${encodeURIComponent(cardAccountId)}` +
    `&record-count=50&sort-order-code=D&sort-key-code=T`;
  // billpay/card/payment/list takes payeeId with a leading '-' (matches
  // the activity-page URL fragment Chase's SPA itself uses).
  const billpayBody = `autoPayPendingEnabled=true&payeeId=-${encodeURIComponent(cardAccountId)}`;
  const evalSrc = `(async () => {
${STAGE_C_IN_PAGE_HELPERS_SRC}
    const formHeaders = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'accept': 'application/json, text/plain, */*',
      'x-jpmc-csrf-token': 'NONE',
      'x-jpmc-channel': 'id=C30',
    };
    const [ovSettled, etuSettled, billpaySettled] = await Promise.allSettled([
      (async () => {
        const f = await fetchWithTimeout(
          '/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD',
          {
            method: 'POST',
            credentials: 'include',
            headers: { ...formHeaders, 'x-jpmc-client-request-id': ${JSON.stringify(requestId)} },
            body: 'context=WEB_CBO_OVERVIEW_DASHBOARD&selectorIdType=CUSTOMER_GROUP',
          },
          8000,
        );
        if (!f.ok) return f;
        return await classifyResponse(f.response);
      })(),
      (async () => {
        const f = await fetchWithTimeout(
          ${JSON.stringify(etuUrl)},
          {
            method: 'GET',
            credentials: 'include',
            headers: { ...formHeaders, 'x-jpmc-client-request-id': ${JSON.stringify(etuRequestId)} },
          },
          8000,
        );
        if (!f.ok) return f;
        return await classifyResponse(f.response);
      })(),
      (async () => {
        const f = await fetchWithTimeout(
          '/svc/rr/payments/secure/v1/billpay/card/payment/list',
          {
            method: 'POST',
            credentials: 'include',
            headers: { ...formHeaders, 'x-jpmc-client-request-id': ${JSON.stringify(billpayRequestId)} },
            body: ${JSON.stringify(billpayBody)},
          },
          8000,
        );
        if (!f.ok) return f;
        return await classifyResponse(f.response);
      })(),
    ]);
    return {
      overview: ovSettled.status === 'fulfilled' ? ovSettled.value : { ok: false, kind: 'rejected', error: String(ovSettled.reason) },
      etu: etuSettled.status === 'fulfilled' ? etuSettled.value : { ok: false, kind: 'rejected', error: String(etuSettled.reason) },
      billpay: billpaySettled.status === 'fulfilled' ? billpaySettled.value : { ok: false, kind: 'rejected', error: String(billpaySettled.reason) },
    };
  })()`;

  let raw: unknown;
  try {
    raw = await page.evaluate(evalSrc);
  } catch (err) {
    return {
      ok: false,
      reason: `evaluate-error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'evaluate-non-object' };
  }
  const split = raw as { overview?: unknown; etu?: unknown };

  // ---- Overview classifier check (load-bearing — bails Stage C on failure) ----
  const ov = (split.overview ?? null) as Record<string, unknown> | null;
  if (!ov) return { ok: false, reason: 'evaluate-missing-overview' };
  if (ov.ok === false) {
    return { ok: false, reason: `overview-${String(ov.kind ?? 'unknown')}` };
  }
  if (typeof ov.kind === 'string' && ov.kind !== 'ok') {
    return {
      ok: false,
      reason: `overview-${ov.kind}${ov.status !== undefined ? `-${String(ov.status)}` : ''}`,
    };
  }
  const ovJson = (ov.json ?? null) as unknown;
  const sentinel = validateStageCOverviewShape(ovJson, new Set([cardAccountId]));
  if (!sentinel.ok) {
    return { ok: false, reason: `sentinel-${sentinel.reason}` };
  }

  // Pull this card's row out of cardAccountOverviews.
  const cache = (ovJson as { cache?: Array<{ url?: string; response?: unknown }> }).cache ?? [];
  const overviewEntry = cache.find(
    (c) => typeof c?.url === 'string' && c.url.includes('/overview/card/v2/list'),
  );
  const groups =
    ((overviewEntry?.response as { cardAccountOverviews?: Array<{ cardAccounts?: unknown[] }> })
      ?.cardAccountOverviews) ?? [];
  const idNum = Number(cardAccountId);
  let match: Record<string, unknown> | null = null;
  outer: for (const g of groups) {
    for (const c of g.cardAccounts ?? []) {
      const cc = c as Record<string, unknown>;
      if (Number(cc.accountId) === idNum) {
        match = cc;
        break outer;
      }
    }
  }
  if (!match) {
    return { ok: false, reason: 'card-not-in-overview' };
  }
  const detail = match.cardAccountDetail as Record<string, unknown> | undefined;
  const pd = (detail?.paymentDetail ?? null) as StageCPaymentDetail | null;
  const lockStatus =
    typeof detail?.creditCardLockStatus === 'string'
      ? (detail.creditCardLockStatus as string)
      : null;
  const autoPayEnrolled =
    typeof detail?.autoPayEnrolled === 'boolean'
      ? (detail.autoPayEnrolled as boolean)
      : null;

  // ---- ETU classifier check (best-effort — null on failure, caller
  //      falls back to DOM scrape for pending charges only). ----
  let pendingChargesAmount: number | null = null;
  const etu = (split.etu ?? null) as Record<string, unknown> | null;
  if (etu && etu.ok !== false && etu.kind === 'ok') {
    const etuJson = (etu.json ?? null) as { totalPendingChargeAmount?: unknown } | null;
    if (etuJson && typeof etuJson.totalPendingChargeAmount === 'number') {
      pendingChargesAmount = etuJson.totalPendingChargeAmount;
    }
  }

  // ---- Billpay classifier check (best-effort — null on failure,
  //      caller falls back to paymentDetail one-slot mapping). ----
  let billpayActivities: StageCBillpayActivity[] | null = null;
  const billpay = (split as { billpay?: unknown }).billpay as Record<string, unknown> | null | undefined;
  if (billpay && billpay.ok !== false && billpay.kind === 'ok') {
    const bpJson = (billpay.json ?? null) as { paymentActivities?: unknown } | null;
    if (bpJson && Array.isArray(bpJson.paymentActivities)) {
      billpayActivities = bpJson.paymentActivities as StageCBillpayActivity[];
    }
  }

  return {
    ok: true,
    paymentDetail:
      pd && (pd.paymentMessageStatusCode || pd.paymentAmount !== undefined) ? pd : null,
    lockStatus,
    autoPayEnrolled,
    pendingChargesAmount,
    billpayActivities,
  };
}

/**
 * Tap into a session's page-level network events and stream every XHR
 * (and fetch) request + response to a JSONL file under research-logs/.
 * Used during Stage B research to identify which JSON endpoints serve
 * the data we currently scrape from the rendered DOM. Enabled only
 * when AUTOG_CHASE_XHR_CAPTURE=1 is set in the env — production runs
 * skip the listener entirely.
 *
 * Returns a teardown function that flushes the file. JSON bodies are
 * inlined when small enough to be useful for grep; non-JSON gets a
 * length stamp.
 */
async function attachChaseXhrCapture(
  page: Page,
  profileId: string,
): Promise<() => Promise<void>> {
  const { mkdir, appendFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.cwd(), 'research-logs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `chase-xhr-${profileId}-${ts}.jsonl`);
  await writeFile(file, '');
  logger.info('chase.xhrCapture.start', { profileId, file });

  const append = (ev: unknown): void => {
    void appendFile(file, JSON.stringify(ev) + '\n').catch(() => undefined);
  };
  const onRequest = (req: import('playwright').Request): void => {
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    append({
      ts: Date.now(),
      event: 'request',
      url: req.url(),
      method: req.method(),
      reqHeaders: req.headers(),
    });
  };
  const onResponse = async (resp: import('playwright').Response): Promise<void> => {
    const req = resp.request();
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    const respHeaders = resp.headers();
    const contentType = respHeaders['content-type'] ?? '';
    let body: unknown;
    let bodyLen = 0;
    try {
      const buf = await resp.body();
      bodyLen = buf.length;
      if (contentType.includes('application/json') && bodyLen < 2_000_000) {
        try {
          body = JSON.parse(buf.toString('utf8'));
        } catch {
          body = buf.toString('utf8').slice(0, 4000);
        }
      }
    } catch {
      // body unreadable — redirect, blocked, or context closed mid-read
    }
    // Capture full response headers — needed to observe _abck rotation,
    // bm_sv lifecycle, and Set-Cookie patterns when investigating Stage C
    // anti-bot behavior. Cheap (~1KB extra per entry).
    append({
      ts: Date.now(),
      event: 'response',
      url: resp.url(),
      status: resp.status(),
      contentType,
      respHeaders,
      bodyLen,
      body,
    });
  };
  page.on('request', onRequest);
  page.on('response', (r) => void onResponse(r));
  return async () => {
    page.off('request', onRequest);
    logger.info('chase.xhrCapture.stop', { profileId, file });
  };
}

/**
 * Open a Chase window pointed at the Pay-card flyout for the given
 * card. Navigates the session to the SSO seed, runs auto-login
 * recovery if needed, then lands on the flyout URL. The session is
 * NOT closed on return — caller is expected to register it in
 * chaseActionSessions so the user can finish the pay flow manually
 * in the visible window. Mirrors chaseOpenRewards's hand-off pattern.
 *
 * Returns ok:false (with the session already closed) on auth-prompt
 * recovery failures, so the caller can surface the error and not
 * leak a window.
 */
export async function openChasePayPage(
  profileId: string,
  cardAccountId: string,
): Promise<
  | { ok: true; session: ChaseSession }
  | { ok: false; reason: string }
> {
  // Always visible — the user is doing the pay action themselves.
  // No headless option here.
  const session = await openChaseSession(profileId);
  const flyoutUrl =
    `https://secure.chase.com/web/auth/dashboard#/dashboard/summary/${encodeURIComponent(
      cardAccountId,
    )}/CARD/BAC/index;flyout=payCard,-${encodeURIComponent(
      cardAccountId,
    )},BAC,microApp`;
  try {
    // Direct-to-flyout nav. On a warm session (cookies present) Chase
    // serves the flyout immediately — saves the ~500-800ms dashboard
    // hop the previous dual-nav flow paid every time. On a cold/expired
    // session Chase 302s us to /logon, which the recovery step below
    // picks up; we then re-navigate to the flyout once we're authed,
    // landing in the same end state as the old code with one extra nav
    // only on the rare cold path.
    await session.page.goto(flyoutUrl, {
      waitUntil: 'load',
      timeout: 30_000,
    });
    const recovery = await maybeAutoLoginAndContinue(session.page, profileId);
    if (!recovery.recovered) {
      await session.close().catch(() => undefined);
      return { ok: false, reason: recovery.reason };
    }
    // Recovery may have moved the URL off the flyout (Chase redirects
    // post-login to the dashboard summary page, not the flyout). Re-nav
    // when that happens. On the warm path the URL still contains the
    // flyout fragment and we skip the second goto entirely.
    if (!session.page.url().includes('flyout=payCard')) {
      await pacingPause();
      await session.page.goto(flyoutUrl, {
        waitUntil: 'load',
        timeout: 30_000,
      });
    }
    logger.info('chase.pay.windowOpened', {
      profileId,
      cardAccountId: redactCardId(cardAccountId),
    });
    return { ok: true, session };
  } catch (err) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

