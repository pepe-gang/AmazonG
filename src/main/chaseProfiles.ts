import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChaseProfile } from '../shared/types.js';

// re-exported below alongside chaseProfileDir; centralised so the
// driver doesn't have to know about path layout.

/**
 * Local-only store for Chase login profiles. Mirrors the shape of the
 * Amazon profile store but kept entirely separate — different threat
 * model (real-money writes pending), different lifecycle, no BG sync.
 *
 * On disk:
 *   userData/chase-profiles.json          → metadata array
 *   userData/chase-profiles/{id}/         → per-profile Playwright user-data
 *
 * Profile ids are UUIDs generated locally; the dir name is sanitized
 * to alphanumerics + dashes before use as a filesystem path so a
 * malformed id can't escape the userData root via traversal.
 */

function metadataPath(): string {
  return join(app.getPath('userData'), 'chase-profiles.json');
}

/**
 * Sanitize a profile id for use as a filesystem path component.
 * Strips anything outside [a-zA-Z0-9-]. Throws if the result is
 * empty so the caller never gets back a value that resolves to
 * the parent directory — an empty component combined with
 * `join(userData, 'chase-profiles', '')` yields `chase-profiles/`,
 * and a recursive `rm` on that path would wipe every profile.
 *
 * UUIDs from `randomUUID()` are already safe; the strip + throw is
 * defensive insurance against any future code path that hands an
 * id from an untrusted source.
 */
export function sanitizeChaseProfileId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) {
    throw new Error(
      `unsafe chase profile id: ${JSON.stringify(id)} (no safe characters)`,
    );
  }
  return safe;
}

/**
 * Filesystem-safe directory for a given profile's persistent context.
 */
export function chaseProfileDir(id: string): string {
  return join(app.getPath('userData'), 'chase-profiles', sanitizeChaseProfileId(id));
}

/**
 * Per-profile storageState JSON dump path. Sits next to the
 * Playwright user-data dir, not inside it, so it doesn't get picked
 * up as Chromium profile data. We dump cookies + origin storage
 * here on every session close because launchPersistentContext's
 * SQLite store silently drops session cookies (cookies without
 * Expires/Max-Age) — and Chase's auth tokens are predominantly
 * session cookies, so without this dump the user appears
 * "logged out" on every relaunch even though persistence "worked".
 */
export function chaseSessionStatePath(id: string): string {
  return join(
    app.getPath('userData'),
    'chase-profiles',
    `${sanitizeChaseProfileId(id)}.session.json`,
  );
}

export async function loadChaseProfiles(): Promise<ChaseProfile[]> {
  try {
    const raw = await readFile(metadataPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ChaseProfile[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function saveChaseProfiles(list: ChaseProfile[]): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(metadataPath(), JSON.stringify(list, null, 2), 'utf8');
}

export async function createChaseProfile(label: string): Promise<ChaseProfile[]> {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('label required');
  const list = await loadChaseProfiles();
  list.push({
    id: randomUUID(),
    label: trimmed,
    loggedIn: false,
    lastLoginAt: null,
    cardAccountId: null,
    createdAt: new Date().toISOString(),
  });
  await saveChaseProfiles(list);
  return list;
}

export async function updateChaseProfile(
  id: string,
  patch: Partial<Omit<ChaseProfile, 'id' | 'createdAt'>>,
): Promise<ChaseProfile[]> {
  const list = await loadChaseProfiles();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return list;
  const existing = list[idx];
  if (!existing) return list;
  list[idx] = { ...existing, ...patch };
  await saveChaseProfiles(list);
  return list;
}

/**
 * Delete the metadata row AND the per-profile user-data dir, since
 * leaving cookies on disk after the user removed the profile defeats
 * the point of "remove". Best-effort on the dir removal — a failure
 * (e.g. another Chromium process still has files open) shouldn't
 * block the metadata write that the UI depends on. Also clears the
 * adjacent storageState dump file so a re-add genuinely starts fresh.
 */
export async function removeChaseProfile(id: string): Promise<ChaseProfile[]> {
  const list = await loadChaseProfiles();
  const filtered = list.filter((p) => p.id !== id);
  await saveChaseProfiles(filtered);
  await Promise.all([
    rm(chaseProfileDir(id), { recursive: true, force: true }).catch(
      () => undefined,
    ),
    rm(chaseSessionStatePath(id), { force: true }).catch(() => undefined),
  ]);
  return filtered;
}
