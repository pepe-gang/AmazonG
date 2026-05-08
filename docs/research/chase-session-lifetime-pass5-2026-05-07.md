# Chase session lifetime — pass 5 (post Akamai-revert)

**Date:** 2026-05-07
**Triggered by:** user observed ~20 min re-auth on this branch. We reverted the pass-3 Akamai cookie filter (which hypothesized restoring _abck across launches caused fast expiry) — but the user wasn't sure if 20 min was a regression vs normal Chase behavior.

Four parallel research rounds: real Chase TTL data, post-mortem of pass-3 hypothesis, diagnostic instrumentation plan, session-extension techniques.

## TL;DR

**1. 20 minutes is on the LONG end of normal Chase web idle timeout.** Public sources: Chase's own session-warning page says "we'll automatically sign you out in approximately 1 minute" with the warning typically appearing around 10-11 min of idle. Authenticated XHRs reset the idle timer, so 20 min of *activity* before re-auth is plausibly normal — not a regression. Confidence: medium.

**2. Pass-3's Akamai cookie filter hypothesis was wrong, AND we now understand why.** The mental model was: "_abck embeds a TLS+process fingerprint, so cross-process restore invalidates." Wrong on two counts:
- `_abck` doesn't bind to TLS — JA3/JA4 are fingerprinted at each request, not embedded in cookie state
- The embedded sensor digest is over CLIENT ENVIRONMENT (UA, navigator, screen, fonts, canvas, AudioContext) — properties that are STABLE across launches of the same persistent profile

Real Chrome restores `_abck` from SQLite on every cold start. Akamai-protected sites tolerate this all day. AmazonG presents the same JA3 + same device digest as the prior session — there's no structural reason Akamai would reject it. **Filtering REMOVED a device-trust signal Chase uses to extend TTL**, which is why 20-min appeared.

**3. The right next move: ship diagnostic instrumentation, NOT another speculative fix.** After 7 days of real data, we can definitively answer "is 20 min normal Chase TTL or are we doing something wrong?" Without the data, more hypotheses would just be guessing.

## Round 1 — Real Chase web session TTL

**Sourced findings:**
- **Idle timeout: ~10-11 minutes** based on:
  - Chase's own ChaseLock variant shows "Your session will expire in 30 seconds"
  - chase.com warning text quoted on HN: "we'll automatically sign you out in approximately 1 minute"
  - Multiple aggregator articles cite "10-15 min idle" — anecdotal but consistent
- **Absolute timeout: no public data.** Industry default 8-24h, no Chase-specific source.
- **Warning window: 30s to 1 min** before forced logout, depending on Chase property.
- **What resets the idle timer:** authenticated XHR is industry standard, not Chase-specific. Scrolling/focus likely DON'T reset.
- **Mobile vs desktop web:** no public timing diff data.
- **Remember-this-device:** affects 2FA skip on next login, NOT current-session TTL.
- **Cross-tab interference:** AmazonG's persistent context is a SEPARATE cookie jar from regular Chrome. Independent sessions, no collision.

**Verdict on the 20-min observation:** plausibly normal. If user was actively clicking AmazonG every few minutes, the idle timer should keep resetting — meaning the re-auth at 20 min is more likely an absolute-timeout boundary OR a bot-detection-driven re-auth than the standard idle path. **Confidence: medium.**

**Sources:** HN 35038210, ChaseLock SessionTimeout.htm, FlyerTalk UR thread, J.P. Morgan 2-step doc.

## Round 2 — Post-mortem of pass-3 Akamai hypothesis

**What pass-3 got wrong:**

The reasoning treated `_abck` like a session-bound JWT signed with an ephemeral process key. It isn't. It's a long-lived stamp the sensor script keeps refreshing in-place as long as the page periodically POSTs telemetry.

**Actual `_abck` lifecycle:**
- Format: `<version>~<sensor-validation-id>~<request-counter>~<deadline-ts>~<flags>~<HMAC>`
- **Mint:** first hit issues unsolved cookie (`...~-1~-1~...`)
- **Solve:** sensor script POSTs telemetry, response Set-Cookies a valid cookie with future deadline
- **Refresh:** subsequent sensor POSTs roll the deadline forward; freshness window typically ~1 hour
- **Invalidation:** server flips to `~0~` only when sensor data malformed, JA3/JA4 mismatches device class, or expected cookie chain is broken

The cookie is "good for ~1 hour or until the sensor next refreshes it" — NOT "single-use" and NOT "process-bound."

**Why filtering MADE THINGS WORSE — ranked hypotheses:**

