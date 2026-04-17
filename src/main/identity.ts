import { safeStorage, app } from 'electron';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { IdentityInfo } from '../shared/types.js';

type Stored = {
  apiKey: string;
  identity: IdentityInfo;
};

function dataDir(): string {
  return app.getPath('userData');
}

function identityPath(): string {
  return join(dataDir(), 'identity.bin');
}

export async function loadIdentity(): Promise<Stored | null> {
  try {
    const buf = await readFile(identityPath());
    if (!safeStorage.isEncryptionAvailable()) {
      const raw = buf.toString('utf8');
      return JSON.parse(raw) as Stored;
    }
    const decoded = safeStorage.decryptString(buf);
    return JSON.parse(decoded) as Stored;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveIdentity(stored: Stored): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const json = JSON.stringify(stored);
  if (safeStorage.isEncryptionAvailable()) {
    await writeFile(identityPath(), safeStorage.encryptString(json));
  } else {
    await writeFile(identityPath(), json, 'utf8');
  }
}

export async function clearIdentity(): Promise<void> {
  try {
    await unlink(identityPath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
