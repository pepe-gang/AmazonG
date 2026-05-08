# Chase Stage C — Round 3: AmazonG architecture impact audit

**Date:** 2026-05-08
**Status:** research only — nothing shipped from this pass
**Builds on:** `chase-mcp-direct-fetch-2026-05-08.md` (the Stage C finding) + pass-3 roadmap + pass-4 widening
**Charter:** trace how a 1-fetch-per-profile model ripples through every IPC, storage, UX, concurrency, and session-lifecycle path that today assumes per-card semantics.

## TL;DR

1. **AmazonG today is 1:1 profile↔card** (`ChaseProfile.cardAccountId: string | null`, single field — `src/shared/types.ts:277`). Stage C's overview returns N cards in one fetch but the rest of AmazonG only consumes one. The 1:1 boundary is the load-bearing assumption, not Stage C's inability to fan out — Stage C is *easier* than today, not harder, as long as we keep 1:1.
2. **TTL gate is already per-profile** (`index.ts:1827-1833`, `chase-account-snapshots.json` keyed by `profileId`, not `cardAccountId`). Zero refactor needed for #1.
3. **Per-card retry UX** (`Bank.tsx:923-934`) is also per-profile under the 1:1 model — the "Refresh this card" button calls `chaseSnapshotRefresh(profileId)`. The "one fetch fail = all cards fail" worry from the charter doesn't bite *today*, only after a future multi-card-per-profile feature.
4. **Worker pool collapses gracefully**: today's `FETCH_ALL_CONCURRENCY=2` (`Bank.tsx:327`) serializes profiles 2-at-a-time because of Akamai's burst-detection window. Stage C does the same thing — profiles are still independent userDataDirs, no contention. **Concurrency stays 2 across profiles**; nothing changes here because profile-vs-profile parallelism is unchanged.
5. **Stage B fallback is the single biggest open architectural decision.** Recommendation: **Stage C wraps Stage B at the `runFetch` level** (option a in the charter), not feature-flag both paths. Reason: Stage C reuses `openChaseSession` + the existing `page.on('response')` listener as a fallback inside the same nav. One nav, two extraction strategies — clean, atomic.
6. **Refactor scope: ~150-200 LOC, 3 files** if we keep 1:1. **~600-1000 LOC, 8+ files** if we also do multi-card-per-profile in the same change. **Strong recommendation: ship 1:1 Stage C first**, then multi-card-per-profile as a follow-up.

---

## Per-question answers

### Q1 — TTL gate operates per-profile-now (Stage C-compatible)

**File evidence:** `src/main/index.ts:1796-1835`, `src/main/chaseAccountSnapshotStore.ts:24,57-61`.

The TTL gate today already short-circuits on `getAccountSnapshot(id)` where `id` is the **profileId**, not a cardAccountId. The cached snapshot is keyed `Record<profileId, ChaseAccountSnapshot>` (chaseAccountSnapshotStore.ts:24). So the gate is *de facto* per-profile already, even though the rest of the model is per-card. This is a happy accident — the 1:1 mapping made profileId and cardAccountId interchangeable as cache keys.

**Stage C interaction:** zero change. The 90s freshness window and `force` bypass continue to work. If we ever expand to multi-card-per-profile (see Q8), the gate becomes "if ANY card in this profile was fetched <90s ago, all cards skip" — which is correct, because Stage C fetches them all in one shot.

```ts
// index.ts:1826-1834 — already per-profile:
if (!force) {
  const cached = await getAccountSnapshot(id);   // id = profileId
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SNAPSHOT_FRESHNESS_TTL_MS) {
      logger.info('chase.snapshot.freshHit', { id, ageMs });
      return { ok: true, snapshot: cached, fromCache: true } as const;
    }
  }
}
```

### Q2 — Per-card retry / per-card error UX

**File evidence:** `Bank.tsx:222-271, 923-934, 1135-1144`.

Today the per-card retry button (`Bank.tsx:923-934`) is wired to `refreshSnapshotFor(profileId)`. Under 1:1, "card" and "profile" are the same row in the UI — the retry IS per-profile because each profile *is* a card.

The pass-3 doc's mention of "per-card retry" was loose — the actual code is per-profile. So there's no UX adaptation needed for Stage C-with-1:1.

**Charter's worry — "one fetch fail = all cards fail":** doesn't apply at 1:1. If Stage C's `Promise.all` of overview + rewards fails wholly, the result is exactly the same as today's per-card fail: the one row shows the snapshot error banner with the inline "Sign in to Chase" button. No change.

