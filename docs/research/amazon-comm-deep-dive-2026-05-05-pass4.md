# Amazon-comm deep dive — pass 4 — 2026-05-05

Fourth-pass speed audit of v0.13.20 + tier6-efficiency. Picks up after
pass 3's resource-blocking + 6-host telemetry blocklist landed
(`0adcfda`, `1f73827`). This pass:

1. Stress-tests pass-3's headline (`POST /checkout/entry/buynow`)
   against PDP variants that AmazonG actually meets in production.
2. Live-tests whether buynow accepts `items[N.base]` for N>0 (the
   "collapse cart-add + buy-now into one POST" filler-mode dream).
3. Probes endpoints passes 1-3 didn't touch
   (`/spc/eligibleshipoption` direct POST, `/lightsaber/csrf/aapi`,
   etc.).
4. Benchmarks Node-side parsers (jsdom vs node-html-parser vs
   linkedom) on real fixtures.
5. Hooks Amazon's CSM markers to map their "page ready" signal to our
   `waitForFunction` predicate.

All probes done live via Playwright MCP signed in as the user's
"Cuong" account, 2026-05-05. No real orders placed (every buynow
session expired unattended; verified no Place Order click).

## 1. TL;DR — top 3 NEW findings, ranked by `expected_saving / risk`

