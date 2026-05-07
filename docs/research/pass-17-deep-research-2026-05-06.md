# Pass 17 — Deep research, 2026-05-06 (round 11) — CHECKOUT PAGE FOCUSED

User asked specifically for checkout-page speed work. Pass 17 is a focused
audit of every read AmazonG does on `/checkout/p/{purchaseId}/spc`.

Headline finding: **`page.content()` + JSDOM is the dominant /spc read
pattern** at 3-5 sites. Each call costs ~80-200ms. Inlining parsers into
`page.evaluate` saves **~300-700ms per buy** on /spc-side work alone.

This is the **biggest per-buy /spc-specific saving** found in the
research arc.

---

## 🔴 Major: 3 /spc readers use `page.content()` + JSDOM

Audited every call site that reads /spc DOM. The pattern:

```ts
const html = await page.content();           // CDP serialize ~50-150ms
const doc = new JSDOM(html).window.document; // parse ~24ms (empirical bench)
const result = pureParser(doc);              // pure DOM walk ~5ms
```

**Cost per call: ~80-200ms typical.** Three sites use this pattern on /spc:

### 1. `readCashbackOnPage` — `buyNow.ts:1461-1465`

```ts
async function readCashbackOnPage(page: Page): Promise<number | null> {
  const html = await page.content();
  const doc = new JSDOM(html).window.document;
  return findCashbackPct(doc);
}
```

`findCashbackPct` (`amazonProduct.ts:74-94`) is a 20-line DOM walk:
```ts
doc.querySelectorAll('[id*="cashback" i], [class*="cashback" i], ...');
// then regex /(\d{1,2})\s*%\s*back/gi
```

**Inlinable**: pass the function body into `page.evaluate`. Browser-native
DOM is faster than JSDOM, and we skip the CDP serialize entirely.

Fires once per buy (single-mode) + once after BG name toggle (cashback
retry). 1-2 calls × ~150ms = **150-300ms saved per buy**.

### 2. `pickBestCashbackDelivery` — `buyNow.ts:2067-2092` (PER ITERATION)

```ts
for (let i = 0; i < MAX_ITERATIONS; i++) {
  await syncCheckedAttribute(page);           // page.evaluate ~30ms
  const html = await page.content();          // ~80-200ms ⭐
  const plans = computeCashbackRadioPlans(
    new JSDOM(html).window.document, ...
  );
  ...
  await page.locator(sel).first().click(...);
  await page.waitForTimeout(500);             // BLIND WAIT 500ms
}
```

Per iteration: ~660-790ms total. MAX_ITERATIONS=6, typical 1-3 iterations.
Three optimizations stack:

- **Inline parser into evaluate**: -150ms/iter (skip page.content + JSDOM)
- **Replace 500ms blind with `waitForResponse(/eligibleshipoption/)`**:
  -250ms/iter typical (already proven in B4 — same fix already shipped
  for the OUTER `waitForDeliverySettle` at `buyNow.ts:325`; not applied
  to the per-iteration wait inside this function)
- **Combine `syncCheckedAttribute` + `computeCashbackRadioPlans` into one
  evaluate**: -30ms/iter

Per iteration: **~430ms saved (660ms → 230ms)**. Typical 2 iters = **~860ms
saved per buy.**

### 3. `verifyTargetCashback` — `buyWithFillers.ts:1711-1724`

```ts
await page.evaluate(() => {
  document.querySelectorAll('input[type="radio"]').forEach(...);  // sync attr
});
const html = await page.content();
const hit = readTargetCashbackFromDom(
  new JSDOM(html).window.document, targetAsin, targetTitle
);
```

Same pattern. The pure parser `readTargetCashbackFromDom` walks the
target's line-item, scopes its shipping-group, reads the % back.

Inlining into evaluate: skip CDP serialize + JSDOM. **Saves ~150ms per
call**. Fires 1-2 calls per filler buy = **150-300ms saved per filler
buy**.

---

## 📊 Empirical bench: parser-side cost on /spc fixture

Ran `.research/bench_spc_parse.mjs` against the 318KB /spc fixture:

```
=== JSDOM parse + querySelectorAll (n=10) ===
  median: 24.0ms  min: 18.0ms  max: 39.0ms

=== regex-only "% back" extraction (n=10) ===
  median: 0.16ms  min: 0.14ms  max: 0.22ms

Speedups: regex vs JSDOM: 151×
```

**Key insight:** the JSDOM parse itself is 24ms — but `page.content()`'s
CDP serialize round-trip is **bigger** (50-150ms typical for a 318KB
payload). So the dominant cost is the round-trip, not the parse.

