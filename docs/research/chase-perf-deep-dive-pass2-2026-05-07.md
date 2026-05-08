# Chase perf deep-dive — pass 2 (4-round research)

**Date:** 2026-05-07
**Builds on:** `chase-perf-deep-dive-2026-05-07.md` (Tier A shipped on `chase-perf-tier-a` branch)

Four parallel research rounds:
1. Codebase audit — every Chase file end-to-end, find unshipped wins
2. Playwright hybrid-request capabilities (`context.request` vs `page.evaluate(fetch)` vs `page.on('response')`)
3. Chase web architecture inference — what JSON endpoints power the SPA
4. Bank anti-bot fingerprint surface — what's leaking, what would harden

## TL;DR

**The biggest unexplored win is `page.on('response')` passive XHR interception.** Today we navigate, wait for SPA hydration to finish painting the DOM, then scrape rendered text. The SPA fires its own JSON XHRs to populate that DOM; if we listen for those JSON responses and resolve as soon as the data arrives, we skip the whole hydration tail. Saves **~2-6s per snapshot fetch**, with **zero anti-bot risk** because we don't issue any new requests — we only listen to the ones the SPA was going to fire anyway.

**The biggest dangerous-looking idea to AVOID: `context.request.get(url)`.** It's tempting (clean API, share cookies), but Playwright's `APIRequestContext` runs in Node and uses Node's TLS — so JA3 won't match the Chromium pages from the same context. Akamai (and Shape) cross-check JA3 against cookie sessions; mismatch is a strong tell. **Don't ship this against Chase.**

## Round 1 — Codebase findings (10 unshipped opportunities)

Sorted by ROI:

### A2-1. Race the 3 candidate selectors in redeem checkbox click
**File:** `chaseDriver.ts:919-935`
**Current:** sequential for-loop with 5s waitFor each — failure path = 15s total.
**Fix:** `Promise.any([...candidates.map(c => c.waitFor({timeout: 10_000}).then(() => c))])` — first match wins.
**Saving:** up to 10s on selector-drift failure path (zero on happy path).
**Risk:** zero. Same selectors, same eventual scope.
**LOC:** ~10.

### A2-2. `captureSummaryDebugSnapshot` — drop `fullPage: true`
**File:** `chaseDriver.ts:363`
**Current:** `page.screenshot({ path: file, fullPage: true })` — scrolls the page off-screen rendering all content, then re-stitches.
**Fix:** drop `fullPage: true` (defaults to viewport).
**Saving:** ~100-300ms on error-path snapshots (error path only).
**Risk:** zero. Diagnostic artifact, not user-facing.
**LOC:** 1.

### A2-3. Merge the dual-nav in `openChasePayPage`
**File:** `chaseDriver.ts:1326-1343`
**Current:** `goto('/dashboard') → maybeAutoLoginAndContinue → pacingPause → goto('/dashboard/summary/.../flyout=payCard,...')` — two full navs.
**Fix:** if the session is already warm (cookies present at session-open log shows `cookiesAtOpen > 0`), skip the dashboard hop and go directly to the flyout URL. Fall back to dual-nav if recovery is needed.
**Saving:** ~500-800ms per pay-window open.
**Risk:** low — flyout URL contains the AI param so it has card context already.
**LOC:** ~15.

### A2-4. `attachSessionAutoSave` — coalesce framenavigated + 60s interval
**File:** `chaseDriver.ts:388-429`
**Current:** 2s framenavigated coalesce AND independent 60s interval — both schedule writes that don't dedup.
**Fix:** single coalesced timer; interval just resets the coalesce timer.
**Saving:** ~1-2 disk writes per multi-step session (cosmetic).
**Risk:** low.
**LOC:** ~10.
**Verdict:** not worth shipping unless you're already in this file. Cosmetic.

### A2-5. Context pool — keep warm contexts for 60-120s after fetch
**File:** `chaseDriver.ts:1059+` (snapshot fetch entry point)
**Current:** every snapshot fetch calls `openChaseSession` → `chromium.launchPersistentContext` — pays ~3-5s spawn cost every time.
**Fix:** keep one warm context per profile in a Map; on snapshot/redeem/pay completion, schedule teardown after 60-120s. If a new call comes in within the window, reuse.
**Saving:** ~3-5s per fetch (on the 2nd+ fetch within the pool window — i.e., when user clicks Refresh on the same card twice in a minute, or Fetch All across many cards).
**Risk:** medium. Profile-lock conflicts (user opens Pay while pool window is still warm), context-crash recovery, complexity.
**LOC:** ~80.
**Verdict:** worth shipping but as its own PR. Defer until Tier B is in.

