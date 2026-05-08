# Chase research — pass 4 (deep dive synthesis)

**Date:** 2026-05-07
**Method:** 4 parallel research rounds + direct enumeration of the captured Chase JSONL
**Status:** research only, nothing shipped from this pass

Builds on pass-3 (Akamai cookie filter + TTL + structured errors, all shipped on `chase-perf-tier-a` branch).

## TL;DR — the four most actionable findings

| # | Finding | Why it matters | Cost | Risk |
|---|---|---|---|---|
| 1 | **Widen `ChaseAccountSnapshot` type once** to capture 11 untapped JSON fields (creditLimit, paymentDetail, lastPaymentDate, etc.) | One-shot PR unblocks **7 high-value Bank tab features** (utilization indicator, due-date warning, multi-card aggregate panel, card nickname+mask, statement balance, last-payment line, past-due banner) — all renderer-only after the type widens | ~30 LOC main + ~200 LOC renderer for all 7 features | Zero anti-bot risk |
| 2 | **CDP blocklist for Chase** (c.go-mpulse.net, analytics.chase.com, reco.chase.com) | Cuts 18 noise XHRs that fire during hydration contention window. ~50-500ms saved per snapshot fetch. Bandwidth: ~8KB | ~25 LOC | Low — none of the 3 hosts touch Akamai sensor pipeline |
| 3 | **Atomic-write fix for `chase-profiles.json` + `chase-redeem-history.json` + `chase-account-snapshots.json`** | Currently `writeFile()` direct = corruption window on crash / concurrent writes. Critical: data-loss potential. POSIX is mostly atomic; Windows is NOT. | ~30 LOC (write-then-rename pattern, share helper) | Zero — pure correctness |
| 4 | **Capture run during real redemption (`AUTOG_CHASE_XHR_CAPTURE=1`)** to identify chaseloyalty redemption endpoints | Unlocks Stage B for redeem flow (~0.5-1.5s passive listener) and ultimately Stage C direct-fetch (~15-30s of redeem time eliminated) | 5 min user time | Zero — same code path as today |

The single highest-leverage move is **#1 — widen the snapshot type**. It's a 30 LOC main-process change that unlocks ~7 features as pure renderer work afterward. Everything else (utilization graphs, due-date alerts, etc.) is feature work on top of that single foundation.

---

## Round 1 — Untapped fields in the captured Chase JSON

I dumped the full structure of `dashboard/module/list`'s `cache[].response.detail` object. **50+ fields exist; we use 3.**

### Top-priority untapped fields (UI features they unlock)

| Field | What it is | Feature it unlocks |
|---|---|---|
| `creditLimit` (number) | e.g., 35000 | Credit utilization gauge with FICO-threshold colors |
| `paymentDetail.paymentAmount` (number) | 10628.21 | "Payment due: $X" inline |
| `paymentDetail.paymentMessageStatusCode` (string) | "PAYMENTTODAY" | Red urgency banner when due today |
| `nextPaymentDueDate` (YYYYMMDD) | "20260526" | "Due in N days" countdown |
| `pastDueAmount` (number) | 0 (or > 0 = late) | Red past-due banner, financial-emergency indicator |
| `lastStmtBalance` (number) | last statement balance | "Statement: $X.XX (May 1)" disambiguates from current |
| `lastStmtDate` (YYYYMMDD) | last statement date | (above) |
| `lastPaymentAmount` (number) | 13279.12 | "Paid $X.XX on May 4" footer line — confirms recent pay |
| `lastPaymentDate` (YYYYMMDD) | "20260504" | (above) |
| `nickname` (string, top-level) | "Amazon" | Replace bare numeric ID with "Amazon ··5088" everywhere |
| `mask` (string, top-level) | "5088" | (above) |

### Lower-priority untapped fields (informational, capture for free)

`accountOpenDate`, `aprAsOfDate`, `autoPayEnrolled`, `cashAPR`, `purchaseAPR`, `cashAdvanceLimit`, `closed`, `lockStatus`, `nextClosingDate`, `payInFull`, `productCode`, `rewardProgramCode`, `rewardsEligible`. Capture these once (~free disk cost) for future feature opportunities; don't render them yet.

### The unlock pattern (~30 LOC)