| # | Hypothesis | Confidence |
|---|---|---|
| H5 | **Device-trust signal removal.** Chase's app-layer session uses the bot-management cookie set as a "this device has been here before" hint. Stripping all four = clean-slate visitor → Chase shortens auth TTL. | ~55% |
| H1 | **"New device" risk-scoring.** Closely related to H5; cold-start clients get more aggressive challenge-and-revalidate cadence. | ~25% |
| H3 | **Mixed-state corruption.** Plausible only if filter were partial; we dropped all four together. | ~10% |
| H2 | **Incomplete fresh mint.** Possible if early Chase navs don't give sensor enough time, but Chase pages keep sensor running. | ~7% |
| H4 | **Confirmation bias.** N=1; possible. | ~3% |

**What we now know:**
- Cross-process `_abck` restore is normal (real Chrome does it daily)
- Pass-3's invalidation model was structurally wrong
- Filter correlation with shorter session lifetime is real (revert restored prior behavior)

**What we still don't know:**
- Whether 20-min-vs-overnight delta is reliably reproducible (N=1 user)
- Whether server-side TTL or Akamai-layer effect drives re-auth
- Whether localStorage device-trust token is being preserved correctly across all session lifecycles
- Akamai freshness window for chase.com specifically

## Round 3 — Diagnostic instrumentation plan (~480 LOC)

**The plan:** ship instrumentation that lets us empirically answer "is this normal Chase or are we doing something wrong?" After 7 days of data, the answer is in the JSONL.

### Components

**A. Session-lifecycle event log** (`src/main/chaseSessionEvents.ts`, ~120 LOC)
JSONL append-only at `userData/chase-session-events/{profileId}.jsonl`. One line per significant event:
- `event: "open"` with cookieCount, hasAbckCookie, abckHash, lastEventAgeMs, lastSnapshotOkAgeMs
- `event: "auth-needed"` with signal kind: 'logon-url' | 'iframe-overlay' | 'inline-shell' | 'identity-verification'
- `event: "auto-login-attempted"` with outcome + duration
- `event: "snapshot-ok"` with field counts
- `event: "snapshot-failed"` with reasonKind
- `event: "close"` with cookieCount, abckChangedFromOpen, abckRotations, sessionDurationMs

Cost: ~250 bytes/line, ~1KB/fetch, ~1MB/day per user across all profiles. Lazy rotation at 5MB.

**B. Cookie diff helper** (`src/main/chaseCookieDiff.ts`, ~60 LOC)
`diffCookies(before, after) → { added, removed, changed, abckChanged, abckBefore, abckAfter, bmRotations }`. Uses `hashCookieValue(value)` (12-char sha256 prefix) so we never log actual cookie values to disk.

**C. Categorized auth-prompt signal** (~25 LOC in `chaseDriver.ts:739-790`)
Replace current 2-boolean log with a discriminated `signalKind`. Distinguishes between URL-based bounce, iframe overlay, "inline shell" (re-auth baked into SPA without URL change), and identity-verification.

**D. Time-since-last-success on session open** (~15 LOC)
Read JSONL on every `openChaseSession`, find most recent `snapshot-ok`, log age. **THE key signal** for distinguishing "20-min server TTL" from "AmazonG-triggered invalidation."

**E. Auto-login-fired counter per fetch** (~10 LOC)
Track in local var, log on close event. If consistently >0, cookie restore is broken.

**F. Renderer-side debug panel** (~120 LOC, dev-mode only)
Collapsible drawer showing the per-profile session-events tail. Auto-refreshes every 5s. Color-coded by event kind.

### After 7 days of data — interpretation guide

| Pattern in JSONL | Hypothesis confirmed |
|---|---|
| `lastSnapshotOkAgeMs` clusters tightly at 18-22 min on `auth-needed` events | Chase has hard server-side TTL ~20 min — only fix is "auto-login is fast enough you don't notice" |
| `lastSnapshotOkAgeMs` is bimodal (cluster at ~20 min + cluster at hours/days) | Two failure modes — subdivide by signal kind |
| `lastSnapshotOkAgeMs` is highly variable (5 min to 2h) | Something WE do is invalidating sessions; TTL hypothesis wrong |
| `abckChangedFromOpen` is `false` on most closes AND we see frequent `auth-needed` | autoSave isn't catching rotation — real bug |
| `autoLoginsThisSession >= 1` rate >5% per fetch | Cookie restore is silently broken every fetch |
| `signal: 'inline-shell'` rate >10% | Detector missing modern Chase overlay variant |
| `auth-needed` clusters at fixed time-of-day (e.g., 03:00 local) | Chase's nightly batch session-flush — server-side TTL with fixed boundary |

