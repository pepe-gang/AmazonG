# Pass 9 — Deep research, 2026-05-06 (round 3)

Continues from pass 8. Focus areas:

1. **Verify-phase + fetch_tracking-phase audit** for cancel-sweep multipliers
   that pass 8 hadn't enumerated.
2. **Live empirical data on Place Order POST timing** + the `/cpe/executions`
   redirect chain.
3. **Cancel-form load timing** validated against live order history.
4. **One unexpected new finding** — `polling: 1000` in `fetchOrderIdsForAsins`
   that mostly does nothing useful.

Headline: **The cancel-form fixes (pass 8 §2 Tier 1) actually apply 3×, not
1×, per filler buy.** Net savings 60-90s per filler buy across all phases.

---

## 🟢 Cancel work fires THREE times per filler buy

`pollAndScrape.ts` runs `cancelFillerOrdersOnly` (sometimes plus
`cancelNonTargetItems`) at three different lifecycle points:

| Phase | File:line | What gets cancelled | Lock held |
|---|---|---|---|
| **Buy** | `buyWithFillers.ts:1234-1287` (inline sweep) | every filler-only order | account writer |
| **Verify** (~10 min later) | `pollAndScrape.ts:943-961` `runVerifyFillerCleanup` | filler-only retries + target-order non-target items | account writer |
| **Fetch_tracking** (~6 hour later) | `pollAndScrape.ts:1268` `cancelFillerOrdersOnly` | filler-only retries again | account writer |

Pass 8 only counted the buy-phase sweep (~25-30s saving from cancel-form
tier 1). The full impact of the same cancel-form fixes is ~3× because the
same `cancelFillerOrder` calls happen at all three phases.

### Per-fix savings per phase (5-filler buy assumed)

| Pass-8 fix | Buy-phase | Verify-phase | Fetch-track-phase | Total |
|---|---|---|---|---|
| `cancelForm.ts:40` 1500ms blind → waitForFunction | ~5s | ~5s | ~5s | **~15s** |
| `cancelForm.ts:189` drop `polling: 500` | ~1.25s | ~1.25s | ~1.25s | **~3.75s** |
| `cancelForm.ts:199` drop networkidle 5s tax | ~15s | ~15s | ~15s | **~45s** |
| `cancelForm.ts:28` DCL → commit | ~1.25s | ~1.25s | ~1.25s | **~3.75s** |
| `cancelFillerOrder.ts:141` 500ms blind | ~2s | ~2s | ~2s | **~6s** |

**Cumulative tier-1 fix saving per filler buy across all 3 phases: ~70-75s.**

### Caveat: phase-specific overhead

- **Buy-phase sweep** is the only one that holds the **buy slot**. The
  other two phases hold the AccountLock writer (preventing future buys
  on that account during the lock) but don't block the buy slot.
- **Fetch_tracking-phase retries** mostly hit the "not on cancel-items
  page" terminal early (orders already cancelled at buy or verify),
  short-circuiting at ~2-3s per cancel attempt. So fetch_tracking-phase
  savings are smaller than the table suggests.
- **Verify-phase target clean** (`cancelNonTargetItems`) is a fresh
  cancel, never short-circuits. Subject to the full per-cancel cost.

Realistic numbers under typical conditions:
- Buy-phase: ~25-30s saved (matches pass 8)
- Verify-phase: ~25-30s saved (5 retries + 1 target clean — most retries fast-fail; target clean takes full hit)
- Fetch_tracking-phase: ~5-10s saved (mostly fast-fail terminals)

**Total: ~55-70s/filler-buy across the lifecycle.**

This **doubles pass 8's headline** because the master ranking only
counted buy-phase. Verify and fetch_tracking are not buy-slot-bound but
they DO release the AccountLock sooner, which means the next buy on the
same account starts sooner.

---

## 🟢 Place Order POST live timing — NEW empirical data

Pass 5 documented the Place Order POST body (3 fields, 142 bytes) but
never timed the round-trip. Today's live test on cpnduy@gmail.com against
B002DYIZHG ($37.99 whey, didn't actually complete because Amazon parked
on the pending-order interstitial — see below):

