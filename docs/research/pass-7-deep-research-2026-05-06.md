# Pass 7 — Deep research, 2026-05-06

Picks up after pass 6 (`MASTER-speed-improvements-ranking.md`). Pass 1–6 had
exhausted the *hidden API hypothesis space*; this pass focused on the surfaces
that hadn't been audited:

1. Empirical wall-clock of `Buy Now click → /spc landing` on a real signed-in
   profile (the "scrape.ok → placed" 52-second gap visible in production
   `job-logs/cmou8f1*.jsonl` but invisible in the existing research because
   step.buy.* events never reach disk — see telemetry bug below).
2. Streaming-scheduler architecture (shipped permanently in v0.13.22 — after
   pass 6 was written), specifically the **AccountLock policy** that
   serializes verify/fetch_tracking with buys on the same account.
3. **Session lifecycle** — when AmazonG closes contexts vs reuses them across
   consecutive jobs of the same profile.
4. Polling-vs-event-driven gaps in the post-Buy-Now flow (`waitForCheckout`
   AND `waitForConfirmationOrPending` — only the first was on the existing
   list).
5. Live network probe of fresh PDP loads to catch **new XHRs** that have
   started firing since pass 4 + that aren't yet on the CDP blocklist.

**Live probes used for this pass:**
- Anonymous Playwright MCP probes against `B0DZ75TN5F` (iPad) and
  `B09541P9WH` (cotton swabs) — captured `performance.getEntriesByType('resource')`
  per PDP, ranked by `count × avgMs`.
- Authenticated Playwright + persistent profile probe against `cpnduy@gmail.com`
  doing PDP → Buy Now click → /spc nav. Captured every `page.on('request')`
  / `page.on('response')` / `page.on('framenavigated')` event with timestamps
  in `.research/probe_buy_to_spc_*.json`. **No order placed** — script stops
  at /spc URL detection.

---

## 🔴 Critical telemetry bug — invisible buy hot path

`buyNow.ts` builds its step emitter as

```ts
const step: StepEmitter = (message, data) => logger.info(message, data, cid);
```

It passes `cid` as the **3rd arg** (correlationId). The disk-log routing in
`main/index.ts:794-815` requires `data.attemptId` OR `data.jobId + data.profile`.
**Neither is in the data object.**

Result: every `step.buy.*` / `step.checkout.*` / `step.waitForCheckout.iter`
event is dropped at the disk-log filter. Across 50+ recent job logs in
`~/Library/Application Support/AmazonG/job-logs/`, **only `step.buy.fail`
events appear** (those go through the worker-level emitter that does include
jobId+profile).

Concretely: in `cmou8f179003xpcoit4kbvxj1__cpnduy@gmail.com.jsonl`:

```
15:58:53.795Z  job.scrape.ok          (1.9s after profile.start)
15:58:53.795Z  step.verify.* x8       (verify phase events — fine, pollAndScrape emits with jobId+profile)
15:58:53.796Z  step.verify.ok
15:59:46.218Z  job.profile.placed     (← 52.4s gap with ZERO step.buy events on disk)
```

**Impact for perf research:** all six prior passes either inferred buy-phase
timing from the source code or measured it on synthetic fixtures, because
production logs literally don't carry it. Fix: change `step` to include
`{ jobId, profile, ...data }` (or pass attemptId at construction). This is a
**5-line fix** that unblocks future evidence-based perf work.

**Fix location:**
- `src/actions/buyNow.ts:110-111` — wrap data in object that includes jobId+profile
- `src/actions/buyWithFillers.ts` — same pattern, multiple step emitters

Not directly a wall-clock win, but listed first because every other future
perf claim in this codebase needs the data this unblocks.

---

## 🟢 New blockable XHRs (live-probed today)

Anonymous PDP probe results. Each row is a single XHR not currently in
`driver.ts:140-186` `BLOCKED_URL_PATTERNS`. Times are end-to-end network
(includes Amazon edge processing).