## Round 4 — Session extension techniques (top 3)

**Constraint: no anti-bot weakening.**

### #1 — Keepalive ping inside open user-facing windows (~30 LOC, zero/low risk)
While a Pay/Open-Rewards window is open, fire `page.evaluate(() => fetch('/svc/rl/accounts/secure/v1/dashboard/module/list', {credentials:'include', headers:{'x-jpmc-csrf-token':'NONE','x-jpmc-channel':'id=C30'}}))` every 12-18 min randomized. Skip when `document.visibilityState !== 'visible'`. Same socket pool, same TLS, same cookie state — transport-indistinguishable from the SPA's own XHRs.

**Mechanism:** Chase's idle timer is reset by any authenticated XHR. The endpoint is the same one the SPA fires during hydration.

### #2 — More aggressive `attachSessionAutoSave` (~40 LOC, zero risk)
Add three triggers to the existing 2s framenavigated coalesce + 60s interval:
- `page.on('response')` matching `/svc/rl/.../module/list` AND status 200 → coalesced save
- `page.on('response')` where Set-Cookie present in headers → save (cookie rotated)
- 30s "no-event" idle save via reset-on-event timer

Doesn't extend TTL — ensures we don't lose the most recent rotated cookies on force-quit. Combined with #1, this stretches *effective* lifetime as observed by the user.

### #3 — Detect "session about to expire" warning + click "Stay signed in" (~30 LOC, low risk)
`page.locator('text=/session.*(expire|time out)/i')` watcher polling every 5s inside open windows. On match: click "Stay signed in" if present, fire one keepalive XHR regardless. Highest-confidence per-event signal we can get short of an XHR capture.

**Caveat:** needs one DOM-watcher capture run (~14 min, leave Pay window open) to confirm the exact selector text. Without that, #3 is selector guesswork.

### Skip permanently
- Cross-context session sharing (#4 from research) — wrong model for AmazonG; each profile is a different Chase login
- Background context spawn for keepalive — exact Tier-C anti-pattern from pass3
- Pre-fetch on app launch via real network probes — same Tier-C concern; file-state-only pre-flight is fine

## Synthesized recommendation

**Don't ship more speculative fixes. Ship the diagnostics instead.**

The pass-3 Akamai filter taught us that hypothesizing without instrumentation produces wrong answers fast. The right next move is the ~480 LOC diagnostic patch — it's all-on logging that answers the empirical question definitively.

**Order of operations:**

1. **Ship diagnostics PR** (~480 LOC, all-on logging + dev-mode debug panel). Lets the user see when re-auth happens and what triggered it.
2. **Use AmazonG normally for ~3-7 days.** Don't change behavior to test — just collect baseline data.
3. **Read the JSONL.** Apply the interpretation guide above. Now we KNOW whether 20-min is server TTL or our bug.
4. **If server TTL:** ship #1 (keepalive ping). Validate against data.
5. **If our bug:** the JSONL will point at exactly which event sequence is wrong (auto-login firing every fetch, _abck not rotating, inline-shell never detected, etc.)

**What NOT to ship right now:**
- More cookie filtering / restoration tweaks (we just learned this lesson)
- Keepalive pings without diagnostics first (might fix the symptom, but we won't know what we fixed)
- Stay-signed-in clicker without DOM capture (selector is guesswork)

**What's safe to ship in parallel:**
- The pending-charges race fix (already done — `page.content()` + selector wait)
- TTL gate on snapshot refresh (already shipped pass-3, doesn't depend on session-lifetime hypothesis)

## Open questions for the user

1. **What does "20 min and login again" actually look like?** Does Chase show:
   - a) A full /logon URL redirect with username pre-filled
   - b) An iframe overlay with username pre-filled
   - c) The Cuong window auto-login transparently and you only see a brief flash
   - d) Identity verification / 2FA prompt
   
   The user-visible signal narrows the hypothesis significantly.

2. **Active or idle?** Were you clicking around AmazonG / Chase windows during those 20 min, or did you walk away? If idle, 10-11 min would be expected; 20 is actually long.

3. **Was this on a profile that had a fresh login (post-2FA) or a long-restored one?** Fresh post-2FA sessions might have a different TTL signature than ones restored from JSON.

The diagnostic instrumentation will tell us all of this empirically. Without it, more rounds of research are just speculation on top of speculation.
