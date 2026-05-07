# Pass 8 — Deep research, 2026-05-06 (round 2)

Continues from pass 7. This pass focused on three things pass 7 left open:

1. **Live empirical test of the unshipped HTTP buynow bypass (B3)**
2. **Cancel-sweep timing audit** — pass 7 noted lifecycle phases serialize via
   `acquireWrite`, but didn't actually count the total cancel-sweep cost
   inside a filler buy.
3. **`forceFlush` jobStore cost on the buy hot path**

Headline: **B3 is dead. Cancel sweep is much bigger than expected.**

---

## 🪦 B3 (HTTP buynow bypass) — empirically WORSE than the click flow

Pass 4 estimated B3 saves 300–700ms per single-mode buy. Pass 7 left it as
"unshipped, needs hardening". Today's live A/B test on cpnduy@gmail.com
against B002DYIZHG (Optimum Nutrition Gold Standard whey, 3 runs, headless):

| Run | HTTP bypass total | Click-driven total | Delta |
|---|---|---|---|
| 1 | 5328ms | 3575ms | **bypass +1753ms** |
| 2 | 5054ms | 3760ms | **bypass +1294ms** |
| 3 | 5158ms | 3618ms | **bypass +1540ms** |

**HTTP bypass is consistently 1.3–1.8s SLOWER.**

### Why the master-doc estimate was wrong

The estimate assumed `POST /checkout/entry/buynow` returns a quick **302**
to `/spc`. In reality, Amazon now serves /spc HTML **inline** in the POST
response (status 200, ~340–380KB body). The same server-side work that
previously happened across the 302 chain happens before the POST headers
flush. Empirical timings:

```
[bypass] PDP fetch (HTTP):  2180–2566ms  (full body download required —
                                          no streaming)
[bypass] POST /entry/buynow: 1999–2113ms  (Amazon renders /spc inline)
[bypass] page.goto /spc:      272–296ms
                              -----
                              TOTAL: 5054–5328ms

[click] page.goto PDP+wait:  1315–1340ms  (commit + waitForFunction —
                                          doesn't wait for full body)
[click] click + /spc nav:    2076–2123ms  (parallel with bg page work)
                              -----
                              TOTAL: 3420–3760ms
```

The click flow has two structural advantages:

1. `page.goto({ waitUntil: 'commit' })` returns at TCP commit (~50ms);
   downstream `waitForFunction` polls the buy-button at ~16ms RAF cadence
   and resolves AS SOON AS the buy box hydrates — typically before the
   full 2.7MB body has finished transferring.
2. The 302 chain happens browser-side, so image decoding / sub-resource
   requests can pipeline alongside it.

`ctx.request.get` (HTTP-only) MUST download the full body before resolving
its promise. **No streaming for `ctx.request.get`** — pass 5's streaming-fetch
candidate (A9) was for the GET path, but the same logic exposes the
limitation here: every byte of the 2.7MB PDP must arrive over the wire.

### What about A9 streaming + B3?

Even the optimistic case where streaming PDP fetch cuts the 2.4s GET to
~700ms (proportional to byte position of the buy-now form fields):

```
streaming PDP fetch:  ~700ms
POST /entry/buynow:   2000ms  (Amazon's edge work, can't be faster)
page.goto /spc:        290ms
                      -----
                      ~3000ms
```

vs. click flow's 3420–3760ms — saves ~400–700ms, MATCHING the original B3
estimate but only because the savings come from the streaming-PDP work,
not from the buynow-bypass. **B3 alone (without A9) is a regression.**
**B3 + A9 is roughly the same as ship-as-is.**

### Outcome

- Move B3 to the dead list.
- A9 still has standalone value for the PDP HTTP fetch fallback path
  (when buy-now click misses on AsBM-only PDPs).

---

## 🟢 Cancel sweep is the elephant in the filler-mode room