**Future-proofing for multi-card:** if/when a profile renders N cards, retries should still be per-profile (= one Stage C nav). Per-card retry inside a Stage C profile is wasteful — it would require Stage B, defeating the whole point. The right pattern is: surface each card's missing-data separately, but the retry button is profile-scoped and refreshes them all. This matches Chase's own SPA UX (the dashboard refresh button on chase.com refreshes everything).

**Recommendation for Stage C v1 (1:1):** zero UX change. The "Refresh this card" button text already reads "Re-fetch this card's points balance, credit balance, and in-process payments" (`Bank.tsx:928`) which truthfully describes Stage C as well.

### Q3 — Worker pool / concurrency stagger

**File evidence:** `Bank.tsx:316-341` (FETCH_ALL_CONCURRENCY = 2), pass-3 roadmap §2.2 (worker stagger).

Today: 2 workers pull profileIds off a queue, each calls `chaseSnapshotRefresh(profileId)`. Each call spawns one Chromium per profile.

Stage C: 2 workers pull profileIds off a queue, each calls `chaseSnapshotRefresh(profileId)`. Each call spawns one Chromium per profile, then does ONE `page.evaluate(fetch())` for all cards in that profile.

**Conclusion: the worker pool model is unchanged.** The "N per profile" loop the charter is worried about doesn't exist today either — every IPC call already does N internal nav-and-listens per *card*, but at the IPC boundary it's profileId in, snapshot out. Stage C just makes the inside cheaper.

**Concurrency dimension across profiles** (3+ Chase logins): today, 2 profiles parallel = 2 Chromiums up at once = OK because separate userDataDirs. Stage C keeps the same pattern. The pass-3 worker stagger (1.5-2.5s) was needed because each Chromium fired an Akamai-sensitive nav. Stage C still fires one nav per profile, so Akamai stagger is still meaningful — but **the "concurrency 3-4" suggestion from pass-3 §2.3 (lazy-spawn on first-XHR signal) is actually less interesting after Stage C**, because Stage C's bottleneck is the Chromium-cold-start + nav (~3-5s), not the per-card listen-and-paint loop. Concurrency 2 saturates that already.

**The pre-warmed pool of N always-on contexts** that pass-3 said "don't do" becomes still-don't-do after Stage C — same userDataDir-lock concern, same RAM cost, still gated on the bottleneck being chromium-spawn (which Stage C makes once per profile, not per card).

### Q4 — Storage state save-trigger compatibility

**File evidence:** `chaseDriver.ts:535-581` (attachSessionAutoSave).

`attachSessionAutoSave` triggers on:
- `page.on('framenavigated')` — every mainframe nav, debounced 2s
- 60s safety-net interval

A Stage C session lives ~5s (one nav, then `page.evaluate(fetch())`, then close). The 60s safety-net interval **never fires** in that window. Whether `framenavigated` fires depends on the goto's `waitUntil`:
- `waitUntil: 'domcontentloaded'` (proposed for Stage C, see chase-mcp-direct-fetch-2026-05-08.md:117) — yes, framenavigated fires on the nav
- The 2s debounce after framenavigated means the save fires at ~T+2s into the 5s session

**Conclusion:** Stage C still triggers ONE state save during the session (the framenavigated path), 2-3s before the close-time `storageState()` dump. The auto-save isn't redundant — Chase's cookies rotate during the live nav (Akamai mints fresh `_abck`), so the framenavigated-triggered save captures rotated cookies; the close-time save captures the FINAL state including any cookies the in-page fetches set.

Stage C is fine here. **No changes to attachSessionAutoSave needed.**

But also: Stage C wall-clock (~5s) means the session is essentially "open the door, walk through, close the door." The framenavigated save IS belt-and-suspenders insurance against the close-time save failing, not a different value. Fine to leave both.

### Q5 — Pay window + Open Rewards windows contention

**File evidence:** `index.ts:1538-1626` (chaseOpenRewards), `index.ts:1908-2000` (chasePayBalance), `index.ts:1844-1849, 1707-1712, 1921-1929` (lock checks).

Today's lock pattern: `chaseActionSessions: Map<profileId, ChaseSession>`. Every snapshot/redeem/pay handler refuses if `chaseActionSessions.has(id)`. The user's open Pay window or Open Rewards window blocks Stage C the same way it blocks Stage B today.

Stage C is **shorter** (5s vs 5-13s), so the contention window is shorter — there's *less* chance the user clicks Pay during a Stage C fetch. Net positive.

**No new failure modes.** Same userDataDir lock. Same `chaseActionSessions` registration. Same close handlers (`index.ts:1583-1587, 1955-1959`).

### Q6 — Cache TTL & disk-first display + progressive update

**File evidence:** `Bank.tsx:289-314, 222-271, 955-996`.

