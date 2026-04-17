import type { DriverSession } from '../browser/driver.js';
import { logger } from '../shared/logger.js';

const AMAZON_SIGNIN_URL = 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';
const AMAZON_HOME = 'https://www.amazon.com/';
const POLL_INTERVAL_MS = 1500;

export type LoginResult = {
  loggedIn: boolean;
  detectedName: string | null;
  reason?: 'success' | 'cancelled' | 'timeout';
};

export async function loginAmazon(
  session: DriverSession,
  opts: { timeoutMs?: number } = {},
): Promise<LoginResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  // Reuse the about:blank tab Chromium opens the persistent context with —
  // otherwise the user sees a blank tab plus the sign-in tab.
  const existingPages = session.context.pages();
  const page = existingPages[0] ?? (await session.newPage());

  let windowClosed = false;
  page.on('close', () => {
    windowClosed = true;
  });

  try {
    await page.goto(AMAZON_SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    logger.warn('amazon.login.nav.error', { error: String(err) });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (windowClosed) {
      return { loggedIn: false, detectedName: null, reason: 'cancelled' };
    }

    const state = await probeSignedInState(session, page).catch(() => null);
    if (state?.loggedIn) {
      try {
        await page.close();
      } catch {
        // ignore
      }
      return { loggedIn: true, detectedName: state.detectedName, reason: 'success' };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  try {
    await page.close();
  } catch {
    // ignore
  }
  return { loggedIn: false, detectedName: null, reason: 'timeout' };
}

export async function isLoggedInAmazon(session: DriverSession): Promise<LoginResult> {
  // Reuse the persistent context's about:blank tab so we don't add an extra
  // tab next to whatever else might be open in this session.
  const existing = session.context.pages();
  const page = existing[0] ?? (await session.newPage());
  await page.goto(AMAZON_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const state = await probeSignedInState(session, page);
  return {
    loggedIn: state.loggedIn,
    detectedName: state.detectedName,
    reason: state.loggedIn ? 'success' : undefined,
  };
}

async function probeSignedInState(
  session: DriverSession,
  page: Awaited<ReturnType<DriverSession['newPage']>>,
): Promise<{ loggedIn: boolean; detectedName: string | null }> {
  const cookies = await session.context.cookies('https://www.amazon.com');
  const hasSessionCookie = cookies.some(
    (c) => c.name === 'at-main' || c.name === 'sess-at-main' || c.name === 'x-main',
  );
  if (!hasSessionCookie) {
    return { loggedIn: false, detectedName: null };
  }

  const accountText = await page
    .locator('#nav-link-accountList-nav-line-1')
    .first()
    .textContent({ timeout: 3000 })
    .catch(() => null);
  if (!accountText) return { loggedIn: false, detectedName: null };
  const txt = accountText.trim();
  const signedOut = /^hello,?\s*sign in$/i.test(txt);
  if (signedOut) return { loggedIn: false, detectedName: null };

  const m = txt.match(/^hello,?\s+(.+)/i);
  const name = m?.[1]?.trim() ?? txt;
  return { loggedIn: true, detectedName: name };
}
