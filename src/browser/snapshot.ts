import type { BrowserContext, Page } from 'playwright';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

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
 * Delete all snapshot directories. Returns number of dirs removed.
 * Called from jobStore.clearAll() — wipes the snapshot folder when the
 * user clears the attempts table. Captures only happen in dev mode, so
 * this is a no-op for packaged installs (no snapshots to delete).
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