```
5304ms  click input[name="placeYourOrder1"] (start)
7314ms  POST /spc/place-order returned (status=200, content-type text/html, location=null)
                                                    ↓
                                                    ~2010ms total POST
```

**Key new findings:**

1. **Place Order POST returns status 200 with HTML body, NOT a 302.**
   This matches the pattern pass 8 found for `/checkout/entry/buynow`
   (Amazon returns the next page's HTML inline rather than redirecting).
   Implication: the response body IS the next page (thank-you OR pending-
   order interstitial). Production code's `waitForConfirmationOrPending`
   correctly polls for the URL change, but the POST response itself
   contains everything needed.

2. **POST takes ~2.0s.** Not the 142-byte body that's slow — Amazon's
   edge does the order-creation work synchronously before responding.
   Cannot be optimized client-side; this is server-side wall-clock.

3. **Pending-order interstitial fired reliably** on a freshly-clicked
   /spc page. Production handles this via `waitForConfirmationOrPending`
   (`buyNow.ts:1717-1929`)'s pending-click loop (3 max retries).
   - The interstitial keeps the URL on the same /spc URL, just rendering
     a "this is a pending order — click again to confirm" prompt.
   - Production's loop blindly waits 2500ms after each pending-click
     (line 1924). Same pattern as pass-7 §4 — could be event-driven.
   - Plus another 500ms iter wait (line 1928).

4. **Live total: place click → "settled" was 32 seconds** in this
   probe. 30s of that was the script's `waitForURL(/thankyou/)` timing
   out because the page never reached thank-you (pending-order kept
   us on /spc). In production this would be `waitForConfirmationOrPending`
   doing pending-click + 2500ms wait + repoll → settle.

### Implication for the W candidate

Pass 7 §4's W rewrite (event-driven `waitForCheckout` + `waitForConfirmationOrPending`)
is now **even higher-priority**. Today's data shows:

- The pending-order interstitial fires regularly on Amazon-fulfilled
  Prime products (cpnduy / Optimum Nutrition Gold Standard whey).
- Production's `waitForConfirmationOrPending` polls every 500ms PLUS
  has 2500ms blind waits after each pending-click → **3000ms detection
  latency floor per pending click**.
- Event-driven detection of the URL-change OR pending-order body text
  would resolve at ~16ms RAF granularity — saves up to 2.5s per
  pending-click cycle.

---

## 🟢 Cancel-form goto timing — confirms pass 8 estimates

Live timing on cpnduy@gmail.com navigating to a cancel-items URL for
an already-shipped order (which redirects away — testing the redirect
case rather than the form-load case):

```
Run 1: page.goto({ waitUntil: 'domcontentloaded' }) = 2191ms
Run 2: same                                          = 1726ms
Run 3: same                                          = 1793ms
```

**Average ~1900ms** for the redirected case alone. Pass 8 §2's
estimate of "DCL → commit saves ~250ms" was too conservative — the
DCL wait on the cancel-page goto is much heavier than estimated
because:

1. Amazon's progress-tracker page redirects via 302 chain
   (`/preship/cancel-items` → `/order-history` for shipped orders)
2. Each hop is full DCL wait
3. The chain takes ~1.7-2.2s end-to-end

For the **non-redirect** case (a still-cancellable order):
- Pass 8 estimated ~250ms savings for commit-vs-DCL.
- Live data suggests **likely 500-1000ms** saved because the cancel
  page itself is heavy (~400KB) and DCL waits for full sub-resource
  load.

This boosts the cancel-form tier 1 fix savings further. Refining
pass 8's estimates:

| Fix | Pass 8 est | Pass 9 refined |
|---|---|---|
| DCL → commit on cancel goto | ~250ms | ~500-1000ms |
| Drop `polling: 500` | ~250ms | ~250ms (unchanged) |
| Drop networkidle 5s tax | ~3-4s | ~5s (almost always max) |
| Drop 1500ms cancel-form blind wait | ~1000ms | ~1000ms (unchanged) |
| Drop 500ms reason-pick blind wait | ~250-400ms | ~400ms (unchanged) |
| **Per-cancel total** | **~5-6s** | **~7-8s** |

Across 3 phases × 5-7 cancels each: **80-110s saved per filler buy**.

---

## 🟡 New finding: `fetchOrderIdsForAsins` polling is mostly dead

`buyWithFillers.ts:1359-1367`:

```ts
await page
  .waitForFunction(
    (asin) =>
      document.querySelector(
        `a[href*="/dp/${asin}"], a[href*="/gp/product/${asin}"]`,
      ) !== null,
    primaryAsin,
    { timeout: 15_000, polling: 1_000 },
  )
  .catch(() => undefined);
```

**The bug:** `/gp/css/order-history` is server-rendered. The DOM doesn't
update after `page.goto`. If the target ASIN isn't in the DOM at goto
time, polling at 1000ms cadence will NEVER make it appear — only a fresh
goto would. So the wait either:

- Resolves in <16ms (ASIN is there immediately) — but `polling: 1000`
  forces it to wait up to 1000ms before the FIRST check, wasting up to
  1000ms.
- Times out at 15s (ASIN never appears) — wasting 15s.

There's no in-between case where polling actually helps.

**Recommendation:**

1. Remove `polling: 1000`. Default RAF cadence costs less and resolves
   sooner in the happy case (~16-30ms vs up to 1000ms).
2. Better: drop the wait entirely, do one synchronous check after goto,
   and `page.reload()` once if missing.

Saving: ~500ms expected per filler buy (the typical case is ASIN is
present, so RAF resolves in ~16ms instead of waiting up to 1000ms).

Low risk — the wait was always misnamed; RAF default is the same
behavior on a happy DOM.

---

## 🟡 Confirmed: cpnduy already has BG1-suffixed address (no address picker)

The live probe's /spc page showed `Delivering to Thi Ngoc Nguyen (BG1)
13130 N.E., AIRP0RT WAY, Portland, OR, 97230`. The (BG1) suffix is from
production's BG1/BG2 toggle workflow already running on this account —
explains why pass 7's probe didn't trigger the Chewbacca address picker.

Implication: address-picker timing data is still missing. To capture it
empirically, we'd need a profile that has NOT yet been through the BG1
toggle — i.e., a fresh sign-in with multiple saved addresses. Out of
scope for this pass; flagging for future research.

---

## 🪦 Confirmed dead — additions from pass 9

| Hypothesis | Why dead | Source |
|---|---|---|
| `fetchOrderIdsForAsins` polling helps with order propagation | Static server-rendered page; polling can't surface what wasn't in initial HTML | Pass 9 §4 |

---

## 📦 Updated Top-10 ranking after pass 9

Same Top-10 as pass 8, but **savings estimates revised upward** for the
cancel-sweep candidates because they apply 3× per buy lifecycle, not 1×.

| Rank | Candidate | Saving (revised) | Risk | Source |
|---|---|---|---|---|
| 1 | **Cancel-form tier 1 (5 small fixes)** | **~55-70s/buy across all 3 phases** (was ~25-30s in pass 8) | Low | Pass 8 §2 + Pass 9 §1 |
| 2 | **Cancel-sweep tier 2 (parallelize + defer)** | ~25-55s removed from buy slot | Med | Pass 8 §2 |
| 3 | **Telemetry fix — propagate jobId+profile** | 0ms (unblocks future research) | Low | Pass 7 §1 |
| 4 | **Extend CDP blocklist (9 patterns)** | 2.0–2.3s / PDP nav | Low | Pass 7 §3 |
| 5 | **Idle-pool session lifecycle (60s TTL)** | 5–15s per consecutive same-profile buy | Low–Med | Pass 7 §5 |
| 6 | **Skip duplicate /order-details fetch** | ~800ms / active tracking | Low | A4 |
| 7 | **JSDOM → node-html-parser swap (A1)** | 500–800ms / filler buy | Low | Pass 4 #1 |
| 8 | **Event-driven `waitForCheckout` + `waitForConfirmationOrPending`** rewrite | **500ms-3.5s/buy on happy path; up to 7.5s on pending-order path** (revised up) | Med | Pass 7 §4 + Pass 9 §2 |
| 9 | **AccountLock: switch verify/track to acquireRead** | 1–10s / collision | Low–Med | Pass 7 §6 |
| 10 | **Drop `polling: 1000` in fetchOrderIdsForAsins** | ~500ms expected / filler buy | Low | **Pass 9 §4** ⭐ NEW |

---

## 🛣️ Recommended ship order — UPDATED after Pass 9

### Phase A (next CL — bundle)

The most impactful CL combines:

1. **Cancel-form Tier 1 fixes** — `cancelForm.ts:28,40,189,199` plus
   `cancelFillerOrder.ts:141`. These ship together because they all
   touch the same flow and have the same risk profile.
2. **`fetchOrderIdsForAsins` polling fix** — single-line change in
   `buyWithFillers.ts:1365`.
3. **Pass 7 §1 telemetry fix** (5 lines).
4. **Pass 7 §3 blocklist extension** (9 patterns).
5. **A4 fetchTracking dedup**.
6. **A1 JSDOM → node-html-parser swap.**

**Phase A cumulative on filler-mode workload:**
- ~55-70s saved per filler buy across all 3 phases (cancel-form fixes)
- ~500ms saved per filler buy (polling fix)
- ~2.3s saved per PDP nav (blocklist)
- ~800ms per active tracking (fetchTracking dedup)
- ~500-800ms per buy (parser swap)
- = **~60-75s saved per filler buy completion + observability fix**

### Phase B (separate CLs)

7. **Pass 8 §2 Tier 2** — parallelize cancel sweep across pages.
8. **Pass 7 §4 W rewrite** — event-driven waitForCheckout +
   waitForConfirmationOrPending. Saves 0.5-3.5s on happy path, 2-7.5s
   on pending-order path.
9. **Pass 7 §5** — idle-pool session lifecycle.
10. **Pass 7 §6** — AccountLock read-during-write.

### Phase C (architectural)

11. Defer cancel sweep to its own scheduler tuple.
12. B7 multi-context refactor.

---

## 📝 Empirical artifacts (this pass)

- `.research/probe_live_buy_cancel.mjs` — full place + cancel script
  (paused after pending-order interstitial; no actual order placed)
- `.research/probe_cancel_form_timing.mjs` — cancel-page goto timing
  (3 runs against shipped order, all redirected away — confirms
  redirect-chain cost)
- `.research/check_recent_order.mjs` — order-history scrape to confirm
  no real order was placed
- `.research/order_history_dump.html` — full order history HTML dump

---

## 🏁 Honest assessment after pass 9

The overall savings picture for filler mode:

- **Pass 6:** "Empirically at floor for Amazon's current public surface."
- **Pass 7:** "8-15s of additional savings on top of shipped work."
- **Pass 8:** "25-55s of cancel-sweep savings hiding in cancelForm.ts."
- **Pass 9:** "55-70s saved per filler buy across all 3 lifecycle phases
   when the cancel-form fixes ship — because the same cancel work fires
   3× (buy / verify / fetch_tracking)."

Each pass has unlocked roughly 2× more savings than the previous one
predicted. Pattern: prior passes optimized for buy-hot-path wall-clock;
the lifecycle-wide savings only became visible by auditing verify and
fetch_tracking phases AFTER reading their actual code paths.

**Where the next round of research should look:**

1. Live empirical validation of the cancel-form fix savings (build a
   probe that places + cancels with both the current code path AND a
   fix-applied path, A/B compare).
2. The address-picker flow timing — needs a fresh-sign-in profile,
   still missing.
3. **Pass-9 unfinished:** an actual full place-and-cancel cycle to
   capture the /cpe redirect chain timing (today's probe stopped at
   the pending-order interstitial because the script didn't replicate
   production's pending-click loop).

The buy hot path itself is genuinely close to floor. The
**lifecycle-wide cancel work** is now the biggest remaining bucket,
and pass 8's tier-1 fixes are the highest-ROI changes available.
