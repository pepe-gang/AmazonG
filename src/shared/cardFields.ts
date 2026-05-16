import type { BillingAddress } from './types.js';

/**
 * Pure helpers for normalizing saved-card fields. Kept electron-free
 * so they're unit-testable in isolation (tests/unit/cardFields.test.ts)
 * — cardVault.ts (storage) and buyNow.ts (the checkout add-card flow)
 * both use them.
 */

/**
 * Normalize an MM/YY-ish expiry to canonical "MM/YY". Returns null
 * for a blank value; throws on a non-blank value that can't be
 * parsed (so the caller can surface the error inline).
 */
export function normalizeExpiry(raw: string): string | null {
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

/**
 * Split an expiry into the values Amazon's add-card form expects:
 * `month` unpadded ("1".."12") and `year` 4-digit ("2028"). Accepts
 * "MM/YY" or "MM/YYYY"; returns null for blank/unparseable input.
 */
export function splitExpiry(
  expiry: string | null | undefined,
): { month: string; year: string } | null {
  const m = (expiry ?? '').trim().match(/^(\d{1,2})\s*\/?\s*(\d{2,4})$/);
  if (!m || !m[1] || !m[2]) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return { month: String(month), year: `20${m[2].slice(-2)}` };
}

/**
 * Trim a billing address; an all-blank one collapses to null.
 * Country defaults to 'US' when empty.
 */
export function normalizeBilling(
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
