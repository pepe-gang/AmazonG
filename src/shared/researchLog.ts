/**
 * Append-only JSONL writer for research-mode events.
 *
 * Used by experimental code paths (currently: surgical cashback recovery)
 * to record detailed per-step state we'll mine later for patterns.
 *
 * **Fires ONLY when `process.env.NODE_ENV === 'development'`.** Production
 * builds compile this to a no-op call so the writer never lands research
 * data on real users' machines or BG. The dev-only gate is checked at
 * call time, not module init, so a `npm run dev` session writes events
 * even after settings are loaded.
 *
 * Each event is one JSONL line under
 * `userData/research-logs/<streamName>.jsonl`. Streams are append-only;
 * the writer never reads or rotates them. Manual cleanup if files grow
 * large (typical: ~2KB per event, ~50-100 events/day in heavy dev).
 *
 * Errors swallowed — research data is non-critical. A failed write must
 * never affect the buy flow.
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Allowlist of research streams. Add a new stream by adding its name
 * here AND documenting its payload schema in
 * `docs/research/research-streams/<streamName>.md`. The allowlist
 * exists so a typo in a `streamName` doesn't silently land events
 * in a never-mined "default" file.
 */
const ALLOWED_STREAMS = new Set<string>([
  'cashback-experiments',
]);

function isDevMode(): boolean {
  // Check at call time, not module init, so changes to NODE_ENV during
  // a long-running dev session take effect. (Unlikely but cheap.)
  return process.env.NODE_ENV === 'development';
}

/**
 * Lazy `electron.app` lookup so non-Electron contexts (vitest, scripts)
 * don't crash importing this module. Returns null when Electron's
 * userData path isn't reachable — callers treat that as research-
 * disabled and skip the write.
 */
async function getUserDataDir(): Promise<string | null> {
  try {
    const electron = await import('electron');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (electron as any).app?.getPath?.('userData') ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one JSONL event to the named stream. No-op when not in dev mode
 * or when streamName isn't allowlisted. Never throws — research logging
 * must never affect the buy flow.
 *
 * Schema versioning is the caller's responsibility — include a
 * `schemaVersion` field in `payload` so future analysis can interpret
 * older events.
 */
export async function appendResearchEvent(
  streamName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isDevMode()) return;
  if (!ALLOWED_STREAMS.has(streamName)) {
    console.warn(
      `[researchLog] streamName "${streamName}" not in allowlist; event dropped`,
    );
    return;
  }
  try {
    const userData = await getUserDataDir();
    if (!userData) return; // non-Electron context (test, script)
    const dir = join(userData, 'research-logs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${streamName}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n';
    await appendFile(path, line, 'utf8');
  } catch {
    // Swallow — research is non-critical.
  }
}