### A2-6. Other smaller findings (lower priority)
- A2-6a. `redeem flow line 832` — `waitForSelector('text=Available points')` after `waitUntil: 'load'`. Probably redundant on happy path. 0-3s saving on edge cases. Risk: low.
- A2-6b. Snapshot fetch summary/loyalty: `waitFor` + `textContent` in Promise.all could be `locator.textContent({timeout: ...})` directly (locator implicit-waits). Saves the explicit waitFor round-trip. ~50-100ms.
- A2-6c. Redeem flow line 998 pacingPause: comment-protected; suspect but leave alone.

## Round 2 — Playwright hybrid-request analysis

### The three options compared

| Signal | `context.request.get()` | `page.evaluate(fetch)` | Real SPA XHR |
|---|---|---|---|
| Cookies | Shared | Shared | Native |
| TLS / JA3 | **Node OpenSSL — MISMATCH** | Chromium BoringSSL ✓ | ✓ |
| HTTP/2 frame order | Node h2 — different | Same socket pool ✓ | ✓ |
| `sec-ch-ua`, `sec-fetch-*` | Manual / often missing | Auto-attached ✓ | ✓ |
| `Origin` / `Referer` | Manual | Auto from page realm ✓ | ✓ |
| sessionStorage access | NO | YES via evaluate | YES |
| Preceding nav events | None — cold | Present on same page ✓ | ✓ |

**Conclusion:** `context.request` looks identical to real Chrome at the cookie layer but is a **different client** at the transport layer. Bot managers like Akamai score TLS+cookies+behavioral history together — a `context.request` call materializing mid-session with a cookie you got from Chromium but a TLS handshake from Node is exactly the kind of mismatch Akamai pattern-matches on.

`page.evaluate(() => fetch(...))` is **transport-indistinguishable** from the SPA's own XHRs. Same socket pool, same TLS, same headers. Only behavioral layers above transport could potentially tell them apart.

### The three patterns ranked by safety

1. **`page.on('response')` passive observation** — listen for the SPA's own XHRs during a normal `page.goto`. Zero new requests, zero perturbation. Resolves as soon as JSON arrives, skipping the DOM-paint tail. **Safest.**
2. **`page.evaluate(() => fetch(...))` with captured tokens** — load SPA once, capture bearer/CSRF headers via `page.on('request')`, replay subsequent calls in-page. Indistinguishable at transport layer. **Safe but more complex.**
3. **`context.request.get()`** — DO NOT use against Chase. JA3 mismatch + no preceding nav events = strong tell.

### Empirical validation path that doesn't touch production Chase
Stand up a local endpoint that logs JA3 + headers + HTTP/2 frame order. Point AmazonG's Playwright code at it under all three patterns and diff. Reproduces what a WAF would see at the transport layer with zero exposure to Chase.

## Round 3 — Chase XHR architecture (sourced findings)

