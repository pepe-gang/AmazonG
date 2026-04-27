import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChaseRedeemEntry } from '../shared/types.js';

/**
 * Local-only history of automated Chase redemptions, keyed by Chase
 * profile id. We persist only successful runs — failed attempts are
 * surfaced live in the UI but not retained, since the user can re-
 * trigger and there's nothing recoverable from a failed redemption.
 *
 * On disk: userData/chase-redeem-history.json
 *
 * Shape:
 *   { "<profileId>": ChaseRedeemEntry[], ... }
 *
 * Each public function comes in two flavors: the default uses
 * `app.getPath('userData')` to resolve the file path (production);
 * the `*At` variant takes the file path explicitly so the logic is
 * unit-testable without mocking electron.
 */

type HistoryFile = Record<string, ChaseRedeemEntry[]>;

function historyPath(): string {
  return join(app.getPath('userData'), 'chase-redeem-history.json');
}

async function loadAll(filePath: string): Promise<HistoryFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HistoryFile;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function saveAll(filePath: string, data: HistoryFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Most-recent-first list of past redemptions for one profile. */
export async function listRedeemHistoryAt(
  filePath: string,
  profileId: string,
): Promise<ChaseRedeemEntry[]> {
  const all = await loadAll(filePath);
  const list = all[profileId] ?? [];
  return [...list].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export async function listRedeemHistory(
  profileId: string,
): Promise<ChaseRedeemEntry[]> {
  return listRedeemHistoryAt(historyPath(), profileId);
}

/** Append a new redemption row. Idempotent on (profileId, orderNumber)
 *  so a duplicate IPC fire (or a retry after a transient log save fail)
 *  doesn't double-count. Empty orderNumber falls through and always
 *  appends — better to over-record than lose a real redemption. */
export async function appendRedeemEntryAt(
  filePath: string,
  profileId: string,
  entry: ChaseRedeemEntry,
): Promise<void> {
  const all = await loadAll(filePath);
  const list = all[profileId] ?? [];
  if (entry.orderNumber) {
    const existing = list.find((e) => e.orderNumber === entry.orderNumber);
    if (existing) return;
  }
  list.push(entry);
  all[profileId] = list;
  await saveAll(filePath, all);
}

export async function appendRedeemEntry(
  profileId: string,
  entry: ChaseRedeemEntry,
): Promise<void> {
  return appendRedeemEntryAt(historyPath(), profileId, entry);
}

/** Drop all history for one profile. Used when removeChaseProfile
 *  fires so a re-add starts with a clean slate. */
export async function clearRedeemHistoryAt(
  filePath: string,
  profileId: string,
): Promise<void> {
  const all = await loadAll(filePath);
  if (!(profileId in all)) return;
  delete all[profileId];
  await saveAll(filePath, all);
}

export async function clearRedeemHistory(profileId: string): Promise<void> {
  return clearRedeemHistoryAt(historyPath(), profileId);
}