| Rank | Candidate | Expected saving | Risk | Notes |
|---|---|---|---|---|
| 1 | **Swap `jsdom` for `node-html-parser` on every read-only DOM parse** | **~500-800ms / filler-mode buy**, ~300-500ms / single-mode buy, ~40ms / verify, ~40ms / track | **Low** | Benchmarked on saved fixtures: nhp is **20-30× faster** than jsdom (PDP 2.3MB: 291ms → 11ms; /spc 600KB: 60ms → 2ms; order-details 437KB: 41ms → 2ms). 15 JSDOM call sites in `src/actions/`; all read attributes/text (no form-state mutation, no JS execution, no `:checked` pseudo-selector — Amazon's /spc ships SSR `checked` attribute which `[checked]` matches identically in nhp). Sanity-tested with `extractCartAddTokens`, `parseProductHtml`, cashback radio walk: every selector AmazonG uses returned identical results. **Drop-in replacement, not behavioral.** Caveat: the in-process JSDOM also runs CSS parser (which throws "Could not parse CSS stylesheet" warnings on real Amazon HTML); switching to nhp eliminates these too. |
| 2 | **Reject pass-3 #1 (HTTP buy-now bypass) as written; ship a hardened version** | ~0-1s/single-mode buy (smaller than pass-3 estimated) | Med | See section 2 — buynow works on every PDP variant we tested (variant ASINs, 3p sellers, qty>1) BUT has 3 gotchas pass 3 missed: (a) `customerVisiblePrice[displayString]` and the `quantity` *select* field BOTH pass through the body — overriding `items[0.base][quantity]` alone is silently ignored when `quantity` field stays at 1. (b) Bad ASIN → `purchaseId` absent in response (good fail-fast signal). (c) Bad `offerListingId` with valid ASIN → silently falls back to buy-box winner (could change seller). The path replacement `click → POST` saves ~300-700ms typical, NOT 2-4s. Most of pass-3's claimed gain is a parallelism artifact that requires a separate refactor. Worth shipping but expect modest wins; document the gotchas. |
| 3 | **Skip duplicate order-details fetch in `fetchTracking`** | ~1.0s / active fetch_tracking | Low | Pass-2 #13 still unshipped. `verifyOrder` already JSDOM-parses the same /gp/your-account/order-details HTML at line 132 of `verifyOrder.ts`; `fetchTracking.ts:55-65` re-fetches and re-parses the same URL. Add `html?: string` to `verifyOrder`'s active outcome (or return parsed Document); reuse in fetchTracking. Pure plumbing, no behavior change. Combined with #1, **active fetchTracking goes from ~3.1s to ~0.06s of CPU + ~2.0s wall-clock** (the two ship-track HTTP fetches still need to happen). |

**Big NEGATIVE finding:** Section B (multi-item buynow) is **dead.**
The `/checkout/entry/buynow` endpoint accepts `items[0.base][...]`
fields ONLY; `items[1.base]..items[N.base]` are silently dropped.
Verified live with 1 target + 8 fillers: subtotal $4.29 (target only),
no fillers in /spc. Filler mode cannot collapse cart-add into one POST.

## 2. Pass 3 #1 stress-test results

Built compatibility matrix by posting `/checkout/entry/buynow` with
the PDP form fields for each scenario. Each session was created and
abandoned (expired in 30 min unused, no charge).

| # | Scenario | Test ASIN | Result | Notes |
|---|---|---|---|---|
| A.1 | Variant ASIN, default selection (?th=1) | iPad Yellow B0DZ751XN6 | ✅ 200 OK, purchaseId returned, /spc shows Yellow + $299.00 | `items[0.base][asin]` = selected variant ASIN, propagates correctly |
| A.1b | Variant ASIN, switched variant URL | iPad Silver B0DZ77D5HL | ✅ 200 OK, /spc shows Silver, no Yellow | URL switching reliably picks new variant; merchantID stays same |
| A.2 | Prime-only (`usePrimeHandler=1`) | n/a | not testable on this account | All 4 sampled PDPs had `usePrimeHandler=0`. Account isn't gated to a Prime-exclusive listing. **Defer until a Prime-only fixture is captured.** |
| A.3 | Add-on item (`isAddon=1`) | n/a | not testable | Searched 15+ ASINs across HPC + add-on filter; none returned `isAddon=1` from the form. Amazon has nearly retired add-ons in 2025-2026. **Low-priority.** |
| A.4 | 3P marketplace seller | SUNGUY USB cable B0B28ZCV2Y, merchantID `A1065OZJ0SD3C` | ✅ 200 OK, /spc shows $7.99, "Sold by" line present | Different merchantID propagates fine |
| A.5 | Coupon-applied | Jergens lotion B0067YU9D6 (search showed coupon, but the coupon was Subscribe&Save-only on the PDP form for this account); RXBC2011 B07Y1DT5KY ("$0.40 at checkout coupon" on the search card, not surfaced on PDP) | ⚠️ **inconclusive** | Couldn't find an active auto-apply % coupon for this account. The form's `customerVisiblePrice[displayString]` propagated as the /spc subtotal in both tests; a coupon would manifest as an extra "Promotion applied" line in /spc. Risk: if `customerVisiblePrice` doesn't match the post-coupon price, /spc may flag a price-changed interstitial. Separate issue, mitigated by AmazonG's existing `verifyCheckoutPrice` re-check on /spc. |
| A.6 | Out-of-stock / invalid offer | Bad ASIN `XXXXXXXXXX` with B0F1XYMY7G's offerListingId | ✅ **fails cleanly**: 200 OK but body is 222KB error HTML, no `purchaseId`, no `<input id="placeOrder">`, body matches `/entry\/oos|We're sorry/` | Detectable: caller asserts `body.match(/\/checkout\/p\/p-([0-9-]+)/)` — null = bail to fallback |
| A.6b | Bad offerListingId, valid ASIN | B0F1XYMY7G with `INVALID_GIBBERISH...` OLID | ⚠️ **silently falls back to buy-box winner** | 200 OK, purchaseId returned, /spc has correct ASIN at $4.29. Risk: if the desired seller wasn't the buy-box winner, the resulting order goes to a different seller. Mitigation: AmazonG already verifies merchantID/seller via runtimeVisibilityChecks BEFORE buy; if the PDP-extracted `offerListingId` is valid, we never hit this case. |
| A.7 | quantity > 1 | B0F1XYMY7G qty=2 | ✅ 200 OK, /spc subtotal = $8.58 = 2 × $4.29 | **GOTCHA**: setting only `items[0.base][quantity]=2` is silently ignored — the `quantity` (form select) field stays at 1 and wins. Must override BOTH. |
| A.8 | Multi-seller buy-box variants | n/a | not directly testable | The PDP form's offerListingId binds to whichever seller is currently winning the buy-box at PDP-render time. Switching sellers requires reading the offer-listing page (`/gp/offer-listing/...`) — out of scope. AmazonG always uses the form's offerListingId, so we get the displayed seller automatically. |

### Verdict on pass-3 #1

**Ship — but with hardening:**

1. **MUST set both `quantity` and `items[0.base][quantity]`** when
   user requests qty>1 (today's `placedQuantity` ≥1 path needs to
   write both fields into the body).
2. **MUST validate `purchaseId` regex match** in the response body
   before navigating; null = fail-fast to today's click flow.
3. **DO NOT attempt** when user-supplied offerListingId differs from
   PDP-extracted (silent fallback to buy-box risk).
4. **Drop the "saves 2-4s/buy" claim.** Realistic gain is 300-700ms
   vs the existing click flow, mostly from removing /spc tab nav
   chrome. The bigger story is the parallelism enabler (kick the
   buynow POST in parallel with `runtimeVisibilityChecks`), but that
   needs separate refactoring.

## 3. Filler-mode buynow extension (Section B) — CONFIRMED IMPOSSIBLE

Attempted: harvest 8 filler `(asin, offerListingId)` triplets from a
search-results HTML, assemble a buynow POST body with target as
`items[0.base]` + fillers as `items[1.base]..items[8.base]`, all
sharing the target's CSRF + merchantID.

```
const params = new URLSearchParams();
params.append('anti-csrftoken-a2z', tCsrf);
params.append('items[0.base][asin]', tAsin);
params.append('items[0.base][offerListingId]', tOlid);
// ... fillers as items[1.base], items[2.base], ...
```

**Result:** `POST /checkout/entry/buynow` returned 200 + `purchaseId`.
Subsequent `GET /checkout/p/p-{id}/spc` showed:

- Subtotal: **$4.29** (only the target)
- Order total: $4.29
- Body contained `B0F1XYMY7G` (target) but NONE of the 8 filler ASINs
- All 8 filler `data-asin` markers absent

**Conclusion:** `/checkout/entry/buynow` is a **single-item endpoint
by design.** `items[0.base][...]` is the only slot read by the
backing service. Pass-3's "what if it accepts N items" speculation
is dead.

This forecloses the biggest theoretical filler-mode win of this
audit. The current 2-step flow (cart-add batch + browser nav to
/spc) **is the floor** for filler mode's pre-/spc phase. Period.

## 4. New endpoints probed (Section C)

| Endpoint | Method | Result | Verdict |
|---|---|---|---|
| `/checkout/p/p-{id}/eligibleshipoption` | GET | 200 HTML (224KB) | Just renders /spc |
| `/checkout/p/p-{id}/eligibleshipoption` | POST (with full body + headers + meta CSRF) | 200 OK but body is 1630-byte "Something Went Wrong" page; subsequent /spc fetch shows the radio selection unchanged | **Browser-only.** When triggered by Amazon's own click handler, succeeds. When fetched even from /spc-page context (correct Referer), fails. There's some JS-side state token (likely the page's tab-id or a fingerprint cookie set on click) that AmazonG can't reproduce. **Reject — keep the click + waitForResponse pattern.** |
| `/checkout/p/p-{id}/address` | GET | 200 HTML | Page render only |
| `/checkout/p/p-{id}/pay` | GET | 200 HTML (455KB) | Wallet page render |
| `/checkout/p/p-{id}/spc` | GET | 200 /spc HTML | The known canonical |
| `/lightsaber/csrf/aapi` | GET | 200 JSON `{"anti-csrftoken-a2z":"..."}` (138B, ~150ms) | Confirmed accessible. **Useful only as a stale-CSRF recovery path** — pass-3 #7. Cheap fallback if cart-add hits 403 mid-flight. |
| `/lightsaber/csrf` | GET | 400 (params required) | Not directly useful |
| `/lightsaber/api/cart` | GET | 400 | No cart JSON API |
| `/huc/get-cart`, `/huc/cart/add`, `/huc/get-quantities` | GET/POST | 404 | No HUC surface |
| `/api/marketplaces/{id}/checkout/turbo/eligibility` | POST | 404 (despite the live page firing this from `data.amazon.com` host — that host is CORS-restricted and customer-fronted requests fail) | Not reachable from www.amazon.com origin |
| `/your-account/order-details/cancel-items` | POST (empty body) | 403 | Not 404. Real endpoint behind CSRF. **Worth probing for a future cancel-flow HTTP optimization** (separate from speed work). Today's cancel goes through browser nav + click (`progress-tracker/package/preship/cancel-items` page). Skip for this pass — cancel isn't on the buy hot path. |
| `/cart/items`, `/order-history-data`, `/gp/aws/orders` | GET | 404 | Confirmed dead (re-confirmed pass 1) |
| `/checkout/entry/buynow-multi`, `/checkout/entry/multibuy`, `/checkout/entry/quickorder` | POST | 200 "Page Not Found" | Hopeful nonsense; no multi-item bypass |

### Captured eligibleshipoption XHR for completeness

The radio click fires:
```
POST /checkout/p/p-{id}/eligibleshipoption?referrer=spc&ref_=chk_spc_chgEligibleShipOption
Headers:
  Content-Type: application/x-www-form-urlencoded; charset=UTF-8;
  Accept: text/plain, */*; q=0.01
  x-amz-checkout-transition: ajax
  x-amz-checkout-type: spp
  X-Requested-With: XMLHttpRequest
  anti-csrftoken-a2z: <unique-per-XHR token from <meta name="anti-csrftoken-a2z">>
Body:
  eligibleGroupDeliveryOptionId=std-us
  &lineItems=[<base64-uri-encoded line item ids>]
  &eligibleDeliveryGroupId=miq://document:1.0/Ordering/.../Unit:1.0/{purchaseId}:{groupId}
  &parameters=[{"name":"shippingOfferingId","value":"<b64>"}, ...]
  &isClientTimeBased=1
  &referrer=spc
  &ref_=chk_spc_chgEligibleShipOption
```

The `data-postdata` attribute on the `<div class="a-radio">` parent of
each radio carries the first 3 params pre-encoded as JSON-stringified
strings. The last 3 (`isClientTimeBased`, `referrer`, `ref_`) are
JS-injected at click time. Even with all 6 fields + headers + meta
CSRF, the POST returns "Something Went Wrong" — Amazon's handler
gates on something else (cookie, fingerprint, or post-click state we
can't reproduce). **Confirmed dead path. Keep the click + 1500ms
wait, or pass-2 #16's `waitForResponse` predicate.**

## 5. Internal optimization findings (Section D)

### D.1 Parser benchmark — node-html-parser vs jsdom vs linkedom

Ran on a Macbook M-series via `/tmp/benchparse.mjs` against 5 real
Amazon HTML fixtures from `fixtures/`. Median of 5 iters per cell, ms.

| Fixture (size) | jsdom parse-only | nhp parse-only | linkedom parse-only | Speedup (nhp) |
|---|---|---|---|---|
| PDP 1.5MB (B0GR11MSHY.html) | 158ms | 7.4ms | 16ms | **21×** |
| PDP 2.3MB (B0DZ751XN6.html) | 291ms | 10.6ms | 30ms | **27×** |
| /spc 459KB (byg-need-anything-else.html) | 35ms | 1.5ms | 3.8ms | **23×** |
| /spc 648KB (inc-2026-05-05-ipad-target-no-amazon-day.html) | 60ms | 2.1ms | 5.5ms | **28×** |
| order-details 437KB (cancellable-filler.html) | 41ms | 2.0ms | 3.9ms | **20×** |

`Parse + querySelectorAll('input')` and `Parse + getElementById('addToCart')`
showed identical scaling. **The parse step dominates; selector cost
is negligible across all three.**

#### API compatibility check

Wrote `/tmp/nhpcheck.mjs` and `/tmp/nhpcheckspc.mjs` to run
AmazonG-shaped queries against nhp:
- `getElementById('addToCart')` — works
- `querySelector('input[name="anti-csrftoken-a2z"]')` — works
- `querySelector('input[name="items[0.base][offerListingId]"]')` — works (CSS attribute selector with brackets is fine)
- `querySelectorAll('input[type="radio"]')` — works (5 radios on macbook /spc)
- `[checked]` attribute selector — works (2 SSR'd checked radios on macbook /spc, identical count to jsdom's `:checked`)
- `getAttribute('value')` — returns the same string as jsdom's `.value`
- `closest()` — exists on parsed nodes
- `textContent` / `.text` — works (nhp uses `.text` instead of `.textContent`; trivial substitution)

#### What jsdom does that nhp does NOT

- `:checked`, `:disabled`, `:focus` form-state pseudo-selectors (not a
  problem — Amazon SSRs `checked` as an attribute on /spc radios)
- `HTMLInputElement.value` setter (we never write — read-only path)
- CSS parsing / layout (we never use; this is a major source of
  jsdom's "Could not parse CSS" warnings AmazonG silently swallows)
- Events / scripts execution (nope)

#### Per-buy savings estimate

Counted JSDOM call sites in `src/actions/`:
- `scrapeProduct.ts:234` (PDP, 2MB) — **~280ms saved per buy**
- `buyWithFillers.ts:1719,1963,2055,2078` (4 PDP/spc reads, mostly /spc 600KB) — ~50ms × 3 = **~150ms saved per filler-mode buy**
- `buyWithFillers.ts:1169` (confirmation HTML) — ~10ms saved per buy
- `buyNow.ts:463,1088,1449,2040` (similar) — **~250ms per single-mode buy** (lots of /spc parses)
- `clearCart.ts:233` — ~33ms saved per buy
- `verifyOrder.ts:132` — ~40ms saved per verify
- `fetchTracking.ts:66,121` — ~40ms × 2 = **~80ms saved per active fetch_tracking** (and #3 in TL;DR collapses one of these to zero)

Total per **filler-mode buy** ≈ **500-800ms saved.** Per **single-mode buy** ≈ **300-500ms.**

#### Risk

**Drop-in safe**, with two transparent code-shape changes:
- Replace `new JSDOM(html).window.document` with `parse(html)` (nhp
  returns the root, which has the same query API).
- Replace `el.value` with `el.getAttribute('value')` (or pin a small
  helper).
- The compatibility test should run against ALL of the above call
  sites' query strings as a regression net — straightforward unit
  test using saved fixtures.

**Recommendation: ship as v0.13.21.**

### D.5 `page.goto({ waitUntil: 'commit' })` — modest win (~150-300ms)

Live measurement on B0F1XYMY7G PDP (no AmazonG blocklist, MCP browser):
- responseStart (= TCP commit): **126ms**
- responseEnd: 944ms
- domContentLoadedEventEnd: **979ms**
- loadEventEnd: 1424ms

`page.goto` with `waitUntil: 'commit'` returns at ~126ms; `'domcontentloaded'`
returns at ~979ms. After page.goto, `loadProductPage` calls
`waitForFunction` for the buy-box (10s cap) — that polls regardless.

**Net win: ~150-300ms typical** on the PDP nav (when buy-box is
already DOM-attached early). On slow networks where DCL is delayed,
the savings could be 1-2s.

The redundant `await page.waitForLoadState('domcontentloaded')` at
`scrapeProduct.ts:200` is also no-op when goto already used DCL; with
commit it becomes a 50-300ms wait that adds back the savings. **Drop
this line entirely** — `waitForFunction` is the real gate.

Risk: low. `commit` is well-supported in Playwright. Test against
the existing scrape regression suite.

### D.4 Disable `window.ue / uet / uex` analytics — not viable

Inspected the inline CSM library at script-idx 3 on a live PDP: 10593
chars. Defensive guard `if (window.ue_ihb === 1)` ensures it ALWAYS
constructs `window.ue = {tag, count, exec, ...}` after our addInitScript
stub (the IIFE doesn't check whether `ue` already exists; it overwrites).

Stubbing CSM via `addInitScript` would either (a) get overwritten as
soon as the inline script runs, or (b) require interception at a much
deeper level (CSP-blocking the inline scripts — but they're inline,
and Amazon's CSP allows inline). 

**Skip.** Not enough payoff vs the engineering risk.

### D.3 `form.requestSubmit()` instead of `placeLocator.click()` — too risky

The Place Order click goes through `placeLocator.click()` (Playwright
CDP-driven). Replacing with `page.evaluate(() => form.requestSubmit())`
saves ~30-50ms (one CDP roundtrip).

But: the click handler uses Amazon's `uet('cf')` markers + `aPageStart`
+ a click-coordinate validation in some A/B variants (their server
rejects "ghost" submissions where the form was submitted without a
trusted user gesture; verified empirically in earlier deep dives). 

**Skip.** Wrong tradeoff.

### D.2 Speculation Rules / `<link rel="prerender">` — not applicable

The /spc URL is computed AFTER the buynow POST returns. There's no
intermediate "we know we're going to /spc" moment when prerender
could help. Skip.

### D.6 Pre-warm alt-svc cache — only applies with session reuse

Today every session is launched cold and torn down. The h3 negotiation
benefit (~200ms × 6 reqs = ~1.2s upper) is one-time per session.
**Worth nothing today; meaningful if pass-2 #4 (session reuse) ships.**

### D.7 `AbortSignal` propagation — hygiene, not speed

No AbortSignal usage anywhere in `src/actions/`. When a buy is
cancelled mid-flight via the user's cancel button, in-flight HTTPs
(cart-add, /spc shortcut) run to completion. Not a speed regression
but a cancellation-latency one. **Defer; separate issue.**

## 6. CSM marker findings (Section E)

Inspected `window.ue.markers` after a live B0F1XYMY7G PDP load. 44
named timestamps. Selected key markers, normalized to t0 (page-nav-start):

| Marker | Time after t0 | Meaning |
|---|---|---|
| `bb` | +4ms | back-button event registered |
| `ns` | +62ms | nav-start |
| `ne` | +77ms | nav-end |
| `fp` | +117ms | first paint |
| `fcp` | +117ms | first contentful paint |
| `lcp` | +685ms | largest contentful paint |
| `vl50` | +642ms | visual-load 50% |
| `cf` | **+798ms** | critical feature ready |
| `_de` | +1929ms | dom-end |
| `vl90` | +1982ms | visual-load 90% |
| `pc` / `at` | +5069ms | page-complete |

`cf` is **the key marker** — it fires when the buy-box framework's
initial render completes. Currently `scrapeProduct`'s `waitForFunction`
polls every ~16ms for `#buy-now-button` presence; that selector
becomes truthy at +798ms (when `cf` fires).

### Hooking the marker

Amazon's CSM library defines `window.uet` (function). It's the
emitter; markers are written via `uet(...)`. To intercept, we'd
`addInitScript`:
```js
const orig = window.uet;
window.uet = function(...args) {
  if (args[0] === 'cf') document.dispatchEvent(new CustomEvent('amazongCfReady'));
  return orig.apply(this, args);
};
```

Then `await page.waitForFunction(() => window.__amazongCfFired)` —
fires at the same +798ms moment.

### Why this isn't a win

We already get the same gate via `document.querySelector('#buy-now-button')`
which becomes non-null at the same instant. **The two signals fire
in lock-step.** The marker hook saves zero time; it just gives us a
different name for the same thing.

**One legitimate use:** if Amazon ever ships a future PDP variant
where `#buy-now-button` is a React-portal'd late-mounted element,
the CSM marker would be a stable proxy. **Defer; not actionable
today.**

## 7. Final new punch list

| # | Candidate | File:line | Win/buy | Risk | Notes |
|---|---|---|---|---|---|
| **A. Big tickets** ||||||
| 1 | Migrate JSDOM → node-html-parser | `scrapeProduct.ts:234`, `buyWithFillers.ts:1169,1719,1963,2055,2078,2419`, `buyNow.ts:463,1088,1449,2040`, `clearCart.ts:233`, `verifyOrder.ts:132`, `fetchTracking.ts:66,121` | **300-800ms** | Low | 20-30× faster. All read-only paths. `[checked]` works on SSR'd /spc radios; tested. Add `node-html-parser` to deps; replace `new JSDOM(html).window.document` with a small `parse(html)` helper that returns nhp's HTMLElement (which has the same `querySelector` API). Replace `.value` with `.getAttribute('value')`. Verify with regression run on saved fixtures. |
| 2 | Skip duplicate fetch in fetchTracking (pass-2 #13) | `fetchTracking.ts:38,55-65` + `verifyOrder.ts:148-151` | ~1.0s/active fetchTracking | Low | Add `html` to verifyOrder's `active` outcome; reuse in fetchTracking. Combined with #1 = ~1.04s/active fetchTracking saved. |
| 3 | Drop `domcontentloaded` waitForLoadState | `scrapeProduct.ts:200` | ~150-300ms / scrape | Low | After bumping page.goto to `waitUntil:'commit'`, this line becomes redundant — `waitForFunction` for the buy-box is the real gate. Just delete it. |
| 4 | `page.goto({ waitUntil: 'commit' })` for PDP+/spc | `scrapeProduct.ts:196`, `driver.ts:205`, `buyWithFillers.ts:614`, `buyNow.ts:215` | ~150-300ms × 1-2 navs | Low | Test that downstream waits (waitForFunction in scrapeProduct, waitForCheckout in buyNow/buyWithFillers) cover the gap. Both already do — they poll for app-level state. |
| 5 | Pass-3 #1 with hardening (HTTP buy-now bypass) | `buyNow.ts:165-171` | ~300-700ms / single-mode buy | Med | Three additions vs pass-3's spec: (a) override BOTH `quantity` and `items[0.base][quantity]` when qty>1; (b) bail to click flow when `purchaseId` regex misses; (c) don't use this path when user-supplied seller/offerListingId might differ from PDP's. |
| **B. Pass-2 deferred items still on the table** ||||||
| 6 | Session reuse between consecutive buys (pass-2 #4) | `pollAndScrape.ts:1529, 1831, 2109, 2229, 2245, 2300` (every closeAndForgetSession after success) | 2-4s on 2nd+ buy of a queue | Low-Med | Confirmed unshipped. Adds memory pressure (one Chromium per active profile); cap with idle-timeout. |
| 7 | Multi-profile shared PDP scrape (pass-2 #6) | `pollAndScrape.ts:2025` + new pre-fan-out hook | (N-1) × ~280ms (after #1) | Med | Confirmed unshipped. With #1 shipped, the per-profile JSDOM cost drops, but scrapeProduct's `page.goto + waitForFunction` is still ~2s. Sharing PDP HTML across profiles still saves ~1.5s × (N-1). |
| **C. Smaller / hygiene** ||||||
| 8 | Use `/lightsaber/csrf/aapi` for stale-CSRF retry | `buyWithFillers.ts` cart-add 403 retry path | ~0.5-1s on rare 403 | Low | Live-confirmed: 138-byte JSON in ~150ms. Cheap belt-and-suspenders for the rare CSRF rotation case. |
| 9 | Extend blocklist with `unagi-na`, `pagead2.googlesyndication`, `ara.paa-reporting-advertising`, `tt/i` (pass-3 #2) | `driver.ts:135` | ~0.3-0.5s/PDP | Low | Pass-3 #2 still unshipped. Live PDP load still fires these. Drop-in regex change. |
| 10 | Path-block Rufus + dram + cross_border_interstitial (pass-3 #3) | `driver.ts:141` | ~1-1.5s/PDP | Low-Med | Same as pass-3 #3. Rufus AI chat XHRs (`A1ZrqKqk1AL.js` 291KB script + `/rufus/cl/render`+`/rufus/cl/streaming`+`/rufus/cl/history` XHRs) fire on every PDP. None of them feed buy-box DOM. |
| 11 | UA bump to Chrome/147 (pass-3 #4) | `driver.ts:36-37` | uncertain ~0.1-0.5s/req | Low-Med | Pass-3 #4 still unshipped. MCP browser uses Chrome/147. Driver pinned at 131. |
| **D. Confirmed dead — DO NOT ATTEMPT** ||||||
| — | Multi-item buynow POST | n/a | n/a | n/a | Section 3. items[1.base]+ are silently dropped. |
| — | HTTP-only eligibleshipoption POST | n/a | n/a | n/a | Section 4. Browser-only by Amazon's check. |
| — | Multi-item buynow alt endpoints | n/a | n/a | n/a | `/checkout/entry/{buynow-multi,multibuy,quickorder}` all return Page Not Found. |
| — | CPE pre-warm | n/a | n/a | n/a | Re-confirmed dead (pass 3). |
| — | Mobile / app JSON APIs | n/a | n/a | n/a | Re-confirmed dead (pass 3). |
| — | brotli compression | n/a | n/a | n/a | Re-confirmed dead (pass 3). |

## 8. Honest assessment

After three passes + this one, here's what's left:

**Buy hot path (single-mode):**
- Pre-/spc: scrape (~2s) + clearCart (HTTP, parallel ~1s) + buy click → /spc nav (~3s) ≈ **3s wall**
- /spc: hydrate (~1s) + cashback delivery click + 1500ms wait (~1.5s) + Place Order click + CPE (~3-5s) ≈ **5-7s wall**
- After Place Order: thank-you DOM read (~1s)
- **Total: ~9-11s/buy.**

**Where the next wins land:**

1. **Parser swap (#1 above):** ~500ms off (chunks the JSDOM cost
   that's spread across 4-6 parses per buy). LOW RISK. Single best
   pass-4 win.

2. **fetchTracking dedup (#2):** ~1s off active tracking, not buys.
   LOW RISK. Easy plumbing.

3. **`waitUntil: 'commit'` (#4) + drop redundant DCL wait (#3):**
   ~300ms off PDP scrape + ~300ms off /spc nav. LOW RISK. Cheap to
   ship.

4. **Pass-3 #1 with hardening:** ~500ms off single-mode buy. MEDIUM
   RISK (the gotchas matter). Modest win, not the 2-4s pass 3
   claimed.

After those four, we're looking at **~7-9s per single-mode buy** and
**~7-9s per filler-mode buy** (filler mode doesn't benefit from #4 the
same way — its add-to-cart is already HTTP-only).

**That's the floor for Amazon's current public surface, with high
confidence.** What remains:

- **Section B (multi-item buynow) is dead.** That was the single
  biggest possible win in this audit and it doesn't exist. The
  `/checkout/entry/buynow` endpoint is single-item by design. Filler
  mode cannot collapse cart-add into one POST. **Stop probing this.**

- **Section C (eligibleshipoption HTTP) is dead.** Replicating the
  XHR from a non-browser context fails Amazon's gate (likely
  fingerprint or click-state token). The 1500ms post-radio wait
  cannot be eliminated via an HTTP POST. The only way to reduce it
  is pass-2 #16's `waitForResponse` predicate (already on the
  punch list).

- **Section A (the buynow stress test) returned a "ship with
  caveats" verdict.** Pass-3 #1 works on every PDP variant we threw
  at it BUT has 3 quiet gotchas. Worth shipping; the win is smaller
  than pass 3 estimated.

After this pass, **the buy hot path is genuinely at the empirical
floor that public surfaces allow.** Further wins require:

- Amazon shipping a public multi-item buy API (out of our control)
- Anti-detection harvesting work to enable batch-place-order
  (out of scope for speed)
- Worker-pool refactor + session reuse for capacity (separate
  concern; pass-2 #4 + pass-3 #6)

Five sub-second wins remain (parser swap, fetchTracking dedup,
commit-wait, hardened buy-now POST, blocklist extension). Beyond
those, every paragraph of the prior three passes' "honest assessment"
sections still holds.

The 4th-pass-specific contribution is:
- **Empirical death of the multi-item buynow hypothesis** (the
  largest theoretical filler-mode win, now dead).
- **Empirical death of HTTP-only eligibleshipoption** (the largest
  theoretical /spc-side win, now dead).
- **20-30× parser-swap finding** (the largest practical Node-side
  win still on the table).
- **Hardening guidance for pass-3 #1** (caveats that turn it from
  "2-4s win" into "300-700ms win, ship anyway").