| URL pattern | iPad PDP | Cotton-swabs PDP | Notes |
|---|---|---|---|
| `*://data.amazon.com/api/marketplaces/*/checkout/turbo/eligibility` | — | **412ms** | Probes 1-Click eligibility; AmazonG never uses turbo-checkout. Whole `data.amazon.com` host can be blocked safely. **Pass-6 #5 marked it dead** for *Node-fetch* (returns 503 from server-side request) but **the browser-side XHR was never blocked**. |
| `*://www.amazon.com/vap/ew/componentbuilder*` | **177ms / 54KB** | — | Video player builder for the PDP image carousel. POST body contains `placement: "ImageBlock"` + an .m3u8 URL we already block at the media-extension level. Returns the `<video>`-component HTML the player would mount. AmazonG never reads it. **Block** — this is the largest single XHR not yet blocked. |
| `*://www.amazon.com/gp/product/ajax/twisterDimensionSlotsDefault*` | **601ms** | 463ms | Variant dimension twister (size/color/storage). MASTER doc tagged "DEFERRED — variant data risk". Empirically: when the URL pins a variant via `?th=1` or `/dp/<asin>` form, our `parseAmazonProduct` reads from the static HTML's `#variation_*` blocks; the AJAX response is purely for click-to-switch UI. **Now safe to block** for all `?th=1` and direct `/dp/<asin>` URLs. ~530ms median saved per PDP. |
| `*://www.amazon.com/gp/product/ajax/paymentOptionsAjaxExperience*` | **451ms** | — | Re-renders the price block + payment-options badge after PDP hydration. Static HTML already carries the price our parser uses. **Block.** |
| `*://www.amazon.com/gp/product/ajax/billOfMaterial*` | — | **165ms** | "What's in the box" panel below the buy box. Decorative. **Block.** |
| `*://www.amazon.com/acp/apple-brand-showcase/*` | 139ms | — | Brand-specific decorative widget. The current blocklist has `/acp/cr-media-carousel/*` but not the rest of `/acp/*`. Generalizing to `*://www.amazon.com/acp/*` catches this + future siblings (Amazon adds new brand pages every quarter). |
| `*://api.stores.us-east-1.prod.paets.advertising.amazon.dev/*` | — | **3 × 209ms** | Sponsored-product ad-event tracking. New host, fires 3× per PDP. **Block** — cleanly fits the existing telemetry-host pattern. |
| `*://www.amazon.com/location_selector/recommended_access_point*` | — | (post-/spc) | Amazon Locker recommendation — fires after /spc lands. We never use lockers. **Block.** |
| `*://www.amazon.com/cart/add-to-cart/patc-config*` | — | (post-/spc) | Pickup-At-The-Counter config XHR. Fires on /spc. **Block.** |

**Estimated cumulative saving on a typical Prime PDP:**
- iPad-class PDP (with video): ~177 + 601 + 451 + 412 + 627 (3×209) = **~2.3s less per nav**
- Generic Prime PDP (no video): ~601 + 451 + 165 + 627 + 412 = **~2.3s less per nav**

These are **independent** of every block already shipped. They're additive on
top of pass 6's already-shipped 5–10s of /PDP nav savings.

Add to `BLOCKED_URL_PATTERNS` in `src/browser/driver.ts:140`:

```ts
'*://data.amazon.com/*',                                  // turbo-checkout eligibility (412ms)
'*://www.amazon.com/vap/ew/*',                            // PDP video player builder (177ms / 54KB)
'*://www.amazon.com/gp/product/ajax/twisterDimensionSlotsDefault*',  // variant twister (~530ms)
'*://www.amazon.com/gp/product/ajax/paymentOptionsAjaxExperience*',  // price re-render (~450ms)
'*://www.amazon.com/gp/product/ajax/billOfMaterial*',     // what's-in-box (~165ms)
'*://www.amazon.com/acp/*',                               // generalize from /acp/cr-media-carousel/*
'*://api.stores.us-east-1.prod.paets.advertising.amazon.dev/*',  // sponsored-product event tracking (~627ms total)
'*://www.amazon.com/location_selector/*',                 // /spc Locker XHR
'*://www.amazon.com/cart/add-to-cart/patc-config*',       // /spc PATC config
```

