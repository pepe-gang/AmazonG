/**
 * Regex matching every Chase URL we treat as "auth needed before
 * the automation can continue." Covers the bare login redirect plus
 * the step-up auth flows Chase routes high-risk actions (large
 * redemption, payment, profile change) through. Headless runs that
 * land here would otherwise just time out — our URL check turns it
 * into an actionable "session needs refreshing" message instead.
 *
 * Patterns:
 *   /logon                  bare login page
 *   /identity-verification  step-up 2FA (one-time code, etc.)
 *   /identityProtection     alternate spelling Chase uses on some flows
 *   /auth/totp              authenticator-app entry
 *   /passwordReset          forced reset blocking dashboard access
 */
const CHASE_AUTH_URL_RE =
  /(?:\/logon|identity-verification|identityProtection|\/auth\/totp|passwordReset)/i;

/** True when the URL indicates Chase will refuse to serve dashboard
 *  data without the user typing credentials / clearing 2FA. */
export function isChaseAuthPromptUrl(url: string): boolean {
  return CHASE_AUTH_URL_RE.test(url);
}

/**
 * Pure HTML parsers for the values surfaced in the Bank-tab card
 * snapshots: rewards points balance (chaseloyalty home), current
 * credit-card balance (secure.chase.com card summary), and the
 * list of in-process payments (secure.chase.com payment-activity).
 * Each parser takes a full-page HTML string and returns the
 * displayed string(s) verbatim — no normalization beyond trim.
 *
 * Why regex over jsdom: Chase's markup classes are stable and the
 * regexes here have explicit class-name anchors, which is enough
 * for our needs and keeps these helpers usable from any context
 * (production scrape + fixture-driven unit tests) without spinning
 * up a DOM. Selectors come from MCP investigation captured in
 * tests/fixtures/chase/{summary,loyalty-home,payment-activity}.html.
 *
 * Note on quote tolerance: production page.content() returns clean
 * HTML, but our captured fixtures are JSON-encoded (so attribute
 * quotes appear as `\"`). The regexes below tolerate either form
 * by using character classes like `[\\"]+` where appropriate.
 */
import type { ChasePaymentEntry } from '../shared/types.js';

/**
 * Pull the rewards points display ("70,473 pts" / "0 pts") from a
 * loyalty home page. Empty string when the markup didn't match —
 * caller treats that as "couldn't determine."
 *
 * Primary anchor: `<div class="points zero-points">0 pts</div>` /
 * `<div class="points">70,473 pts</div>` inside the page header
 * `card-info` block. We accept any classes containing the literal
 * "points" token so a future stylistic rename of the modifier
 * (e.g. dropping "zero-points") doesn't break us.
 */
export function parsePointsBalanceFromHtml(html: string): string {
  const primary = html.match(
    /class="[^"]*\bpoints\b[^"]*"[^>]*>\s*([\d,]+(?:\.\d+)?)\s*pts\s*</i,
  );
  if (primary?.[1]) return `${primary[1]} pts`;
  // Fallback: any "<digits> pts" sequence in the document. Loose,
  // but the loyalty home is the only Chase page we'd ever feed in
  // here, and "pts" only ever appears as the rewards-points unit.
  const fallback = html.match(/([\d,]+(?:\.\d+)?)\s*pts\b/);
  if (fallback?.[1]) return `${fallback[1]} pts`;
  return '';
}

/**
 * Pull the credit-card "Current balance" amount from the secure.chase.com
 * card summary page. Returns the displayed string with sign + dollar
 * prefix preserved (e.g. "-$1,105.68" — the negative sign means the
 * card has a credit balance / nothing owed).
 *
 * Primary anchor: the recon bar markup
 *   <div class="...activity-tile__recon-bar-balance">-$1,105.68</div>
 * Fallback walks the text near a "Current balance" label.
 */
