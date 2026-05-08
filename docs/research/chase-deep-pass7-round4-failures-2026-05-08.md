# Chase Stage C — production failure modes audit (round 4 / pass 7)

**Date:** 2026-05-08
**Status:** research only
**Scope:** what fails in production with Stage C (single-nav + `page.evaluate(fetch)` parallel batch) that today's Stage B (per-card nav + passive `page.on('response')` listener + DOM fallback) handles robustly.
**Sources:** `chaseDriver.ts:1284-1612` (Stage B today), `docs/research/chase-mcp-direct-fetch-2026-05-08.md` (the new finding), `docs/research/chase-perf-pass4-deep-research-2026-05-07.md` (14 correctness issues), `docs/research/chase-perf-pass3-roadmap-2026-05-07.md` (Akamai cookie filter), `docs/research/chase-session-pass6-deep-2026-05-07.md` (sensor mechanics), `research-logs/chase-xhr-*.jsonl` (live captures), `.research/dashboard-module-list-overview.json` (parsed shape), Playwright `types.d.ts` (page.evaluate signature — **no timeout option**).

## TL;DR

Stage C is **brittle by construction**: it replaces five forgiving fallback layers (passive listener + selector wait + DOM scrape + `extract*` JSON helpers + per-card retry) with one declarative chain of `fetch().then(r => r.json())` that throws or returns sentinel-less garbage on any drift. Today's Stage B has nine distinct ways to recover from a flaky Chase response; Stage C has zero by default. The four highest-severity new failure modes are: (1) **`page.evaluate(fetch())` has no built-in timeout** — a stuck connection blocks indefinitely (Playwright `evaluate` overload has no `options` param, confirmed in `types.d.ts`); (2) **`r.json()` throws on Akamai HTML 403** — un-handled rejection drops the entire batch; (3) **JSON shape drift returns empty array, not error** — silent partial corruption; (4) **`Promise.all` rejects on first failure** — one transient 500 nukes 12 good responses. All four are fixable with ~30 LOC of defensive shape inside `page.evaluate`. The mitigation list at the end is what MUST ship before Stage C is production-safe.

---

## Failure-mode table — trigger → today vs Stage C → mitigation

