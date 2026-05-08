# Chase perf — pass 3 roadmap (4-round research synthesis)

**Date:** 2026-05-07
**Status:** research only, nothing shipped from this pass
**Builds on:** Tier A + A2 + Stage B (shipped on `chase-perf-tier-a` branch)

Four parallel rounds: redeem flow, concurrency engineering, session lifetime, UX/perceived perf. The single biggest finding **is not a perf optimization** — it's a likely root-cause for "session works yesterday, dead today."

## TL;DR — top 3 things ranked by ROI

| # | Change | Saving / Impact | Risk | LOC |
|---|---|---|---|---|
| **1** | **Stop restoring Akamai cookies (`_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`) across process restarts.** Filter them out of the JSON snapshot restore in `openChaseSession`. Let Akamai mint fresh per launch. | Likely fixes "session expired overnight" — biggest UX pain | Low | ~10 |
| **2** | **TTL gate on `chaseSnapshotRefresh` IPC.** Skip the chromium spawn entirely when last successful fetch was <60-120s ago. | Killshot for double-clicks, StrictMode, panic-clicks. ~5s saved per dropped call | Low | ~15 |
| **3** | **Inline "Sign in to Chase" button on session-expired error rows.** Remove the worst current UX moment (red error text with no visible action). | Cuts cognitive distance on the worst-case path | None | ~20 + ~50 prereq |

These three together: **~95 LOC, no anti-bot weakening, addresses the user's biggest pain points.**

## Round 3 finding — Akamai cookie pollution (THE ONE)

`src/main/chaseDriver.ts:131-145` restores all cookies from the JSON snapshot, including Akamai's bot-management cookies:
- `_abck` — the master sensor-data digest cookie. Carries timestamps + counters + a signed digest of the JS-derived browser fingerprint that minted it.
- `bm_sz`, `ak_bmsc`, `bm_sv` — supporting Akamai telemetry / sensor-state cookies.

**The problem:** Akamai mints `_abck` under a specific TLS session + Chrome process state. When AmazonG relaunches, the old `_abck` is replayed under a NEW Chromium TLS session with subtle fingerprint drift (ephemeral TLS handshake, different process-level entropy, etc.). This is **exactly the mismatch Akamai is built to detect** — the cookie's embedded sensor-digest no longer matches the live request fingerprint, and the cookie is invalidated on first use. Chase reads "Akamai cookie invalid" as "session expired" and bounces to /logon.

**Why this matters:** the user's empirical observation in this conversation (the Cuong profile that worked yesterday but showed login form today) is exactly this pattern. AmazonG's auth-cookie persistence is correct (we restore `secure.chase.com` Path=/ cookies, the JPMC session tokens, etc.) — but we ALSO restore `_abck`, which kills the session as soon as it's used.

**The fix is a 4-line filter** in the cookie-restore loop:

```ts
const SKIP_COOKIES = /^(_abck|bm_sz|ak_bmsc|bm_sv)$/i;
const eligibleCookies = (state.cookies ?? []).filter(c => !SKIP_COOKIES.test(c.name));
if (eligibleCookies.length > 0) await context.addCookies(eligibleCookies);
```

The first nav of the new session triggers Akamai's sensor JS, which mints a fresh `_abck` valid for the new TLS state. Same as a real Chrome user closing + reopening the browser.

**Sources for this finding:**
- Captain Compliance, Kameleo glossary (cookie structure)
- Scrapfly Akamai bypass writeup (rotation cadence + invalidation triggers)
- Cross-checked against MaxxRK/chaseinvest-api's design — they use `curl_cffi` chrome impersonation specifically because raw HTTP TLS doesn't match a real browser's. Same root cause shape.

**Expected impact:** if Round 3's hypothesis is right, this single change could 5x-10x effective session lifetime. Defaults from a real Chrome with persistent cookies are days-to-weeks; AmazonG's observed behavior of hours-to-day is consistent with the Akamai-cookie-replay invalidation hypothesis.

**Risk:** very low. Worst case: each launch costs the ~500ms Akamai sensor JS warmup it would have done anyway on a fresh device. Cookies that auth Chase itself remain restored — only the bot-manager telemetry cookies are dropped.

## Round 1 — redeem flow findings

The redeem flow (22-50s wall-clock) has 6 concrete improvements available, but **all of them are gated on one capture run.** chaseloyalty.chase.com endpoints have **no public reverse-engineering anywhere** — no GitHub repos, no blog posts, nothing. We don't know the URLs.