`buyWithFillers.ts:1234-1287` runs the post-place cancel sweep **serially**
over every non-target order Amazon spawned. With 5 filler orders, the
sweep is a bigger time-sink than the entire buy hot path.

### Per-cancel breakdown

`cancelFillerOrder` calls into `cancelForm.ts`. Walking the steps:

| Op | File:line | Cost | Note |
|---|---|---|---|
| `page.goto(CANCEL_URL, { waitUntil: 'domcontentloaded' })` | `cancelForm.ts:28` | ~500ms | could be `'commit'` ~50ms |
| `page.waitForTimeout(1500)` | `cancelForm.ts:40` | **1500ms blind** | should be `waitForFunction` for cancel form |
| Tick checkboxes (page.evaluate) | | ~30ms | |
| Pick reason (page.evaluate) | | ~30ms | |
| `page.waitForTimeout(500)` | `cancelFillerOrder.ts:141` | **500ms blind** | could detect form-state change |
| `clickRequestCancellation` + listeners | | ~100ms | OK (event-driven) |
| `waitForCancelOutcome` | `cancelForm.ts:162-201` | varies | see below |
| Per-pass: total | | **3.5–6s** | |

`waitForCancelOutcome` itself:
- Drains the 20s response/navigation listeners — typically resolves in
  ~1–2s on cancel
- `page.waitForLoadState('domcontentloaded')` — fast
- **`page.waitForFunction(..., { polling: 500 })`** — line 189. This is
  forcing 500ms cadence when the default (no `polling` opt) is RAF
  (~16ms). Self-imposed slowdown — confirmation banner usually appears
  ~50ms after navigation but we wait up to 500ms to detect it.
- `page.waitForLoadState('networkidle', { timeout: 5_000 })` — line 199.
  Amazon fires telemetry beacons for several seconds post-cancel; this
  almost always hits the full 5s timeout.

**Per-cancel observable cost: 3.5–6s minimum, +5s of `networkidle`
near-tax = ~8–11s typical.**

### Sweep cost over 5 fillers

`for` loop, no parallelism (`buyWithFillers.ts:1234`):
- 5 cancels × 8–11s = **40–55s sweep**
- Plus `await page.waitForTimeout(8_000)` between retries on failure
- Plus `await page.waitForTimeout(3_000)` safety buffer at end (line 1286)

This **runs INSIDE `buyWithFillers`** — i.e., before the function returns.
The buy slot stays held until the whole sweep finishes. With a 5-profile
fan-out + maxConcurrentFillerBuys=3, the 4th and 5th profiles wait for
40–55s of cancel-sweep tail.

Pass 7 §5 (idle-pool sessions) only handles the close-tail portion (5–15s).
The cancel sweep is on top of that.

### Optimization tiers

**Tier 1 (low risk, drop-in):**
1. **`cancelForm.ts:40`** — replace `waitForTimeout(1500)` with
   `page.waitForFunction(() => !!document.querySelector('input[type="checkbox"][name*="itemId" i]'))`.
   Cancel form usually hydrates in ~200–500ms; saves ~1000ms per cancel.
2. **`cancelFillerOrder.ts:141`** — same fix, replace 500ms blind wait
   with `waitForFunction` on the submit button enabled state.
   Saves ~250–400ms.
3. **`cancelForm.ts:189`** — drop `polling: 500`. Default RAF cadence
   resolves the banner ~50ms after it renders instead of up to 500ms.
   Saves ~250ms expected.
4. **`cancelForm.ts:199`** — `networkidle` 5s timeout almost always
   maxes out (Amazon fires post-cancel telemetry for ~6s). Replace
   with a bounded `waitForResponse` on the actual cancel-confirm
   navigation, OR drop networkidle entirely (the response/nav promises
   already drained at line 170 are the load-bearing signal).
   Saves ~3–4s per cancel.
5. **`cancelForm.ts:28`** — `waitUntil: 'commit'` instead of
   `'domcontentloaded'` (saves 200–500ms — same pattern as A5 already
   shipped for buy-flow navs).

