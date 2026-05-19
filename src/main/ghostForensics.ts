import { appendFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';

/**
 * Dev-only forensic capture for the ghost-order investigation.
 *
 * When a ghost order is suspected, an investigator starts from an Amazon
 * order id + the order-detail page HTML + the account email. To trace it
 * back to the buy, they need the page state AmazonG saw around the Place
 * Order — keyed so it can be found from those starting points.
 *
 * `captureGhostForensic` writes, per `submissionId`:
 *   userData/ghost-forensics/<submissionId>/<tag>.html  — page HTML
 *   userData/ghost-forensics/<submissionId>/<tag>.png   — full-page PNG
 *   userData/ghost-forensics/<submissionId>/manifest.jsonl — one line per
 *     capture: ts, tag, profile, jobId, cartAsins, amazonPurchaseId, url
 *
 * The manifest's `cartAsins` is the bridge: given only the order-detail
 * HTML, an investigator reads the ordered ASIN(s) and matches them here.
 *
 * Gated on the packaged check (electron `app.isPackaged`) — a complete
 * no-op in the shipped app, so it adds zero cost to a real user's buys.
 * Never throws — forensics must not break a buy.
 */

const nodeRequire = createRequire(import.meta.url);

function isUnpackaged(): boolean {
  try {
    const electron = nodeRequire('electron') as typeof import('electron');
    return !electron.app.isPackaged;
  } catch {
    return false;
  }
}

function forensicsDir(submissionId: string): string | null {
  try {
    const electron = nodeRequire('electron') as typeof import('electron');
    return join(
      electron.app.getPath('userData'),
      'ghost-forensics',
      submissionId,
    );
  } catch {
    return null;
  }
}

export type ForensicMeta = {
  profile: string;
  jobId?: string | null;
  cartAsins?: string[];
  amazonPurchaseId?: string | null;
};

/**
 * Capture the current page's HTML + PNG into the submission's forensic
 * folder and append a manifest line. Dev-only; no-op when the app is
 * packaged or `submissionId` is empty. Never throws.
 */
export async function captureGhostForensic(
  page: Page,
  submissionId: string,
  tag: string,
  meta: ForensicMeta,
): Promise<void> {
  if (!submissionId || !isUnpackaged()) return;
  const dir = forensicsDir(submissionId);
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const safeTag = tag.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = join(dir, `${safeTag}.html`);
    const pngPath = join(dir, `${safeTag}.png`);
    const url = page.url();
    // Bound the page I/O. If the tab is hung — the very failure mode this
    // capture exists to investigate — page.content()/screenshot() can hang
    // forever. Race against a timeout so a capture can never stall a buy;
    // the manifest line is still written so the attempt is recorded.
    await Promise.race([
      Promise.all([
        page
          .content()
          .then((html) => writeFile(htmlPath, html, 'utf8'))
          .catch(() => undefined),
        page
          .screenshot({ path: pngPath, fullPage: true })
          .catch(() => undefined),
      ]),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    appendFileSync(
      join(dir, 'manifest.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        tag,
        submissionId,
        url,
        ...meta,
      }) + '\n',
    );
  } catch {
    // forensics must never break a buy
  }
}
