import { app } from 'electron';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import type { ChaseAccountSnapshot } from '../shared/types.js';
import { chaseProfileDir, chaseSessionStatePath } from './chaseProfiles.js';
import { getChaseCredentials } from './chaseCredentials.js';
import {
  isChaseAuthPromptUrl,
  parseAvailableCreditFromHtml,
  parseCreditBalanceFromHtml,
  parseInProcessPaymentsFromHtml,
  parsePendingChargesFromHtml,
  parsePointsBalanceFromHtml,
} from './chaseScrape.js';
import type { ChasePaymentEntry } from '../shared/types.js';

export type ChaseSession = {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

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
  await page.screenshot({ path: file, fullPage: true });
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
      cardAccountId,
      pointsRedeemed: result.pointsRedeemed,
      amount: result.amount,
      orderNumber: result.orderNumber,
    });
  } else {
    logger.warn('chase.redeem.failed', {
      profileId,
      cardAccountId,
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
  let scope: Scope | null = null;
  try {
    await page
      .locator('iframe#logonbox')
      .waitFor({ state: 'attached', timeout: 6_000 });
    const frame = page.frameLocator('iframe#logonbox');
    scope = {
      locator: (sel) => frame.locator(sel) as unknown as ReturnType<Page['locator']>,
      // Iframe layout — success = iframe detaches.
      waitForLogonGone: () =>
        page
          .locator('iframe#logonbox')
          .waitFor({ state: 'detached', timeout: 30_000 }),
    };
  } catch {
    // No iframe — try the parent document. Wait for the username
    // input to show up directly.
    try {
      await page
        .locator('#userId-input-field-input')
        .waitFor({ state: 'visible', timeout: 6_000 });
      scope = {
        locator: (sel) => page.locator(sel),
        // Full-page layout — success = URL leaves /logon.
        waitForLogonGone: () =>
          page.waitForURL(
            (url) => !/\/logon/i.test(url.toString()),
            { timeout: 30_000 },
          ),
      };
    } catch {
      return { kind: 'no_login_form' };
    }
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
  // bot-detection scoring more lenient. Skip the clear when Chase
  // has already pre-filled the right username via "Remember
  // username" — touching the field with fill('') can trigger
  // re-population by Chase's autofill listener and waste keystrokes.
  try {
    const currentUser = await userField.inputValue({ timeout: 2_000 }).catch(() => '');
    if (currentUser !== creds.username) {
      await userField.click({ force: true, timeout: 5_000 });
      // Keyboard-clear: select-all + backspace. More tolerant of
      // Chase's input handlers than fill('').
      await userField.press('ControlOrMeta+a').catch(() => undefined);
      await userField.press('Backspace').catch(() => undefined);
      await userField.type(creds.username, { delay: 35 });
      logger.info('chase.autoLogin.typedUsername', {
        usernameLen: creds.username.length,
      });
    } else {
      logger.info('chase.autoLogin.usernamePrefilled');
    }
    await passField.waitFor({ state: 'visible', timeout: 5_000 });
    await passField.click({ force: true, timeout: 5_000 });
    await passField.press('ControlOrMeta+a').catch(() => undefined);
    await passField.press('Backspace').catch(() => undefined);
    await passField.type(creds.password, { delay: 35 });
    logger.info('chase.autoLogin.typedPassword', {
      passwordLen: creds.password.length,
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
  try {
    const rememberMe = scope.locator('#rememberMe');
    const already = await rememberMe.isChecked({ timeout: 1_500 }).catch(() => false);
    if (!already) {
      await rememberMe.check({ force: true, timeout: 3_000 }).catch(() =>
        rememberMe.click({ force: true, timeout: 3_000 }),
      );
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
  const creds = await getChaseCredentials(profileId).catch(() => null);
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

  await page.goto(
    `https://chaseloyalty.chase.com/home?AI=${encodeURIComponent(cardAccountId)}`,
    { waitUntil: 'load', timeout: 30_000 },
  );
  try {
    await page.waitForSelector('text=Available points', { timeout: 30_000 });
  } catch {
    return {
      ok: false,
      kind: 'error',
      reason: 'Rewards page never finished loading. Re-login may be required.',
    };
  }
  await pacingPause();

  // Pass AI on the cash-back URL too so Chase's loyalty SPA has
  // explicit active-card context. Some session states render an
  // empty page (just the decorative chrome) without it, even when
  // /home?AI=... succeeded earlier — Chase appears to scope the
  // loyalty session to whatever was last passed in the query.
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
  let checkbox: Locator | null = null;
  for (const cand of candidates) {
    try {
      await cand.waitFor({ state: 'attached', timeout: 5_000 });
      checkbox = cand;
      break;
    } catch {
      // try next
    }
  }
  if (!checkbox) {
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
  try {
    const { page } = session;
    let creditBalance = '';
    let pendingCharges = '';
    let availableCredit = '';
    let pointsBalance = '';

    // 1) Card summary page — credit balance + pending charges.
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
      // Wait for the recon bar VALUE element (the label class ends
      // with "-text"; the value class is the bare prefix). The SPA
      // hash-routes after domcontentloaded so the bar takes a few
      // seconds to hydrate even after the document is "loaded."
      // 30s gives a cold persistent-context start enough room to
      // SSO, route, and render. Selector-based wait is more
      // reliable than text-based since "Current balance" can also
      // appear in unrelated tooltips / aria-labels during loading.
      await page
        .locator('.activity-tile__recon-bar-balance')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const summaryHtml = await page.content();
      creditBalance = parseCreditBalanceFromHtml(summaryHtml);
      // Same page hosts the "Pending charges" line in the activity
      // accordion above the recon bar. Pull it out of the same
      // page.content() so we don't pay for a second navigation.
      pendingCharges = parsePendingChargesFromHtml(summaryHtml);
      availableCredit = parseAvailableCreditFromHtml(summaryHtml);
      if (!creditBalance) {
        // Diagnostic log + screenshot so we can tell whether the
        // page hadn't rendered, the SPA bounced us elsewhere, or
        // the regex anchor stopped matching. Screenshot lands at
        // userData/chase-snapshot-debug/{profileId}-{ts}.png — the
        // user can dig it out next time we triage a missing balance.
        logger.warn('chase.snapshot.summaryNoBalance', {
          profileId,
          cardAccountId,
          url: page.url(),
          htmlSize: summaryHtml.length,
        });
        await captureSummaryDebugSnapshot(page, profileId).catch(() => undefined);
      }
    } catch (err) {
      logger.warn('chase.snapshot.summaryError', {
        profileId,
        cardAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2) Loyalty home — rewards points header.
    try {
      await page.goto(
        `https://chaseloyalty.chase.com/home?AI=${encodeURIComponent(cardAccountId)}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      // Same selector-anchor approach as the summary page. The
      // ".points" class is what wraps "70,473 pts" / "0 pts" in
      // the page-header card-info block.
      await page
        .locator('.card-info .points')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const loyaltyHtml = await page.content();
      pointsBalance = parsePointsBalanceFromHtml(loyaltyHtml);
    } catch (err) {
      logger.warn('chase.snapshot.loyaltyError', {
        profileId,
        cardAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3) Payment-activity page — in-process payments only.
    // Note the leading minus on payeeId — it's how Chase
    // distinguishes credit-card payees from other types
    // internally. We pass it through verbatim.
    let inProcessPayments: ChasePaymentEntry[] = [];
    try {
      await page.goto(
        `https://secure.chase.com/web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-${encodeURIComponent(
          cardAccountId,
        )};payeeType=CREDIT_CARD`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      // The activity table renders inside an `activityRow` tbody.
      // Wait for it to populate; if the user has no activity at
      // all the wait will time out and we just return an empty
      // list, which is the right answer.
      await page
        .locator('tbody.activityRow')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const activityHtml = await page.content();
      inProcessPayments = parseInProcessPaymentsFromHtml(activityHtml);
    } catch (err) {
      logger.warn('chase.snapshot.activityError', {
        profileId,
        cardAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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
        cardAccountId,
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
      cardAccountId,
      pointsBalance,
      creditBalance,
      pendingCharges,
      availableCredit,
      inProcessCount: inProcessPayments.length,
    });
    return {
      ok: true,
      snapshot: {
        pointsBalance,
        creditBalance,
        pendingCharges,
        availableCredit,
        inProcessPayments,
        fetchedAt: new Date().toISOString(),
      },
    };
  } finally {
    stopAutoSave();
    await session.close();
  }
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
  try {
    await session.page.goto('https://secure.chase.com/web/auth/dashboard', {
      waitUntil: 'load',
      timeout: 30_000,
    });
    const recovery = await maybeAutoLoginAndContinue(session.page, profileId);
    if (!recovery.recovered) {
      await session.close().catch(() => undefined);
      return { ok: false, reason: recovery.reason };
    }
    await pacingPause();
    await session.page.goto(
      `https://secure.chase.com/web/auth/dashboard#/dashboard/summary/${encodeURIComponent(
        cardAccountId,
      )}/CARD/BAC/index;flyout=payCard,-${encodeURIComponent(
        cardAccountId,
      )},BAC,microApp`,
      { waitUntil: 'load', timeout: 30_000 },
    );
    logger.info('chase.pay.windowOpened', { profileId, cardAccountId });
    return { ok: true, session };
  } catch (err) {
    await session.close().catch(() => undefined);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

