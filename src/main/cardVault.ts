import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import type {
  CreditCardSafe,
  CreditCardInput,
  CreditCardEdit,
  BillingAddress,
  SyncCard,
} from '../shared/types.js';
import { normalizeExpiry, normalizeBilling } from '../shared/cardFields.js';
import { writeJsonAtomic } from './atomicJson.js';

/**
 * Encrypted-at-rest local store for the user's Amazon payment cards.
 * Drives the "Verify your card" challenge handler and the per-account
 * card assignment used at checkout.
 *
 * On disk: userData/card-vault.json
 *
 * Shape: { cards: [ { id, label, last4, numberEnc, expiry, cvvEnc } ] }
 *   - numberEnc / cvvEnc — base64 of safeStorage.encryptString(...).
 *     The plaintext PAN + CVV are NEVER written to disk and NEVER
 *     logged. cvvEnc is null when no CVV was supplied.
 *   - label / last4 / expiry are plaintext: label + last4 drive the
 *     renderer's card dropdown, expiry (MM/YY) is low-sensitivity and
 *     also shown there.
 *
 * Legacy rows saved before this revision carry only { id, last4,
 * numberEnc } — loaded gracefully (label defaults to "Card ••NNNN",
 * expiry/cvv null).
 *
 * Built on Electron's safeStorage (OS keychain). Plaintext PAN/CVV are
 * only decryptable by the same OS user on the same machine.
 *
 * Renderer never receives the PAN or CVV — the IPC surface exposes
 * only the safe view ({ id, label, last4, expiry }).
 */

type StoredCard = {
  id: string;
  /** Optional on disk for legacy rows; toSafe() supplies a default. */
  label?: string;
  /** Cardholder name, plaintext. Absent on legacy rows. */
  cardholderName?: string;
  last4: string;
  numberEnc: string;
  /** MM/YY, plaintext. Absent on legacy rows. */
  expiry?: string | null;
  /** Encrypted CVV, or null/absent when none was supplied. */
  cvvEnc?: string | null;
  /** Billing address, plaintext. Absent on legacy rows / when none. */
  billingAddress?: BillingAddress | null;
};

type StoreFile = { cards: StoredCard[] };

/** Safe view handed to the renderer — no PAN, no CVV, ever. */
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

/** Normalize an MM/YY-ish expiry. Returns null when blank, throws on
 *  an unparseable non-blank value. */
const toSafe = (c: StoredCard): CardSafe => ({
  id: c.id,
  label: c.label?.trim() || `Card ••${c.last4}`,
  last4: c.last4,
  expiry: c.expiry ?? null,
  cardholderName: c.cardholderName?.trim() ?? '',
  billingAddress: c.billingAddress ?? null,
});

/** Renderer-facing list — PAN + CVV stripped. */
export async function listCards(): Promise<CardSafe[]> {
  return (await loadAll()).map(toSafe);
}

/**
 * Add a card. The number may contain spaces / dashes — stripped
 * before validation. `expiry` and `cvv` may be blank (stored null).
 * Returns the updated safe list. Throws on an invalid number / expiry
 * / cvv so the renderer can surface the error inline.
 */
