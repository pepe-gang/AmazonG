import type { BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NavigationError } from '../shared/errors.js';

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
  const userDataDir = join(opts.userDataRoot, sanitizeProfile(profile));
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

  return {
    profile,
    context,
    async newPage() {
      return await context.newPage();
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
      await context.close();
    },
  };
}

function sanitizeProfile(p: string): string {
  return p.replace(/[^a-zA-Z0-9@._-]/g, '_');
}
