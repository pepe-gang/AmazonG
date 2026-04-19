import type { BrowserContext, Page } from 'playwright';
import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Error group ids used by the snapshot capture settings. Users can pick
 * which groups to capture; an empty selection means "capture all".
 */
export const ERROR_GROUPS = [
  { id: 'price_exceeded', label: 'Price exceeds max' },
  { id: 'out_of_stock', label: 'Out of stock' },
  { id: 'address_mismatch', label: 'Address not found' },
  { id: 'address_stuck', label: 'Address picker failed' },
  { id: 'cashback_low', label: 'Cashback below minimum' },
  { id: 'cashback_toggle', label: 'BG name toggle failed' },
  { id: 'buy_button', label: 'Buy Now button issue' },
  { id: 'place_order', label: 'Place Order failed' },
  { id: 'confirm_stuck', label: 'Confirmation page stuck' },
  { id: 'checkout_price', label: 'Checkout price unreadable' },
  { id: 'condition_blocked', label: 'Item condition rejected' },
  { id: 'shipping_blocked', label: 'Shipping / Prime issue' },
  { id: 'verify_failed', label: 'Order verification error' },
] as const;

export type ErrorGroupId = (typeof ERROR_GROUPS)[number]['id'];

/**
 * Classify an error message into one of the known error groups.
 * Returns null for unrecognised messages (they still get captured
 * when the user has "capture all" selected).
 */
export function classifyError(error: string): ErrorGroupId | null {
  const e = error.toLowerCase();

  // Price exceeded
  if (/exceeds (max|retail cap) \$/.test(error) || /exceeds max \$/.test(e)) return 'price_exceeded';

  // Out of stock
  if (
    e.includes('not in stock') ||
    e.includes('out of stock') ||
    e.includes('currently unavailable') ||
    e.includes('item_unavailable')
  ) return 'out_of_stock';

  // Address mismatch — no matching saved address
  if (
    e.includes('no saved address starts with') ||
    e.includes('no allowed prefixes configured')
  ) return 'address_mismatch';

  // Address stuck — picker/redirect failures
  if (
    e.includes('address picker') ||
    e.includes('address submitted but') ||
    e.includes('deliver button persisted') ||
    e.includes('change-address link not found') ||
    e.includes('did not re-render')
  ) return 'address_stuck';

  // Cashback toggle failures
  if (e.includes('name-toggle')) return 'cashback_toggle';

  // Cashback below minimum
  if (/cashback \d/.test(e) || e.includes('cashback missing')) return 'cashback_low';

  // Buy Now button
  if (
    e.includes('buy-now button never appeared') ||
    e.includes('buy now button is not available') ||
    e.includes('failed to click buy now')
  ) return 'buy_button';

  // Place Order button
  if (
    e.includes('no place order button') ||
    e.includes('failed to click place order')
  ) return 'place_order';

  // Confirmation stuck
  if (
    e.includes('pending order page') ||
    e.includes('confirmation url never loaded')
  ) return 'confirm_stuck';

  // Checkout price unreadable
  if (e.includes('could not read item price on /spc')) return 'checkout_price';

  // Condition blocked
  if (e.includes('listing is used') || e.includes('listing is amazon renewed')) return 'condition_blocked';

  // Shipping / Prime
  if (e.includes('cannot ship') || e.includes('not prime-eligible')) return 'shipping_blocked';

  // Verify failures
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

function snapshotsDir(): string {
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
  let count = 0;
  let bytes = 0;
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      try {
        const s = await stat(entryPath);
        if (!s.isDirectory()) continue;
        count += 1;
        const files = await readdir(entryPath);
        for (const file of files) {
          try {
            const fs = await stat(join(entryPath, file));
            bytes += fs.size;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { count, bytes };
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
