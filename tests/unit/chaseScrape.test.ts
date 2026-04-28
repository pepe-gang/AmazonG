import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isChaseAuthPromptUrl,
  parseAvailableCreditFromHtml,
  parseCreditBalanceFromHtml,
  parseInProcessPaymentsFromHtml,
  parsePendingChargesFromHtml,
  parsePointsBalanceFromHtml,
  sumPaymentAmounts,
} from '../../src/main/chaseScrape.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string): string =>
  join(here, '..', 'fixtures', 'chase', name);

async function loadFixture(name: string): Promise<string> {
  return readFile(fixturePath(name), 'utf8');
}

describe('parsePointsBalanceFromHtml', () => {
  it('extracts the displayed rewards balance from the loyalty home fixture', async () => {
    const html = await loadFixture('loyalty-home.html');
    // The captured fixture is for an account with 0 pts (just
    // post-redemption). The parser must still return the formatted
    // value rather than treating "0 pts" as "no match."
    expect(parsePointsBalanceFromHtml(html)).toBe('0 pts');
  });

  it('reads a comma-separated value from the primary class anchor', () => {
    const html =
      '<div class="card-info"><div class="points">70,473 pts</div></div>';
    expect(parsePointsBalanceFromHtml(html)).toBe('70,473 pts');
  });

  it('reads a fractional points value', () => {
    const html =
      '<div class="card-info"><div class="points">7,199.82 pts</div></div>';
    expect(parsePointsBalanceFromHtml(html)).toBe('7,199.82 pts');
  });

  it('falls back to a loose "X pts" match when the class anchor is absent', () => {
    expect(parsePointsBalanceFromHtml('<span>123 pts available</span>')).toBe(
      '123 pts',
    );
  });

  it('returns empty string when nothing matches', () => {
    expect(parsePointsBalanceFromHtml('<div>no rewards info here</div>')).toBe('');
  });
});

describe('parseCreditBalanceFromHtml', () => {
  it('extracts the current balance from the summary fixture', async () => {
    const html = await loadFixture('summary.html');
    // The captured fixture shows a credit balance (Chase owes the
    // user money) of -$1,105.68 in the recon bar. The negative
    // sign is part of the displayed string and must be preserved.
    expect(parseCreditBalanceFromHtml(html)).toBe('-$1,105.68');
  });

  it('reads a positive balance from the recon-bar anchor', () => {
    const html =
      '<div class="activity-tile__recon-bar-balance">$2,345.67</div>';
    expect(parseCreditBalanceFromHtml(html)).toBe('$2,345.67');
  });

  it('does not confuse the balance value with the label class', () => {
    // The label class ends with "-balance-text"; the value class
    // ends with "-balance". The regex must distinguish them so a
    // page that interleaves both doesn't return the label.
    const html =
      '<div class="activity-tile__recon-bar-balance-text">Current balance</div>' +
      '<div class="activity-tile__recon-bar-balance">$42.00</div>';
    expect(parseCreditBalanceFromHtml(html)).toBe('$42.00');
  });

  it('falls back to a $-amount near a Current balance label', () => {
    const html =
      '<section><h2>Current balance</h2><span>$987.65</span></section>';
    expect(parseCreditBalanceFromHtml(html)).toBe('$987.65');
  });

  it('returns empty string when nothing matches', () => {
    expect(parseCreditBalanceFromHtml('<div>statement summary</div>')).toBe('');
  });
});

describe('parseInProcessPaymentsFromHtml', () => {
  it('returns only the in-process rows from the payment-activity fixture', async () => {
    const html = await loadFixture('payment-activity.html');
    const rows = parseInProcessPaymentsFromHtml(html);
    // The captured fixture has exactly one in-process payment
    // ($13,000.00 dated Apr 25, 2026); the rest are Completed.
    expect(rows).toEqual([
      { date: 'Apr 25, 2026', status: 'In process', amount: '$13,000.00' },
    ]);
  });

  it('extracts multiple in-process rows from a small synthetic table', () => {
    const html =
      '<table><tbody>' +
      '<tr><td data-th="Payment date"><span>Apr 25, 2026</span></td>' +
      '<td data-th="Status"><span>In process</span></td>' +
      '<td data-th="Amount"><span>$100.00</span></td></tr>' +
      '<tr><td data-th="Payment date"><span>Apr 24, 2026</span></td>' +
      '<td data-th="Status"><span>Pending</span></td>' +
      '<td data-th="Amount"><span>$50.00</span></td></tr>' +
      '<tr><td data-th="Payment date"><span>Apr 23, 2026</span></td>' +
      '<td data-th="Status"><span>Completed</span></td>' +
      '<td data-th="Amount"><span>$25.00</span></td></tr>' +
      '</tbody></table>';
    const rows = parseInProcessPaymentsFromHtml(html);
    expect(rows).toEqual([
      { date: 'Apr 25, 2026', status: 'In process', amount: '$100.00' },
      { date: 'Apr 24, 2026', status: 'Pending', amount: '$50.00' },
    ]);
  });

  it('skips rows missing any required field', () => {
    const html =
      '<tr><td data-th="Payment date"><span>Apr 25, 2026</span></td>' +
      '<td data-th="Status"><span>In process</span></td>' +
      // no amount cell
      '</tr>';
    expect(parseInProcessPaymentsFromHtml(html)).toEqual([]);
  });

  it('returns empty when there is no payment table', () => {
    expect(parseInProcessPaymentsFromHtml('<div>some other page</div>')).toEqual([]);
  });
});