**The unblocker:** trigger a real redemption with `AUTOG_CHASE_XHR_CAPTURE=1` set. The infra is already wired in `chaseDriver.ts:1122-1129`. One redemption produces a JSONL with:
- The `/home` page hydration XHRs (would let us skip the /home nav, ~3-5s saved)
- The cash-back form's data-load XHRs
- The redeem POST URL + body shape (would let us replace click-Submit + waitForURL chain with a captured POST, ~3-6s saved)
- The success-page confirmation JSON (would let us replace textContent regex scrape with typed JSON, ~0.5-1.5s saved + cleaner)

**Confirmed from MaxxRK's chaseinvest-api source:**
- All Chase /svc/ endpoints require `x-jpmc-csrf-token: NONE` (literal string "NONE")
- Plus `x-jpmc-channel: id=C30`
- Plus standard Chrome headers Playwright auto-attaches

**Don't ship without capture:**
- Speculative endpoint paths would be guesswork.
- Submit-replacement is a money-moving call. Akamai/Shape almost certainly fingerprint the click-vs-fetch pattern at submit time. `Event.isTrusted` is fine because Playwright's locator.click goes through CDP (trusted), but skipping the click entirely changes the behavioral envelope.

**Stage B-style success listener IS shippable today** even without the capture — listen for any POST whose URL matches `/redemption|redeem/i` + method POST + 200 status, parse JSON for `orderNumber` / `confirmationNumber`. ~30 LOC. ~0.5-1.5s saved.

**Best next step for redeem:** schedule a single capture run during a real redemption (5 minutes of user time), then implement based on captured shapes.

## Round 2 — concurrency engineering findings

Three layered improvements, each independently shippable:

### #2.1 — TTL gate on refresh (free win, no architecture change)
`chaseSnapshotRefresh` IPC currently always spawns chromium. Add a `Date.now() - new Date(fetchedAt).getTime() < 90_000` gate before the spawn — return cached result. Covers double-clicks, React StrictMode double-fires, and panic-clicks during the 5-13s fetch window. ~15 LOC. **Killshot for the most annoying class of "why is it spawning a window AGAIN" complaints.** Add a `force=true` IPC param so the explicit "Refresh All" button can bypass.

### #2.2 — Worker stagger (1.5-2.5s, NOT 800ms)
The earlier suggestion of 800ms was too short. Akamai's burst-detection window is at least 3-5s wide (matches the empirical XHR-landing window in `chaseDriver.ts:1209`'s 6s ceiling). 800ms stagger keeps all workers inside the same sensor window. **2s minimum.**

```ts
for (let i = 0; i < workerCount; i++) {
  const offsetMs = i * 2_000;
  setTimeout(() => void worker(), offsetMs);
}
```

~8 LOC. Risk: very low. Saving: lets you raise concurrency to 3-4 on long-card lists (8+ cards). For 4 cards it doesn't help much (already serialized at concurrency 2 = 2 batches).

### #2.3 — Lazy-spawn on first-XHR signal (the real win)
Worker N waits until Worker N-1's `dashboard/module/list` XHR has returned 200 before kicking off. Event-driven instead of wall-clock. Already plumbable: `runFetch` listens on `page.on('response')` for that exact URL. Surface a `onHotZoneCleared` callback up through IPC.

~30 LOC. Concurrency 3-4 becomes empirically viable. The signal is the right one — it means "I'm past Akamai's hot zone" without paying a full DOM-render delay.