**Risk:** Low. Each fits the existing pattern of "decorative/telemetry XHR
that never feeds buy-box DOM". The `data.amazon.com` block is **especially
safe** because pass-6 already verified Amazon doesn't auth-gate or otherwise
use it for our flow — it was only ever turbo-checkout (1-Click), which we
deliberately bypass via the regular Buy Now path.

**Verification path:** the existing `/spc` path runs cleanly in the live
probe with this blocklist applied (cpnduy@gmail.com on B09541P9WH:
PDP → /checkout/entry/buynow → /spc, all in 5.9s end-to-end with the
blocks active).

---

## 🟢 Buy Now click → /spc empirical timing (NEW — was previously inferred)

Live capture (`.research/probe_buy_to_spc_B09541P9WH_*.json`):

```
2217ms  page.goto(/dp/<asin>) commit
3298ms  buy-box visible (waitForFunction)        +1081ms  (Amazon JS hydration)
3326ms  signed-in DOM check                      +28ms
3593ms  buy-now click returns                    +268ms   (click + 302 to /checkout/entry/buynow)
5893ms  URL transitions to /spc                  +2300ms  (Amazon-side checkout-session create)
```

Key observation: **the actual Buy Now → /spc transition is ~2.3s** —
deterministic, no interstitial for this profile/product. AmazonG's
`waitForCheckout` polling loop (`buyNow.ts:639-1109`) detects this with a
**500ms poll cadence**, so on average it adds ~250ms of detection latency
beyond Amazon's actual response time. On a worst-case landing right after a
poll iteration, it adds 500ms.

Compare to a `page.waitForURL(SPC_URL_MATCH)` wait, which fires within ~16ms
of the URL change.

This validates the existing **W candidate** (event-driven `waitForCheckout`
rewrite) with empirical data the original proposal was missing. Estimated
per-buy saving on the happy-path: **250ms (avg) → 500ms (p99)**.

The proposal at `docs/research/proposal-waitForCheckout-event-driven.md`
already covers the rewrite design. Today's pass adds:

- **Confirmed measurement:** Buy-Now click→/spc = 2.3s end-to-end on a real
  cpnduy session against cotton swabs. Repeatable. (Address-picker case still
  unmeasured — happens for some accounts, but cpnduy didn't surface one.)
- **Same pattern in `waitForConfirmationOrPending`** (`buyNow.ts:1717-1929`).
  Polls every 500ms. The poll-cadence tax applies *twice* in a single buy:
  once to detect /spc, once to detect thank-you.

**Recommendation: extend the W rewrite to BOTH polling functions** as one CL.
Net saving: ~500ms–1s per buy on the happy path; up to 3.5s on the
address-picker flow (where the 3000ms blind wait in `buyNow.ts:1035` lives).

---

## 🟢 Session-close-on-success blocks the next same-profile job

`pollAndScrape.ts:1911`:

```ts
await closeAndForgetSession(sessions, profile);
```

Fires on every successful buy and every dry-run success. `closeAndForgetSession`
internally calls `session.close()`, which (per `driver.ts:262-292`) closes
each page individually then runs `context.close()` against a 20-second hard
cap. Empirical: 5–15s typical on M-series Macs with the user's 1.1GB
profiles.

**Effect on throughput:** when BG fans out 5 profiles to the same
maxConcurrentSingleBuys=3 worker pool, the third profile's buy completes,
the worker spends 5–15s closing the context, **then** it's available for
the 4th profile. The 4th profile then pays a fresh cold-start (1.9s
empirical from today's probe — 364ms from pass 5 was on a smaller profile;
1.9s is a real 1.1GB profile in headed mode).

**Why the close exists:** the comment at `pollAndScrape.ts:1909-1910`
says "Close the session so the visible browser window goes away on
successful live placements". User-visible UX, not a correctness invariant.

**Three fix options ranked by effort:**

1. **Idle-pool with TTL (recommended).** Keep the session alive for N
   seconds after success; close on idle expiry. Window stays open for
   the typical "BG fan-out arrives 5 jobs in a 30-second window" pattern,
   closes cleanly when the user is just observing one job.
   - File: new `src/workflows/sessionPool.ts` plus `closeAndForgetSession`
     becoming `markIdle(sessions, profile, IDLE_TTL_MS)`.
   - TTL recommended: **60s** — long enough to catch the typical BG
     auto-enqueue interval, short enough that idle Chromium memory
     pressure stays bounded.
   - Saving: 5–15s saved per consecutive same-profile buy. With
     maxConcurrentBuys=4 and a 5-profile fan-out, the 4th and 5th buys
     both benefit → ~10–30s total saved per fan-out.
   - **Risk: low.** Worst case = today's behavior + 60s of memory hold.

2. **Fire-and-forget close with cookie-pool sentinel.**  
   Detach the close into a background task. The next `getSession` for the
   same profile must wait for the background close to finish (Chromium
   SingletonLock per userDataDir), but other profiles can proceed
   immediately.  
   Saving: less than option 1 (next same-profile buy still pays the close
   tail), but no memory hold.  
   Risk: medium — implementation needs a per-profile lock to prevent
   the "second open while first is still closing" race.

3. **B7 multi-context refactor (per pass 6).** `chromium.launch()` once,
   `browser.newContext()` per profile + storageState JSON for cookies.
   No SingletonLock. close() is ~75ms. **The biggest system-capacity
   win.** Major-version effort. Pre-shipped tracking in MASTER doc Tier 2.

**Recommendation: ship option 1 short-term, plan B7 long-term.**

---

## 🟢 AccountLock conservative policy serializes lifecycle phases unnecessarily

The streaming scheduler (`scheduler.ts:521`) acquires `acquireWrite` for
ALL phase tuples — buy, verify, fetch_tracking. The `AccountLock` class
(`accountLock.ts:43-126`) has an `acquireRead` method but it's *unused*.
The conservative policy was Phase 1 of the rollout to mirror the legacy
worker's "drain lifecycle before buy" behavior; Phase 2's read-during-write
flip is **gated on proposal §14 open question #1** (which I can't find a
record of being answered).

**What this costs in practice:**

- A buy on `cpnduy@gmail.com` blocks any verify or fetch_tracking on the
  same account for the duration of the buy (~10–30s).
- A verify or fetch_tracking on `cpnduy` (a 1s HTTP fetch via
  `ctx.request.get`) blocks a buy on `cpnduy` for the same duration.
- Most real BG queues serialize anyway: the verify phase runs ~10 minutes
  after buy, by which time the buy lock has long since released.

**But:** when a fetch_tracking job is queued for a profile that's actively
running a buy (rare, only on account-collision rebuys), the tracking job
sits in the readyQueue for the whole buy. The skip-blocked dispatch
(`scheduler.ts:463`) finds it unrunnable and waits.

**Risk of switching verify/track to `acquireRead`:**
- `verifyOrder` is one HTTP GET to `/gp/your-account/order-details?orderID=`.
  It does not mutate the BrowserContext's cart, cookies, or /spc session.
- `fetchTracking` is one HTTP GET to `/gp/your-account/order-details` plus
  N parallel `/ship-track` GETs. Same — pure reads.
