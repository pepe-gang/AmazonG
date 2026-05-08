# Chase Stage C — pass-7 synthesis (5-round deep research)

**Date:** 2026-05-08
**Status:** research only; nothing shipped
**Builds on:** `chase-mcp-direct-fetch-2026-05-08.md` (the live MCP capture that proved direct-fetch works) + 4 prior research passes
**Companion docs:** `chase-deep-pass7-round{1-5}-*-2026-05-08.md`

---

## TL;DR — the synthesized verdict

Stage C is real, the perf gain is real (30-50× for multi-card profiles, 1-10× for typical 1-4-card profiles), and the anti-bot risk is **low** (R1 confirmed the pattern is already shipping in production via the keepalive). But Stage C is structurally less forgiving than Stage B, and the production-safety machinery that today's Stage B inherits implicitly needs to be ported explicitly. **Realistic LOC is ~285, not ~120.**

Three Tier-0 gates from R4 must ship FIRST as a foundation PR (write-temp-rename, AbortSignal-per-fetch, shape-drift sentinel). Then Stage C v1 lands wrapping Stage B at the runFetch level (R3's option-a, R4's recommended fallback architecture). Two free wins from R5 (drop `/home` redeem nav, surface lockStatus + autoPayEnrolled) bundle in.

The single biggest empirical unknown across all 5 rounds: **`pendingChargesAmount` reliability**. R2 says the field reads 0.0 for every card we captured, even ones whose UI showed pending charges historically. R3 + R4 both flag this. **Stage C should keep the DOM scrape for `pendingCharges` until we capture a profile with live pending charges and diff JSON vs DOM.**

---

## Cross-round convergent findings (high-confidence)

### 1. Pre-fire sentinel — wait for SPA's first natural dashboard XHR before firing the batch [R1 §Q1, R4 F8/F9/F15]

R1 and R4 independently arrived at the same recommendation. R1 reasoned from Akamai sensor freshness; R4 reasoned from the duplicate-request race + mid-batch `_abck` rotation. Both want: after `domcontentloaded` and `maybeAutoLoginAndContinue`, wait for the SPA's own `dashboard/module/list` POST to land (using the existing Stage B `page.on('response')` listener), THEN fire the parallel `Promise.all`. Costs ~1-2s, eliminates two distinct risk vectors.

**Implementation note:** This means Stage C ALWAYS attaches the Stage B listener as the gating signal, even when not used for fallback. Reuses code we already have.

### 2. Stage B is the fallback, NOT a feature-flagged sibling [R3 §Q7 + R4 F3/F4/F7]