export function parseCreditBalanceFromHtml(html: string): string {
  const primary = html.match(
    /activity-tile__recon-bar-balance(?!-)[^>"]*"[^>]*>\s*(-?\$[\d,]+\.\d{2})\s*</,
  );
  if (primary?.[1]) return primary[1];
  const labelIdx = html.search(/Current\s+balance/i);
  if (labelIdx >= 0) {
    const slice = html.slice(labelIdx, labelIdx + 800);
    const fallback = slice.match(/(-?\$[\d,]+\.\d{2})/);
    if (fallback?.[1]) return fallback[1];
  }
  return '';
}

/**
 * Pull the "Pending charges" total off the summary page. This is
 * authorized-but-not-yet-posted activity (a charge that's hit the
 * authorization rails but Chase hasn't finalized into the statement
 * balance yet) — distinct from the "Current balance" recon-bar
 * value, and distinct from "in-process payments" (those are
 * outgoing payments going *down* your balance, this is incoming
 * charges that'll go *up*).
 *
 * Markup the regex anchors on:
 *   <span ...>Pending charges:&nbsp;</span>
 *   <span ...>$11,758.95</span>
 *
 * `<\\?\/span>` accepts both clean HTML (production page.content())
 * and JSON-escaped fixture form. Returns empty string when the
 * pending-charges block isn't present (no pending activity).
 */
export function parsePendingChargesFromHtml(html: string): string {
  const m = html.match(
    /Pending charges:[\s\S]{0,80}?<\\?\/span>\s*<span[^>]*>\s*(-?\$[\d,]+\.\d{2})/i,
  );
  if (m?.[1]) return m[1];
  return '';
}

/**
 * Pull the "Available credit" amount from the recon row on the
 * summary page — what the cardholder has left to spend before
 * hitting the credit limit (credit limit minus posted balance
 * minus pending charges, computed by Chase server-side).
 *
 * Markup the regex anchors on:
 *   <div ... data-testid="availableCreditWithTransferBalance">
 *     ...nested spans...
 *     <span ...>$18,709.67</span>
 *
 * The label "Available credit" sits in a sibling div before the
 * data-testid container. We anchor on the data-testid because it's
 * the more stable identifier — the label text could be rephrased
 * but Chase's testid attributes survive across redesigns.
 *
 * Fallback: walks text near the literal "Available credit" label
 * for any future Chase build that drops or renames the testid.
 */
export function parseAvailableCreditFromHtml(html: string): string {
  const primary = html.match(
    /data-testid=[\\"]+availableCreditWithTransferBalance[\\"]+[\s\S]{0,800}?(\$[\d,]+\.\d{2})/i,
  );
  if (primary?.[1]) return primary[1];
  const labelIdx = html.search(/Available\s+credit/i);
  if (labelIdx >= 0) {
    const slice = html.slice(labelIdx, labelIdx + 800);
    const fallback = slice.match(/(\$[\d,]+\.\d{2})/);
    if (fallback?.[1]) return fallback[1];
  }
  return '';
}

/**
 * Pull every payment row whose status is "In process" / "Pending" /
 * "Scheduled" / "Processing" — anything not yet finalized — out of
 * the payment-activity table on secure.chase.com.
 *
 * Row markup (quote-escaping aside):
 *   <tr>
 *     <td data-th="Payment date"><span>Apr 25, 2026</span></td>
 *     <td data-th="Status"><span>In process</span> ...</td>
 *     ...
 *     <td class="amount" data-th="Amount"><span>$13,000.00</span></td>
 *   </tr>
 *
 * Returned in the document's natural order (Chase already sorts
 * newest first). Any row with a missing field is skipped — better
 * to drop a noisy row than render half-data.
 *
 * The "in-process" filter intentionally accepts a few synonyms
 * because Chase's terminology drifts: "In process" on the credit-
 * card payment screen, "Pending" on bill-pay, "Scheduled" for
 * future-dated. Anything containing the word "complete" is
 * filtered out (post-fact, not actionable for the user).
 */
const IN_PROCESS_STATUS_RE = /\b(in[\s-]?process|pending|processing|scheduled)\b/i;
const COMPLETED_STATUS_RE = /\bcompleted\b/i;

export function parseInProcessPaymentsFromHtml(html: string): ChasePaymentEntry[] {
  const result: ChasePaymentEntry[] = [];
  // Walk every <tr>...</tr> that contains a "Payment date" cell.
  // [\s\S]*? for "any character including newlines" since the
  // target HTML has line breaks inside cells.
  const rowRegex =
    /<tr[^>]*>[\s\S]*?<td[^>]*data-th=[\\"]+Payment date[\\"]+[\s\S]*?<\/tr>/gi;
  for (const m of html.matchAll(rowRegex)) {
    const row = m[0];
    const dateMatch = row.match(
      /data-th=[\\"]+Payment date[\\"]+[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i,
    );
    const statusMatch = row.match(
      /data-th=[\\"]+Status[\\"]+[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i,
    );
    const amountMatch = row.match(
      /data-th=[\\"]+Amount[\\"]+[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i,
    );
    if (!dateMatch?.[1] || !statusMatch?.[1] || !amountMatch?.[1]) continue;
    const status = statusMatch[1].trim();
    if (COMPLETED_STATUS_RE.test(status)) continue;
    if (!IN_PROCESS_STATUS_RE.test(status)) continue;
    result.push({
      date: dateMatch[1].trim(),
      status,
      amount: amountMatch[1].trim(),
    });
  }
  return result;
}

// sumPaymentAmounts lives in src/shared/chasePayments.ts so the
// renderer can import it without crossing the main-process
// boundary; re-exported here for callers already importing from
// chaseScrape.
export { sumPaymentAmounts } from '../shared/chasePayments.js';