Today's flow:
1. On mount, load every profile's snapshot from disk (`Bank.tsx:294-314`). UI renders cached values immediately.
2. User clicks "Fetch all" or per-card refresh.
3. `refreshSnapshotFor(profileId)` sets `snapshotPending[profileId] = true`, dims the card to 50% opacity (`Bank.tsx:957-959`), runs the IPC, swaps in the new snapshot when it lands.

**The "progressive per-card update" the charter worries about** doesn't actually exist today — each card updates atomically when its IPC returns. There's no inside-a-fetch "balance arrived but pending hasn't" partial render. The progressive feel is **across** cards (card A finishes at T+5s, card B at T+10s), not inside a single card.

**Stage C interaction:** zero change. Stage C's `Promise.all` returns one snapshot per card, all at once (~5s). The renderer loop `for (p of eligible) refreshSnapshotFor(p.id)` already updates each profile's card independently as its IPC returns. Even at 1:1, this is fine — Stage C's fan-in is inside one IPC call, the outside fan-out is unchanged.

**Future multi-card concern:** if a future profile renders 3 cards, Stage C arrives all-at-once. The "first paint to all final" cycle for that profile is one tick. That's a UX *upgrade* (no more waiting for card 13 to finish 65s after card 1) — not a regression.

### Q7 — Stage B fallback: feature-flag both paths or fall through?

