import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Encrypted-at-rest local store for Chase username + password,
 * keyed by Chase profile id. Built on Electron's safeStorage which
 * uses the OS keychain (macOS Keychain, Windows DPAPI, libsecret on
 * Linux) to wrap the encryption keys — so the password is only
 * decryptable by the same OS user who saved it, on the same
 * machine, after they've logged in.
 *
 * On disk: userData/chase-credentials.json
 *
 * Shape: { "<profileId>": { u: base64-encrypted-username,
 *                           p: base64-encrypted-password } }
 *
 * Why a separate file from chase-profiles.json:
 *   - Smaller blast radius if the JSON file is ever sent somewhere
 *     it shouldn't be (logs, support bundles, screenshots). Profile
 *     metadata is innocuous; credentials are not.
 *   - Different lifecycle — clearing credentials shouldn't require
 *     mutating the profile row.
 *
 * Renderer never sees the plaintext. Only main-process code calls
 * `getChaseCredentials`; the IPC surface only exposes set / clear /
 * has (boolean). Logs never include the values.
 */

type StoredEntry = { u: string; p: string };
type StoreFile = Record<string, StoredEntry>;

export type ChaseCredentials = {
  username: string;
  password: string;
};

function storePath(): string {
  return join(app.getPath('userData'), 'chase-credentials.json');
}

async function loadAll(): Promise<StoreFile> {
  try {
    const raw = await readFile(storePath(), 'utf8');
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

async function saveAll(data: StoreFile): Promise<void> {
  await mkdir(dirname(storePath()), { recursive: true });
  await writeFile(storePath(), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Encrypt a string with the OS keychain and return base64 for
 * JSON-safe storage. Throws when safeStorage isn't available
 * (rare on macOS; possible in CI / Linux without a desktop session).
 */
function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption is not available on this device — refusing to store credentials in plaintext',
    );
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(b64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is not available on this device');
  }
  return safeStorage.decryptString(Buffer.from(b64, 'base64'));
}

/** Save (or overwrite) credentials for one Chase profile. */
export async function setChaseCredentials(
  profileId: string,
  creds: ChaseCredentials,
): Promise<void> {
  const all = await loadAll();
  all[profileId] = {
    u: encrypt(creds.username),
    p: encrypt(creds.password),
  };
  await saveAll(all);
}

/**
 * Read + decrypt credentials for one profile. Returns null when
 * nothing is stored. Caller must be in the main process; never
 * surface this through any IPC path.
 */
export async function getChaseCredentials(
  profileId: string,
): Promise<ChaseCredentials | null> {
  const all = await loadAll();
  const row = all[profileId];
  if (!row) return null;
  try {
    return {
      username: decrypt(row.u),
      password: decrypt(row.p),
    };
  } catch {
    // Decryption failure usually means the OS user changed or the
    // keychain item was removed externally. Nothing we can do —
    // surface as "no credentials" so the caller falls back to
    // manual login.
    return null;
  }
}

/** Boolean check used by the renderer to decide whether to show
 *  "Set credentials" vs "Update / Clear." */
export async function hasChaseCredentials(profileId: string): Promise<boolean> {
  const all = await loadAll();
  return Boolean(all[profileId]);
}

/** Drop credentials for one profile. Used when removeChaseProfile
 *  fires + when the user explicitly clicks "Clear credentials". */
export async function clearChaseCredentials(profileId: string): Promise<void> {
  const all = await loadAll();
  if (!(profileId in all)) return;
  delete all[profileId];
  await saveAll(all);
}