describe('sumPaymentAmounts', () => {
  it('returns $0.00 for an empty list', () => {
    expect(sumPaymentAmounts([])).toBe('$0.00');
  });

  it('sums simple amounts', () => {
    expect(
      sumPaymentAmounts([
        { date: 'Apr 25, 2026', status: 'In process', amount: '$100.00' },
        { date: 'Apr 24, 2026', status: 'Pending', amount: '$50.50' },
      ]),
    ).toBe('$150.50');
  });

  it('handles thousands commas and large numbers', () => {
    expect(
      sumPaymentAmounts([
        { date: 'Apr 25, 2026', status: 'In process', amount: '$13,000.00' },
        { date: 'Apr 24, 2026', status: 'In process', amount: '$5,512.98' },
        { date: 'Apr 23, 2026', status: 'Pending', amount: '$200.50' },
      ]),
    ).toBe('$18,713.48');
  });

  it('preserves a negative net total', () => {
    expect(
      sumPaymentAmounts([
        { date: 'Apr 25, 2026', status: 'Pending', amount: '$100.00' },
        { date: 'Apr 24, 2026', status: 'Pending', amount: '-$250.00' },
      ]),
    ).toBe('-$150.00');
  });

  it('skips unparsable rows by treating them as zero', () => {
    expect(
      sumPaymentAmounts([
        { date: 'Apr 25, 2026', status: 'Pending', amount: '$50.00' },
        { date: 'Apr 24, 2026', status: 'Pending', amount: '' },
        { date: 'Apr 23, 2026', status: 'Pending', amount: 'not a number' },
      ]),
    ).toBe('$50.00');
  });
});

describe('parsePendingChargesFromHtml', () => {
  it('extracts the pending charges total from the summary fixture', async () => {
    const html = await loadFixture('summary.html');
    // The fixture's recon row reads "Pending charges: $11,758.95".
    expect(parsePendingChargesFromHtml(html)).toBe('$11,758.95');
  });

  it('reads a value from clean HTML', () => {
    const html =
      '<span>Pending charges:&nbsp;</span><span>$2,345.67</span>';
    expect(parsePendingChargesFromHtml(html)).toBe('$2,345.67');
  });

  it('tolerates whitespace and small markup between the label and value', () => {
    const html =
      '<span>Pending charges: </span>\n  <span class="x">$0.00</span>';
    expect(parsePendingChargesFromHtml(html)).toBe('$0.00');
  });

  it('returns empty when the pending-charges block is absent', () => {
    expect(parsePendingChargesFromHtml('<div>No pending</div>')).toBe('');
  });
});

describe('parseAvailableCreditFromHtml', () => {
  it('extracts the available credit from the summary fixture', async () => {
    const html = await loadFixture('summary.html');
    // The fixture's recon row labels Available credit and the
    // testid-anchored value is $18,709.67.
    expect(parseAvailableCreditFromHtml(html)).toBe('$18,709.67');
  });

  it('reads from clean HTML using the testid anchor', () => {
    const html =
      '<div data-testid="availableCreditWithTransferBalance">' +
      '<span>$2,345.67</span></div>';
    expect(parseAvailableCreditFromHtml(html)).toBe('$2,345.67');
  });

  it('tolerates JSON-escaped attribute quotes', () => {
    const html =
      '<div data-testid=\\"availableCreditWithTransferBalance\\">' +
      '<span>$1,000.00</span></div>';
    expect(parseAvailableCreditFromHtml(html)).toBe('$1,000.00');
  });

  it('falls back to a $-amount near the Available credit label', () => {
    const html =
      '<div>Available credit</div><div><span>$987.65</span></div>';
    expect(parseAvailableCreditFromHtml(html)).toBe('$987.65');
  });

  it('returns empty string when nothing matches', () => {
    expect(parseAvailableCreditFromHtml('<div>statement summary</div>')).toBe('');
  });
});

describe('isChaseAuthPromptUrl', () => {
  it('matches the bare login redirect', () => {
    expect(isChaseAuthPromptUrl('https://secure.chase.com/web/auth/logon')).toBe(true);
  });

  it('matches step-up identity verification', () => {
    expect(
      isChaseAuthPromptUrl(
        'https://secure.chase.com/web/auth/dashboard#/dashboard/identity-verification',
      ),
    ).toBe(true);
    expect(
      isChaseAuthPromptUrl('https://secure.chase.com/identityProtection/verify'),
    ).toBe(true);
  });

  it('matches TOTP entry and forced password reset', () => {
    expect(isChaseAuthPromptUrl('https://secure.chase.com/auth/totp')).toBe(true);
    expect(
      isChaseAuthPromptUrl('https://secure.chase.com/web/auth/passwordReset'),
    ).toBe(true);
  });

  it('does not match the normal post-login dashboard', () => {
    expect(
      isChaseAuthPromptUrl(
        'https://secure.chase.com/web/auth/dashboard#/dashboard/overview',
      ),
    ).toBe(false);
    expect(
      isChaseAuthPromptUrl(
        'https://secure.chase.com/web/auth/dashboard#/dashboard/summary/865860218/CARD/BAC',
      ),
    ).toBe(false);
  });

  it('does not match the loyalty home page', () => {
    expect(
      isChaseAuthPromptUrl('https://chaseloyalty.chase.com/home?AI=865860218'),
    ).toBe(false);
  });
});

