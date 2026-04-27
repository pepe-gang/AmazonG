import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChaseAccountSnapshot } from '../shared/types.js';

/**
 * Local-only cache of per-profile Chase card snapshots (rewards
 * points + current credit balance + in-process payments). The Bank
 * tab reads this on mount so the card always renders the most-recent
 * values without spawning a fresh Chase window every visit. New
 * snapshots overwrite the previous row outright — we don't keep
 * history here (that's chase-redeem-history.json's job).
 *
 * On disk: userData/chase-account-snapshots.json
 *
 * Shape: { "<profileId>": ChaseAccountSnapshot, ... }
 *
 * Each public function comes in two flavors: the default uses
 * `app.getPath('userData')` (production); the `*At` variant takes
 * the file path explicitly so the logic is unit-testable without
 * mocking electron.
 */

type StoreFile = Record<string, ChaseAccountSnapshot>;

function storePath(): string {
  return join(app.getPath('userData'), 'chase-account-snapshots.json');
}

async function loadAll(filePath: string): Promise<StoreFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StoreFile;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function saveAll(filePath: string, data: StoreFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function getAccountSnapshotAt(
  filePath: string,
  profileId: string,
): Promise<ChaseAccountSnapshot | null> {
  const all = await loadAll(filePath);
  return all[profileId] ?? null;
}

export async function getAccountSnapshot(
  profileId: string,
): Promise<ChaseAccountSnapshot | null> {
  return getAccountSnapshotAt(storePath(), profileId);
}

export async function setAccountSnapshotAt(
  filePath: string,
  profileId: string,
  snapshot: ChaseAccountSnapshot,
): Promise<void> {
  const all = await loadAll(filePath);
  all[profileId] = snapshot;
  await saveAll(filePath, all);
}

export async function setAccountSnapshot(
  profileId: string,
  snapshot: ChaseAccountSnapshot,
): Promise<void> {
  return setAccountSnapshotAt(storePath(), profileId, snapshot);
}

export async function clearAccountSnapshotAt(
  filePath: string,
  profileId: string,
): Promise<void> {
  const all = await loadAll(filePath);
  if (!(profileId in all)) return;
  delete all[profileId];
  await saveAll(filePath, all);
}

export async function clearAccountSnapshot(profileId: string): Promise<void> {
  return clearAccountSnapshotAt(storePath(), profileId);
}