Both rounds prescribe option-a (R3's terminology): **Stage C wraps Stage B inside the same `runFetch`**. Single Chromium spawn, single nav, two extraction strategies. On any of (a) JSON-shape drift, (b) Akamai HTML 403, (c) consistent SPA-error responses, fall through to the Stage B passive-listener path which is *already running* during the same nav. R4 explicitly rules out feature-flagged double-spawn ("doubles Chromium spawns / Akamai sensor cycles per click — exactly the bot-shape we avoid").

**Kill switch (if needed):** `AUTOG_CHASE_DISABLE_STAGE_C=1` env var, matches existing pattern. Don't use `settings.experimental` (R3 §Q7b).

### 3. The proper in-process payments source is `/svc/rr/payments/secure/v1/billpay/card/payment/list` [R2 §coverage gap, R5 §Top-1]

Both R2 and R5 land on this endpoint. R2 found the multiplicity gap (overview's `paymentDetail` is one-slot per card; the activity DOM scrape and the billpay-list endpoint are both N-row). R5 confirmed the endpoint URL was captured in older JSONLs and traced its 2423-byte response. **Combined recommendation:** for Stage C v1, use the inline `paymentDetail` field in the overview as the primary source (covers ~95% of users who have ≤1 in-flight payment per card), keep DOM scrape as a Stage B fallback, and capture the `/billpay/card/payment/list` request body in a 5-min sprint to enable a Stage C v2 that handles multi-payment correctness.

### 4. `pendingChargesAmount` reliability is unverified — keep DOM fallback [R2 §3, R3 ambiguity-c, R4 implied-via-shape-drift]

R2 contradicted the round-1 worry that the field is unreliable, but only because all 13 captured cards reported `0.0`. **The pass-3-noted disagreement between this field and the recon-bar UI hasn't been disproven**, just unobserved. Stage C should fall through to Stage B's DOM scrape for `pendingCharges` specifically until empirical confirmation.

### 5. Two free renderer wins should bundle [R5 §3, R5 §Top-2]

`creditCardLockStatus` ("UNLOCKED" etc.) and `autoPayEnrolled` (boolean) are already present in the overview JSON we'd be extracting anyway. Surfacing them in Bank.tsx is renderer-only, ~30 LOC, zero new XHR. Per R3, these don't even change Stage C's main-process scope — pure renderer work that lands alongside.

### 6. Drop the loyalty `/home` nav in the redeem flow — confirmed reachable directly [MCP capture, R5 §6]

`https://chaseloyalty.chase.com/cash-back?AI={accountId}` loads `/rest/cash-back/redemption-info` correctly without a prior `/home` nav. Saves 3-5s per redeem. Trivial to land — single line in `chaseDriver.ts:1025-1046`. R5 ranks this as a free win.

---

## Cross-round tensions / ambiguities

### A. LOC estimate: R3 says ~95-200; R4 says ~285. **R4 is right.**

R3 counted the architectural-impact code: runFetch refactor, fallback wiring, IPC pass-through. R4 added the production-safety scaffold: `Promise.allSettled`, AbortSignal-per-fetch, content-type guards, shape-drift sentinel, error-class classifier, mid-batch reauth handling. R4's machinery is non-negotiable for production-safe behavior; without it, Stage C silently corrupts snapshots on any drift. Realistic estimate: **~285 LOC main + ~30 LOC renderer = ~315 LOC across 4 files**.

### B. Concurrency of rewards fetches: R1 says cap at 6-8; R4 says cap at 4. **Default to 4 with a tunable.**

R1 derived the 6-8 ceiling from the SPA's empirical organic burst (5 POSTs in 313ms). R4 derived 4 from a worry about HTTP/2 stream contention + Akamai burst-detection conservatism. Since 4 ≤ 6-8 and the difference is ~50ms in wall-clock for a typical 4-card profile, **default to 4**. Add an `AUTOG_CHASE_STAGE_C_REWARDS_CHUNK_SIZE` env var so empirical tuning doesn't need a code change.

### C. Profile-vs-card boundary in IPC [R3 §Q8]

R3 confirmed AmazonG today is 1:1 profile↔card (`ChaseProfile.cardAccountId: string | null`). Stage C v1 stays 1:1 — no IPC changes, no storage changes. Multi-card-per-profile is a separate ~600-1000 LOC project that R3 explicitly recommends NOT bundling. **Stage C v1 ships as a runFetch-internal optimization invisible to the rest of the app.**

---

## Updated ship plan — three PRs

### PR 1 (v0.13.29) — production-safety foundation [R4 Tier-0]

**Scope:** ~85 LOC main, no renderer change, no Chase logic change.

| # | Item | LOC | Source |
|---|---|---|---|
| 1 | Write-temp-rename helper (atomic JSON saves) for `chase-account-snapshots.json`, `chase-profiles.json`, `chase-redeem-history.json` | ~30 | R4 G1 + pass-4 audit #1/#3/#4 |
| 2 | Capture run for `/billpay/card/payment/list` request body (5-min user task; `AUTOG_CHASE_FULL_CAPTURE=1`) — needs to record `postData` not just URL | 0 | R2 §3, R5 §Top-1 |
| 3 | Extend `attachChaseXhrCapture` to log `respHeaders` so future `_abck` rotation observability is in place | ~10 | R1 §empirical; pass-3 #3.3 |
| 4 | Per-fetch `AbortSignal.timeout` helper that returns `{ok:false, reason:'timeout'}` on abort | ~15 | R4 G2 |
| 5 | Shape-drift sentinel helper (the positive-signal check from R4 D1) | ~25 | R4 G3 |
| 6 | Akamai HTML 403 detector helper (content-type guard returning `{kind:'akamai-403'}`) | ~15 | R4 F2/F7 |

**Bake time:** 1 week. Foundation-only PR. None of these are visible to users; they're scaffolding.

### PR 2 (v0.13.30) — Stage C, default off behind kill switch [R3 + R4 + R5 free wins]

**Scope:** ~285 LOC main + ~30 LOC renderer.

| # | Item | LOC | Source |
|---|---|---|---|
| 1 | `runFetchStageC` inside same `openChaseSession` + nav as Stage B; falls through to Stage B passive listener on shape-drift / Akamai 403 / 401 | ~150 | R3 §Q7, R4 F3 |
| 2 | SPA-first-XHR sentinel: wait for the Stage B listener's first `dashboard/module/list` arrival before firing parallel batch | ~25 | R1 §Q1, R4 F8/F15 |
| 3 | `Promise.allSettled` with per-card error mapping (NOT `Promise.all`) | ~20 | R4 F1 |
| 4 | Rewards fetches in chunks of 4 with sequential gates inside the `evaluate` | ~25 | R1 §Q4, R4 F9/F10 |
| 5 | `x-jpmc-client-request-id: crypto.randomUUID()` per fetch (back-port to keepalive too) | ~5 | R1 §Q3 |
| 6 | `pendingCharges` always falls through to DOM scrape until empirical verification | ~10 | R2 §3 |
| 7 | `inProcessPayments` uses overview's `paymentDetail` for v1; falls through to DOM scrape if `paymentMessageStatusCode` is missing | ~20 | R2 §gap, R5 §Top-1 |
| 8 | Drop `/home` nav from redeem flow (`chaseDriver.ts:1025-1046`); navigate straight to `/cash-back?AI=...` | ~5 | R5 §6, MCP capture |
| 9 | Surface `creditCardLockStatus` + `autoPayEnrolled` in `ChaseAccountSnapshot` + Bank.tsx renderer | ~30 | R5 §3 |
| 10 | `AUTOG_CHASE_DISABLE_STAGE_C=1` env-var kill switch | ~5 | R3 §Q7b |
| 11 | Structured error-class classifier returning `{kind: 'session-expired'\|'akamai-403'\|'rate-limit'\|'shape-drift'\|'timeout'\|'transient-5xx'\|'unknown'}` | ~30 | R4 D2-D5 |
| 12 | Logging: `chase.snapshot.stageC.{success,fallback,shapeDrift,akamai403,timeout}` events | ~15 | R4 observability |

**Bake time:** 2-3 days with Stage C **on by default**, with the kill-switch env var as the rollback.

### PR 3 (v0.13.31+) — observability + tier-2 follow-ups [post-Stage-C]

| # | Item | When |
|---|---|---|
| 1 | Capture run for live redemption (`AUTOG_CHASE_XHR_CAPTURE=1` during a real redeem) | when user has redeemable points |
| 2 | Stage C-redeem (replace click-Submit with captured POST) | after #1 |
| 3 | `/svc/rr/payments/secure/v1/billpay/card/payment/list` direct-fetch for multi-payment-correctness | after PR1 capture |
| 4 | Multi-card-per-profile model migration (separate project, ~600-1000 LOC per R3 §Q8) | strategic, deferred |
| 5 | Pay-bill flow renderer-side data prefetch (R5 §Top-2) | strategic, deferred |

---

## Empirical follow-ups still required

These items can't be answered from existing data and should be addressed before/during Stage C ship:

1. **`pendingChargesAmount` JSON-vs-DOM diff** — capture a profile with live pending charges and verify whether the JSON field matches the recon-bar UI (R2 §3, R3 ambig-c, R4)
2. **Mid-batch `_abck` rotation observability** — extend capture to log response Set-Cookie, run one Stage C burst against the 13-card profile, watch for `_abck=~0~` rotation (R1 §Q5, R4 F9)
3. **Chase rate-limit thresholds** — empirical only; if Stage C 429s anywhere, dial down `STAGE_C_REWARDS_CHUNK_SIZE` (R1 §Q4)
4. **Live redemption capture** — pass-4's standing recommendation, still open. Unblocks Stage C-redeem (R5 §4, R2 §5)
5. **`/billpay/card/payment/list` request body shape** — captures to date have `postData: null`; need a capture run with body recording on (R5 §Top-1)

---

## What NOT to do

- **Don't feature-flag Stage B and Stage C as parallel paths** — doubles spawn cost (R3 §Q7, R4 F3 implication)
- **Don't `Promise.all` without `allSettled`** — one transient 500 nukes 12 good fetches (R4 F1)
- **Don't fire Stage C before SPA's first natural XHR lands** — sensor-freshness race (R1 §Q1, R4 F8/F15)
- **Don't bundle multi-card-per-profile with Stage C v1** — separate project (R3 §Q8)
- **Don't use `Promise.race(timeout)`** — `AbortSignal.timeout` is the only way to actually cancel the in-flight fetch (R4 F6)
- **Don't ship Stage C without the foundation PR** — write-temp-rename + sentinel + AbortSignal are non-negotiable (R4 Tier-0)

---

## Confidence scorecard

| Claim | Confidence | Source |
|---|---|---|
| Direct fetch from page.evaluate works for snapshot endpoints | **High** (empirically verified via MCP) | mcp-direct-fetch doc |
| Pattern is anti-bot-equivalent to Stage B at the network layer | **High** | R1 §TL;DR-1 |
| `paymentDetail` covers ~95% of in-process-payment users (≤1 in-flight per card) | **Medium** | R2 §gap, requires multi-payment empirical capture |
| `pendingChargesAmount` is reliable | **Low** (unverified) | R2 §3 |
| Stage C wraps Stage B as fallback is the right architecture | **High** | R3 §Q7, R4 F3 (independent agreement) |
| LOC estimate ~285 main + ~30 renderer | **Medium-high** | R4 detailed breakdown |
| 30-50× speedup for multi-card profiles | **High** | mcp doc empirical (282ms parallel, 13 cards) |
| Tier-0 gates are non-negotiable for production-safe Stage C | **High** | R4 detailed failure-mode analysis |
| Mid-batch `_abck` rotation will or won't happen during 14-fetch burst | **Unknown** | R1 §Q5, requires empirical |

---

## Bottom line

Stage C is the right next ship after the current `chase-perf-tier-a` branch. The win is real and large. The risk is low at the protocol layer but moderate at the production-correctness layer — Stage C trades nine fallback paths for one declarative chain, and the 285 LOC of replacement scaffolding is what makes it safe.

The **foundation PR (write-temp-rename + AbortSignal + sentinel) should ship first and bake for a week** before Stage C lands. Stage C ships behind a kill switch (default on, env-var off-switch); after a week of clean logs, the kill switch can be removed.

Two free wins (drop `/home` redeem nav, surface lockStatus + autoPayEnrolled) bundle into the Stage C PR for free.
