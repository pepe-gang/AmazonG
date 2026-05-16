import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import type {
  CreditCardSafe,
  CreditCardInput,
  BillingAddress,
  SyncCard,
} from '../shared/types.js';
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

/** Trim a billing address; an all-blank one collapses to null. */
function normalizeBilling(
  b: BillingAddress | null | undefined,
): BillingAddress | null {
  if (!b) return null;
  const t = (s: string | undefined) => (s ?? '').trim();
  const out: BillingAddress = {
    fullName: t(b.fullName),
    line1: t(b.line1),
    line2: t(b.line2),
    city: t(b.city),
    state: t(b.state),
    zip: t(b.zip),
    country: t(b.country) || 'US',
    phone: t(b.phone),
  };
  const hasContent = out.fullName || out.line1 || out.city || out.zip;
  return hasContent ? out : null;
}

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
function normalizeExpiry(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*\/?\s*(\d{2,4})$/);
  if (!m || !m[1] || !m[2]) throw new Error('expiry must look like MM/YY');
  const mm = m[1].padStart(2, '0');
  const yy = m[2].slice(-2);
  if (Number(mm) < 1 || Number(mm) > 12) {
    throw new Error('expiry month must be 01–12');
  }
  return `${mm}/${yy}`;
}

const toSafe = (c: StoredCard): CardSafe => ({
  id: c.id,
  label: c.label?.trim() || `Card ••${c.last4}`,
  last4: c.last4,
  expiry: c.expiry ?? null,
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
 * Replace the entire local vault with a set pulled from BG sync. The
 * PAN + CVV are re-encrypted with THIS device's OS keychain (the
 * synced blob carries cleartext — safeStorage keys are machine-bound
 * and don't travel). Main-process ONLY.
 *
 * Wholesale replace: on a sync pull BG is the source of truth.
 * Returns the resulting safe list. Throws if keychain encryption is
 * unavailable (same guard as addCard) so the caller can skip the
 * apply rather than silently lose cards.
 */
export async function replaceCardsFromSync(
  cards: SyncCard[],
): Promise<CardSafe[]> {
  const next: StoredCard[] = [];
  for (const c of cards) {
    const digits = (c.number ?? '').replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    const cvvDigits = (c.cvv ?? '').replace(/\D/g, '');
    next.push({
      id: c.id || randomUUID(),
      label: (c.label ?? '').trim(),
      cardholderName: (c.cardholderName ?? '').trim(),
      last4: digits.slice(-4),
      numberEnc: encrypt(digits),
      expiry: c.expiry ?? null,
      cvvEnc: cvvDigits ? encrypt(cvvDigits) : null,
      billingAddress: normalizeBilling(c.billingAddress),
    });
  }
  await saveAll(next);
  return next.map(toSafe);
}