| # | Trigger | Stage B (today) | Stage C (proposed, naive) | Mitigation |
|---|---------|------------------|----------------------------|------------|
| F1 | One rewards fetch returns transient 500 | Listener never fires for that card → DOM fallback path → caller sees em-dash for points only; balance still scraped | `Promise.all` rejects → `page.evaluate` throws → all 13 cards' data lost | Use `Promise.allSettled` inside the `evaluate`; map per-card to {ok, value} or {ok:false, reason} |
| F2 | Chase returns Akamai HTML 403 (bot-manager rejection) for the overview fetch | Listener `resp.json()` throws in catch, `xhrJson.dashboard` stays null, DOM fallback fires | `await r.json()` throws inside `evaluate` → entire batch fails; caller sees "page.evaluate: SyntaxError: Unexpected token <" | Read `r.headers.get('content-type')` first; if not `application/json`, return `{httpStatus, bodyHead: text.slice(0,512)}` |
| F3 | Chase ships SPA refactor renaming `cardAccountOverviews` → `creditCardAccountOverviews` | We use BOTH listener-cached JSON path AND DOM fallback (`extractDashboardDetail` returns null → DOM `.activity-tile__recon-bar-balance` scrape) | Parser returns `[]` because the field name no longer matches. **Indistinguishable from "user has 0 cards."** Caller saves empty snapshot, UI shows "—" for every field | Sentinel: `data.overviewJson?.code !== 'SUCCESS'` OR `cache` array missing OR no entry whose `url` includes `/overview/card/v2/list`. If sentinel fails, log `chase.snapshot.stageC.shapeDrift` + fall through to Stage B |
| F4 | Auth cookies expired between launch and `page.evaluate` (e.g., `_abck` invalidated mid-batch on a "protected action") | Mid-batch nav surfaces `/logon` redirect → `maybeAutoLoginAndContinue` recovers + re-fires the nav for the failing card | `Promise.all` returns 14 responses with mixed shapes — some `{code:'SUCCESS',...}`, some Akamai HTML, some `{code:'ACCOUNTS:AuthorizationException'}`. We parse the SPA-error one as "no cards" (F3) | Per-fetch shape check; if all fetches return SPA-error or Akamai-403, treat as session-expired; fire `maybeAutoLoginAndContinue` once and retry the whole `evaluate` |
| F5 | Page navigated mid-batch (user clicked Login on Bank tab while Stage C was running) | Per-card listener guarded by `xhrJson.X === null` check; if context torn down, listener never fires; DOM fallback may succeed on the new page | `evaluate` throws `Execution context was destroyed` → batch fails → caller surfaces uncaught | Wrap `page.evaluate(...)` in try/catch; treat "context destroyed" / "Target closed" as a special transient-recoverable kind |
| F6 | One slow Chase 504 hangs a single fetch indefinitely | 6s deadline ceiling on listener wait (`xhrsLandedDeadline = Date.now() + 6_000` in chaseDriver.ts:1387) | **`page.evaluate` has no timeout** (Playwright API confirmed); `Promise.all` blocks until Chase TCPs RST or default browser timeout (~5 min). Renderer spinner grinds. | Inside `evaluate`: `fetch(url, { signal: AbortSignal.timeout(8000) })`. Per-fetch ceiling. Map AbortError to `{ok:false, reason:'timeout'}` |
| F7 | Akamai 403 with body `<html>...captcha</html>`, content-type `text/html` | Listener catches the JSON-parse failure silently, falls to DOM scrape (which itself shows the Chase login overlay → `maybeAutoLoginAndContinue` recovers) | `r.json()` throws; even if caught, we have nothing typed to fall back to (no DOM scrape ran) | Dual-path: if any of the 14 fetches returns Akamai-403 shape, kill the batch + run `maybeAutoLoginAndContinue` + Stage B fallback for this run |
| F8 | SPA's own first XHR (`dashboard/module/list`) and ours race; Chase returns 429 to the second one | Stage B has a single nav, single listener, single XHR — no race | Two parallel POSTs to identical URL/body within ~10ms; HTTP/2 deduplication is a server-discretion thing — if Chase 429s the duplicate we lose the overview | **Wait for the SPA's own request to land first** (single page.on('response') listen for the same URL pattern), THEN fire ours from `page.evaluate`. Adds ~200-300ms but avoids the race entirely. Alternative: only fire the rewards fetches in parallel; let the SPA's overview listener catch the overview JSON (Stage C-lite) |
| F9 | `_abck` invalidates DURING Stage C's burst (14 fetches in <1s might count as a "protected action" that triggers rotation per pass-6 finding) | Stage B fires only 2 XHRs per nav (Chase's own SPA), spread across ~3-5s | Mid-batch fetches use a now-stale `_abck` → fail with Akamai-403 mid-batch | Defer rewards fetches behind the overview fetch (sequential gate); use shorter burst (~3 in flight, not 13). Or: empirically test this with a 13-card profile and only ship if no mid-batch invalidation observed |
| F10 | `Promise.all` of 13 rewards fetches saturates HTTP/2 stream slots; Chase returns ECONNRESET | Stage B never has 13 concurrent fetches | Each `r.json()` throws connection error | Concurrency cap inside `evaluate`: process rewards in chunks of 4 with sequential gates |
| F11 | `chase-account-snapshots.json` write contention (two snapshot saves race) | At Stage B's 5-13s/card cadence, races are rare | At Stage C's ~5s/profile cadence + 13 cards updated in a single save, a Refresh-All across 3 profiles can race three saveAll() calls concurrently | **Write-temp-rename helper MUST ship first** (pass-4 audit #1, #3, #4). Without this, Stage C's 30-50× speedup amplifies the corruption window |
| F12 | Force-quit during `page.evaluate(fetch)` mid-flight | session.close() doesn't run; `attachSessionAutoSave` 60s flush captured cookies up to ~60s ago | Same — but the in-flight fetches are abandoned without any chance to drain | Don't change behavior; just confirm the auto-save cadence still covers (it does — fetches are <1s, flush is 60s) |
| F13 | Renderer rapid-fires Refresh All while a Stage C run is in flight | TTL gate (`SNAPSHOT_FRESHNESS_TTL_MS`, index.ts:1802) returns cached; `coalesceSnapshot` dedupes by id | Same TTL gate works; same coalesce. Stage C inherits this safety | No new mitigation needed (verify still works) |
| F14 | Chase rotates `cardAccountId` after a card replacement (real-world: lost card → new acct id) | Stage B per-card nav uses the stored `cardAccountId`; if invalid, summary page rejects, we surface error | Stage C has the SAME problem PLUS: rewards-fetch body is hardcoded `accountId=${id}` so if the stored id is stale, the rewards endpoint may 404 silently while overview returns full data for the new id | Detect "rewards 404 but overview SUCCESS" and treat as "card-id drift"; surface to user |
| F15 | `maybeAutoLoginAndContinue` is called AFTER `domcontentloaded` but BEFORE Akamai sensor JS has run | Stage B's per-card nav fires sensor JS multiple times; one of the navs always lands a clean sensor | Stage C does ONE nav and immediately pivots to fetch. If the dashboard URL redirects to /logon, `maybeAutoLoginAndContinue` runs; but if it lands on /dashboard with a valid-looking shell BUT a stale-cookie state, our fetch sees Akamai-403 | After `maybeAutoLoginAndContinue` returns `recovered: true`, wait for the SPA's first `dashboard/module/list` XHR before firing ours (proves `_abck` is fresh) |
| F16 | `localStorage` device-trust JWT was dropped on a previous force-quit (pass-6 round 3 — `indexedDB:true` is OFF) | Affects login frequency, same in both stages | Same | Out of scope for this round; pass-6 has the fix |

---

## Detection patterns (false-positive-resistant signals)

### D1 — "JSON shape drift" detection (F3, F4)

The single most important sentinel. The current `extractDashboardDetail` helper (chaseDriver.ts ~line 1406) just returns `null` on miss; today that triggers DOM fallback. Stage C has no fallback — silent empty render.

**Required positive sentinel** (must ALL be true to accept the response as "real, schema-matching" before parsing card data):

```ts
const ok =
  json
  && json.code === 'SUCCESS'                           // Chase API contract
  && Array.isArray(json.cache)                          // shape root exists
  && json.cache.some(c =>                               // expected entry present
    c?.url?.includes('/overview/card/v2/list')
    && c?.response?.code === 'SUCCESS'
    && Array.isArray(c.response.cardAccountOverviews)
  );
```

**Empirically grounded**: confirmed against `.research/dashboard-module-list-overview.json`:
- Top-level `code` is `SUCCESS` (verified)
- 1 occurrence of `cardAccountOverviews` (verified)
- 3 occurrences of `customerId` (3 customer entries — multi-customer profiles exist, drift signal)

**False-positive resistance**: this is a 3-field positive assertion (root code, root cache array, nested cache entry). No realistic Chase change will preserve all three while breaking field names. If Chase renames `cardAccountOverviews` to `creditCardAccountOverviews`, the URL `/overview/card/v2/list` must also have changed (paired refactor) — both signals would flip together, sentinel correctly fires.

**Remediation when sentinel fails**: log `chase.snapshot.stageC.shapeDrift` with the URL list of `cache[].url` so we know what the new path is, then fall back to Stage B per-card nav for THIS run.

### D2 — "Akamai 403" vs "SPA 401/403" vs "rate-limit" disambiguation (F2, F4, F7)

Different bodies for the same 4xx status. Distinguishing matters for UX:

| Source | HTTP status | content-type | Body | UX |
|--------|-------------|--------------|------|-----|
| Akamai bot-manager | 403 | `text/html` | `<html>...captcha or "Access Denied"...</html>` | "Stage B fallback engaged" + retry |
| Chase SPA auth-check | 401 OR 403 | `application/json` | `{"code":"ACCOUNTS:AuthorizationException",...}` | "Sign in to Chase" |
| Chase rate limiter | 429 | `application/json` OR header-only | minimal JSON | "Try again in 30s" |
| Chase 5xx | 500/502/504 | mixed | error page or empty | "Chase is down" + retry |

**Disambiguation order** (inside `evaluate`):

```ts
const r = await fetch(url, opts);
const ct = r.headers.get('content-type') || '';
const status = r.status;
let body: any = null;
let bodyText: string | null = null;
if (ct.includes('application/json')) {
  try { body = await r.json(); }
  catch { body = null; bodyText = '[json parse failed]'; }
} else {
  // HTML / text — DON'T call r.json(). Capture first 512 chars for diagnosis.
  try { bodyText = (await r.text()).slice(0, 512); } catch { bodyText = null; }
}
return { ok: r.ok, status, ct, body, bodyText };
```

**On the main-process side** (after `page.evaluate` returns):

```ts
type FetchOutcome =
  | { kind: 'akamai_403'; status: number; bodyText: string }
  | { kind: 'auth_required'; status: number; spaCode: string }   // ACCOUNTS:AuthorizationException
  | { kind: 'rate_limit'; status: 429 }
  | { kind: 'server_error'; status: 5xx }
  | { kind: 'ok'; data: ChaseModuleList };

function classify(r: { status: number; ct: string; body: any; bodyText: string | null }): FetchOutcome {
  if (r.status === 200 && r.body?.code === 'SUCCESS') return { kind: 'ok', data: r.body };
  if (r.status === 429) return { kind: 'rate_limit', status: 429 };
  if (r.status >= 500) return { kind: 'server_error', status: r.status };
  if (r.status === 401 || r.status === 403) {
    if (r.body?.code?.startsWith('ACCOUNTS:') || r.body?.code === 'UNAUTHORIZED') {
      return { kind: 'auth_required', status: r.status, spaCode: r.body.code };
    }
    // 403 with HTML body, OR no body, OR Akamai-shaped — assume Akamai
    if (!r.ct.includes('application/json')) {
      return { kind: 'akamai_403', status: r.status, bodyText: r.bodyText ?? '' };
    }
    // 403 with empty JSON body — still treat as Akamai (the SPA always sends a code)
    return { kind: 'akamai_403', status: r.status, bodyText: '' };
  }
  // Anything else — log + treat as server_error
  return { kind: 'server_error', status: r.status };
}
```

**Critical**: `r.body?.code?.startsWith('ACCOUNTS:')` is the SPA-vs-Akamai discriminator. The dashboard JSON we captured uses `code: 'SUCCESS'`; the auth/cookie failures observed at MaxxRK/chaseinvest-api use `ACCOUNTS:AuthorizationException`.

### D3 — "Stage C parser broken" vs "user has no cards" (F3)

Both look like `cards.length === 0`. Discriminator:

```ts
function isEmptyResultSuspicious(json, expectedCardIds: number[]): boolean {
  // We're feeding cardAccountIds into Stage C — if we expected at least one card
  // and got back zero from a 200 SUCCESS response, that's parser failure (not "no cards")
  return expectedCardIds.length > 0 && cards.length === 0;
}
```

**Caller already knows the expected card IDs** (from `chase-profiles.json`, the `cardAccountId` field). If we asked for 13 and got 0 with `code: 'SUCCESS'`, that's drift, not data. Log + Stage B fallback.

### D4 — "Mid-batch sensor invalidation" detection (F9)

If the first fetch in the batch returns `code: 'SUCCESS'` but later ones return Akamai-403, infer that `_abck` rotated mid-burst. **Signal**: at least one `ok` AND at least one `akamai_403` in the same `Promise.allSettled` result.

```ts
const results = await page.evaluate(...);  // [{kind: 'ok'|'akamai_403'|...}, ...]
const oks = results.filter(r => r.kind === 'ok').length;
const akamai = results.filter(r => r.kind === 'akamai_403').length;
if (oks > 0 && akamai > 0) {
  logger.warn('chase.snapshot.stageC.midBatchSensorRotation', { oks, akamai });
  // Fall back to Stage B for the failed cards, OR retry the whole batch with delay
}
```

### D5 — Pre-flight context check (F5)

Before firing the `evaluate`, verify the page is still alive:

```ts
if (page.isClosed()) return { ok: false, reason: 'context closed', kind: 'transient' };
const ctx = page.context();
if (ctx === null) return { ok: false, reason: 'context destroyed', kind: 'transient' };
```

(`page.isClosed()` is the canonical check — Playwright surfaces it before throwing.)

---

## Recovery patterns

### R1 — Auth-required (D2: `auth_required` OR all-akamai-403)

1. Log `chase.snapshot.stageC.authRequired`.
2. Fire `maybeAutoLoginAndContinue(page, profileId)` once.
3. If recovered: re-run the entire `page.evaluate` batch ONCE.
4. If still failed: return `{ok:false, reason:'session expired', kind:'session-expired'}`.

This matches Stage B's recovery — the difference is Stage C's recovery happens INSIDE the runFetch, not on a per-card nav.

### R2 — Akamai 403 (D2: `akamai_403`, but NOT all-of-batch)

The bot-manager flagged ONE specific request, but our session is otherwise fine. Stage B's response: silent failure → DOM fallback. Stage C's response: per-card retry with a 1-2s delay (gives `_abck` time to rotate) before bailing to Stage B.

### R3 — Rate limit 429 (D2: `rate_limit`)

Surface to the user with a "try again in 30s" hint. Don't retry automatically (could compound the throttle). The renderer already classifies `/rate.?limit/i` as `kind: 'rate-limit'`.

### R4 — Server 5xx (D2: `server_error`)

Treat as transient: retry once after 1.5s, then bail. Stage B has no equivalent retry — Stage C can be slightly MORE robust here because it's cheaper.

### R5 — Shape drift (D1, D3)

1. Log `chase.snapshot.stageC.shapeDrift` with the unknown `cache[].url` keys.
2. Fall back to Stage B for THIS profile's run (lose the 30× speedup but don't show empty data).
3. Optionally: also fire a "phone home" log line so we can detect Chase SPA refactors centrally.

