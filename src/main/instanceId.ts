/**
 * Stable per-install AmazonG instanceId, persisted to userData.
 *
 * Generated once via crypto.randomUUID() and stored in
 * `userData/instance-id.txt`. Read on every authenticated BG hit so
 * BG can detect when two AmazonG instances are active for the same
 * user (one-AmazonG-per-user model — see the migration design doc).
 *
 * NOT a security primitive. Anyone with file-system access can read
 * or overwrite. Purely a stable identifier for the detect-and-warn
 * flow; BG's atomic claim is what guarantees no duplicate orders if
 * two instances accidentally race.
 *
 * Lazy electron import so this module is safe to import from
 * non-Electron contexts (vitest, scripts).
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

let cached: string | null = null;

function userDataDir(): string | null {
  try {
    const electron = nodeRequire("electron") as typeof import("electron");
    return electron.app.getPath("userData");
  } catch {
    return null;
  }
}

/**
 * Returns this install's stable instanceId. Generates + persists on
 * first call. Same value across restarts unless the file is deleted.
 *
 * Returns the in-memory cached value after the first call so
 * filesystem I/O happens at most once per process lifetime.
 *
 * Falls back to a transient UUID (not persisted) if userData is
 * unavailable — keeps tests / scripts working without an Electron
 * context.
 */
export function getInstanceId(): string {
  if (cached !== null) return cached;
  const dir = userDataDir();
  if (!dir) {
    cached = randomUUID();
    return cached;
  }
  const path = join(dir, "instance-id.txt");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{20,}$/i.test(existing)) {
      cached = existing;
      return cached;
    }
  } catch {
    // File missing or unreadable — fall through to generate.
  }
  const fresh = randomUUID();
  try {
    writeFileSync(path, fresh, "utf8");
  } catch {
    // Persistence failure is non-fatal — we'll regenerate next start.
  }
  cached = fresh;
  return cached;
}
