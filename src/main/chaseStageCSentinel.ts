/**
 * Positive-signal validator for the Stage C overview response.
 *
 * Stage C (PR2, not yet shipped) replaces the per-card snapshot-fetch
 * loop with a single direct fetch of
 * `/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD`,
 * extracting cards from the cached `/svc/rr/.../overview/card/v2/list`
 * response. If Chase ships a SPA refactor that renames a field, our
 * parser silently returns an empty array — indistinguishable from
 * "this customer has no cards." This validator catches that case so
 * the caller can fall through to Stage B's passive-listener path.
 *
 * Returns `{ ok: true }` only when ALL of the following hold:
 *   - top-level shape matches the documented contract (`code: 'SUCCESS'`,
 *     `cache` array)
 *   - the `/overview/card/v2/list` cache entry exists and is itself
 *     `code: 'SUCCESS'`
 *   - `cardAccountOverviews` is a non-empty array yielding ≥1 card
 *   - if `expectedCardIds` is provided, ≥half of the expected ids
 *     appear in the response (defends against partial-data drift that
 *     returns 1 card when we know the customer has 13)
 *
 * Source for the schema: `.research/dashboard-module-list-overview.json`
 * (live capture 2026-05-08) + `docs/research/chase-mcp-direct-fetch-2026-05-08.md`.
 */

export type StageCSentinelResult =
  | { ok: true; cardCount: number }
  | { ok: false; reason: string };

export function validateStageCOverviewShape(
  json: unknown,
  expectedCardIds?: ReadonlySet<string>,
): StageCSentinelResult {
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'response-not-object' };
  }
  const root = json as Record<string, unknown>;
  if (root.code !== 'SUCCESS') {
    return { ok: false, reason: `root-code-${String(root.code)}` };
  }
  if (!Array.isArray(root.cache)) {
    return { ok: false, reason: 'missing-cache-array' };
  }
  const overviewEntry = (root.cache as Array<Record<string, unknown>>).find(
    (c) =>
      typeof c?.url === 'string' && c.url.includes('/overview/card/v2/list'),
  );
  if (!overviewEntry) {
    return { ok: false, reason: 'missing-overview-cache-entry' };
  }
  const response = overviewEntry.response as
    | Record<string, unknown>
    | undefined;
  if (!response || response.code !== 'SUCCESS') {
    return {
      ok: false,
      reason: `overview-response-code-${String(response?.code)}`,
    };
  }
  const groups = response.cardAccountOverviews;
  if (!Array.isArray(groups)) {
    return { ok: false, reason: 'cardAccountOverviews-not-array' };
  }
  const cards = groups.flatMap((g) => {
    const ga = g as Record<string, unknown>;
    return Array.isArray(ga.cardAccounts) ? (ga.cardAccounts as unknown[]) : [];
  });
  if (cards.length === 0) {
    return { ok: false, reason: 'cardAccountOverviews-empty' };
  }
  if (expectedCardIds && expectedCardIds.size > 0) {
    const seen = new Set<string>();
    for (const c of cards as Array<Record<string, unknown>>) {
      if (c.accountId !== undefined && c.accountId !== null) {
        seen.add(String(c.accountId));
      }
    }
    const overlap = [...expectedCardIds].filter((id) => seen.has(id)).length;
    if (overlap * 2 < expectedCardIds.size) {
      return {
        ok: false,
        reason: `expected-card-overlap-${overlap}-of-${expectedCardIds.size}`,
      };
    }
  }
  return { ok: true, cardCount: cards.length };
}
