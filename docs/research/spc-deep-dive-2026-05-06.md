# /spc deep-dive — 2026-05-06

**Branch:** `research/qty-limit-bypass` (spillover; can move to a new branch when shipping)
**Method:** live Playwright MCP session, Cuong @ Portland 97230, cart with 8 items, single-pass measurements (n=1 for lifecycle, n=3 for redirect-chain timing)

## Empirical baselines

### Initial /spc load (no AmazonG blocking active — naive Amazon)

| Metric                  | Value     | Note                                                           |
|-------------------------|-----------|----------------------------------------------------------------|
| TTFB (firstByte)        | 268 ms    | Amazon's edge response                                         |
| Full HTML download      | 2,902 ms  | 404 KB transfer, 404 KB decoded (gzipped wire = streamed body) |
| DOMContentLoaded        | 2,912 ms  | Fires immediately after responseEnd (no extra DOM work)        |
| loadEvent               | 2,922 ms  | Same — no async work delays load                               |
| Redirect time           | 0 ms      | `/checkout/entry/cart` → `/checkout/p/<id>/spc` is a single-nav 302; browser follows it as one request |

So **/spc is dominated by network — the response body itself takes 2.6s to stream** at this profile's edge POP. AmazonG's CDP image/font/media blocks save bandwidth on the *follow-up* sub-resources but don't shrink this primary response.

### Redirect-chain timing (n=3 per row)

| Path                                           | Mean ms | Note                                                                |
|------------------------------------------------|---------|---------------------------------------------------------------------|
| `GET /checkout/entry/cart?proceedToCheckout=1` | **3,012** | Backend allocates a new purchaseId + boots a fresh checkout session |
| `GET /checkout/p/<purchaseId>/spc?referrer=spc` (direct hit, same cart) | **1,210** | Reuses existing purchaseId — saves ~1.8s                           |

**1.8s saved per /spc re-entry** when the purchaseId is cached and the cart hasn't mutated.

### Delivery-pick → eligibleshipoption settle

A single radio click (one of 2 in the only delivery group on this cart) fired:

| XHR / event                                                   | Duration | Wire size |
|---------------------------------------------------------------|----------|-----------|
| `GET /checkout/p/<id>/eligibleshipoption?referrer=spc&...`    | **2,826 ms** | 18 KB compressed |
| `prime-presentation-metrics` follow-up beacon                 | 78 ms    | 0 KB      |