In `chaseDriver.ts:runFetch`, the JSON extraction block already destructures `currentBalance` / `availableCredit` / `pendingChargesAmount`. Extend that block to pull the additional fields from `detail` + `response` + the response root. Widen `ChaseAccountSnapshot` in `src/shared/types.ts` to carry the additional fields as typed numbers/strings. That single change unblocks features 1, 2, 3, 4, 7, 8, 10 from Round 3.

### Risk: zero
Same XHRs, same data, just persisting more of it. No additional Chase calls.

---

## Round 2 — Chase resource blocklist (CDP-level)

Captured 47 XHR responses across 8 hosts during one snapshot fetch. **2 are critical; 18 are noise.**

### Block (Tier 1 — zero risk, ship)

```ts
const BLOCKED_URL_PATTERNS_CHASE = [
  '*://c.go-mpulse.net/*',       // Akamai mPulse RUM (separate from Akamai Bot Manager)
  '*://analytics.chase.com/*',   // Chase self-hosted Adobe Analytics ingestion
  '*://reco.chase.com/*',        // Recommendations beacons (post-data, free win)
];
```

**Why these are safe:**
- `c.go-mpulse.net`: Akamai's RUM product — **separate from Akamai Bot Manager**. The bot-manager sensor lives on `secure.chase.com/auth/fcc/adaptive` and the `_abck`/`bm_*` cookies. mPulse is the *measurement* layer; bot-manager is the *security* layer.
- `analytics.chase.com`: 16 fire-and-forget beacons, all 0-byte responses. Self-hosted Adobe Analytics. Not Akamai.
- `reco.chase.com`: 2 beacons fire AT +5635ms (after both data XHRs we care about). Blocking has zero wall-time cost; just cleans up the tail.

**Saving:** ~50-500ms shaved off hydration. The mPulse + analytics requests fire in the +53ms to +2530ms window where the SPA is contending for HTTP/2 stream slots.

**Implementation:** Mirror the Amazon pattern in `src/browser/driver.ts:140-263` — add a `BLOCKED_URL_PATTERNS_CHASE` constant + a per-page `Network.setBlockedURLs` CDP call in `openChaseSession`. ~25 LOC.

### Don't block