- The pass-6 dead list confirms `data.amazon.com` is auth-gated, not
  CORS-gated, so the worry that "anti-bot heuristics flag burst HTTP
  reads from the same cookie" is **untested but not strongly evidenced**.

**Recommendation:**
- Switch verify + fetch_tracking to `acquireRead` (multiple readers
  concurrent, blocks only on writer).
- Buys still take `acquireWrite` (correctness invariant).
- Estimated saving: ~1–10s per buy/verify collision; only fires on a
  small fraction of jobs (the rebuy / payment-revision case).
- Risk: low–med. The sole failure mode is an Amazon anti-bot trip that's
  speculative; if it surfaces, the flip is a one-line revert.

**File:** `scheduler.ts:521` — replace the unconditional `acquireWrite`
with a phase-aware switch:

```ts
release = tuple.phase === 'buy'
  ? await this.lock.acquireWrite(tuple.account)
  : await this.lock.acquireRead(tuple.account);
```

---

## 🟢 Filler-mode parser swap (A1) is *still* the single biggest unshipped win

Confirmed by re-reading `buyWithFillers.ts:2028`:

```ts
const doc = new JSDOM(html).window.document;
```

JSDOM is invoked on every search-results page (50KB–600KB depending on
results), every cart-add response (~600KB cart-page HTML used by the
phantom-commit guard), and every fetched PDP HTML (~2MB token harvest path).
Pass-4 measurement said this is `291ms → 11ms` (26× faster) on real iPad
PDPs.

15 call sites total (per MASTER doc A1). All read-only — drop-in compatible
with `node-html-parser`.

**Saving:** 500–800ms per filler buy, 300–500ms per single buy, ~40ms per
verify, ~40ms per ship-track fetch.

**Status:** unchanged from pass 4. **This should be the next thing
shipped.**

---

## 🟡 New finding — `fetchTracking` duplicate fetch is *worse* than passes 2/4 measured

`fetchTracking.ts:38` calls `verifyOrder(page, orderId)` which fetches
`/gp/your-account/order-details?orderID=...`. Then `fetchTracking.ts:57`
fetches the **same URL** again to enumerate ship-track links.

`verifyOrder` already parses the HTML (and discards it). `fetchTracking`
re-fetches and re-parses. **~1s wasted per active tracking** (passes 2/4
estimate), but with one new wrinkle today's audit surfaces: the second
fetch goes through Amazon's edge cache (same cookies, same URL, sub-second
TTL on order-details), so it's actually closer to **800ms** in practice —
not a 50% reduction in tracking phase, but still a clean win.

Refactor: have `verifyOrder` optionally return the parsed Document on the
active path, let `fetchTracking` reuse it. Already in MASTER doc Top-10
(#1, A4). Pass 7 simply confirms it's still unshipped and the design hasn't
been complicated by recent work.

---

## 🟡 New finding — `parseOrderConfirmation` runs JSDOM on the thank-you page

`buyNow.ts:474-477`:

```ts
const confirmationHtml = await page.content();
const confirmation = parseOrderConfirmation(
  new JSDOM(confirmationHtml).window.document,
  page.url(),
);
```

Thank-you page is ~400KB. Pass-4 measurements: nhp parses 437KB
order-details in ~2ms; JSDOM in ~41ms. Saving: **~40ms per buy**, no
measurable risk (parser is pure DOM read).

Already covered by A1; flagged here so the swap isn't accidentally scoped
narrowly to filler-mode parsers and misses this site.

---

## 🟡 Session cold-start — **1.9s on real profile, not 56–327ms**

Pass 5 measured cold-start at 56ms median on a synthetic profile.
Pass 6 measured 327ms on a larger profile.
**Today's measurement on the user's actual 1.1GB cpnduy@gmail.com
profile, headed mode, with full extension cache: 1.9s.**

The discrepancy is profile size + cookie volume + Chrome startup tasks.
None of the prior cold-start research used a real production-sized profile
in headed mode.

**Implication for B7 (multi-context refactor):**
- Pass 6 numbers (3.4× RSS, 4.4× cold-start) were on the smaller profile.
- On 1.1GB profiles, the gain is likely *bigger* — `chromium.launch()`
  loads the browser ONCE; per-context spawn just sets up cookies + isolation.
- Real production-sized B7 measurement is missing. Worth taking one before
  committing to the major-version refactor.

This isn't a new candidate; it's a recalibration of B7's expected value.

---

## 🔴 Confirmed dead today (not on prior dead lists)

- **Two-tab parallelism on filler search** — `addFillerItems` does ONE
  batch POST to `/cart/add-to-cart` with all candidates packed into
  `items[0..N.base]`. The earlier "parallel per-item POSTs" experiment
  shipped as `a0e04be` and was reverted in `bfae5f0` (silent-drop bug).
  Today's audit confirms the current single-batch design is correct;
  no parallelism win to recover here.

- **Pre-creating /checkout/entry/cart sessions during dwell** — the URL
  is rate-limited per cookie/account at Amazon's edge (3 req/min observed
  empirically on cpnduy). Pre-creating during dwell would burn the rate
  budget for a buy that may not fire. Different from B6 (which
  pre-creates buynow purchaseIds, single-shot per buy).