### What to NOT do
- Pre-warmed pool of N always-on contexts: ~150-200 LOC, RAM cost ~200MB × N, userDataDir lock conflicts with Pay/Open Rewards. Not worth it until #2.1 + #2.2 + #2.3 ship and we measure that the chromium-spawn cost is actually the bottleneck.
- Pre-fetch on Bank tab open: was tried and reverted because it spawned visible Chase windows on every visit. The reason still applies (Stage B didn't change visibility, just speed).
- HTTP/2 socket pool sharing: architecturally inapplicable across persistent contexts.

## Round 3 — session lifetime (more findings beyond the Akamai cookie filter)

### #3.1 — Pre-expiry warning ping
Schedule an hourly background health check per profile: open a tiny context, navigate to /dashboard, run `maybeAutoLoginAndContinue` to detect auth state, close. If it surfaces `otp_required` or `recovered=false`, push an OS notification BEFORE the user actually hits the broken state. Reuses existing code. Cadence ≥30 min, serialized across profiles to avoid the parallel-fetch invalidation pattern.

### #3.2 — Background "I'm here" ping inside open sessions
While a Chase window is open (Pay, Open Rewards), schedule a `page.evaluate(() => fetch(dashboardModuleListUrl))` every 12-18 minutes (randomized). Same TLS state, no new context spawn. Resets Chase's idle timer without anti-bot suspicion. Only inside USER-FACING windows where it's natural traffic — never in a pure background context.

### #3.3 — Capture Set-Cookie headers in research mode
`AUTOG_CHASE_XHR_CAPTURE` already records request headers. Extend to record response Set-Cookie headers. Will let us pin exactly what Chase's auth cookie TTLs look like vs Akamai's, and confirm the Akamai-cookie hypothesis empirically before committing to the filter from #1.

### Tier C — DON'T do
- UA spoofing, CDP-evasion stealth plugins
- Mobile API endpoints (out of scope, also requires attestation)
- Pure background "keepalive" pings from a relaunched context — defeats the purpose if A1 (Akamai-cookie filter) is the real fix

## Round 4 — UX / perceived perf findings

**Already shipped (verified):**
- Cached-first display from disk (`Bank.tsx:269-289`)
- Per-card progressive update (each refresh keyed by profileId)
- Skeleton UI states (cached values stay visible at 50% opacity during refresh)
- Inline per-card retry button (`Bank.tsx:885-896`)

**The remaining wins, ranked:**

### #4.1 — Inline "Sign in to Chase" button on session-expired errors
Today: red error text *"likely a parallel-fetch rate-limit or expired session. Try refreshing this card alone, or sign in again."* User has to find the Login button on the card itself. The flag flip works (`Bank.tsx:231-233` re-fetches profiles), but there's no affordance.

Fix: when `snapshotError` matches session-expired, render a "Sign in to Chase" button INSIDE the error banner that calls the same `onLogin` handler. ~20 LOC. **Highest UX win available.**

### #4.2 — Structured error kinds
Prerequisite for #4.1 to be cleaner. Make `chaseSnapshotRefresh` return `{ ok: false, reason: string, kind: 'session-expired' | 'rate-limit' | 'unknown' }`. Already half-implemented (regex match on reason). Promote to structured field. ~50 LOC.

### #4.3 — 4-tier color-graded staleness
Today binary 24h amber threshold. Fix: green (<2h), neutral (2-12h), amber (12-48h), red (>48h). Bonus: shorten threshold to 6h when `pendingCharges` or `inProcessPayments` is non-empty. ~30 LOC.

### #4.4 — Per-profile "priority refresh" flag + #4.5 opt-in tab-focus auto-refresh
~180 LOC combined. Lets users mark 2-3 cards as "auto" and have those refreshed on Bank tab open while others stay manual. Only worth it if user actually has 5+ cards.

### Skip
- Sort cards by staleness — breaks muscle memory
- Pre-fetch on launch — same visible-windows reason as before

## Suggested ship order

The highest-ROI 4-item bundle (~95 LOC, no anti-bot weakening):

| # | Change | Why first |
|---|---|---|
| 1 | Filter Akamai cookies on restore | Likely fixes "session expired overnight" — the biggest UX pain |
| 2 | TTL gate on `chaseSnapshotRefresh` | Free win; addresses "why is it opening a window AGAIN" |
| 3 | Worker stagger 2s | 8 LOC; harmless; enables concurrency 3-4 in future |
| 4 | Inline "Sign in to Chase" button on session-expired errors (+ structured error kinds) | Cuts cognitive distance on the worst-case path |

After that bundle ships and is validated:

5. Capture run during a real redemption (`AUTOG_CHASE_XHR_CAPTURE=1`)
6. Stage B-style success listener for redeem flow (~30 LOC, ~0.5-1.5s, zero risk)
7. Drop `/home` nav from redeem flow if capture confirms hydration XHRs are identifiable
8. Lazy-spawn on first-XHR signal (~30 LOC, raises concurrency to 3-4 reliably)
9. Color-graded staleness UI

## What's still off the table

- `context.request.get()` direct HTTP — Node TLS / JA3 mismatch
- UA / canvas / font / audio fingerprint spoofing — counterproductive
- Headless mode for any Chase flow — Chase fingerprints headless instantly
- playwright-extra-stealth plugin set — third-party patch surface, breaks on Playwright bumps
- Mobile API endpoints — different attestation chain, risky

## Confidence scorecard

| Finding | Confidence |
|---|---|
| Akamai cookie restore is invalidating sessions | Medium-high (strongest available signal: AmazonG's empirical session-loss matches the documented Akamai invalidation pattern; not directly verified) |
| chaseloyalty endpoints are not publicly reverse-engineered | High (4 GitHub repos checked, all target secure.chase.com only) |
| `dashboard/module/list` returns the recon-bar data | High (empirical capture from earlier in this session) |
| Stagger window 1.5-2.5s is right | Low-medium (derived from observed XHR-landing window, not Akamai threshold) |
| Per-card progressive update already works | High (verified by reading Bank.tsx) |

**The single most useful empirical follow-up:** ship the Akamai-cookie filter, then watch session lifetime over a week. If users go from "expired daily" to "expired weekly", the hypothesis is confirmed.