export async function addCard(input: CreditCardInput): Promise<CardSafe[]> {
  const digits = (input.number ?? '').replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    throw new Error('card number must be 13–19 digits');
  }
  const expiry = normalizeExpiry(input.expiry ?? '');
  const cvvDigits = (input.cvv ?? '').replace(/\D/g, '');
  if (cvvDigits && (cvvDigits.length < 3 || cvvDigits.length > 4)) {
    throw new Error('CVV must be 3–4 digits');
  }
  const cards = await loadAll();
  const card: StoredCard = {
    id: randomUUID(),
    label: (input.label ?? '').trim(),
    cardholderName: (input.cardholderName ?? '').trim(),
    last4: digits.slice(-4),
    numberEnc: encrypt(digits),
    expiry,
    cvvEnc: cvvDigits ? encrypt(cvvDigits) : null,
    billingAddress: normalizeBilling(input.billingAddress),
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
 * Update a card's editable fields — label, cardholder name, expiry,
 * billing address. The card number + CVV are write-once (encrypted,
 * not readable back) and left untouched; to change those, remove and
 * re-add the card. Returns the updated safe list. Throws on an
 * invalid expiry (same as addCard).
 */
export async function updateCard(
  id: string,
  patch: CreditCardEdit,
): Promise<CardSafe[]> {
  const cards = await loadAll();
  const idx = cards.findIndex((c) => c.id === id);
  if (idx < 0) return cards.map(toSafe);
  const existing = cards[idx]!;
  cards[idx] = {
    ...existing,
    label: (patch.label ?? '').trim(),
    cardholderName: (patch.cardholderName ?? '').trim(),
    expiry: normalizeExpiry(patch.expiry ?? ''),
    billingAddress: normalizeBilling(patch.billingAddress),
  };
  await saveAll(cards);
  return cards.map(toSafe);
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

/**
 * Resolve a card's full details by vault id. Main-process ONLY — used
 * by the checkout payment-fill flow. Returns null when the id is
 * unknown or the PAN can't be decrypted. `cvv` is null when the card
 * was saved without one.
 */
export async function getFullCardById(
  id: string,
): Promise<{
  label: string;
  cardholderName: string;
  number: string;
  expiry: string | null;
  cvv: string | null;
  billingAddress: BillingAddress | null;
} | null> {
  const match = (await loadAll()).find((c) => c.id === id);
  if (!match) return null;
  try {
    return {
      label: match.label?.trim() || `Card ••${match.last4}`,
      cardholderName: match.cardholderName?.trim() ?? '',
      number: decrypt(match.numberEnc),
      expiry: match.expiry ?? null,
      cvv: match.cvvEnc ? decrypt(match.cvvEnc) : null,
      billingAddress: match.billingAddress ?? null,
    };
  } catch (err) {
    logger.warn('cardVault.fullCardDecryptFailed', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decrypt every stored card for cross-device sync. Main-process ONLY
 * — the plaintext PAN + CVV must never cross IPC. A card whose PAN
 * fails to decrypt is skipped (don't abort the whole sync on one bad
 * row). See putSync in src/bg/client.ts.
 */
export async function exportCardsWithNumbers(): Promise<SyncCard[]> {
  const cards = await loadAll();
  const out: SyncCard[] = [];
  for (const c of cards) {
    try {
      out.push({
        id: c.id,
        label: c.label?.trim() || `Card ••${c.last4}`,
        cardholderName: c.cardholderName?.trim() ?? '',
        last4: c.last4,
        number: decrypt(c.numberEnc),
        expiry: c.expiry ?? null,
        cvv: c.cvvEnc ? decrypt(c.cvvEnc) : null,
        billingAddress: c.billingAddress ?? null,
      });
    } catch (err) {
      logger.warn('cardVault.exportDecryptFailed', {
        id: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/**
 * Replace the local vault with a set pulled from BG sync. The PAN +
 * CVV are re-encrypted with THIS device's OS keychain (the synced
 * blob carries cleartext — safeStorage keys are machine-bound and
 * don't travel). Main-process ONLY.
 *
 * FIELD-PRESERVING MERGE — not a blind overwrite. A synced field is
 * applied only when it carries a value; when it's blank/null the
 * existing local value is kept. This defends against a sync round-
 * trip through a BG deploy that doesn't yet know the extended card
 * shape (label / cardholderName / expiry / cvv / billingAddress) and
 * strips those fields — without the merge, every startup pull would
 * gut a fully-entered card down to just its number.
 *
 * Returns the resulting safe list. Throws if keychain encryption is
 * unavailable (same guard as addCard) so the caller can skip the
 * apply rather than silently lose cards.
 */
export async function replaceCardsFromSync(
  cards: SyncCard[],
): Promise<CardSafe[]> {
  const prevById = new Map((await loadAll()).map((c) => [c.id, c]));
  const next: StoredCard[] = [];
  for (const c of cards) {
    const digits = (c.number ?? '').replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    const prev = c.id ? prevById.get(c.id) : undefined;
    const cvvDigits = (c.cvv ?? '').replace(/\D/g, '');
    next.push({
      id: c.id || randomUUID(),
      label: (c.label ?? '').trim() || prev?.label || '',
      cardholderName:
        (c.cardholderName ?? '').trim() || prev?.cardholderName || '',
      last4: digits.slice(-4),
      numberEnc: encrypt(digits),
      expiry: c.expiry ?? prev?.expiry ?? null,
      cvvEnc: cvvDigits ? encrypt(cvvDigits) : (prev?.cvvEnc ?? null),
      billingAddress:
        normalizeBilling(c.billingAddress) ?? prev?.billingAddress ?? null,
    });
  }
  await saveAll(next);
  return next.map(toSafe);
}