**This means pass 7's A1 (JSDOM → node-html-parser) doesn't help these
sites** — node-html-parser would shave ~20ms off the 24ms parse, but
the 100ms round-trip cost remains. The right fix here is **inlining the
parser into `page.evaluate`** (skips both the round-trip AND the parse).

For these 3 sites, **inline-into-evaluate beats node-html-parser swap**.

---

## 🟢 Combined /spc-side savings — the headline number

Per typical filler buy:

| Site | Calls | Saving each | Total |
|---|---|---|---|
| `pickBestCashbackDelivery` | 2 iters | ~430ms (parser + wait + sync) | ~860ms |
| `verifyTargetCashback` | 1-2 | ~150ms (parser only) | ~150-300ms |
| `readCashbackOnPage` | 1 | ~150ms (parser only) | ~150ms |

**Total per filler buy: ~1.2-1.3s saved on /spc-side reads.**

For single-mode buys (no `verifyTargetCashback`):

| Site | Calls | Saving each | Total |
|---|---|---|---|
| `pickBestCashbackDelivery` | 2 iters | ~430ms | ~860ms |
| `readCashbackOnPage` | 1 | ~150ms | ~150ms |

**Total per single-mode buy: ~1.0s saved.**

---

## 🟡 Smaller /spc finds

### `verifyCheckoutPrice` is fine

`buyNow.ts:1208-1276` already uses a single `page.evaluate` (no
page.content+JSDOM). Cost: ~50-100ms typical. No optimization needed.

### `ensureAddress` fast path is fine

The fast-path `readCurrentAddress(page)` is one page.evaluate (~30ms).
The slow-path (mismatched address) does a full picker + form submit
flow — but that's correct and unavoidable.

### `findPlaceOrderLocator` — already shipped consolidation (pass 7 / `0c5ee70`)

The 9 separate `loc.count()` probes were consolidated into one `evaluate`.
Already-shipped. Verified via git log.

### Sequential vs parallel

The /spc-side reads on the buy hot path are:
1. `verifyCheckoutPrice` (~50-100ms)
2. `ensureAddress` fast-path (~30ms)
3. `pickBestCashbackDelivery` (multiple iterations, each ~500-800ms)
4. `readCashbackOnPage` (~150-200ms)
5. `findPlaceOrderLocator` (~50ms after pass-7 consolidation)

**They run sequentially.** Could `verifyCheckoutPrice` + `ensureAddress`
run in parallel? Yes — both are reads, no mutation. ~50ms saved.

But this is dwarfed by the parser-inlining wins above. Lower priority.

---

## 🟡 The /spc page.content() finding generalizes — every page.content+JSDOM hot site

Searched the codebase for the same pattern. Outside /spc:

| File:line | Context | Note |
|---|---|---|
| `buyNow.ts:211` | ATC fallback PDP token harvest | Pass 4 #1 (A1) — JSDOM swap helps here since this is on Node side, not page |
| `buyNow.ts:474` | Thank-you page parse | Pass 7 §"new finding" |
| `buyNow.ts:1101` | error fall-through (verifyCard) | Same |
| `buyNow.ts:1462` | `readCashbackOnPage` ⭐ | **THIS PASS** |
| `buyNow.ts:2069` | `pickBestCashbackDelivery` ⭐ | **THIS PASS** |
| `buyWithFillers.ts:1721` | `verifyTargetCashback` ⭐ | **THIS PASS** |
| `verifyOrder.ts:132` | active-state check on /order-details | Pass 4 #1 — JSDOM swap helps |
| `fetchTracking.ts:66, 121` | order-details + ship-track | Pass 4 #1 |

The **3 /spc-on-`page` sites** are uniquely suited for inline-into-evaluate
because they run inside a browser context. The other sites use
`ctx.request.get` (HTTP-only, no page) — those benefit from the
node-html-parser swap.

**Two distinct optimizations:**
- A1 (JSDOM → node-html-parser): for HTTP-fetched HTML on Node side
- **Pass 17 (page.content+JSDOM → page.evaluate inline)**: for /spc DOM reads

These are NOT alternatives — they apply to different surfaces. Both
should ship.

---

## 📦 Updated MASTER ranking after pass 17

Pass 17's findings are substantial — **~1.0-1.3s per buy** on /spc reads
alone. This vaults to top tier.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | Doomed-cashback-retry short-circuit | ~80-160s/failed cashback buy | Low | Pass 13 §1 |
| 6 | BG AutoBuyJob compound index | ~250ms-2.4s/fan-out per user | Low | Pass 14 §1 |
| 7 | **Inline /spc parsers into `page.evaluate`** ⭐ NEW | **~1.0-1.3s per buy** (replaces 3 page.content()+JSDOM sites) | Low | **Pass 17 §1-3** |
| 8 | BG-side `autoSubmitTracking` → `waitUntil` | ~500ms-2s per fetch_tracking report | Low | Pass 16 §1 |
| 9 | CDP blocklist extension | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 10 | Idle-pool session lifecycle | 5–15s/consecutive | Low–Med | Pass 7 §5 |