That's a single iteration. `pickBestCashbackDelivery` caps at 6 iterations; in the worst case ~17s of post-click settling. AmazonG already uses `page.waitForResponse(/eligibleshipoption/)` (B4 = `b4fc79e`) — but the *picker itself* uses a fixed `waitForTimeout(500)` between clicks (`buyNow.ts:2167`). On this profile the actual settle is **~5.6× longer than the picker's wait**, which means the next-iter `:checked` re-read happens against a half-settled DOM. (See `verifyTargetCashback` after the picker — that's where the real gate fires; the inner picker wait is generous-ish.)

### Place Order endpoint shape

```http
POST /checkout/p/<purchaseId>/spc/place-order?referrer=spc&ref_=chk_spc_chw_placeOrder

anti-csrftoken-a2z=<csrf>
placeYourOrder1=Place your order
hasWorkingJavascript=1
```

Three fields. **No line-item refs in the body.** The purchaseId in the URL is the entire cart-state pointer. Amazon's response shape (per pass-9 capture) is ~2010ms, returning the next-page HTML inline (sometimes 200, sometimes 302 to /cpe within the same session).

## What's already shipped (and good)

- **CDP `Network.setBlockedURLs`** — kills images / fonts / media / 13+ telemetry-and-widget host patterns. Empirically eliminates ~150–250 sub-resources per /spc load.
- **Inline /spc parsers** (`48d5ff1`) — `pickBestCashbackDelivery` / `verifyTargetCashback` / `readCashbackOnPage` now run inline `page.evaluate` instead of `page.content()`+JSDOM. ~1.0–1.3s saved per buy on the read side.
- **`waitForResponse(/eligibleshipoption/)`** post-pick — already wired in. Replaces an old fixed `waitForTimeout(1500)`.
- **`SPC_ENTRY_URL` shortcut** — already going straight through `/checkout/entry/cart?proceedToCheckout=1`. Skips the BYG interstitial.

## New unshipped findings → ranked

| # | Saving / buy | Risk | LOC | Where it lands                             | Description |
|---|--------------|------|-----|--------------------------------------------|-------------|
| 1 | **~1,800 ms** (re-entry case)        | Med  | ~30 | `amazonHttp.ts` + `buyWithFillers.ts` re-entry sites | **Cache `purchaseId` + use direct `/checkout/p/<id>/spc?referrer=spc` URL on subsequent /spc visits** within the same buy when cart hasn't mutated. Empirically `/checkout/p/<id>/spc` is 1.21s vs entry/cart's 3.01s.  Surgical-cashback recovery's Phase A removes items (mutates cart → invalidates purchaseId), so doesn't apply there — but other re-entry sites (re-read after toggle, recovery from delivery-options-changed) do. |
| 2 | ~175 ms     | Low  | 1   | `driver.ts:BLOCKED_URL_PATTERNS`            | **Add `*://www.amazon.com/cart/add-to-cart/patc-config*` to the CDP blocklist.** Currently only `patc-template` and `get-cart-items` are blocked; `patc-config` still fires on every /spc load. 175 ms / 6.5 KB. Pass-7 §3 flagged this; appears not to have shipped. |
| 3 | ~250–500 ms | Low–Med | ~80 | `buyNow.ts:waitForConfirmationOrPending` | **Event-driven `waitForConfirmationOrPending` rewrite.** Today the helper polls every 500 ms via `page.evaluate` (mean detection latency ≈ 250 ms; tail up to 500 ms). Replacing the URL match with `page.waitForURL(<conf-pattern>)` and the banner / body-text check with a MutationObserver eliminates the polling tax. The delivery-options-changed signal still needs DOM, so a hybrid `Promise.race` between `waitForURL` and the mutation-observer evaluate. Pass-7 §4 already had this in the unshipped list as "W rewrite". |
| 4 | ~500 ms (occasional)| Low | ~10 | `buyNow.ts:pickBestCashbackDelivery:2167`   | **Replace `waitForTimeout(500)` between picker clicks with `waitForResponse(/eligibleshipoption/, { timeout: 5_000 }).catch(() => undefined)`.** Today the picker waits a fixed 500 ms even though the actual eligibleshipoption response is 2.8s. Most picker iterations don't actually need a full settle (the inner loop only re-reads `:checked` properties, which update synchronously on click); but on the rare iter where Amazon re-renders new radio options, we DO need the response. Tighter wait (event-driven, with cap) doesn't slow the common path and prevents a stale read in the rare case. |
| 5 | ~50 ms steady | Low | ~5 | `setMaxQuantity` + `detectBuyPath` callsite (pass 12) | **Parallelize `setMaxQuantity` + `detectBuyPath`**. Already in MASTER doc as pass 12 #15. Confirmed by the /spc trace — both reads are pure DOM, run sequentially today. Race them. |
| 6 | n/a (resilience) | Low | ~20 | `buyNow.ts:waitForConfirmationOrPending` | **Add `data-action="place-order"` selector to the pending-page Place Order detection.** This is the *declarative* button Amazon's Chewbacca delegated-click handler wires to (`<span data-action="place-order">Place your order</span>`). It exists in BOTH the initial /spc and the pending-order interstitial; it's *not* covered by today's selector list (`#submitOrderButtonId button`, etc.). If Amazon ever ships an A/B that drops the static `<input name="placeYourOrder1">`, the existing detection misses; `data-action="place-order"` is a stable Chewbacca-defined contract. |

## What I deliberately didn't push on (and why)

- **Direct POST to `/checkout/p/<id>/spc/place-order` (skipping the click)**. The body shape is trivial (3 fields), so a direct POST is technically possible. But the click handler may set Chewbacca-side session state, refresh CSRF, or fire fraud-signal beacons before the POST. Pass-8 already killed the analogous "B3 HTTP buynow" path for similar reasons (1.3–1.8s slower in practice). The savings here would be at most ~100–300 ms (the click handler's pre-POST work) against unknown anti-fraud risk. Not worth shipping without an A/B-style test on a dedicated account.
- **Pre-firing eligibleshipoption with synthetic params**. The response depends on cart state and selected radio — no shortcut without speculation that may be wrong.
- **Direct `/checkout/p/<id>/spc` on the FIRST entry of a buy.** We don't know the purchaseId yet. The entry/cart hop is unavoidable on the first /spc visit per buy.

## Estimate of total shippable wins on /spc

If you ship items **#1 + #2 + #3 + #4** plus the already-on-the-MASTER-doc #5:

- New work: ~1,800ms (item 1, **re-entry only**) + 175ms (#2) + 250-500ms (#3) + 500ms (#4 occasional) ≈ **~2.6–2.9s per buy in the surgical/recovery flow, ~0.4-0.7s per buy in the common path.**
- LOC: ~125 across 4 commits.
- Risk: low–medium (the purchaseId-cache logic in #1 has a "did cart mutate?" guard that's the only real correctness concern).

Combined with the already-shipped /spc work (~1.0-1.3s from pass-17 inline parsers, plus the CDP blocklist), this gets the post-shipped checkout-side "/spc → Place Order ready" window from today's measured baseline (~5.7s for one delivery click + entry/cart re-entry) down to **~3.0s** in the common path and meaningfully tighter in the surgical-recovery flow.

## Where to start

If picking ONE: ship **#2 (patc-config blocklist)**. It's a one-line diff with 175ms guaranteed savings on every /spc load, no risk, and aligns with the existing `cd71962`/`16a21e5` blocklist commits. From there, **#1 (purchaseId cache for re-entry)** is the biggest absolute win but only kicks in when the surgical-recovery branch ships and starts mutating cart mid-buy.