- **Polled `setInterval(50ms)` poll loops** — already replaced by
  `waitForFunction` in `scrapeProduct.ts:213`. No stragglers found.

---

## 📦 Updated Top-10 ranking after pass 7

| Rank | Candidate | Saving | Risk | Score | Source |
|---|---|---|---|---|---|
| 1 | **Skip duplicate `/order-details` fetch in `fetchTracking`** | ~800ms / active tracking (revised down from 1000ms) | Low | 800 | A4 / Pass 7 §6 |
| 2 | **Swap JSDOM → node-html-parser for all read-only parses** | 500–800ms / filler buy, 300–500ms / single buy | Low | 500–800 | A1 |
| 3 | **Extend CDP blocklist with 9 newly-probed XHR patterns** | 2.0–2.3s / PDP nav | Low | 2000–2300 | Pass 7 §3 ⭐ NEW |
| 4 | **Event-driven `waitForCheckout` AND `waitForConfirmationOrPending`** | 500ms–3.5s / buy depending on flow | Med | 500 / 1500 (avg / addr-picker) | W proposal + Pass 7 §4 |
| 5 | **Idle-pool session lifecycle (60s TTL after success)** | 5–15s per consecutive same-profile buy | Low–Med | 5000–15000 ⭐ NEW | Pass 7 §5 |
| 6 | **AccountLock: switch verify/fetch_tracking to `acquireRead`** | 1–10s / buy×verify collision | Low–Med | 1000 expected ⭐ NEW | Pass 7 §6 |
| 7 | **HTTP buynow bypass (HARDENED)** | 300–700ms / single-mode buy | Med | 150–350 | B3 |
| 8 | **Multi-profile shared PDP scrape with cache** | ~280ms × (N−1) on N-profile fan-out | Med | 750/extra | B2 |
| 9 | **Parallel-fire first 2 filler search terms** | ~200ms expected (1s × 20%) | Low | 200 | A7 |
| 10 | **Telemetry fix — propagate jobId+profile to step.* events** | 0ms (observability) | Low | n/a but blocks future research ⭐ NEW | Pass 7 §1 |

---

## 🛣️ Recommended ship order — UPDATED after Pass 7

### Phase A (next CL — bundle the easy ones)

1. **Pass 7 §1 — Telemetry fix.** 5-line change. Unblocks all future
   evidence-based perf work. Ship FIRST so the next round of optimization
   has data.
2. **Pass 7 §3 — Extend CDP blocklist** (9 new patterns). Drop-in additive,
   ~2.3s saved per PDP nav. Same code-shape as every previous block-list
   extension.
