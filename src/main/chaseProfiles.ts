import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChaseProfile } from '../shared/types.js';

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
 * Filesystem-safe directory for a given profile's persistent context.
 * UUIDs are already safe (hex + dashes), but the strip is defensive in
 * case ids ever come from elsewhere — never trust an id you didn't
 * generate yourself.
 */
export function chaseProfileDir(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  return join(app.getPath('userData'), 'chase-profiles', safe);
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
 * block the metadata write that the UI depends on.
 */
export async function removeChaseProfile(id: string): Promise<ChaseProfile[]> {
  const list = await loadChaseProfiles();
  const filtered = list.filter((p) => p.id !== id);
  await saveChaseProfiles(filtered);
  await rm(chaseProfileDir(id), { recursive: true, force: true }).catch(
    () => undefined,
  );
  return filtered;
}