### R6 — Per-card partial failure (F1)

`Promise.allSettled` returns mixed results. For each card:
- If overview ok + rewards ok → full snapshot
- If overview ok + rewards failed → snapshot with empty `pointsBalance` + log
- If overview failed → no snapshot for this card (skip in the save batch, leave previous on disk)

Renderer already shows em-dash for missing fields, so this degrades gracefully.

---

## Pre-flight checks before firing Stage C fetch

A 7-line guard at the top of `runFetchStageC`. Each check has a specific failure mode it prevents:

```ts
// Pre-flight: refuse to run Stage C if any of these is unsafe.
async function preflightStageC(page: Page, profileId: string): Promise<PreflightResult> {
  // 1. Page is still alive (F5 / D5)
  if (page.isClosed()) return { ok: false, reason: 'page closed', kind: 'transient' };

  // 2. We're not on /logon or an OTP page (F4 / F15)
  //    Note: maybeAutoLoginAndContinue already covers this — just don't skip it.
  const recovery = await maybeAutoLoginAndContinue(page, profileId);
  if (!recovery.recovered) return { ok: false, reason: recovery.reason, kind: 'session-expired' };

  // 3. URL is on the Chase auth shell origin (defensive — guards against a
  //    cross-site nav that left us on chase.com instead of secure.chase.com)
  const u = page.url();
  if (!u.startsWith('https://secure.chase.com/')) {
    return { ok: false, reason: `unexpected origin ${new URL(u).origin}`, kind: 'unknown' };
  }

  // 4. SPA shell has hydrated enough to have a valid `_abck` cookie. The
  //    pass-6 finding: `_abck` is "solved" after 3 successful sensor POSTs.
  //    Best proxy we have: wait for ANY `secure.chase.com/svc/` XHR to complete
  //    successfully — that proves auth + sensor are both live.
  const sentinelPromise = page.waitForResponse(
    r => r.url().includes('/svc/') && r.status() === 200,
    { timeout: 8_000 }
  ).catch(() => null);
  const sentinelOk = (await sentinelPromise) !== null;
  if (!sentinelOk) {
    return { ok: false, reason: 'spa hydration sentinel never landed', kind: 'transient' };
  }

  return { ok: true };
}
```