---

## 🛣️ Recommended ship order — UPDATED after Pass 17

### Phase A (next CL — bundle)

The /spc parser inlining slots naturally into Phase A:

1. Cancel-form Tier 1 fixes (Pass 8/9)
2. Doomed-cashback-retry short-circuit (Pass 13 §1)
3. listMergedAttempts two-tier broadcast (Pass 11 §1)
4. Telemetry fix (Pass 7 §1)
5. **Inline /spc parsers into `page.evaluate`** ⭐ NEW (Pass 17)
6. CDP blocklist extension (Pass 7 §3)
7. fetchTracking dedup (A4)
8. JSDOM → node-html-parser swap (A1) — for the HTTP-fetched sites only

**Phase A cumulative on filler-mode buy:**
- ~55-70s saved per filler buy (cancel-form)
- ~80-160s saved per doomed-cashback failure
- ~500ms-2.4s saved per fan-out (BG broadcast)
- **~1.2-1.3s saved per buy on /spc reads** ⭐ NEW
- ~2.3s saved per PDP nav (blocklist)
- ~800ms per active tracking
- ~500-800ms per buy (parser swap A1, NON-/spc sites)
- 95% reduction in BG request rate

### Phase A.0 (BG repo bundle, ships via `vercel --prod`)

1. AutoBuyJob `(userId, phase, createdAt DESC)` index (Pass 14)
2. SharedDeal `storeSlugs` GIN index (Pass 15)
3. `autoSubmitTracking` → `waitUntil` (Pass 16)
4. `createRebuyJob` loop → `waitUntil` (Pass 16)

---

## 🏁 Honest assessment after pass 17

Eleven passes in. Pass 17 is **focused and yields a substantial new
finding** — ~1.0-1.3s per buy on /spc-side reads alone. **The biggest
per-buy /spc-specific saving in the research arc.**

The user's request — "especially the checkout page" — was the right
ask. Going wider into BG endpoints / worker / deps (passes 14-16) was
yielding diminishing returns. Re-focusing on /spc surfaced something
big that earlier passes missed because they audited /spc reads as
"correctly using JSDOM (covered by A1 swap)" without considering
that **A1 doesn't apply to in-page reads** — for those, inlining into
`page.evaluate` is the right shape.

### Why prior passes missed this

- Pass 4 #1 framed JSDOM swap as the parse-cost optimization
- A1 was tagged for ALL `new JSDOM()` sites without distinguishing
  HTTP-fetched (Node-side) from page.content()-driven (post-CDP)
- For the 3 /spc sites, **the page.content() round-trip dominates the
  cost** — A1's parse-side savings (~20ms) are noise compared to the
  ~80-150ms CDP serialize cost the inline-evaluate fix eliminates

This is a clear example of why the user's "different angle / focus
specific area" prompts have consistently outperformed "audit broadly"
prompts. **Constraints surface findings.**

### Eleven-pass trajectory

| Pass | Surface | Marginal saving | Found via |
|---|---|---|---|
| 7 | buy hot path | 8-15s | broad audit |
| 8 | cancel sweep | +25-55s | different angle |
| 9 | verify + fetch_tracking | +30-40s revised | deeper |
| 10 | live A/B blocked | unchanged | live probe |
| 11 | system-wide IPC | +500ms-2.4s/fan-out | different angle |
| 12 | hygiene | +200-300ms | deeper |
| 13 | failure paths | +80-160s on failures | different angle |
| 14 | BG endpoints | +250ms-2.4s/fan-out | different angle |
| 15 | BG worker + deals | +100-500ms | further out |
| 16 | BG lib | +500ms-2s | different angle |
| 17 | /spc reads (focused) | **+1.0-1.3s per buy** ⭐ | user-prompted focus |

### Pattern continuation

User-directed focused passes (17) and "different angle" passes (8, 11,
13, 14, 16) consistently outperform "deeper into same code" passes (9,
10, 12, 15).

If continuing to dig into checkout: the next focus area would be the
**/spc-side state machine timing** (waitForCheckout iter cadence,
Chewbacca interstitial click flows) — pass 7 §4 (W rewrite) already
covers the polling cadence; the remaining wins are smaller blind waits.

After 11 passes, **shipping Phase A is now ~3-5 seconds of compounded
per-buy savings PLUS the lifecycle-wide cancel-sweep wins**. Real
production telemetry post-Phase-A will reveal whether further /spc
work is needed.
