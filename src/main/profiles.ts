import { app } from 'electron';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AmazonProfile } from '../shared/types.js';

type Stored = {
  profiles: AmazonProfile[];
};

function filePath(): string {
  return join(app.getPath('userData'), 'profiles.json');
}

export function profileDataDir(email: string): string {
  return join(app.getPath('userData'), 'amazon-profiles', sanitizeEmail(email));
}

function sanitizeEmail(e: string): string {
  return e.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

export async function loadProfiles(): Promise<AmazonProfile[]> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Stored;
    return parsed.profiles ?? [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveProfiles(profiles: AmazonProfile[]): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  const body: Stored = { profiles };
  await writeFile(filePath(), JSON.stringify(body, null, 2), 'utf8');
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
    addedAt: new Date().toISOString(),
    lastLoginAt: null,
    loggedIn: false,
  };
}