**Why the SPA sentinel matters**: empirical capture (chase-xhr-capture-findings) showed Chase's SPA fires `dashboard/module/list` itself within ~3-5s of page load. If we wait for THAT to land before firing our own fetch, three things are true:
1. `_abck` is fresh (just used successfully)
2. Auth cookies are validated (server returned 200)
3. Our fetch will be the SECOND identical request, not first — eliminates the F8 race entirely

**Cost**: ~3-5s of waiting. **Stage C still wins** because the 13 rewards fetches (today: ~130s sequential, tomorrow: ~150ms parallel) dwarf the 3-5s sentinel cost.

---

## Specific sentinel checks for JSON shape drift

These are the runtime assertions that flag drift before we save garbage:

```ts
// Before parsing the multi-card overview:
function assertOverviewShape(json: unknown, expectedCardIds: number[]): asserts json is OverviewResponse {
  if (!isObject(json)) throw new ShapeError('overview', 'not-object');
  if (json.code !== 'SUCCESS') throw new ShapeError('overview', `code=${json.code}`);
  if (!Array.isArray(json.cache)) throw new ShapeError('overview', 'no-cache-array');

  const overviewEntry = json.cache.find((c: any) =>
    c?.url?.includes('/overview/card/v2/list')
  );
  if (!overviewEntry) throw new ShapeError('overview', 'no-overview-cache-entry');
  if (overviewEntry.response?.code !== 'SUCCESS')
    throw new ShapeError('overview', `entry-code=${overviewEntry.response?.code}`);

  const cardOverviews = overviewEntry.response?.cardAccountOverviews;
  if (!Array.isArray(cardOverviews))
    throw new ShapeError('overview', 'no-cardAccountOverviews');

  // The killer drift check: did we get back AT LEAST ONE of the cards we expected?
  const flatCards = cardOverviews.flatMap((co: any) => co.cardAccounts ?? []);
  const returnedIds = new Set(flatCards.map((c: any) => c.accountId));
  const missing = expectedCardIds.filter(id => !returnedIds.has(id));
  // Tolerate ONE missing card (could be a closed account dropped server-side).
  // Refuse if MORE than half the cards are missing — that's drift, not data.
  if (missing.length > expectedCardIds.length / 2) {
    throw new ShapeError('overview', `${missing.length}/${expectedCardIds.length} cards missing`);
  }

  // Spot-check the per-card detail object — confirm at least the load-bearing fields exist
  const sampleDetail = flatCards[0]?.cardAccountDetail;
  if (!sampleDetail) throw new ShapeError('overview', 'no-cardAccountDetail-on-sample');
  if (typeof sampleDetail.currentBalance !== 'number')
    throw new ShapeError('overview', 'currentBalance-not-number');
  // (deliberately lenient — only assert the load-bearing fields; the wider field
  // set from pass-4 is opportunistic and missing fields render as em-dash)
}

// Before parsing rewards:
function assertRewardsShape(json: unknown, cardId: number): asserts json is RewardsResponse {
  if (!isObject(json)) throw new ShapeError('rewards', 'not-object');
  if (json.code !== 'SUCCESS') throw new ShapeError('rewards', `code=${json.code}`);
  if (!Array.isArray(json.cardRewardsSummary))
    throw new ShapeError('rewards', 'no-cardRewardsSummary');
  // Don't assert on length: a card with no rewards eligibility can return [].
  // But if non-empty, the summary must have currentRewardsBalance as a number.
  if (json.cardRewardsSummary.length > 0
      && typeof json.cardRewardsSummary[0].currentRewardsBalance !== 'number') {
    throw new ShapeError('rewards', 'currentRewardsBalance-not-number');
  }
}
```