The most useful source: **[`MaxxRK/chaseinvest-api`](https://github.com/MaxxRK/chaseinvest-api)** — a Playwright-based reverse-engineered Python client. Its `urls.py` has confirmed paths:

### Confirmed endpoint shapes

- **Dashboard modules (the recon-bar data):**
  `https://secure.chase.com/svc/rl/accounts/secure/v1/dashboard/module/list`
  This is almost certainly the call that hydrates the recon-bar (balance + available credit + pending charges). Likely **one call serves all three** — not 3 separate XHRs as the existing code's regex split implies.

- **Investment positions:** `/svc/wr/dwm/secure/gateway/investments/.../v2/positions`
- **Equity quotes:** `/svc/wr/dwm/secure/gateway/.../v1/quotes`

### Inferred (verify before shipping)

- **Payment activity (likely):** somewhere under `/svc/rr/accounts/secure/v1/account/activity/...`. The CSV-download variant `/account/activity/download/card/list` is documented (Mühe blog 2016, path shape persists). The JSON variant for the `<tbody class="activityRow">` rows likely lives in the same family.
- **Loyalty (chaseloyalty.chase.com):** **no public sources.** Verify by capturing one real session.

### Auth model
- Cookie-based session is the public-visible model.
- Modern reverse-engineers (2024+) use Playwright instead of `requests` library — strong signal that the auth flow is non-trivial (sensor-based) and rendering in a real browser is the path of least resistance.
- Likely an additional CSRF / anti-forgery header (JPMC-internal name; not publicly known).

### Anti-bot stack — best-guess
- **Almost certainly Akamai Bot Manager Premier.** `_abck`, `bm_sz`, `ak_bmsc`, `bm_sv` cookies on `.chase.com` are the smoking gun (verify by inspecting `Set-Cookie` headers).
- **Possibly F5 Shape Security** stacked on auth endpoints. JPMC has a documented Shape deployment (F5 acquisition press, 2020). Some researchers report seeing both — Akamai at edge, Shape on auth.

### Why this matters for the hybrid approach
The XHR shapes are hypothesized; we don't know the **exact** paths until we capture one real authenticated session. **Before shipping Tier B/C, do one capture run** — `page.on('response', logResponse)` against the user's own Chase account, dump every JSON to `research-logs/chase-xhr-*.jsonl`. Read the captures, identify which JSON populates which UI value, then the implementation is mechanical.

## Round 4 — Anti-bot fingerprint surface

### What we already cover (LOAD-BEARING — DO NOT WEAKEN)
- `--disable-blink-features=AutomationControlled` ✓
- `navigator.webdriver = false` stub ✓
- `headless: false` ✓
- Default UA (no spoofing) ✓
- pacingPause + per-character type with 35ms delay ✓
- Persistent context with localStorage device-trust token ✓

### What's NOT covered (potential vectors)

| Vector | Bot-shape risk | Cover cost | Verdict |
|---|---|---|---|
| Iframe `navigator.webdriver` propagation | Medium — Akamai's sensor sometimes runs in iframes | ~25 LOC | Worth shipping |
| Worker thread `navigator.webdriver` | Medium — Shape's behavioral collector observed in workers | ~10 LOC | Worth shipping with #1 |
| Keystroke timing (currently fixed 35ms) | High if Shape is on the auth path — humans have log-normal distribution | ~8 LOC | Worth shipping |
| Mouse entropy (currently zero) | High if Shape — pure Playwright nav has no mousemove | ~15 LOC | Worth shipping |
| WebGL renderer = SwiftShader? | Low — verify it's not SwiftShader in production builds | ~10 LOC | Diagnostic-only |
| CDP `Runtime.enable` artifacts | Medium IF Chase escalates — currently Akamai marks it but doesn't always block | ~12 LOC, fragile | Defer until users report challenges |
| Canvas/font/audio spoofing | Counterproductive — fingerprint should be STABLE | n/a | DO NOT ADD |
| `playwright-extra-stealth` wholesale | Bundles 12 evasions | +2 deps, ~10 LOC | DO NOT ADD — third-party patch surface |

### What Akamai BM specifically fingerprints (from public reverse-engineering)
Sensor data POST to `/_bm/<token>` carrying:
- Canvas hash, WebGL renderer, screen metrics
- Mouse/keypress timing entropy
- `navigator` enumeration
- Plugin list
- Audio DSP fingerprint
- TLS JA3 cross-checked against UA
- CDP/Runtime artifacts (`cdc_*`, `$cdc`, `__driver_evaluate`, etc.)
- HTTP/2 frame ordering, ALPN behavior

### What F5 Shape adds (if deployed on auth path)
- DOM mutation timing relative to mouse/keyboard
- Focus/blur sequencing
- Paste vs keystroke distinction
- Worker-thread behavioral telemetry

### The single biggest unmitigated risk
**Behavioral monoculture.** Pure Playwright `goto + type` produces zero mousemove, no scroll, deterministic keystroke intervals. If Chase ever escalates from "observe" to "challenge" mode based on Shape's behavioral signals, the auth path breaks first. **Recommendations 2 + 3 from the table address this for ~25 LOC and zero risk.**

## Synthesized ship plan

### Stage A2 — Codebase quick wins (zero anti-bot risk)
Already on `chase-perf-tier-a`. Add to it:

| # | Change | Saving | LOC |
|---|---|---|---|
| 1 | Race candidate selectors in redeem checkbox click | up to 10s on failure path | ~10 |
| 2 | Drop `fullPage: true` from debug screenshot | ~100-300ms on error path | 1 |
| 3 | Skip dashboard nav in `openChasePayPage` when session is warm | ~500-800ms / pay-window open | ~15 |

**Total: ~30 LOC, no anti-bot impact.**

### Stage B — Passive XHR interception (THE BIG ONE)
**Single biggest perf win available.** Add `page.on('response')` to the snapshot fetch path. Listen for the JSON XHRs the SPA already fires. Resolve when the data arrives.

**Prerequisite:** one empirical capture run to identify exact endpoint paths (research script that listens during a real fetch and dumps to JSONL). Then the implementation is mechanical.

**Saving:** ~2-6s per snapshot fetch. The single biggest single change available.
**Anti-bot risk:** zero — we don't issue any new requests.
**LOC:** ~80 for the capture script + ~50 for the production listener.

### Stage C — In-page token replay (orthogonal, more complex)
After Stage B is proven: capture bearer/CSRF tokens once at SPA load via `page.on('request')`, then replay subsequent fetches via `page.evaluate(() => fetch(url, {headers}))`. Eliminates the cross-domain SSO bounce to chaseloyalty entirely (call its endpoints in-page from the dashboard tab).

**Saving:** ~3-5s per snapshot fetch (eliminates the loyalty-domain nav).
**Anti-bot risk:** low — transport-indistinguishable from SPA XHRs.
**LOC:** ~150.
**Defer until Stage B is shipped + stable.**

### Stage D — Anti-bot hardening (orthogonal to perf)
Address behavioral monoculture and iframe/worker fingerprint propagation. None of these speed up Chase per se — they reduce the rate at which Chase escalates the user to extra MFA challenges, which indirectly helps perf because failed auth costs 30-90s of recovery + retry.

| Change | Vector | LOC |
|---|---|---|
| Iframe + worker `navigator.webdriver` propagation | Akamai iframe sensor / Shape worker | ~25 |
| Keystroke jitter (log-normal distribution + occasional 80-200ms "thinking" gaps) | Shape behavioral timing | ~8 |
| Pre-warm mouse + scroll on first nav | Shape mouse entropy | ~15 |

**Total ~50 LOC, ship as its own PR.** No measurable perf gain unless Chase's anti-bot escalates; insurance.

### What we DELIBERATELY won't ship

- ❌ `context.request.get()` — JA3 mismatch from Node TLS stack
- ❌ playwright-extra-stealth — third-party patch surface, breaks on Playwright bumps
- ❌ Canvas/font/audio fingerprint spoofing — fingerprint should be STABLE, spoofing causes more challenges
- ❌ UA spoofing — already documented to make things worse
- ❌ Headless mode for any background flow — Chase fingerprints headless instantly

## Recommended next action

**Capture script first.** Before shipping Stage B, write a one-shot research script that opens a Chase session, navigates to the summary + activity + loyalty pages with `page.on('response', logEverything)`, and dumps every JSON response to `research-logs/chase-xhr-{ts}.jsonl`. Run once on the user's own account. Read the captures. THEN the Stage B implementation is mechanical and risk-controlled.

Without that capture, Stage B is hypothesis — we *think* `**/svc/rl/accounts/**/dashboard/module/list` returns the recon-bar JSON; the capture confirms it.

## Realistic floor after all stages

| Today | Stage A2 | Stage B | Stage B+C | Floor |
|---|---|---|---|---|
| ~10-23s/snapshot | -0 to -0.3s | -2 to -6s | -3 to -5s more | ~3-12s |
| ~22-50s/redeem | -10s on failure paths | n/a (redeem is form-based, not XHR-scrape) | -3 to -5s if rewards endpoint identified | ~12-35s |

Beyond Stage C, server-side latency dominates. Nothing in this doc proposes touching anti-bot countermeasures; the speedups come entirely from "stop waiting for things we don't need."
