# Pass 18 — Deep research, 2026-05-06 (round 12) — CHECKOUT PAGE FOLLOW-UP

User-prompted continuation of pass 17's checkout focus. Pass 17 found
~1.0-1.3s of /spc-side savings via parser-inlining. Pass 18 audits the
remaining /spc surfaces:

1. `syncCheckedAttribute` duplication + `scrollTargetIntoView` redundancy
2. Pre-place stability check
3. /spc-side resource blocking opportunities

Headline: **2 minor wins** (~150-300ms total) and a confirmation that
/spc resource blocking is already near-optimal.

---

## 🟡 `scrollTargetIntoView` runs 3× per filler buy — redundantly

`buyWithFillers.ts` has 3 callers of `scrollTargetIntoView(page, targetAsin, …)`:

| File:line | Caller | Timeout |
|---|---|---|
| `:1569` | `readTargetQuantity` | 2_000ms |
| `:1694` | `verifyTargetCashback` | 5_000ms |
| `:1803` | `verifyTargetLineItemPrice` | 5_000ms |

Each call:
- One CDP call: `page.locator(…).first().scrollIntoViewIfNeeded(…)`
- Browser-side scroll (instant if already in view)

Cost per call: ~30-100ms. Once the target row is scrolled into view (call
#1), call #2 and #3 are no-ops on the browser side — but each still pays
the CDP round-trip.

### Recommended fix

Do scroll ONCE at /spc landing, before any of the 3 reads. Each
read just runs its `page.evaluate` directly without a redundant
`scrollIntoViewIfNeeded`.

Refactor target: pull `scrollTargetIntoView` up into the buy flow's
"after /spc lands" prologue, after `pickBestCashbackDelivery`.

**Saving:** 2 redundant scrolls × ~50ms = ~100ms per filler buy.

**Risk:** Low. Browser-side scroll is idempotent; the question is
just where to place the call.

**File:** `buyWithFillers.ts:1569,1694,1803`.

---

## 🟡 Pre-place stability `waitFor({ state: 'visible' })` is redundant

`buyNow.ts:418-420`:

```ts
await placeLocator
  .waitFor({ state: 'visible', timeout: 1_000 })
  .catch(() => undefined);
step('step.buy.place.settle', { mode: 'visible_wait', cap: 1_000 });
```

Then immediately:

```ts
await placeLocator.click({ timeout: 10_000 });
```

**Playwright's `click()` does the same actionability check internally**:
visible, enabled, stable, not animated. The explicit `waitFor({ state:
'visible' })` is redundant — `click()` would wait the same duration.

The only thing the explicit wait adds is the `step('step.buy.place.settle')`
log line for telemetry. If we keep the log, drop the wait.

**Saving:** ~50-100ms typical case (when button is already visible
when `findPlaceOrderLocator` returns it). When the button is still
hydrating, both paths wait the same duration anyway — no regression.

**Risk:** Low. Pure consolidation onto Playwright's built-in
actionability.

**File:line:** `buyNow.ts:418-420`.

---

## 🟢 /spc-side resource blocking is already near-optimal

Audited `.research/spc-network-checkout.txt` (saved network trace from
the /spc page). Unique URL hosts hit:

| Host / path | Blocked? | Notes |
|---|---|---|
| `fls-na.amazon.com/1/batch/...` | ✓ (host blocked) | Telemetry beacons |
| `m.media-amazon.com/images/.css` | ✓ (.css passes; .css is the file ext + AUIClients query) | Stylesheet — needed |
| `m.media-amazon.com/images/.js` | ✓ (passes — AUI bundle JS, needed) | Cannot block — checkout JS |
| `www.amazon.com/checkout/entry/cart` | ✓ (the /spc nav itself) | Initial nav — needed |
| `www.amazon.com/cross_border_interstitial_sp/render` | **✓ already blocked** | `driver.ts:185` |
| `www.amazon.com/location_selector/recommended_access_point` | **proposed in pass 7 §3** (still pending ship) | Locker recommendation |

The /spc page is **well-optimized for blocking**. The remaining
unblockable items are the page itself + AUI client JS + telemetry
beacons (already blocked).

**No new /spc-specific block candidates found.**

The pass 7 §3 blocklist extension (9 patterns) already includes
`location_selector/*` and `cart/add-to-cart/patc-config*` — both are
the /spc-fired XHRs visible in the trace. Shipping pass 7 §3 covers
this surface fully.

---

## 📦 Updated MASTER ranking after pass 18

Pass 18's findings are small (~150-200ms total). They bundle into the
Phase A.1 hygiene CL alongside pass 12's smaller candidates.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1-7 | (unchanged from pass 17) | | | |
| 7 | Inline /spc parsers into `page.evaluate` | ~1.0-1.3s/buy | Low | Pass 17 |
| ... | (rest unchanged) | | | |

New entries (Phase A.1 hygiene):

- **Move `scrollTargetIntoView` to one upfront call** (Pass 18 §1) —
  ~100ms saved per filler buy
- **Drop pre-place `waitFor({ state: 'visible' })`** (Pass 18 §2) —
  ~50-100ms saved per buy

These two are 1-line and 3-line changes respectively. Bundle into
Phase A.1.

---

## 🛣️ Recommended ship order — UPDATED after Pass 18

### Phase A (next CL — bundle)

(Unchanged from pass 17)

### Phase A.1 — AmazonG follow-up hygiene

8. loadSettings/loadProfiles mtime cache
9. Lazy pickIdsToEvict
10. Parallelize setMaxQuantity + detectBuyPath
11. listAmazonAccounts 60s cache
12. toggleBGNameAndRetry event-driven waits
13. selectAllowedAddressRadio 500ms blind → waitForFunction
14. debug-screenshots auto-prune
15. Drop polling: 1000 in fetchOrderIdsForAsins
16. **`scrollTargetIntoView` → one upfront call** ⭐ NEW
17. **Drop pre-place `waitFor({ state: 'visible' })`** ⭐ NEW

---

## 🏁 Honest assessment after pass 18

Twelve passes in. Pass 18 yielded two small finds — ~100-200ms total
per buy. **Diminishing returns are clear** when continuing the same
focused area.

Pass 17's headline finding (~1.0-1.3s on /spc reads) used most of the
"checkout-page" optimization budget. Pass 18 cleaned up the remaining
small surfaces.

### What's left if continuing on /spc

The major checkout surfaces are now exhaustively audited:
- ✓ Place Order POST timing (pass 9)
- ✓ Pending-order interstitial (pass 9)
- ✓ Chewbacca interstitial waitForCheckout polling (pass 7 §4 W rewrite)
- ✓ /spc parser inlining (pass 17)
- ✓ /spc resource blocking (pass 7 §3 + pass 18)
- ✓ Pre-place stability + scroll redundancy (pass 18)
- ✓ BG name toggle (pass 13 §2)
- ✓ Address picker (pass 13 §3)

The remaining /spc surface is the **state machine itself** — pass 7 §4's
W rewrite already covers it. Once W ships, that's the floor for /spc
work.

### Twelve-pass cumulative for /spc-specific work

| Source | Saving | Notes |
|---|---|---|
| Pass 7 §4 (W rewrite) | 0.5-3.5s/buy | Event-driven detection |
| Pass 13 §1 (doomed-cashback short-circuit) | 80-160s/failure | Failure-path |
| Pass 13 §2 (toggleBGNameAndRetry) | ~700-900ms/toggle | Failure-path |
| Pass 13 §3 (selectAllowedAddressRadio) | ~350ms/picker | Address path |
| Pass 17 (/spc parser inlining) | **~1.0-1.3s/buy** | Hot path ⭐ |
| Pass 18 §1 (scroll redundancy) | ~100ms/filler buy | Filler-only |
| Pass 18 §2 (pre-place waitFor) | ~50-100ms/buy | Hot path |

**Total /spc-specific savings: ~1.5-2s per typical buy** + much more on
failure paths.

**The user's "checkout page" focus has produced the largest concentrated
chunk of per-buy savings in the research arc.**

---

## What to do next

The /spc surface is exhausted. Continued research could:

1. **Audit the `eligibleshipoption` XHR response in detail** — does Amazon
   ship a JSON we could parse instead of re-rendering DOM? Already covered
   in pass 6 dead list.
2. **Audit the post-Place-Order `/cpe/executions` redirect chain** —
   pass 5 measured 142-byte body but the redirect chain is multi-step.
   Each hop has its own latency.
3. **Audit Amazon's checkout JS for hidden APIs** — pass 1-6 dead list.
4. **Build an end-to-end timing benchmark** — instrument production with
   Pass 7 §1 telemetry, capture real /spc → place → thank-you timing
   for a single profile, then compare to the proposed fixes.

Option 4 is the highest-leverage next move — once pass 7 §1 telemetry
is in production, every subsequent research pass has empirical data
instead of inferred timings.

If continuing without shipping: I'd suggest a tightly-scoped next pass on
**the /cpe/executions redirect chain** since pass 9 left that as the
"unfinished" empirical data point. Runs as a focused live probe with the
production-equivalent pending-click loop.
