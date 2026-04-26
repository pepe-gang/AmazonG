import type { BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { logger } from '../shared/logger.js';
import { chaseProfileDir } from './chaseProfiles.js';

export type ChaseSession = {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

/**
 * Open a Chrome window for one Chase profile. Persistent context per
 * profile means cookies + storage survive between launches, so a
 * returning user typically only re-authenticates when Chase decides
 * the session has expired (rather than every launch).
 *
 * Notable differences from the Amazon driver:
 *
 *   - headless is hard-coded to false. The whole point is the user
 *     types credentials + responds to MFA challenges by hand.
 *   - No WebAuthn stubs. Chase uses passkeys / security keys for
 *     MFA, and the Amazon driver's stubs would block them.
 *   - Default user agent — don't spoof. Banks fingerprint UAs and a
 *     custom one is more likely to trigger extra challenges than to
 *     evade them.
 */
export async function openChaseSession(profileId: string): Promise<ChaseSession> {
  const userDataDir = chaseProfileDir(profileId);
  await mkdir(userDataDir, { recursive: true });

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  // Reuse the initial about:blank tab Playwright opens with the
  // persistent context rather than spawning a second one alongside it.
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  return {
    context,
    page,
    close: async () => {
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
