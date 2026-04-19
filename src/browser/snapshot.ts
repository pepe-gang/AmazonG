import type { BrowserContext, Page } from 'playwright';
import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { ErrorGroupId } from '../shared/snapshotGroups.js';

/**
 * Classify an error message into one of the known error groups.
 * Returns null for unrecognised messages (they still get captured
 * when the user has "capture all" selected).
 */
export function classifyError(error: string): ErrorGroupId | null {
  const e = error.toLowerCase();

  if (/exceeds (max|retail cap) \$/.test(error) || /exceeds max \$/.test(e)) return 'price_exceeded';
  if (e.includes('not in stock') || e.includes('out of stock') || e.includes('currently unavailable') || e.includes('item_unavailable')) return 'out_of_stock';
  if (e.includes('no saved address starts with') || e.includes('no allowed prefixes configured')) return 'address_mismatch';
  if (e.includes('address picker') || e.includes('address submitted but') || e.includes('deliver button persisted') || e.includes('change-address link not found') || e.includes('did not re-render')) return 'address_stuck';
  if (e.includes('name-toggle')) return 'cashback_toggle';
  if (/cashback \d/.test(e) || e.includes('cashback missing')) return 'cashback_low';
  if (e.includes('buy-now button never appeared') || e.includes('buy now button is not available') || e.includes('failed to click buy now')) return 'buy_button';
  if (e.includes('no place order button') || e.includes('failed to click place order')) return 'place_order';
  if (e.includes('pending order page') || e.includes('confirmation url never loaded')) return 'confirm_stuck';
  if (e.includes('could not read item price on /spc')) return 'checkout_price';
  if (e.includes('listing is used') || e.includes('listing is amazon renewed')) return 'condition_blocked';
  if (e.includes('cannot ship') || e.includes('not prime-eligible')) return 'shipping_blocked';
  if (e.startsWith('verify:')) return 'verify_failed';

  return null;
}

/**
 * Whether we should capture a snapshot for this error, given the current
 * settings. Returns true when capture is enabled and the error's group
 * is in the selected set (or the set is empty = capture all).
 */
export function shouldCapture(
  error: string,
  snapshotOnFailure: boolean,
  snapshotGroups: string[],
): boolean {
  if (!snapshotOnFailure) return false;
  if (snapshotGroups.length === 0) return true; // empty = all
  const group = classifyError(error);
  // null group (unrecognised) is captured when "all" is selected (empty array)
  // but skipped when specific groups are chosen
  if (!group) return false;
  return snapshotGroups.includes(group);
}

export type SnapshotResult = {
  screenshotPath: string;
  htmlPath: string;
  tracePath: string | null;
};

export function snapshotsDir(): string {
  return join(app.getPath('userData'), 'attempt-snapshots');
}

export function snapshotDir(attemptId: string): string {
  return join(snapshotsDir(), attemptId);
}

/**
 * Start Playwright tracing on a context. Call before the job runs so the
 * trace captures every network request, DOM mutation, and action.
 * Best-effort — failures are silently ignored.
 */
export async function startTracing(context: BrowserContext): Promise<void> {
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
  } catch {
    // tracing not supported or already started — ignore
  }
}

/**
 * Stop tracing without saving. Used on success paths where we don't
 * need the trace data.
 */
export async function discardTracing(context: BrowserContext): Promise<void> {
  try {
    await context.tracing.stop();
  } catch {
    // ignore
  }
}

/**
 * Capture a full-page screenshot, HTML snapshot, and Playwright trace
 * for a failed attempt. Returns paths on success, null if capture fails
 * (best-effort).
 */
export async function captureFailureSnapshot(
  page: Page,
  attemptId: string,
  context?: BrowserContext,
): Promise<SnapshotResult | null> {
  try {
    const dir = snapshotDir(attemptId);
    await mkdir(dir, { recursive: true });
    const screenshotPath = join(dir, 'screenshot.png');
    const htmlPath = join(dir, 'page.html');
    const tracePath = join(dir, 'trace.zip');
    await Promise.all([
      page.screenshot({ path: screenshotPath, fullPage: true }),
      page.content().then((html) => writeFile(htmlPath, html, 'utf8')),
    ]);
    // Stop tracing and save the trace file. This must happen after
    // screenshot/HTML so those captures aren't blocked by trace I/O.
    let savedTrace: string | null = null;
    if (context) {
      try {
        await context.tracing.stop({ path: tracePath });
        savedTrace = tracePath;
      } catch {
        // tracing wasn't started or already stopped — no trace file
      }
    }
    return { screenshotPath, htmlPath, tracePath: savedTrace };
  } catch {
    return null;
  }
}

/**
 * Calculate disk usage of all snapshot directories.
 * Returns { count: number of attempt dirs, bytes: total size }.
 */
export async function snapshotsDiskUsage(): Promise<{ count: number; bytes: number }> {
  const dir = snapshotsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, bytes: 0 };
    throw err;
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const entryPath = join(dir, entry);
        const s = await stat(entryPath);
        if (!s.isDirectory()) return { count: 0, bytes: 0 };
        const files = await readdir(entryPath);
        const sizes = await Promise.all(
          files.map((f) => stat(join(entryPath, f)).then((s) => s.size).catch(() => 0)),
        );
        return { count: 1, bytes: sizes.reduce((a, b) => a + b, 0) };
      } catch { return { count: 0, bytes: 0 }; }
    }),
  );
  return results.reduce((acc, r) => ({ count: acc.count + r.count, bytes: acc.bytes + r.bytes }), { count: 0, bytes: 0 });
}

/**
 * Delete all snapshot directories. Returns number of dirs removed.
 * Job rows and logs are kept — only the heavy debug files go away.
 */
export async function clearAllSnapshots(): Promise<number> {
  const dir = snapshotsDir();
  let count = 0;
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      try {
        await rm(join(dir, entry), { recursive: true, force: true });
        count += 1;
      } catch { /* skip */ }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return count;
}