| Host | Why |
|---|---|
| `secure.chase.com/svc/wl/auth/*` and `/auth/fcc/*` | Akamai sensor lifeline — instant `_abck` invalidation if blocked |
| `asset.chase.com/*` | JS bundles + config; SPA fails to render |
| `static.chase.com/content/pq/*` | CMS page fragments; SPA reads synchronously |
| `static.chasecdn.com/splitio/*` | Feature-flag SDK; **could** be blocked but needs a sacrificial test first (Split.io throws when no data, depends on Chase's fallback handling) |

### Tier 2 (speculative — A/B in a sacrificial profile first)

`*://static.chasecdn.com/splitio/sdk/splitChanges*` — 11.1MB body that fires twice during hydration. If Chase's SPA gracefully falls back to default flag values when this is missing, blocking saves *real* bandwidth. If it doesn't, the SPA breaks. Don't ship blind.

---

## Round 3 — Bank tab feature opportunities (top 5)

Given Stage B's typed JSON, here's the highest user-value × lowest effort lineup:

### 1. Credit utilization indicator (HIGH priority)
- Shows: `(currentBalance / creditLimit) × 100` with FICO color thresholds (green <30%, amber 30-50%, red >50%)
- Why: single biggest user-controllable FICO lever
- LOC: ~30 (small bar/percent on each card)
- Data: `creditLimit` + `currentBalance`

### 2. Due-date warning + payment-due amount (HIGH priority)
- Shows: "Payment due in 5 days" or red "DUE TODAY" ribbon
- Why: prevents late fees — single feature with measurable dollar value
- LOC: ~50 (date math + status switch)
- Data: `nextPaymentDueDate`, `paymentDetail.paymentAmount`, `paymentMessageStatusCode`

### 3. Multi-card aggregate strip (HIGH priority)
- Shows: total balance / total available / total points / total pending across all profiles, in a strip above the grid
- Why: zero new captured fields, pure aggregation. Outsize "this is a real dashboard" feel
- LOC: ~40 (renderer-only)

### 4. Card metadata enrichment — nickname + mask (HIGH priority)
- Shows: "Amazon ··5088" instead of bare numeric `cardAccountId`
- Why: tiny code change, fixes the entire card hierarchy
- LOC: ~15
- Data: `nickname`, `mask`

### 5. Statement balance + last-payment line (MED-HIGH priority)
- Shows: "Statement: $X.XX (May 1)" + "Paid $13,279.12 on May 4"
- Why: closes the loop on Pay my Balance UX, disambiguates statement vs current
- LOC: ~30 (two footer lines)
- Data: `lastStmtBalance`, `lastStmtDate`, `lastPaymentAmount`, `lastPaymentDate`

### Skip / defer
- APR disclosure (clutter, static info)
- Auto-pay scheduling (out of scope, real-money write to Chase)
- Health score (vanity metric, dilutes signal)
- Full history export (premature persistence change)
- Sortable card list (premature, only matters at 5+ cards)
- Threshold notifications (DEFER — builds on #2 first)

### Total bundle effort (1+2+3+4+5 ALL): ~165 LOC renderer + ~30 LOC main

---

## Round 4 — Correctness audit (14 findings)

Bug hunt instead of perf optimization. Top concerns by severity:

### Critical (data loss potential)

**1. Concurrent writes to `chase-profiles.json`** (`chaseProfiles.ts:86-89`)
Direct `writeFile()` with no locking. Renderer can call `chaseAdd` while another path is mid-write. Last write wins. Tiny file = low probability, but data-loss potential is severe. **Fix: write-temp-then-rename.**

**2. JSON parse failure on corrupted session-state silently logs out user** (`chaseDriver.ts:131-216`)
If session-state JSON is truncated (partial write, disk full, crash mid-write), `JSON.parse` throws and the catch logs warning + continues with no session. User has no idea it was corruption vs real expiry. **Fix: catch parse separately, surface a different error path.**

**3. Concurrent writes to `chase-redeem-history.json` race with snapshot store** (`chaseRedeemHistory.ts:43-46`)
Both `chaseRedeemAll` and `chaseSnapshotRefresh` go through `loadAll → modify → saveAll` against the same file family. Per-handler in-flight guards prevent OPENING concurrent sessions, but not concurrent file WRITES. Atomic on POSIX, NOT on Windows. **Fix: same write-temp-rename pattern as #1.**

**4. Force-quit during `attachSessionAutoSave` flush corrupts session-state** (`chaseDriver.ts:421-462`)
60s interval writes, then OS kills mid-write = truncated JSON next launch. Pairs with #2 to silently log user out. **Fix: write-temp-rename + add to the auto-save flush. Or just fsync.**

### High (race conditions)

**5. `chasePayCancel` doesn't atomically clean up `chaseActionSessions`** (`index.ts:2004-2014`)
Race window ~50ms between `chaseActionSessions.delete(id)` and the `on('close')` handler firing. Leaves the map in inconsistent state briefly. **Fix: capture-then-delete pattern.**

**6. Pay-window concurrency check has a TOCTOU window** (`index.ts:1918-1926`)
The `existing` check doesn't atomically prevent concurrent open. Multi-tab clicks could open two Chrome windows for same userDataDir. ProcessSingleton lock causes obscure failure. **Fix: set `chasePayInFlight` BEFORE the bringToFront check.**

**7. `chaseActionSessions` map mixes Pay + Open Rewards sessions without distinguishing** (`index.ts:1550-1583` vs `1918-1950`)
User can: open Rewards window → click Pay → handler sees session exists → `bringToFront` shows Rewards window while UI thinks it's a Pay window. **Fix: split into two maps OR add a `type: 'pay' | 'rewards'` field.**

### Medium (silent failure / leakage)

**8. Keychain-locked vs creds-deleted indistinguishable** (`chaseCredentials.ts:100-118`)
`safeStorage.decryptString()` failure collapses to "no credentials." User on a locked-keychain Mac gets told to re-login forever. **Fix: check `safeStorage.isEncryptionAvailable()` first, separate the two paths.**

**9. `cardAccountId` leaks into log messages** (`chaseDriver.ts:879-880, 1219-1221`)
URLs with cardAccountId end up in error strings + logger payloads + screenshot filenames. Combined with profile label = PII in logs the user might share. **Fix: redact (last 4 digits only).**

**10. STALE_INFLIGHT_MS off-by-zero with slow Chase** (`index.ts:1635-1643`)
3-minute eviction `>` boundary. If a fetch takes exactly 3:00 (slow Chase, overloaded machine), eviction fires while the fetch's finally is closing the Chrome window. Concurrent redeem could grab the userDataDir lock. **Fix: change to `>=` + jitter buffer.**

### Low (architectural debt)

**11.** Watcher in pay window doesn't check `page.isClosed()` before `waitForFunction` — could hold session 15 min after user closed window
**12.** `attachSessionAutoSave` teardown could be skipped on init throw — assignment-before-call edge case
**13.** `context.cookies()` failures swallowed; future "if cookies===0 → loggedIn=false" logic would mis-fire on read errors
**14.** Memory: `page.on('response')` listener architectural footgun if context-pool refactor lands without explicit `.off()` audit

---

## Synthesized priorities

### Tier S — ship next (highest value, lowest risk)

| # | Change | LOC | Risk | Notes |
|---|---|---|---|---|
| **S1** | Widen `ChaseAccountSnapshot` + extract additional JSON fields in runFetch | ~30 | Zero | Foundation for all Bank tab features |
| **S2** | Write-temp-rename helper for all chase-*.json writes | ~30 | Zero | Closes critical data-loss window |
| **S3** | CDP blocklist for Chase (mPulse + analytics + reco) | ~25 | Low | ~50-500ms per fetch saved |
| **S4** | Card metadata enrichment (nickname/mask in UI) | ~15 | Zero | Tiny, fixes whole card hierarchy |
| **S5** | Multi-card aggregate strip | ~40 | Zero | Pure renderer aggregation |

**Bundle: ~140 LOC, zero anti-bot risk, addresses correctness + perf + UX in one PR.**

### Tier A — ship soon (high value, modest effort)

| # | Change | LOC | Notes |
|---|---|---|---|
| A1 | Credit utilization indicator (#1 from Round 3) | ~30 | Highest user value |
| A2 | Due-date warning + amount (#2 from Round 3) | ~50 | Late-fee prevention |
| A3 | Statement balance + last-payment line (#5 from Round 3) | ~30 | Disambiguates statement vs current |
| A4 | Past-due banner (Round 3 #8) | ~10 | Cheap insurance |
| A5 | Capture run during real redemption | 5 min user time | Unblocks Stage B for redeem (~0.5-1.5s) |
| A6 | Race fixes (#5, #6, #7 from Round 4 audit) | ~40 | Race-condition hygiene |

### Tier B — defer until measured

- Stage B for redeem flow (depends on A5 capture)
- Stage C direct-fetch for redeem (depends on A5 + token-capture work)
- Threshold notifications, sortable cards, history export
- Splitio resource block (needs sacrificial-profile A/B)
- Worker stagger / lazy-spawn (already deemed marginal at concurrency 2)

### Tier C — don't ship

- UA spoofing, headless mode, fingerprint masking
- Auto-pay integration (out of scope)
- Health score / gamified metrics
- `context.request.get()` direct HTTP (Node TLS / JA3 mismatch)

---

## What changed our understanding from prior passes

| Prior assumption | New evidence |
|---|---|
| `dashboard/module/list` returns 3 fields we use | It returns **50+ fields per card detail object** — 90% of what AmazonG could surface is already free |
| Chase loyalty endpoints are unknown | High-confidence inference: redemption is `wr` namespace, validate-then-execute pattern, response carries order number |
| Snapshot fetch was already lean | 18 noise XHRs fire during hydration contention window (mPulse, analytics, reco) — blocking is free |
| `chase-profiles.json` writes are safe | They are direct `writeFile()` — Windows + crash = corruption |
| Stage B was the perf finish line | Stage B uncovers a richer surface: same fetch path can drive 7+ new features for renderer-only effort |

---

## Recommended next action

**Single PR, highest-leverage:**

Widen `ChaseAccountSnapshot` (S1) + write-temp-rename helper (S2) + CDP blocklist (S3). ~85 LOC main-process work that:
1. Closes a critical data-loss window (Tier S2)
2. Saves ~50-500ms per fetch (Tier S3)
3. Unblocks ~7 future Bank tab features as renderer-only PRs (Tier S1)

Then in follow-up PRs, ship the user-facing features one at a time (utilization, due-date, multi-card aggregate, etc.) — each is small enough to validate independently and the foundation is already in place.

**The Tier S bundle is the right next ship after the current `chase-perf-tier-a` branch lands.** Pass-3's bundle (Akamai cookie filter + TTL + structured errors + inline Sign-in) is the v0.13.28 release; this would be v0.13.29.