The "tolerate ONE missing card" + "more-than-half-missing fails" heuristic is the right balance:
- Closed accounts being silently filtered server-side is a real Chase behavior (see `closed: true` in the captured JSON for the user's Ink Preferred card)
- A genuine schema rename would drop ~all cards, far above 50%

---

## What MUST ship for Stage C to be production-safe

In dependency order. The first three are **gates** — Stage C cannot ship without them. The rest are recommended.

### Tier 0 — gates (Stage C is unsafe without these)

| # | Change | Reason | LOC |
|---|--------|--------|-----|
| **G1** | **Write-temp-rename helper** for `chase-account-snapshots.json` (and the other chase-*.json files per pass-4 audit #1, #3, #4) | Stage C's 30-50× faster snapshot write makes today's race window dramatically wider. Force-quit during the multi-card save = corrupted snapshot file = next launch reads garbage = silent total data loss | ~30 |
| **G2** | **Per-fetch timeout via AbortSignal** inside `page.evaluate` | `page.evaluate` has NO timeout (Playwright API confirmed). One stuck Chase 504 hangs the entire batch indefinitely. Today's Stage B has the 6s `xhrsLandedDeadline` ceiling; Stage C has nothing | ~15 |
| **G3** | **Sentinel + Stage B fallback** when shape drift detected (D1, D3) | Without this, a Chase SPA refactor silently writes empty snapshots for every user. Today's Stage B has DOM-scrape fallback; Stage C has zero | ~40 |

### Tier 1 — production correctness (ship same PR as Stage C)

| # | Change | Reason | LOC |
|---|--------|--------|-----|
| **P1** | `Promise.allSettled` (not `Promise.all`) inside `evaluate` | One transient 500 fails the whole batch otherwise | ~10 |
| **P2** | content-type guard before `r.json()` | Akamai HTML 403 throws today → uncaught | ~15 |
| **P3** | SPA sentinel wait (D5/preflight #4) — wait for the SPA's first `dashboard/module/list` before firing ours | Eliminates F8 race; ensures `_abck` is fresh; eliminates F9 mid-batch rotation risk | ~30 |
| **P4** | Per-fetch outcome classifier (D2) returning `{kind, status, body}` | Single source of truth for UX disambiguation; renderer's `classifySnapshotErrorKind` can't currently distinguish auth-vs-akamai-vs-ratelimit | ~50 |
| **P5** | Recovery flow R1: detect "all auth_required" → run `maybeAutoLoginAndContinue` once → retry batch once | Stage B's auto-retry is at the per-card nav level; Stage C needs an equivalent at the batch level | ~30 |
| **P6** | "Stage B fallback" code path triggered by R5 / G3 | Lose the 30× speedup, don't show empty data | ~50 (mostly reuses existing Stage B) |
| **P7** | Concurrency cap on rewards fetches (max 4 in flight) | Avoids saturating HTTP/2 stream slots / triggering Akamai burst-detection | ~15 |

**Tier 0+1 bundle: ~285 LOC.** Higher than the original Stage C estimate (~120 LOC) — the production-safety machinery is real cost. Worth it: the 30-50× speedup on multi-card profiles is a transformative UX improvement.

### Tier 2 — observability (ship in v0.13.30 hardening pass)

| # | Change | Reason |
|---|--------|--------|
| O1 | Structured `chase.snapshot.stageC.*` log events for each failure class (drift, akamai_403, auth_required, rate_limit, server_error) | Lets us see Stage C health in the wild without users reporting |
| O2 | Per-fetch latency capture (start/end inside `evaluate`, return alongside the response) | Calibrate the per-fetch timeout (G2) over time |
| O3 | Sample-rate "phone home" log on shape drift — tell us when Chase ships a new SPA before users notice | Low-cost early warning |

### Tier 3 — defer

| # | Change | Why defer |
|---|--------|-----------|
| D1 | Pre-warmed Stage C session pool | Pass-3 already deemed not-worth-it; ship Stage C single-shot first |
| D2 | Empirical `_abck` rotation test with 13-card profile | Defer until we have a 13-card test profile available; ship Tier 0+1 with Promise.allSettled which contains the F9 blast radius |
| D3 | ETag / If-None-Match support | Verified from research-logs: Chase POST endpoints don't send ETag. POST is uncacheable per HTTP spec. Not applicable. |

---

## Specific findings from the questions in the charter

### Q1 — Race: SPA's first XHR vs ours

**Answer**: Fire ours AFTER the SPA's first `dashboard/module/list` lands. Three reasons:
1. Confirms `_abck` is fresh (sensor JS just ran successfully)
2. Confirms auth cookies are valid (server returned 200)
3. Eliminates the duplicate-request race entirely (Chase's HTTP/2 may dedupe; may not; depends on body-hash collision)

Cost: ~3-5s wait. Still Stage C-fast on multi-card profiles because the wins compound across 13 rewards fetches.

### Q2 — Cookie state at `domcontentloaded`

`domcontentloaded` does NOT mean Akamai sensor JS has run — it fires when the HTML is parsed but before all scripts have executed. Reliable signal for "now safe to fetch": **the SPA's own first authenticated `/svc/` XHR landing 200** (Q1's mitigation).

`waitUntil: 'load'` would be marginally safer but still doesn't guarantee sensor solved. The empirical "3 sensor POSTs to be solved" rule (pass-6) means even `load` is too early sometimes.

### Q3 — Auth-cookie expiry mid-fetch

**`maybeAutoLoginAndContinue` has a built-in 1.5s settle window** (chaseDriver.ts:920-933) — it polls 5× × 300ms looking for the auth signal AFTER `domcontentloaded`. This handles the "redirect in flight" case correctly TODAY.

**But** Stage C should call `maybeAutoLoginAndContinue` BEFORE firing the parallel fetch batch (preflight check #2 above), exactly like Stage B does. The structure already works — just inherit it.

The new failure mode is mid-batch expiry: cookies were fine when batch started, expired during the 200ms window. Mitigation: per-fetch outcome classifier (P4) detects auth-required across the batch and triggers R1.

### Q4 — Distinguishing 401/403/429

Solved by D2's classifier. Key insight: **content-type is the Akamai-vs-SPA discriminator.**

### Q5 — JSON shape drift

Solved by D1/D3 sentinels. Key insight: **the "expected card IDs" set is the strongest sentinel** — caller knows we asked for 13, got back 0, that's drift not data.

### Q6 — `Promise.all` partial failure

Use `Promise.allSettled`. Per-card UX: the renderer already shows em-dash for missing fields. A failed rewards fetch leaves `pointsBalance: ''` — same as today's "rewards XHR didn't land" path.

### Q7 — Memory / CDP boundary

Verified: 13-card overview JSON is `~78KB` (`.research/dashboard-module-list-overview.json` is 77,986 bytes). Plus 13 rewards responses at ~1KB each = ~91KB total returned across CDP. **Not a concern** — Playwright routinely returns multi-MB DOM evaluations. Serialization is `JSON.stringify` round-trip; 100KB serializes in single-digit ms.

### Q8 — Akamai sensor stale within session

Same TLS session = same cookie jar. Playwright shares cookies between in-page fetch and any `page.context().cookies()` read. The risk is server-side rotation (Akamai mid-batch issuing a new `_abck` and invalidating the old). Mitigation: P3 (SPA sentinel) ensures fresh `_abck` BEFORE the burst; P7 (concurrency cap of 4) keeps the burst within tolerance; D4 detects mid-batch rotation if it does happen.

### Q9 — `page.evaluate` timeout

**`page.evaluate(pageFunction, arg)` does not accept an options object** (verified in Playwright `types.d.ts` — only `(pageFunction)` or `(pageFunction, arg)` overloads, no `(pageFunction, arg, options)`). There is NO built-in timeout for a Promise returned from `evaluate`. The only way to bound the wait is **inside** the evaluate, with `AbortSignal.timeout(N)` per fetch (G2). Recommended: 8s per fetch.

### Q10 — `maybeAutoLoginAndContinue` recovery

Already correctly fires after the single nav (chaseDriver.ts:1017-1022 in `runRedeemFlow` shows the pattern). The function itself is page-context-aware — it works on `/web/auth/dashboard/overview` exactly as it does on `/web/auth/dashboard#/dashboard/summary/X/CARD/BAC`. No adjustment needed.

The only nuance: if `maybeAutoLoginAndContinue` returns `recovered: true`, the auth flow re-navigated the page. Stage C's preflight needs to re-establish the SPA-sentinel wait AFTER the recovery, not before.

### Q11 — Akamai 403 → HTML body

`await r.json()` on a `text/html` response throws `SyntaxError: Unexpected token < in JSON at position 0`. **Today's Stage B path is robust** because the listener has `try { await resp.json() } catch {}`. **Stage C is NOT robust** unless we mirror that pattern (P2: content-type check first).

### Q12 — In-flight fetch when context closes

`evaluate` throws `Error: Execution context was destroyed, most likely because of a navigation` or `Target page, context or browser has been closed`. Today's Stage B is also vulnerable but the user closing a snapshot-fetch context mid-flight is rare (the windows are always-headed for snapshot fetch, but the user typically isn't looking at them; the fetch is fire-and-forget triggered by a Bank-tab click). Mitigation: catch + map to `{ok:false, reason:'context closed', kind:'transient'}`.

### Q13 — Concurrent-write to chase-profiles.json

**Critical**: ship G1 (write-temp-rename) BEFORE Stage C. Without it, Stage C's 30-50× speedup compresses today's "race rarely" into "race often." A Refresh All across 3 profiles after Stage C ships writes the snapshot file 3× in <2s instead of 3× in 30s — well within the 50-200ms `writeFile` window.

### Q14 — ETag / If-None-Match

**Verified from research-logs**: no `etag` or `if-none-match` headers in any captured `secure.chase.com/svc/*` request or response. POST endpoints are uncacheable per HTTP spec — Chase doesn't ship cache headers because there's no semantic for caching a "give me the current balance" POST. Repeated Stage C fetches will always hit the origin. Not applicable.

---

## Confidence scorecard

| Finding | Confidence | Source |
|---------|-----------|--------|
| `page.evaluate` has no timeout option | High | Playwright `types.d.ts` direct read — only `(fn)` and `(fn, arg)` overloads exist |
| `r.json()` on HTML throws | High | Standard Fetch API behavior |
| Chase POST endpoints don't ship ETag | High | All 3 research-logs JSONLs — searched, none found |
| Mid-batch `_abck` rotation risk | Medium | Pass-6 says "after protected actions"; whether 14 fetches in <1s qualifies as protected is unverified. Mitigation P7 is precautionary |
| Akamai 403 returns HTML | High | Cross-confirmed across 3 sources (pass-3 roadmap, web research, MaxxRK) |
| SPA-first-XHR-landed is a sufficient sensor signal | Medium-high | Strong proxy but not 100% guarantee. Better than `domcontentloaded`, weaker than "wait 5s" |
| Promise.all partial failure shape | High | Standard JS spec |
| Write-contention is real | Medium | Pass-4 audit flagged it; Stage C amplifies but exact race window is OS-dependent |
| Shape-drift sentinel false-positive rate | Medium | Three positive assertions are robust BUT we haven't tested against a real Chase refactor |
| `cardAccountId` rotation on card replacement (F14) | Low-medium | Theoretical — no captured evidence — but the failure mode is plausible |

---

## Bottom line

Stage C is a **30-50× speedup with structural fragility**. The fragility is not "advanced" — it's first-order: a single thrown exception, one stuck connection, one renamed JSON field, one mid-batch sensor rotation can corrupt every card's data. Stage B has had years to grow the nine fallback layers that absorb these. Stage C must reach feature parity on RECOVERY before it ships, even at a higher LOC cost than naïve Stage C.

**Minimum viable Stage C ship plan:**

1. **Pre-req PR (v0.13.29)**: G1 + S2 (write-temp-rename helper, pass-4 audit). 30 LOC. Must ship and bake before Stage C.
2. **Stage C PR (v0.13.30)**: G2 + G3 + P1 + P2 + P3 + P4 + P5 + P6 + P7. ~285 LOC. Behind a feature flag (`AUTOG_CHASE_STAGE_C=1`) for the first release; flip to on-by-default in v0.13.31 after a week of beta.
3. **Hardening PR (v0.13.31)**: O1 + O2 + O3 — observability for production health.

The 30-50× speedup is real and worth the engineering. Just do it with the safety machinery that Stage B already has, not without.