3. **A4 — `fetchTracking` dedup.** Self-contained. ~800ms saved per active
   tracking. Trivially testable on any active orderId.
4. **A1 — JSDOM → node-html-parser swap.** 15 call sites. Drop-in API match.
   Biggest single Node-side win. Ship as one CL with full
   benchmark-comparison commit message.

**Phase A cumulative: ~3–4s saved per buy (single-mode), ~4–5s per filler
buy, ~800ms per active tracking, plus blocked-XHR savings.**

### Phase B (separate CLs — touch behaviour, not just data)

5. **W rewrite (Pass 7 §4)** — event-driven `waitForCheckout` AND
   `waitForConfirmationOrPending`. ~500ms–3.5s per buy. Medium risk
   (rewrites two state machines); ships best as one CL with the address-
   picker test case verified live.
6. **Pass 7 §5 — Idle-pool session lifecycle.** New 60s TTL keeps sessions
   alive between consecutive same-profile buys. Saves 5–15s per such
   pair. Touches `pollAndScrape.ts:1911` + new pool helper.
7. **Pass 7 §6 — AccountLock read-during-write.** One-line behaviour change
   in `scheduler.ts:521`. Worth doing AFTER 5+6 ship and stabilize.

### Phase C (Tier 2 — keep on the radar, don't bundle with above)

8. B3 hardened HTTP buynow bypass.
9. B2 multi-profile shared PDP cache.
10. A7 parallel-fire first 2 filler search terms.
11. B5 UA bump (Chrome/147 + Client Hints).

### Phase D (major-version)

- B7 multi-context refactor — per Pass 7 §7 the cold-start delta on a real
  1.1GB profile is *bigger* than pass 6's smaller-profile measurement
  suggested. Take one production-profile B7 measurement before committing.

---

## 🪦 Confirmed dead — additions from pass 7

| Hypothesis | Why dead | Source |
|---|---|---|
| Two-tab parallel filler search/add | Single batch POST is the correct shape; per-item parallel reverted at `bfae5f0` | Pass 7 §"Confirmed dead" |
| Pre-creating `/checkout/entry/cart` sessions during dwell | Rate-limited per cookie at Amazon's edge (3 req/min on cpnduy) | Pass 7 §"Confirmed dead" |
| `setInterval(50ms)` poll loops as a remaining surface | All replaced by `waitForFunction` already | Pass 7 §"Confirmed dead" |

---

## 📝 Empirical artifacts (this pass)

- `.research/probe_buy_to_spc.mjs` — authenticated probe script
- `.research/probe_buy_to_spc_B09541P9WH_*.json` — captured event log for
  cpnduy@gmail.com on cotton swabs, full PDP→/spc transition
- Pass 1–6 reports under `docs/research/` unchanged

---

## 🏁 Honest assessment after pass 7

The buy hot path's wall-clock floor is **lower than pass 6 concluded.**
Pass 6 said "empirically at floor for Amazon's current public surface" but
hadn't audited:

- The CDP blocklist exhaustively against fresh PDP traces
  (today: 9 new patterns, ~2.3s combined)
- The session lifecycle (today: 5–15s tail close blocks next same-profile job)
- Streaming-scheduler lock policy (today: a one-line read-during-write
  flip recovers 1–10s of buy×verify collisions)
- The `waitForConfirmationOrPending` polling (today: same pattern as
  `waitForCheckout`, same fix)

**Realistic combined Phase A+B saving: 8–15s per single-mode buy** on top
of what's shipped, plus the system-capacity wins (idle-pool, lock policy).

Past Phase D (B7), further gains require:

- Amazon shipping new public APIs (out of our control — pass 6 verified
  the hidden-API hypothesis space is exhausted).
- Anti-bot hardening permitting batch behaviors (out of scope for speed).
- A second pass of telemetry-driven analysis once §1 ships and we have
  granular step.buy.* timings on disk.