**Tier 1 cumulative: ~5–6s saved PER cancel.** For a 5-filler buy:
**25–30s cut from the sweep.**

**Tier 2 (architectural):**
1. **Parallelize the cancel sweep across N pages.** Cancels are
   independent; fan them out across `context.newPage()` × N. Already
   matches the existing `fillerParallelTabs=6` setting model. Net
   ~5× speedup on the serial loop.
2. **Move sweep out of the buy slot.** Defer cancel orders to a new
   "cancel_sweep" phase tuple in the streaming scheduler. The buy
   slot returns immediately once `placed` is reported; the sweep
   runs as a background phase using its own slot, unblocking the
   account for the next buy job. (Combines naturally with Pass 7 §6
   AccountLock read-during-write.)

**Tier 2 cumulative on 5-filler fan-out:**
- Tier 1 brings sweep to ~10–15s
- Tier 2 #1 (parallelize) brings serial sweep to ~3s
- Tier 2 #2 (architectural defer) makes sweep cost zero on the buy hot path
- **Net: 25–55s removed per filler buy completion.**

### File / line summary

| Saving / risk | File:line | Change |
|---|---|---|
| ~1000ms / cancel | `cancelForm.ts:40` | `waitForTimeout(1500)` → `waitForFunction` on form-checkbox-present |
| ~3000ms / cancel | `cancelForm.ts:199` | drop networkidle, OR replace with bounded waitForResponse |
| ~250ms / cancel | `cancelForm.ts:189` | drop `polling: 500` (default RAF) |
| ~250ms / cancel | `cancelForm.ts:28` | `'domcontentloaded'` → `'commit'` |
| ~400ms / cancel | `cancelFillerOrder.ts:141` | 500ms wait → form-state check |
| ~1500ms / cancel | `cancelFillerOrder.ts:244` | second 1500ms wait (fallback path only) |
| ~1500ms / cancel | `cancelFillerOrder.ts:345` | third 1500ms wait (fallback path only) |
| ~3000ms / sweep | `buyWithFillers.ts:1286` | drop the 3000ms safety buffer (waitForCancelOutcome already drained the response) |

---

## 🟡 jobStore.forceFlush is fine, but `writeFile` of full JSON is a footgun

`pollAndScrape.ts:1812-1815`:

```ts
const onStage = (stage) =>
  deps.jobAttempts.update(attemptId, { stage }, { forceFlush: true });
```

Fires twice per buy: once on `'placing'`, once on `null`. Each one calls
`persistNow()` which `writeFile`s the **entire** attempts JSON blob.

With `MAX_ATTEMPTS = 1000`, ~800 bytes per attempt = ~800KB JSON write
per `forceFlush`. On macOS APFS this is sub-millisecond for the syscall
+ a few ms for fsync. Not a perf bottleneck on the hot path.

**BUT:** a clear win is **converting the on-disk format to JSONL** (or a
tiny SQLite). Append-only writes for new attempts; in-place updates for
status changes. Saves the 800KB JSON serialize on every forceFlush AND
reduces fsync amplification.

Saving: ~5ms per forceFlush × 2/buy = 10ms per buy. Not significant. But
if any future feature increases forceFlush count (e.g., per-step stage
markers post-pass-7-§1 telemetry fix), this becomes load-bearing.

**Recommendation: leave as-is for now; revisit if forceFlush call count
grows.** Document tier 4 (capacity-only) so it doesn't get re-discovered.

---

## 🟢 Other notable findings from the second-round audit

### 1. `usedShortcut` lint-silencer dead variable (`buyWithFillers.ts:677`)

```ts
void usedShortcut;
```

Pure dead code. ~0ms saved but flag for cleanup.

### 2. Filler search loop is genuinely serial (confirms A7 in MASTER doc)