**File evidence:** `chaseDriver.ts:1304-1500` (Stage B's listener pattern), `chaseDriver.ts:1474-1500` (DOM fallback inside Stage B).

The current Stage B code has a clean architectural pattern that Stage C should reuse:

```
listener attached BEFORE nav  →  nav  →  passive collect XHRs  →
  if XHRs landed: typed JSON path
  else / partial: DOM scrape fallback
```

Stage C is **the same shape** with a different "where the data comes from" — instead of waiting passively for the SPA to fire its own XHRs, we navigate, then proactively `fetch()` from inside the page.

**Recommended architecture: option (a) — Stage C wraps Stage B inside one runFetch:**

```ts
async function runFetch(profileId, cardAccountId) {
  const session = await openChaseSession(profileId);
  // ... auto-save, XHR listener attach ...
  try {
    await page.goto('https://secure.chase.com/web/auth/dashboard', { waitUntil: 'domcontentloaded' });
    const recovery = await maybeAutoLoginAndContinue(page, profileId);
    if (!recovery.recovered) return { ok: false, reason: recovery.reason };

    // Stage C — direct fetch all cards at once
    const stageC = await tryStageCDirectFetch(page, [cardAccountId]).catch(() => null);
    if (stageC?.ok) return { ok: true, snapshot: stageC.snapshots[0] };

    // Stage C failed (JSON shape drift, fetch threw, etc.) — fall through
    // to the existing per-card Stage B listener path
    logger.info('chase.snapshot.stageC.fallthrough', { profileId, cardAccountId });
    return runStageBPerCard(page, profileId, cardAccountId);
  } finally { /* ... */ }
}
```

**Why option (a) is cleaner than option (b) feature-flag:**

- **One Chromium per fetch.** Option (b) would launch one for Stage C, fail, launch another for Stage B — that's 2 Akamai sensor cycles for one user click, exactly the bot-shape we're avoiding.
- **One nav per fetch.** Option (a) lets us reuse the already-loaded dashboard page for the Stage B listener path. Option (b) re-navigates.
- **Self-healing.** If Chase ships a SPA refactor that breaks Stage C's JSON shape, the system silently degrades to Stage B. No bug report needed; it just gets slower.
- **Less coverage paranoia.** One code path, one set of error-classification regexes (`classifySnapshotErrorKind`, `index.ts:1786-1794`).

**Detection logic for Stage C → Stage B fallthrough:**

- `data.overviewJson?.cache` is undefined or not array → fallthrough
- Found cache entry but no `cardAccountOverviews[].cardAccounts[]` for the requested cardAccountId → fallthrough
- The flat-fetched `currentBalance` / `availableCredit` is missing or non-numeric → fallthrough

These are the same shape-checks `extractDashboardDetail` (`chaseDriver.ts:1786-1808`) already does. **Reuse the same extractor.** Add a thin wrapper that runs it against Stage C's JSON; if null, fall through.

### Q7b — Smallest feature flag

**File evidence:** `chaseDriver.ts:226, 1301` (env-flag pattern), `ipc.ts:278-299` (settings.experimental pattern).

AmazonG has two flag patterns:
- **Env-var dev flags:** `AUTOG_CHASE_FULL_CAPTURE`, `AUTOG_CHASE_XHR_CAPTURE` (`chaseDriver.ts:226, 1301`). Process-local; not user-facing; intended for capture/research.
- **Settings.experimental boolean:** `surgicalCashbackRecovery` (`ipc.ts:278-299, index.ts:799`). Persistent; not in UI; users opt in by editing `settings.json` directly.

**Recommendation: don't add a flag at all** if option (a) is adopted. The fallthrough is implicit. This is the cleanest pattern in AmazonG's codebase — no maintenance cost, no two-paths-to-test, no settings.json schema bump.

If we DO want a kill-switch (in case Stage C turns out to mint different cookies than Stage B and we need to roll back without a release), use the **env-var pattern**: `AUTOG_CHASE_DISABLE_STAGE_C=1` skips the Stage C attempt and goes straight to Stage B. Env vars are zero-infra (no settings.json migration, no UI), and a power user can set it via `launchctl setenv` on macOS. This is the lightest possible escape hatch.

**DON'T use settings.experimental** for Stage C — that pattern is for opt-IN behavior; Stage C is opt-OUT (default on, flag off the broken case).

### Q8 — Per-profile vs per-card iteration: refactoring scope

This is the question with the largest potential blast radius. Walk through every file:

#### IPC handlers (`src/shared/ipc.ts`, `src/main/index.ts`)

- **`chaseSnapshotRefresh(profileId, options)`** — already takes profileId. Returns a *single* `ChaseAccountSnapshot`. Stage C-with-1:1: zero refactor; the Stage C internals fetch all cards but return only the one matching `profile.cardAccountId`. Stage C-with-N:1: signature changes to return `ChaseAccountSnapshot[]` or `Record<cardAccountId, ChaseAccountSnapshot>`. Breaking change.
- **`chaseSnapshotGet(profileId)`** — same shape, same conclusion.
- **`chasePayBalance(profileId)`** — uses `profile.cardAccountId` to build the flyout URL (`index.ts:1942`). Stage C-with-1:1: zero refactor. With N:1: needs a card selector — which card to pay? Probably opens a dialog / surfaces a "which card?" picker before the pay window opens.
- **`chaseOpenRewards(profileId)`** — same as Pay; uses `profile.cardAccountId`.
- **`chaseRedeemAll(profileId)`** — same.
- **`chaseLogin(profileId)`** — captures `cardAccountId` from URL on first card-summary nav (`index.ts:1500-1508`). With N:1 we'd capture all cards from the overview JSON immediately. The login flow becomes more streamlined, not more complex.

#### Bank.tsx renderer state

- `snapshotState: Record<profileId, ChaseAccountSnapshot | null>` (`Bank.tsx:184-186`) — single snapshot per profile. With N:1, becomes `Record<profileId, Record<cardAccountId, ChaseAccountSnapshot>>`. Touches every read site (~30 references in Bank.tsx).
- `redeemState: Record<profileId, ...>` (`Bank.tsx:139`) — same pattern.
- `historyState: Record<profileId, ...>` — same pattern.
- The ChaseCard component (`Bank.tsx:809-1201`) renders one card per profile today. With N:1 it'd need to render N cards per profile or be repeated N times.

#### Storage shape

- `chase-account-snapshots.json: Record<profileId, ChaseAccountSnapshot>` (`chaseAccountSnapshotStore.ts:24`) — single snapshot per profile. With N:1: `Record<profileId, Record<cardAccountId, ChaseAccountSnapshot>>`. Storage migration required.
- `chase-profiles.json` — `cardAccountId: string | null` becomes `cardAccountIds: string[]` or `cards: Array<{accountId, nickname, mask}>`. Migration required.
- `chase-redeem-history.json` — already keyed by profileId; per-card history would need to nest by cardAccountId.

**Conclusion for Q8:** if we keep 1:1, NONE of this changes. The Stage C internals do `Promise.all` of N cards, but only the one matching `profile.cardAccountId` is returned to the renderer. **This is the recommended Stage C v1 scope.**

If we want N:1, scope estimate: ~600-1000 LOC, 8 files (`types.ts`, `ipc.ts`, `chaseAccountSnapshotStore.ts`, `chaseProfilesStore.ts`, `chaseRedeemHistory.ts`, `chaseDriver.ts`, `index.ts`, `Bank.tsx`). Plus migration code that runs once on app startup to convert old `cardAccountId` → first-element-of-cards array. Plus UX design for the N-card-per-profile card layout. Plus `chasePayBalance` and `chaseRedeemAll` need per-card variants. **This is a separate project, not part of Stage C.**

### Q9 — Concurrency of profiles

**File evidence:** `Bank.tsx:316-341` (FETCH_ALL_CONCURRENCY=2), `Bank.tsx:519-559` (Redeem All has no concurrency cap, fans out all profiles).

Today: 3+ Chase profiles parallel-safe because each is a separate userDataDir → separate Chromium → separate cookie jar / TLS state / Akamai sensor session. The pass-3 §2 finding said "concurrency 3-4 reliably" requires the lazy-spawn-on-first-XHR signal trick.

Stage C: same userDataDir-per-profile isolation. Same parallel-safe property. **Concurrency 2 across profiles continues to be the right ceiling**, not because of any Stage C-specific limit, but because of Akamai cross-profile fingerprint correlation (multiple Chromiums hitting Akamai from the same IP within seconds gets noticed, regardless of how the data was extracted). Stage C makes each profile's window shorter, which actually *helps* — but Akamai's sensor doesn't care whether you fetched 1 card or 13 cards in that window.

**No change to the 2-worker pool.** The only ceiling-raising lever is the lazy-spawn-on-first-XHR-signal trick from pass-3 §2.3 — and Stage C makes that trick less interesting (the bottleneck shifts from per-card-listen to chromium-cold-start, which the trick doesn't address).

### Q10 — Akamai cookie filter compatibility

**File evidence:** `chaseDriver.ts:255-281` (cookies are fully restored, including Akamai's; the pass-3 hypothesis was tested and reverted).

The current state: Akamai cookies (`_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`) ARE restored on session open. The pass-3 doc proposed filtering them; the team shipped it 2026-05-07 and reverted because empirically sessions died faster (chaseDriver.ts:259-278 has the full post-mortem comment).

**Stage C interaction:** Stage C fires its in-page fetches **after** `await page.goto()` resolves — by that point the SPA has parsed the response, executed Akamai's sensor JS, and minted any rotated `_abck`. The fetches go out with the freshly-rotated cookie that the page itself would use. **Indistinguishable from the SPA's own XHRs.** Same posture as today's Stage B listener — pass-2 already validated this.

**Risk:** if the goto resolves at `domcontentloaded` (Stage C proposed) BEFORE Akamai's sensor JS finishes minting `_abck`, the fetches go out with a stale cookie. The mcp-direct-fetch doc (line 183) flagged this. Mitigation: change `waitUntil` to `'load'` (heavier but ensures sensor finished), OR wait for the SPA's own first `dashboard/module/list` to land before our `Promise.all` fires (use the existing Stage B listener as a "sensor-ready" gate, then fire our direct fetch after).

The latter is **belt-and-suspenders** and worth implementing in Stage C v1.

### Q11 — Redeem flow architecture

**File evidence:** `chaseDriver.ts:606-1236` (full redeem flow), `chaseDriver.ts:1013-1098` (the navigation chain).

Stage C as proposed touches *only* the snapshot-fetch path. Redeem is unchanged — still click-through Continue → Submit, still navigation-driven. Pass-4 + pass-6 confirmed redeem can't be Stage C-ified without a real-redemption capture (the redemption POST URL isn't publicly known).

**Stage C-redeem opportunity** (out of scope for this round but worth noting):
- mcp-direct-fetch-2026-05-08.md confirmed `chaseloyalty.chase.com/cash-back?AI={accountId}` loads the form data without first hitting `/home` — saves ~3-5s on the redeem path. Easy win.
- The `chaseloyalty.chase.com/rest/cash-back/redemption-info` endpoint returns the form-prefill data (points, statementCredit target, cashBackProductDataList). Stage C could swap the `inputValue('input.mds-text-input__input--hero')` DOM read at chaseDriver.ts:1086 for a direct fetch of this endpoint. ~3-5s saved.
- The actual redemption POST URL/body remains uncaptured. Charter is correct: Stage C-redeem requires the AUTOG_CHASE_XHR_CAPTURE capture run.

**For Stage C v1: redeem stays 100% as-is.** The only adjacent nudge worth shipping in the same PR is dropping the `/home` nav (`chaseDriver.ts:1025-1037`) — go straight to `/cash-back?AI={id}` and skip the "Available points" wait. Saves ~3-5s. ~5 LOC. Zero risk if mcp-direct-fetch-2026-05-08.md's empirical observation holds.

---

## What changes — table

| Concern | Today (Stage B) | Stage C (recommended, 1:1) | Stage C (with N:1, future) |
|---|---|---|---|
| Wall-clock per profile | 5-13s × N cards | ~5s total | ~5s total |
| Chromium spawns per "Fetch all" | N profiles (×2 workers) | N profiles (×2 workers) | N profiles (×2 workers) |
| Navs per profile | 2 per card (summary + activity) | 1 (overview) | 1 (overview) |
| TTL gate | per-profile (cardAccountId == profileId) | per-profile (unchanged) | per-profile (one fetch covers all cards) |
| Per-card retry button | per-profile (1:1) | per-profile (unchanged) | per-profile (refreshes all cards in profile) |
| Worker pool concurrency | 2 across profiles | 2 across profiles | 2 across profiles |
| Akamai burst risk | inside-profile (N nav cycles) | one-shot per profile | one-shot per profile |
| `attachSessionAutoSave` triggers | framenavigated × N + 60s timer | framenavigated × 1 + close-time | same |
| Pay / Open Rewards lock | unchanged | unchanged (shorter window) | unchanged |
| `ChaseAccountSnapshot` shape | unchanged | optionally widened (pass-4 #1) | optionally widened |
| `chase-account-snapshots.json` shape | `Record<profileId, snap>` | unchanged | breaks: `Record<profileId, Record<cardAccountId, snap>>` |
| `ChaseProfile.cardAccountId` shape | `string \| null` | unchanged | breaks: `string[]` or `Array<{...}>` |
| Bank.tsx state shape | per-profile | unchanged | breaks: nested per-card |
| Renderer cards rendered | 1 per profile | unchanged | N per profile (UX redesign) |
| Redeem flow | click-through, navs | unchanged | unchanged (separate research) |

---

## Refactor scope estimate

### Stage C v1 (1:1, recommended)

**~150-200 LOC, 3 files:**

| File | LOC delta | Change |
|---|---|---|
| `src/main/chaseDriver.ts` | +120, -0 | Add `tryStageCDirectFetch(page, ids)`, integrate into `runFetch` before the existing Stage B listener path; reuse `extractDashboardDetail` + `extractRewardsBalance`; format helpers reused |
| `src/main/index.ts` | 0 | No IPC changes |
| `src/shared/types.ts` | 0 | No type changes (unless we also adopt pass-4 #1 widening, which is +30 LOC) |
| `src/renderer/pages/Bank.tsx` | 0 | No renderer changes |

Plus optional:
- `src/main/chaseDriver.ts` +5 LOC: drop `/home` nav from redeem flow per Q11

### Stage C v2 (N:1, separate project, NOT recommended in same PR)

**~600-1000 LOC, 8 files:**

| File | LOC delta | Change |
|---|---|---|
| `src/shared/types.ts` | +30 | `ChaseProfile.cards: ChaseCardSummary[]`; deprecate `cardAccountId` |
| `src/shared/ipc.ts` | +50 | New IPC: `chaseListCards(profileId)`, `chasePayBalance(profileId, cardAccountId)`, etc. |
| `src/main/chaseAccountSnapshotStore.ts` | +50 | Migration helper; nested shape; per-card get/set |
| `src/main/chaseProfilesStore.ts` | +30 | Migration: `cardAccountId` → `cards[0].accountId` |
| `src/main/chaseRedeemHistory.ts` | +30 | Per-card history files |
| `src/main/chaseDriver.ts` | +80 | Pay / redeem accept cardAccountId param |
| `src/main/index.ts` | +100 | All Chase IPC handlers thread cardAccountId |
| `src/renderer/pages/Bank.tsx` | +250 | Multi-card-per-profile UX, per-card buttons, layout redesign |
| Migration unit tests | +50 | Critical — storage-shape change is a one-way door |
| Total | **~600-1000** | Plus design review for the multi-card UI |

This is a **separate project** that should be sequenced AFTER Stage C v1 ships and the team has empirical confidence in the direct-fetch path.

---

## Per-card vs per-profile boundary lines

Today's split:

| Layer | Identifier | Notes |
|---|---|---|
| IPC channel | profileId | `chaseSnapshotRefresh(id)`, `chaseRedeemAll(id)` etc. — 1:1 means cardAccountId is implicit |
| `ChaseProfile` storage | profileId | `chase-profiles.json` keyed by profileId; cardAccountId is a single field within |
| `ChaseAccountSnapshot` storage | profileId | `chase-account-snapshots.json` keyed by profileId |
| Lock map (`chaseActionSessions`) | profileId | One Chrome window per profile is the load-bearing invariant |
| In-flight maps (`chaseSnapshotInFlight` etc.) | profileId | Same |
| Renderer state (`snapshotState`, `redeemState`) | profileId | Single source of truth; UI cards keyed by profileId |
| Internal driver work (Stage B listener) | cardAccountId | Per-card nav, per-card listener; the internal-N happens here |
| Stage C `Promise.all` | cardAccountId | Even at 1:1, the internal fetch shape is "list of cards in profile"; we just pass `[profile.cardAccountId]` |

**The boundary is clean: profileId is exposed; cardAccountId is internal.** Stage C reinforces this. Today's "N internal nav-and-listen per card" is hidden inside one IPC call; Stage C's "1 nav + Promise.all of N fetches" stays inside the same IPC call. The boundary doesn't move.

This is why **Stage C v1 needs no IPC, no storage, no renderer changes**. The boundary already absorbs the change.

---

## Migration / coexistence strategy

**Recommendation: option (a) fall-through, no feature flag, no settings entry.**

```
chaseSnapshotRefresh IPC
  → freshness gate (existing, per-profile TTL)
  → in-flight + lock checks (existing)
  → coalesce (existing)
  → fetchChaseAccountSnapshot
    → openChaseSession (existing)
    → attachSessionAutoSave + XHR-capture (existing)
    → page.on('response', ...) listener attach for Stage B fallback (existing)
    → goto dashboard/overview
    → maybeAutoLoginAndContinue (existing)
    → wait for first SPA dashboard/module/list response (gate for Akamai sensor freshness)
    → tryStageCDirectFetch:
        → page.evaluate(Promise.all([overview, ...rewards]))
        → extractDashboardDetail / extractRewardsBalance from JSON  ← reuse existing
        → return snapshot if all fields present
        → otherwise return null
    → if Stage C returned null:
        runStageBPerCard (existing) — uses passive-listener XHRs already collected
    → close session (existing)
```

**Coexistence properties:**
- **Single Chromium spawn.** Either Stage C wins or Stage B wins, but only one chromium is launched per fetch.
- **Single nav.** Stage B reuses the dashboard page Stage C already navigated to.
- **Single Akamai sensor cycle.** The page hydrates once; Stage C fires its fetch on top of that hydrated context; Stage B (if reached) reads from the listener that already collected the SPA's own XHRs during hydration.
- **Same auth-recovery path.** `maybeAutoLoginAndContinue` runs once; both paths benefit.
- **Same close path.** `attachSessionAutoSave` + `session.close()` once.

**Logging plan:**

```
chase.snapshot.stageC.attempted      { profileId, cardAccountId }
chase.snapshot.stageC.ok             { profileId, cardAccountId, durationMs, cardCountInOverview }
chase.snapshot.stageC.shapeFail      { profileId, cardAccountId, reason: 'no_cache' | 'no_card_match' | ... }
chase.snapshot.stageC.fetchError     { profileId, cardAccountId, error }
chase.snapshot.stageC.fallthrough    { profileId, cardAccountId, fallbackPath: 'stage_b' }
chase.snapshot.stageB.ok             (existing)
chase.snapshot.stageB.domFallback    (existing)
```

After 1-2 weeks of production logs, the ratio of `stageC.ok : stageC.fallthrough` tells us whether Stage C is the steady state or whether Chase ships SPA changes that break it. If fallthrough is rare (<1%), we can confidently drop the Stage B nav-and-listen path in a future PR. If it's high, Stage C is a perf nice-to-have but Stage B remains the load-bearing path.

**Optional kill-switch:** `AUTOG_CHASE_DISABLE_STAGE_C=1` env var skips Stage C and goes straight to Stage B. Zero infrastructure cost. Power user can set it from a launchctl plist; we can ship a Settings toggle later if needed.

---

## What's still ambiguous

1. **Akamai sensor freshness timing under `domcontentloaded`.** The mcp-direct-fetch doc's empirical capture used live MCP from a fully-hydrated page. Whether `waitUntil: 'domcontentloaded'` consistently fires AFTER Akamai's sensor JS minted `_abck` is unverified. Mitigation: gate Stage C on the SPA firing its own first `dashboard/module/list` (we listen anyway for the Stage B fallback path), then fire our direct fetch. Adds ~500-2000ms but eliminates the timing risk.

2. **`/svc/rl/.../dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` per-account behavior at scale.** Confirmed for the user's 13-card profile. Unverified: does the response shape change at 50+ cards? Pagination? Probably not for consumer Chase, but a corporate/business-banking customer with many cards might exercise an untested path. Low risk for AmazonG's user base (consumer credit-card focused), worth noting.

3. **Stage C and the in-process payments scrape.** mcp-direct-fetch confirmed `paymentDetail.paymentMessageStatusCode === "PAYMENTSCHEDULED"` is encoded inline in the overview response. **This eliminates the second nav (payment-activity page) entirely** — saving another 2-3s of wall-clock per fetch. The current implementation parses payment activity with a DOM regex; Stage C should use the typed JSON. **Recommendation: include this in Stage C v1 PR** — it's the same code path, zero additional risk, and dropping the nav is a real perf win.

4. **`pendingChargesAmount` semantic mismatch.** chaseDriver.ts:1396-1410 has a comment that the JSON's `pendingChargesAmount` reads `0` even when the UI shows non-zero — Chase appears to track a different concept (pending balance transfers, not authorization activity). Stage C inherits this — the overview JSON's `pendingChargesAmount` may also be the "wrong" pending number. **Need to capture an `etu-transactions` XHR response from a card with non-zero pending to figure out which field actually mirrors the UI.** Until that's captured, Stage C should fall through to Stage B's DOM-scrape for pending charges.

5. **N:1 multi-card-per-profile UX.** Open question: does the user actually want all 13 of their Chase cards rendered as separate Bank-tab cards? Or should the profile aggregate them into one "Cuong: $X balance, Y points across 13 cards" summary with a drill-in? **This is product design, not architecture** — should be answered before scoping the N:1 work.

6. **Rate-limiting of `accountId=...` rewards endpoint at high N.** Stage C fires N parallel `Promise.all` requests to `/svc/rr/accounts/secure/card/rewards/v2/summary/list`. mcp-direct-fetch tested with 13 cards parallelized successfully. Unknown: does Chase rate-limit at ~50 concurrent same-origin XHRs? Probably not (the SPA fires comparable bursts on hydration). But for a 50-card business profile, may need throttling (`p-limit` style with concurrency 8-10 inside the page).

---

## Confidence scorecard

| Finding | Confidence |
|---|---|
| Stage C-with-1:1 needs zero IPC / storage / renderer changes | **High** — verified by reading every Chase IPC handler + renderer state shape |
| TTL gate is per-profile already | **High** — verified by `index.ts:1827-1833` + `chaseAccountSnapshotStore.ts:24` |
| Worker pool stays at concurrency 2 | **High** — Akamai constraint is independent of Stage B/C |
| Option (a) fall-through is cleaner than feature-flag | **High** — option (b) doubles Chromium spawns and Akamai cycles per fetch |
| Stage C shouldn't use `settings.experimental` flag | **Medium-high** — env-var pattern exists for similar bail-out cases |
| `attachSessionAutoSave` framenavigated still fires at Stage C speed | **Medium** — proposed `domcontentloaded` does fire framenavigated, but depends on Playwright internals |
| In-process payments via overview JSON eliminates second nav | **Medium-high** — empirical capture confirmed the field exists; needs end-to-end test before shipping |
| Pending-charges field semantic mismatch persists in Stage C | **Medium** — same JSON shape as Stage B; same field; same probable mismatch |
| N:1 multi-card-per-profile is a separate project | **High** — scope estimate clearly delineates the boundaries |
| Stage C-redeem requires capture run | **High** — pass-4 + pass-6 already confirmed |

---

## Suggested ship path for Stage C

| Tier | Item | LOC | Risk | Notes |
|---|---|---|---|---|
| **C1** | Stage C `runFetchStageC` integrated into `runFetch` with Stage B fall-through | ~120 | Low | Covers Q1-Q4, Q6-Q9 |
| **C2** | Drop second nav (payment activity) by reading `paymentDetail` from overview JSON | -40 (net) | Low | Covers Q3-Q4 ambiguity #3 |
| **C3** | Add SPA-first-XHR gate before firing Stage C fetches (Akamai sensor freshness insurance) | +20 | Low | Covers ambiguity #1 |
| **C4** | Drop `/home` nav from redeem flow (chaseDriver.ts:1025-1037) | -10 | Low | Covers Q11 nudge |
| **C5** | `AUTOG_CHASE_DISABLE_STAGE_C=1` env-var kill switch | +5 | Zero | Optional; covers Q7b |
| | **Total Stage C v1** | **~95 LOC net** | **Low** | One PR, one Chromium per fetch, no IPC/storage breaks |
| **D1** | Multi-card-per-profile (N:1) | ~600-1000 | Medium | **Separate project** after Stage C v1 lands |
| **D2** | Stage C-redeem (after capture run) | ~150 | Medium | Gated on `AUTOG_CHASE_XHR_CAPTURE=1` capture |

---

## Bottom line

Stage C is a **localized refactor inside `runFetch`**, not an architecture change. AmazonG's profile↔IPC↔renderer↔storage seams already absorb the per-card → per-profile collapse because the 1:1 mapping made profileId the de-facto cache key everywhere already. The only "architecture" decision is option (a) vs (b) for fallback, and (a) is cleaner on every axis.

The harder, follow-on question — multi-card-per-profile — should be deferred. Stage C v1 with 1:1 captures the perf win (~5-50× speedup) without paying the storage-migration / UX-redesign tax. Ship it standalone; revisit N:1 as a separate product question.
