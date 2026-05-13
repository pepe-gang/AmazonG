import { app } from 'electron';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomicJson.js';
import type { AmazonProfile } from '../shared/types.js';
import { sanitizeProfileKey } from '../shared/sanitize.js';

type Stored = {
  profiles: AmazonProfile[];
};

function filePath(): string {
  return join(app.getPath('userData'), 'profiles.json');
}

export function profileDataDir(email: string): string {
  return join(app.getPath('userData'), 'amazon-profiles', sanitizeProfileKey(email));
}

export async function loadProfiles(): Promise<AmazonProfile[]> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Stored;
    const list = parsed.profiles ?? [];
    // Backfill fields for profiles persisted before they shipped.
    //  - `headless`: defaults to true (matches app-wide default).
    //  - `buyWithFillers`: defaults to false (opt-in feature).
    //  - `autoBuy`: defaults to true (preserves prior behavior — every
    //    enabled account claimed buy jobs before this field existed).
    //  - `bgAddress`: defaults to null (opt-in, user fills in per profile).
    return list.map((p) => ({
      ...p,
      headless: p.headless ?? true,
      buyWithFillers: p.buyWithFillers ?? false,
      autoBuy: p.autoBuy ?? true,
      bgAddress: p.bgAddress ?? null,
    }));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveProfiles(profiles: AmazonProfile[]): Promise<void> {
  const body: Stored = { profiles };
  await writeJsonAtomic(filePath(), body);
}

export async function upsertProfile(p: AmazonProfile): Promise<AmazonProfile[]> {
  const list = await loadProfiles();
  const idx = list.findIndex((x) => x.email.toLowerCase() === p.email.toLowerCase());
  if (idx >= 0) list[idx] = { ...list[idx], ...p };
  else list.push(p);
  await saveProfiles(list);
  return list;
}

export async function updateProfile(
  email: string,
  patch: Partial<AmazonProfile>,
): Promise<AmazonProfile[]> {
  const list = await loadProfiles();
  const idx = list.findIndex((x) => x.email.toLowerCase() === email.toLowerCase());
  if (idx < 0) return list;
  const existing = list[idx];
  if (!existing) return list;
  list[idx] = { ...existing, ...patch };
  await saveProfiles(list);
  return list;
}

export async function removeProfile(email: string): Promise<AmazonProfile[]> {
  const list = (await loadProfiles()).filter(
    (x) => x.email.toLowerCase() !== email.toLowerCase(),
  );
  await saveProfiles(list);
  try {
    await rm(profileDataDir(email), { recursive: true, force: true });
  } catch {
    // ignore
  }
  return list;
}

export function newProfile(email: string, displayName?: string): AmazonProfile {
  return {
    email,
    displayName: displayName ?? null,
    enabled: true,
    autoBuy: true,
    addedAt: new Date().toISOString(),
    lastLoginAt: null,
    loggedIn: false,
    headless: true,
    buyWithFillers: false,
    bgAddress: null,
  };
}

/**
 * Reorder profiles to match `orderedEmails`. Profiles not in the list keep
 * their relative order at the end (defensive against stale UI calls).
 */
export async function reorderProfiles(
  orderedEmails: string[],
): Promise<AmazonProfile[]> {
  const list = await loadProfiles();
  const lower = (s: string) => s.toLowerCase();
  const indexOf = new Map(orderedEmails.map((e, i) => [lower(e), i]));
  const sorted = [...list].sort((a, b) => {
    const ai = indexOf.get(lower(a.email));
    const bi = indexOf.get(lower(b.email));
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
  await saveProfiles(sorted);
  return sorted;
}