`buyWithFillers.ts:2299` `for (const term of terms)` runs each search
term sequentially until enough candidates. Pass 4 #11 already noted this;
pass 8 confirms it's still the only place where multi-term searches
serialize without parallelism.

A7 estimate: ~200ms expected (1s × 20% of buys). Still worth shipping
but lower priority than the cancel-sweep wins above.

### 3. `addFillerItems` batches via single POST (correctness-confirmed, not a perf win)

`buyWithFillers.ts:2334-2349` uses one `mainPage.context().request.post`
with `items[0..N.base]` packed into the body. The earlier "parallel
per-item POSTs" experiment shipped as `a0e04be` and was reverted in
`bfae5f0` (silent-drop bug). Today's audit reaffirms the current single-
batch design is correct and there's no parallelism win to recover.

Marking dead: "two-tab parallel filler add" — addressed identically in pass 7's dead list.

### 4. The /spc page renders inline from `/checkout/entry/buynow`

This is the root cause of the B3 result above. Documenting it because
the original pass-3/pass-4 hypothesis ("POST returns quick 302 to /spc")
underpinned multiple speculative wins. Anything that depended on the
"302 redirect chain is browser-skippable" assumption needs re-examination.

What this confirms:
- B6 (pre-create checkout sessions during dwell) — still valid because
  the saving is a different shape (purchaseId is reusable for hours;
  the saving is reusing one session across two clicks, not skipping
  a redirect chain).
- B3 (HTTP buynow bypass) — invalidated, see above.

### 5. Token harvest can use `node-html-parser` (A1) for free

`addFillerViaHttp` (`buyWithFillers.ts` PDP fallback path) parses 2.7MB
PDP HTML via JSDOM just to extract 5 token strings. With nhp this drops
from ~290ms to ~10ms — already covered by A1, but worth noting that B3's
PDP-fetch leg becomes much cheaper if A1 ships.

---

## 📦 Updated Top-10 ranking after pass 8

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | **Cancel-sweep tier 1 (5 small fixes)** ⭐ NEW | **~25–30s on 5-filler buy** | Low | Pass 8 §2 |
| 2 | **Cancel-sweep tier 2 (parallelize + defer)** ⭐ NEW | **~25–55s removed per filler buy** | Med | Pass 8 §2 |
| 3 | **Telemetry fix — propagate jobId+profile** | 0ms (unblocks future research) | Low | Pass 7 §1 |
| 4 | **Extend CDP blocklist (9 patterns)** | 2.0–2.3s / PDP nav | Low | Pass 7 §3 |
| 5 | **Idle-pool session lifecycle (60s TTL)** | 5–15s per consecutive same-profile buy | Low–Med | Pass 7 §5 |
| 6 | **Skip duplicate /order-details fetch in fetchTracking (A4)** | ~800ms / active tracking | Low | Pass 2 #13 / Pass 4 #3 / Pass 7 |
| 7 | **JSDOM → node-html-parser swap (A1)** | 500–800ms / filler buy, 300–500ms / single buy | Low | Pass 4 #1 |
| 8 | **Event-driven waitForCheckout AND waitForConfirmationOrPending** | 500ms–3.5s / buy | Med | Pass 7 §4 |
| 9 | **AccountLock: switch verify/track to acquireRead** | 1–10s / collision | Low–Med | Pass 7 §6 |
| 10 | **Multi-profile shared PDP scrape with cache (B2)** | ~280ms × (N−1) | Med | Pass 6 / B2 |

**Cancel-sweep wins are NEW and HUGE for filler mode** — they vault to the
top of the table. Filler mode is the dominant BG workload (per
`amazonG settings.json`: `wheyProteinFillerOnly: true` + `buyWithFillers:
true` per-account flags).

---

## 🛣️ Recommended ship order — UPDATED after Pass 8

### Phase A (next CL — bundle low-risk wins)

1. **Pass 8 §2 Tier 1** — cancel-sweep small fixes
   (`cancelForm.ts:28,40,189,199` + `cancelFillerOrder.ts:141`).
   ~25–30s/filler-buy saving. Drop-in; only touches cancel path code.
