import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import type { CreditCardSafe } from '../shared/types.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Encrypted-at-rest local store for the user's Amazon payment cards.
 * Drives the auto-handler for Amazon's "Verify your card" checkout
 * challenge: when /spc interrupts Place Order asking the user to
 * re-type a card's full number, the worker matches the challenge's
 * "ending in NNNN" hint against this list and fills the number.
 *
 * On disk: userData/card-vault.json
 *
 * Shape: { cards: [ { id, last4, numberEnc } ] }
 *   - numberEnc — base64 of safeStorage.encryptString(full PAN).
 *     The plaintext PAN is NEVER written to disk and NEVER logged.
 *   - last4 is plaintext — it's needed to match the challenge hint
 *     and isn't sensitive. (Cards saved before the label field was
 *     dropped may still carry a stray `label` key on disk; it's
 *     ignored on read and harmless.)
 *
 * Built on Electron's safeStorage (OS keychain — macOS Keychain,
 * Windows DPAPI, libsecret) — same mechanism as chaseCredentials.ts.
 * The PAN is only decryptable by the same OS user on the same machine.
 *
 * Renderer never receives the plaintext PAN. The IPC surface only
 * exposes the safe view ({ id, last4 }); decryption happens
 * exclusively in main-process worker code via getCardNumberByLast4.
 */

type StoredCard = {
  id: string;
  last4: string;
  numberEnc: string;
};

type StoreFile = { cards: StoredCard[] };

/** Safe view handed to the renderer — no PAN, ever. Re-exported from
 *  shared/types so renderer + IPC code can reference it. */
export type CardSafe = CreditCardSafe;

function storePath(): string {
  return join(app.getPath('userData'), 'card-vault.json');
}

async function loadAll(): Promise<StoredCard[]> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as StoreFile).cards)
    ) {
      return (parsed as StoreFile).cards;
    }
    return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function saveAll(cards: StoredCard[]): Promise<void> {
  await writeJsonAtomic(storePath(), { cards } satisfies StoreFile);
}

function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption is not available on this device — refusing to store a card number in plaintext',
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

const toSafe = (c: StoredCard): CardSafe => ({
  id: c.id,
  last4: c.last4,
});

/** Renderer-facing list — PAN stripped. */
export async function listCards(): Promise<CardSafe[]> {
  return (await loadAll()).map(toSafe);
}

/**
 * Add a card. `rawNumber` may contain spaces / dashes — they're
 * stripped before validation + storage. Returns the updated safe
 * list. Throws on an obviously invalid number so the renderer can
 * surface the error inline.
 */
export async function addCard(rawNumber: string): Promise<CardSafe[]> {
  const digits = (rawNumber ?? '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    throw new Error('card number must be 13–19 digits');
  }
  const cards = await loadAll();
  const card: StoredCard = {
    id: randomUUID(),
    last4: digits.slice(-4),
    numberEnc: encrypt(digits),
  };
  cards.push(card);
  await saveAll(cards);
  return cards.map(toSafe);
}

/** Remove a card by id. Returns the updated safe list. */
export async function removeCard(id: string): Promise<CardSafe[]> {
  const cards = await loadAll();
  const next = cards.filter((c) => c.id !== id);
  if (next.length !== cards.length) await saveAll(next);
  return next.map(toSafe);
}

/**
 * Look up a full card number by its last 4 digits. Main-process ONLY
 * — the worker's verify-card handler calls this. Never expose over
 * IPC. Returns null when no card matches or decryption fails.
 *
 * When multiple stored cards share the same last 4 (rare) the first
 * match wins — the caller logs the ambiguity.
 */
export async function getCardNumberByLast4(
  last4: string,
): Promise<string | null> {
  const cards = await loadAll();
  const match = cards.find((c) => c.last4 === last4);
  if (!match) return null;
  try {
    return decrypt(match.numberEnc);
  } catch (err) {
    logger.warn('cardVault.decryptFailed', {
      last4,
      keychainAvailable: safeStorage.isEncryptionAvailable(),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** How many stored cards share a given last4 — lets the verify-card
 *  handler log when a match was ambiguous. */
export async function countCardsByLast4(last4: string): Promise<number> {
  return (await loadAll()).filter((c) => c.last4 === last4).length;
}