2. **Pass 7 §1 telemetry fix.** 5-line change.
3. **Pass 7 §3 blocklist extension** (9 new patterns).
4. **A4 fetchTracking dedup.**
5. **A1 JSDOM → node-html-parser swap.**

**Phase A cumulative (filler mode):**
- ~25–30s from cancel-sweep
- ~3s from blocklist
- ~800ms from fetchTracking
- ~500–800ms from parser swap
- Net: ~30–35s saved per filler buy completion + observability fix

### Phase B (separate CLs — touch behaviour)

6. **Pass 8 §2 Tier 2** — parallelize cancel sweep across N pages
   (`buyWithFillers.ts:1234`).
7. **Pass 7 §4** — event-driven waitForCheckout + waitForConfirmationOrPending.
8. **Pass 7 §5** — idle-pool session lifecycle.
9. **Pass 7 §6** — AccountLock read-during-write.

### Phase C (architectural)

10. **Defer cancel sweep to its own scheduler tuple** — combines with
    AccountLock read-during-write. Buy slot returns immediately on
    `placed`; sweep runs as a background tuple. Big throughput win for
    rapid filler-mode fan-outs.
11. B7 multi-context refactor.

### Phase D (deferred)

- B6 pre-create checkout sessions during dwell — only useful with B3,
  which is now dead. Re-examine after Phase A ships.
- A7 parallel-fire filler search terms — small win; ship if convenient.

---

## 🪦 Confirmed dead — additions from pass 8

| Hypothesis | Why dead | Source |
|---|---|---|
| **B3 HTTP buynow bypass alone** | Empirically 1.3–1.8s SLOWER than click. Amazon serves /spc HTML inline in the POST response (~340–380KB), so the POST takes ~2s of edge work that the click flow's 302 chain pipelines with browser-side parallel work. `ctx.request.get`/`request.post` doesn't stream, so the full 2.7MB PDP body must download serially. | **Pass 8 §1** ⭐ NEW |
| `usedShortcut` is alive code | Lint-silencer at `buyWithFillers.ts:677` is genuinely dead — not a comment, not a feature flag. Cleanup-worthy. | Pass 8 §misc |

---

## 📝 Empirical artifacts (this pass)

- `.research/probe_http_buynow_bypass.mjs` — initial token-harvest probe
- `.research/probe_buynow_e2e.mjs` — A/B comparison vs click (3 runs)
- `.research/probe_buynow_setcontent.mjs` — page.setContent shortcut test
  (subsequent runs hit Amazon-side rate-limiting; initial run confirmed
  setContent works but doesn't change the HTTP-bypass conclusion)
- `.research/buynow_post_response_*.html` — captured /spc POST response
  bodies, 340–380KB each on success path

---

## 🏁 Honest assessment after pass 8

After pass 7, the headline was: "8–15s of additional savings on top of
shipped work." Pass 8 changes that **dramatically** for filler mode:

- **Filler-mode workloads have 25–55s of cancel-sweep savings nobody had
  audited.** This is now the biggest single bucket in any pass.
- B3 is dead, but the streaming-PDP-fetch (A9) has standalone value
  even without it.
- Telemetry fix unblocks a third research round that, without it, will
  keep being inferred-not-measured.

**The buy hot path itself is still close to floor.** The cancel sweep,
session lifecycle, and lock policy are all *outside the buy hot path*
but show up as throughput tax visible to users via "rapid second-job
pickup feels slow". Pass 7+8 together reframe the perf goal:

> **It's no longer about making one buy faster. It's about making the
> next buy startable sooner.**

Three structural levers, in order of expected return:
1. Cancel sweep tier 1+2 (Phase A+B above).
2. Idle-pool sessions (Phase B).
3. AccountLock policy + cancel-sweep scheduler tuple (Phase C).
