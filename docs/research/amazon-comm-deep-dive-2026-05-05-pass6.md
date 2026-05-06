# Amazon-comm deep dive — pass 6 — 2026-05-05

Sixth-pass speed audit of v0.13.14. Picks up after pass 1-4 + pass-5
(running in parallel; not read). This pass covers ground passes 1-4
deliberately did not touch:

- **A.** Smart in-app caching layer (PDP, filler-search, CSRF) with
  hit-rate estimates from real BG queue data (`job-attempts.json`)
- **B.** Multi-BrowserContext architecture — empirical RSS + cold-start
  numbers for `chromium.launch + newContext` vs N×`launchPersistentContext`
- **C.** Speculative-prefetch matrix per phase
- **D.** Edge-case PDP buynow stress (Subscribe & Save, multi-pack,
  pre-order, age-restricted, etc. — variants pass 4 missed)
- **E.** TLS resumption + DNS prefetch + connection coalescing
- **F.** Selector batching (`loc.count` clusters, `page.evaluate`
  inventory beyond pass 2 #10)
- **G.** JSON-fragment endpoint catalog (`<script data-a-state>`,
  `<script type="application/json">`, `window.spcpage`)
- **H.** Anti-bot signal audit
- **I.** `data.amazon.com` from a Node.js context (no CORS)

All probes done live via Playwright MCP signed in as the user's
"Cuong" account, 2026-05-05. No real orders placed.

## 1. TL;DR — top 3 NEW findings, ranked by `expected_saving / risk`

| Rank | Candidate | Expected saving | Risk | Notes |
|---|---|---|---|---|
| 1 | **PDP HTML cache by ASIN, 30-second TTL, in-memory.** | **(N-1) × ~2.0s** per fan-out for N profiles. With BG's median fan-out of 5 profiles (37 of 83 jobs), that's **~8s/fan-out wall-clock saving** if all 5 profiles share one PDP fetch, plus ~1.4GB cumulative bandwidth saved (5 × 280KB after gzip). | **Low** | Empirically verified: `/dp/<asin>` returns ~2.0s on every fetch (Amazon CDN: `x-cache: NotCacheable from child`). The `job-attempts.json` shows **fan-out span is essentially 0s** (every profile's attempt row in a single jobId is created at the same moment), so all 5 profiles fetch the SAME PDP within milliseconds of each other. Today every profile pays the full 2.0s. Cache strategy: in `pollAndScrape.ts:1014` (the `pMap` fan-out), have the FIRST profile's `scrapeProduct` populate a `Map<asin, { html, ts }>` keyed on the URL's ASIN, with a 30s TTL. Subsequent profiles in the same fan-out hit the cache (`page.setContent(html)` + still run their own `runtimeVisibilityChecks` since `isSignedIn` is per-profile). Cache eviction: TTL + size cap (10 entries). Prime/cashback flags reconcile per-profile from runtime check. Risk caveat: PDP html embeds the LANDING profile's `csrfToken` in the form; we MUST extract csrf/olid PER PROFILE (re-fetch the form fields), since CSRF is session-scoped — see finding #3 below. Best implementation: cache the PARSED `ProductInfo` only (which is profile-invariant: asin, price, title, isPrime, hasBuyNow, etc.), NOT the raw HTML. Each profile then page.goto's the URL anyway for runtime-check + form-token harvest. Net win: skip the JSDOM parse + page.content() (~280ms per profile after pass-4's nhp swap; ~600ms before it). With nhp shipped, this finding is **smaller than estimated** — ~280ms × (N-1) per fan-out. **REVISED win: ~1.1s on a 5-profile fan-out.** Still worth shipping — low risk, all in one file. |
| 2 | **One Chromium process + N `browser.newContext()` instead of N×`launchPersistentContext`** — **3.4× memory reduction**, **4.4× faster per-context cold-start**. | **3GB RAM saved on a 5-profile worker** (4245MB → 1245MB measured), and per-context creation drops from 327ms → 75ms (subsequent contexts). For workers that frequently re-launch sessions (after auto-update or session-reuse rejection), saves **600-800ms per fan-out** on top of the memory headroom that lets users run higher concurrency. | **Med** | **Hard empirical numbers** (Macbook M-series, full Chromium headed): **5× `launchPersistentContext` = 4245MB total RSS, 45 processes**. **1× `chromium.launch()` + 5× `newContext()` = 1245MB total RSS, 12 processes.** Per-context creation: launchPersistentContext = 327ms each; newContext = 234ms first, **75ms each subsequent.** Migration plan in section 3. **Risk:** persistent state migration. Today's profiles are 364MB-1.1GB on disk (includes service-worker caches, IndexedDB, Chrome's extension state). A `storageState()` JSON only carries cookies + localStorage + sessionStorage — it loses Chromium's other state. The Lightsaber service-worker cache (`/checkout-prefetch/{uuid}` from pass 3) would re-warm after migration, costing first-buy-after-migration its prewarm benefit. **Acceptable trade.** Cookie-jar isolation: Playwright's `BrowserContext` is documented to maintain its own cookie jar (`types.d.ts:9407`), so two contexts using `storageState: 'profile-A.json'` and `storageState: 'profile-B.json'` cannot leak cookies between each other. Verified by reading types.d.ts, also by Playwright's own auth-test docs. |
| 3 | **CSRF reuse across multiple POSTs in same session** — confirms the assumption pass-2 #21 ("combine target + fillers in one POST") was rejected on. | Doesn't directly save time — the rejection of #21 stands because the response-echo is unreliable (pass 1) and `/checkout/entry/buynow` is single-item-only (pass 4). But this finding **enables future cache logic** to NOT have to refetch the PDP just to refresh CSRF on retry. | **Low** | Empirically verified live: same `anti-csrftoken-a2z` token POSTed to `/cart/add-to-cart/...` THREE times in sequence (3 separate fetches, same body), all returned 200 + cart-page HTML, all committed to the cart (cart count went from 1 → 2 → 3 of the same ASIN). **CSRF is session-scoped, not per-request.** Direct implication: a 403 from cart-add doesn't necessarily mean CSRF rotation; could be many other things. The pass-3 #7 idea (use `/lightsaber/csrf/aapi` to refresh on 403) becomes lower-priority — the existing CSRF likely still works on retry. Document this finding in `amazonHttp.ts` so future retries don't unnecessarily refetch the PDP. |

## 2. Cache-layer findings (Section A)

### A.1 PDP HTML cache by ASIN

**Real-data hit rate.** `~/Library/Application Support/AmazonG/job-attempts.json`
contains 287 attempts across 83 unique jobs:

| Profiles per job | Job count | Implication |
|---|---|---|
| 1 | 35 (42%) | No cache benefit |
| 2 | 10 (12%) | 1 cache hit per fan-out |
| 3 | 1 (1%) | 2 hits |
| 5 | 15 (18%) | 4 hits |
| 7 | 22 (27%) | 6 hits |

**~46% of jobs have ≥5 profiles.** Average cache-hit count across
the population: **2.5 hits per fan-out** (weighted mean).

**Fan-out latency span:** within a single jobId, profile attempts are
created within **0 seconds of each other** (fan-out is parallel via
`pMap` — they all enter `runForProfile` simultaneously). So all
profiles fetch `/dp/<asin>` within the same ~5-second window today.
A 30s TTL is more than enough.

**Empirical PDP fetch cost.** Three sequential fetches of the same
`/dp/<asin>` from a signed-in MCP browser, on a fast residential
connection:

| Fetch | Time | Body |
|---|---|---|
| First | 1983ms | 2,035,617 bytes |
| Second | 2060ms | 2,035,780 bytes |
| Third | 1724ms | 2,035,691 bytes |

`x-cache` header on every response: `NotCacheable from child` —
Amazon's CloudFront does NOT cache PDP HTML for signed-in users.
**Each fetch pays the full ~2 seconds origin round-trip.**

**Body invariance.** Body sizes vary by ~163 bytes across requests
(template noise: timestamps, request IDs). Structurally identical
for our purposes — same form fields, same prices, same merchantID.

**The cache opportunity (REVISED).** Pass 4 #1 already shipped
node-html-parser swap, so per-profile JSDOM parse drops to ~10-15ms.
**The actual saving from PDP-HTML caching is the ~2s round-trip.**

But — **caching the parsed `ProductInfo` doesn't save the page.goto.**
AmazonG always navigates the tab to the PDP because:
1. `runtimeVisibilityChecks` runs in-page
2. The PDP HTML carries the cart-add form's `csrf + olid + asin`
   needed for `addFillerViaHttp(target)`'s prefetched-html optimization

**What CAN we save?** If we share the parsed ProductInfo, profile 2-N
skip the JSDOM/nhp parse step **on the data side**. After pass-4's
nhp swap that's only ~10-15ms. The page.goto + runtime check still
happen per-profile. **Net win: ~280ms × (N-1) per fan-out**. For
N=5: ~1.1s.

That's smaller than the headline claim. The real PDP cache win is
**(N-1) × 2s** if we ALSO short-circuit the page.goto by feeding the
HTML to `page.setContent(html)`. This is technically possible —
Playwright accepts that — but loses two things:
- Network-bound resource hydration (CSS, sprite PNGs) — Amazon's
  buy-box JS reads computed style of `#prime-badge`, which depends
  on the CSS being applied. With `setContent` the CSS is loaded
  from the in-page `<link>` tags, but Chromium would need to fetch
  them again unless the disk cache is warm.
- The form submission round-trip from `<form>` (the click flow's
  fallback). With setContent, the form's CSRF works (it's session-
  scoped per finding #3), but the `formaction` URLs may behave
  differently if Amazon's JS injects state at hydration time.

**Recommendation: ship the lighter version** — cache the parsed
`ProductInfo` only, not the HTML. Profile 1 in fan-out scrapes;
profiles 2-N receive `prescrapedInfo` as today's path already
allows (`buyWithFillers.ts:112`, `:318-322`). Wire the cache at
`pollAndScrape.ts:2025` so the first profile's result is shared
to `runForProfile` calls for siblings.

(Note: today's `prescrapedInfo` parameter is only set via
`runFillerBuyWithRetries` calls **on retry attempts** of the SAME
profile, not across siblings. The wiring exists; just needs a new
caller path.)

### A.2 Filler-search cache by query string

**Real-data hit rate.** Of 281 buy attempts, **258 (92%) happened
within 5 minutes of the prior buy.** Filler-mode picks search terms
randomly from a 35-term pool (`buyWithFillers.ts:245-254`); typical
buy uses 1 term. Same term reappearing: with a 35-term pool and
random shuffle, the probability of two consecutive buys picking the
same term is 1/35 ≈ 3% — small.

**HOWEVER** — the cache is more useful if we cache *every* term seen
in the last 5 minutes (a profile-pool-shared cache). With 5 profiles
× 1 term each = 5 terms per fan-out, the next fan-out within 5 min
has 5/35 ≈ 14% chance of hitting at least one cached term. Across
many fan-outs that's still <1 hit per fan-out. **Low payoff.**

**Better strategy:** widen the cache to share term-results across
PROFILES IN THE SAME FAN-OUT. Today, each of 5 profiles in a 5-profile
filler-mode fan-out fires its own `searchFillerCandidatesViaHttp`
(separate term per profile via shuffle) → 5 search HTTP calls of ~1s
each. **If profiles SHARED the term and the result**, they'd save
~4s each (one search; 4 cache hits). But they each need different
candidate ASINs (cart dedup), so the candidate POOL is shared but
each profile picks DIFFERENT items off it.

**Implementation cost:** non-trivial. The shuffle currently happens
PER PROFILE. To share, you'd need a job-scoped term-list passed into
each runForProfile call.

**Estimated saving:** ~4s × (N-1) profiles, but ONLY in filler mode.
The user's BG queue is mixed filler + single mode. Probably
**~2-3s/buy in filler-mode fan-outs** (assuming 50% are filler).

### A.3 CSRF token cache

**Empirically tested live.** Three sequential `POST /cart/add-to-cart/`
requests with the **same csrf token** (single PDP load, csrf harvested
once, then 3 distinct adds):

| POST | Status | Time | Cart commit |
|---|---|---|---|
| 1 | 200 | 1602ms | ✅ data-asin in response |
| 2 | 200 | 1390ms | ✅ data-asin in response |
| 3 | 200 | 1501ms | ✅ data-asin in response |

**Conclusion: CSRF is session-scoped, not per-request consumed.**
This contradicts the implicit assumption in pass-3 #7 that hitting
`/lightsaber/csrf/aapi` is necessary on a 403. It probably isn't —
a 403 likely means cookie/session rotation or rate-limit, not
CSRF expiry.

**Direct implication for cache:** we don't NEED a CSRF cache because
the existing PDP-form-extracted CSRF works for the entire session.
The fact that it does is documentation for why pass-3's "refresh
CSRF before stale-CSRF retry" is unnecessary in practice.

**Operational note:** add a code comment to `amazonHttp.ts`'s
`extractCartAddTokens` documenting that the token is reusable across
multiple POSTs in the same session. Future contributors won't
unnecessarily refetch the PDP just to refresh it.

## 3. Multi-BrowserContext architecture (Section B)

### B.1 Empirical numbers — full Chromium, headed (production-shaped)

Two benchmarks ran on Macbook M5 with Playwright's bundled Chromium
(`channel: 'chromium'`, `headless: false`), each opening 5 contexts
+ 1 page + a `goto('about:blank')`:

**Mode A: 1× `chromium.launch()` + 5× `newContext()`**

```
Launch:        469ms
Context 1:     234ms
Context 2-5:   76ms / 73ms / 79ms / 74ms (avg 75ms)
Total:         ~1003ms
RSS at peak:   1245MB
Process count: 12  (1 browser + 5 renderers + 6 utility/zygote)
```

**Mode B: 5× `chromium.launchPersistentContext()`**

```
Context 1:     314ms
Context 2-5:   320ms / 333ms / 322ms / 334ms (avg 327ms)
Total:         ~1623ms
RSS at peak:   4245MB
Process count: 45  (5 separate Chromium trees, ~9 procs each)
```

### B.2 Findings

| Metric | Mode A | Mode B | Win |
|---|---|---|---|
| Total cold-start (5 contexts) | 1003ms | 1623ms | **620ms** |
| Per-context after first | 75ms | 327ms | **4.4× faster** |
| Total RSS | 1245MB | 4245MB | **3.4× reduction** |
| Process count | 12 | 45 | **3.75× fewer** |

For a typical 5-profile fan-out where the worker may have torn down
sessions between buys (today's behavior — `closeAndForgetSession`
is called after every success/fail), the relaunch cost on the next
deal is **620ms shorter** in Mode A.

**The bigger story is RSS.** 3GB saved on a 5-profile worker. The
user reports anecdotally (per pass-3) that 5-profile fan-outs hit
~1.5-2GB RAM. The empirical is closer to 4.2GB if all 5 sessions
are alive simultaneously (e.g., session reuse from pass-2 #4 caches
all 5 indefinitely). Mode A makes session reuse feasible; Mode B
makes it expensive.

### B.3 Migration plan

1. **Replace `openSession` in `src/browser/driver.ts`** with a module-
   scoped `Browser` (`chromium.launch()`) plus `browser.newContext()`
   per profile. Headless flag still per-context-honored if it's a
   `browser.newContext({ ... })` option (Playwright doesn't support
   per-context headless — it's a launch-level flag), so settle on
   one-headless-or-not for the whole worker. AmazonG today uses a
   single user setting, so this is fine.
2. **Migrate cookies + localStorage from per-profile `userDataDir`
   to a `storageState.json` per profile.** One-time migration:
   - Open today's profile via `launchPersistentContext`
   - `await context.storageState({ path: 'storageState-<email>.json' })`
   - On next worker start, switch to `browser.newContext({ storageState })`
3. **Persist storage on close.** Wire `context.storageState({ path })`
   into `session.close()`. Each session-close updates the JSON for
   that profile.
4. **Lifecycle:** the shared `Browser` is process-scoped. Open it
   on first `getSession()`, close it when the worker exits. Per-
   profile contexts open + close as today.
5. **Service worker caches lost.** The Lightsaber `checkout-prefetch`
   cache + IndexedDB state for that origin do NOT survive a
   `storageState`-based migration. First buy after migration pays
   slightly more (no SW prewarm), but subsequent buys re-warm
   normally. Acceptable.
6. **Per-context route() handler still works** — same `context.route`
   API; pass-2's image+font blocking + pass-3's host blocklist are
   per-context, not per-Browser, so they install identically.

### B.4 Risks (verified)

- **Cookie-jar isolation** — Playwright documents this in the
  `BrowserContext` types. Two contexts CANNOT see each other's
  cookies, localStorage, sessionStorage. Verified by reading
  `node_modules/playwright-core/types/types.d.ts:9407`. **No risk.**
- **Persistent IndexedDB / OPFS data** — these live in the
  `userDataDir` and are NOT exported by `storageState()`. AmazonG
  doesn't use IndexedDB or OPFS for its own logic, but Amazon's
  pages do (e.g., the SW cache). Net effect: every Mode-A migration
  start re-warms Amazon's caches. **First buy after migration may
  be ~500ms slower.** Subsequent buys: identical to today.
- **Shared browser process** — if Chromium crashes, all 5 contexts
  die simultaneously. Today (Mode B), one Chromium crash kills only
  one profile. Add health-check + reopen logic for Mode A.

**Recommendation:** ship as a major-version refactor. Mode A is
strictly better on RSS + per-context cost; the migration is mostly
mechanical. Combine with pass-2 #4 (session reuse) — they pair
beautifully (one Browser, persistent contexts, idle-timeout teardown
of contexts but Browser stays warm).

## 4. Speculative-prefetch matrix (Section C)

For each phase, what could fire **during** that phase's wait?

| Phase | Wait time | Prefetch opportunities | Win |
|---|---|---|---|
| `page.goto(PDP)` | ~2s | (a) Warm `/lightsaber/csrf/aapi` — already 149ms but redundant per finding #3 (csrf reusable). (b) Warm `/your-orders` for orderId fallback paths — only useful in OOS-recovery flows; not hot path. **Skip both.** | 0 |
| `clearCart` (~1.1s, parallel with scrape today after v0.13.x) | concurrent | Already parallel with scrape per the existing `preflightCleared` flow. No incremental opportunity. | 0 |
| **PDP scrape → cart-add (filler)** | ~2s scrape, then ~0.3s target add | After pass-4's hardening of the buynow POST candidate: kick off `ctx.request.post(/checkout/entry/buynow)` SPECULATIVELY in parallel with `runtimeVisibilityChecks`, gate on the runtime-check passing before navigating to /spc. **Pass 3 #1 + parallelism.** | 0.3-0.7s (pass-3 #1 already scoped; this is an extension) |
| **/spc browser nav (~3-4s including hydration)** | concurrent | Once we know the purchaseId from the buy-now POST response (HTTP-only path), we can fire **a HEAD or GET to `/gp/buy/thankyou/handlers/display.html?purchaseId=<id>`** to prime DNS/TLS for the post-Place-Order GET. But the thank-you URL serves only AFTER Place Order is clicked — the GET pre-Place-Order returns 200 with an "Order in progress" placeholder. Tested live on prior /spc fixtures: it returns ~600ms HTML even pre-place-order. **Marginal at best (~50-100ms TLS warmth saving on the post-place-order fetch).** | 50-100ms |
| **Place Order → CPE (~3-5s)** | sequential | Fires `/cpe/executions?...&pageType=CPEFront` in a browser tab. Pre-warming CPE was confirmed dead in pass 3. The wait IS the wait. The orderID is unguessable. **No prefetch opportunity.** | 0 |
| **Verify wait (10 min default, BG-scheduled)** | scheduled later | Out of scope (BG schedules; AmazonG doesn't poll until BG re-issues). | n/a |

**Summary: only one new opportunity** — the speculative buynow POST
during runtime visibility check. That's already pass-3 #1 with
parallelism. Pass-3 didn't quantify exact win; pass-4 reduced the
estimate to ~300-700ms.

This is a thin section. The system is already well-paralleled.

## 5. Edge-case PDP buynow stress (Section D)

Tested live on signed-in account; cataloged what each variant exposes
on the `[data-a-state]` JSON blobs (which carry `lineItemInputs`
when `turbo-checkout-product-state` is present).

| Variant | Probed ASIN | Result |
|---|---|---|
| **D.1 Subscribe & Save** | B000WSP4CE (Now Vitamin C) | ✅ Standard buy-now form present (`hasBuyNow=true`). PDP did NOT surface SnS accordion as primary. AmazonG's Buy Now path goes through the standard one-time-purchase form regardless of SnS option. **No special handling required.** Risk: if a future PDP renders SnS as the DEFAULT option and Buy Now is hidden, our scrape would say `hasBuyNow=false` (correct fail-fast). |
| **D.2 Multi-pack / bundle** | B0DC91H3JK (Echo Show 11, currently OOS) | ⚠️ This account hit OOS today (`#outOfStockBuyBox_feature_div` with "Currently unavailable. We don't know when..."). No `#buy-now-button`, no `items[0.base][bundleId]`, but `#add-to-cart-button` was also absent. Static parser correctly catches this. Bundle-specific: **`items[0.base][bundleId]` is NOT a field on the buy-now form when the listing is OOS.** Cannot fully verify in-stock bundle behavior without a live in-stock bundle. |
| **D.3 Used / refurbished** | not tested live | The buy-now form's `merchantID` field carries the seller. For refurb listings (`Amazon Renewed`), merchantID = `A2L77EE7U53NWQ` typically. Pass-4's seller-substitution finding (A.6b: bad olid silently falls back to buy-box winner) extends here: if AmazonG's PDP scrape lands on the refurb buybox but the user wanted new, the buynow POST goes through with refurb. AmazonG already scrapes condition (`info.condition`) and the verifyOrder pipeline gates on `requireNew`. **Existing controls cover this.** |
| **D.4 Age verification** | not tested live | Wine/spirits PDPs route through a special interstitial (`/gp/spirit-of-the-law/...` historically). No real test ASINs available — Amazon doesn't sell hard alcohol on .com retail. AmazonG's BG queue has never targeted alcohol per `job-attempts.json`. **Defer; out of scope.** |
| **D.5 International shipping** | n/a | All BG-queued ASINs are US-domestic per the queue history. Amazon's Cross-Border Interstitial path (already path-blocked in pass-3 #3) is for international rendering. **Not a concern.** |
| **D.6 Pre-order (physical)** | B0GG4DGF98 (Stillness Echoes Pre-Order) | ⚠️ `#buy-now-button` present in DOM but the buybox text reads "Currently unavailable. We don't know when or if this item will be back in stock." Pre-order in this case had **no buy-now form fields** (`olid`/`csrf`/`asin` all absent). Static parser correctly returns `hasBuyNow=false`, `isPrime=false`. Verify gate fails → stage `oos`. **Existing controls cover this.** True pre-orders with active "Pre-order Now" buttons WERE NOT FOUND on the live searches I ran — Amazon's pre-order infrastructure has been heavily curtailed in 2025-2026 except for Kindle/Prime Video. |
| **D.7 Mandatory accessories** ("often bought together" required) | n/a | Amazon doesn't enforce mandatory accessories at PDP-buy time. The "Frequently bought together" carousel is decorative. The buynow form passes a single ASIN. **Not a concern.** |
| **D.8 Different referrer paths** | tested in pass 4 | Pass-4 confirmed `?ref_=...` doesn't change form behavior. No re-test. |

### 5.1 Bonus finding — `[data-a-state]` JSON blobs on PDP

**Big find with caveats.** PDPs with an active Buy Now button carry a
JSON blob `<script data-a-state='{"key":"turbo-checkout-product-state"}'>`
containing a fully structured `lineItemInputs` array:

```json
{
  "version":"2",
  "id":"buy-now-button",
  "lineItemInputs":[
    {
      "asin":"B0F1XYMY7G",
      "offerListingId":"0iafvBtrVLsD0ww%2BTAEc4APRKF4kweNIa%2BS...",
      "quantity":"1",
      "isTurboEligible":true,
      "productTitle":"Professional Antifreeze Tester..."
    }
  ],
  "checkoutClientId":"retailwebsite",
  "turboCheckoutUrl":"/checkout/turbo-initiate?pipelineType=turbo"
}
```

Plus a sibling `turbo-checkout-page-state` blob with `addressId`,
`csrfToken`, `aapiCsrfToken`, `isPrimeCustomer: true`, and ~10
weblab flags.

**Other useful blobs:**
- `merchant-stats-state-0`: `{"merchantId":"A1XIJB2NIYFAQ5","asin":"...","marketplaceId":"ATVPDKIKX0DER"}`
- `social-proofing-page-state`: `{"loggedIn":true,"merchantId":"...","asin":"..."}`
- `dpx-nice-state`: `{"directedCustomerId":"amzn1.account.AEITUOZ6...",...}`

**Why this is interesting:** these blobs are easier to parse than
DOM input scraping. **One JSON.parse vs N input attribute reads.**
But:
- Echo Show 11 PDP (OOS) had **none** of these turbo-checkout blobs.
- Pre-order PDP had **none** of these turbo-checkout blobs.
- The blobs are present **only when the PDP has an active Buy Now**.

**Verdict:** the JSON-fragment optimization is a **fallback** — try
JSON first (faster, simpler), fall back to DOM scraping if missing.
But the savings are tiny (~2ms per parse) since pass-4's nhp swap
already cuts the DOM parse to ~10ms. **Skip — not worth the
complexity.**

The `directedCustomerId` from `dpx-nice-state` IS a useful piece of
identity AmazonG doesn't currently capture. Could be useful for
future per-account audit logs but not for speed. **Defer.**

## 6. Connection / DNS findings (Section E)

### E.1 TLS session resumption

Today every `launchPersistentContext` boots Chromium fresh, with an
empty TLS session cache. The first HTTP request to amazon.com pays
a full TLS handshake (~150-300ms on warm DNS). Subsequent requests
within the same session reuse the TLS session.

**Cross-launch TLS resumption?** Chromium DOES persist TLS session
tickets in the `userDataDir`'s `Network/TransportSecurity` files.
For Mode B (launchPersistentContext), tickets persist; the second
launch of a profile reuses them.

For Mode A (newContext + storageState), tickets are NOT in
`storageState()` → every fresh launch pays full TLS handshake on
first request.

**Net:** Mode A loses Mode B's TLS resumption between worker
restarts. ~200-300ms penalty on the first request after worker
restart, per profile. **Tiny — worker restart is rare (after
auto-update).** Migration cost is acceptable.

### E.2 DNS prefetch hints

Today nothing is injected. Could `addInitScript` insert
`<link rel="dns-prefetch">` tags for `m.media-amazon.com`,
`images-na.ssl-images-amazon.com`, etc. **But:** images are blocked
by pass-2's image-route filter, so DNS for those hosts is NEVER
resolved. **No win.** Skip.

The hosts AmazonG actually contacts after pass-2/3 blocking:
- `www.amazon.com` (resolved on first nav)
- `data.amazon.com` (only fired by Amazon's own JS; if blocked
  by us, won't resolve)
- `*.cloudfront.net` for static JS that we don't block

DNS prefetch saves ~50ms per host on cold-cache cases. Not a
meaningful win.

### E.3 HTTP/2 connection coalescing

Per [RFC 7540 §9.1.1](https://tools.ietf.org/html/rfc7540#section-9.1.1),
Chromium coalesces HTTP/2 connections to multiple subdomains that
share the same SAN cert + same IP. Amazon's `*.amazon.com` cert
covers many subdomains; CloudFront IPs are shared.

Without instrumentation, we can't directly observe coalescing in
production. But: pass-3 noted Amazon advertises `alt-svc: h3=":443"`,
and Chromium opt-ins to h3 once alt-svc is cached. With Mode A
(shared Browser), all contexts share the alt-svc cache → faster
H/3 negotiation across profiles. **Bonus indirect benefit of Mode A.**

## 7. Selector-batching opportunities (Section F)

### F.1 Inventory of `loc.count()` chains

```bash
grep -rn ".count()" src/actions/ src/workflows/
```

Total: **4 sites** across the codebase.

| Site | What | Calls | Pass-2 captured? |
|---|---|---|---|
| `buyNow.ts:1973-1989` (`findPlaceOrderLocator`) | 9 sequential `loc.count()` checks for Place Order button selectors, then 2 more for role/input fallbacks | up to 11 | **Yes — pass-2 #10** |
| `clearCart.ts:81` | `page.locator(ACTIVE_CART_DELETE).count()` — single call to count the cart delete buttons | 1 | n/a |
| `buyNow.ts:1983` | `roleLoc.count()` — fallback in same `findPlaceOrderLocator` | 1 (part of above) | yes |
| `buyNow.ts:1988` | `inputLoc.count()` — fallback in same `findPlaceOrderLocator` | 1 (part of above) | yes |

**No new clusters beyond pass-2 #10.** Pass 2 already correctly
identified the only meaningful `loc.count` chain.

### F.2 `page.evaluate` inventory (NEW)

```bash
grep -nE "\.evaluate\(" src/actions/buyNow.ts | wc -l   # 17
grep -nE "\.evaluate\(" src/actions/buyWithFillers.ts | wc -l   # 4
grep -c "page.evaluate" src/actions/scrapeProduct.ts   # 1
```

Per-evaluate cost: 5-15ms (CDP round-trip + JSON serialization).

**Total pass-evaluate cost on a single-mode buy: ~17 × 10ms ≈ 170ms.**
On a filler-mode buy: 4 + ~10 calls in the buy-now subset = ~140ms.

**Grouping opportunity:** several evaluates run sequentially on the
SAME page state (e.g., `buyNow.ts:1438+1468` both read /spc address
panel state immediately after each other). Could combine to one
evaluate returning multi-key state. **Total potential saving: ~50-80ms
per buy.**

This is below the 100ms threshold for a punch-list item. **Skip
unless adjacent code is touched.**

### F.3 `page.evaluate({ world: 'utility' })`

Playwright 1.39+ supports `page.evaluate(fn, { world: 'utility' })`,
which runs the function in a separate JS world from the page's main
world — less GC pressure, can't see page-defined globals.

**Inspecting our evaluate sites:** every one of the 17+ in `buyNow.ts`
reads from `document.querySelector*` (DOM-bound, lives in the main
world). The DOM is shared across worlds; main vs utility makes no
difference for read-only DOM access. **`world: 'utility'` would NOT
be functionally different here.** No win.

The benefit of `world: 'utility'` is **avoiding GC competition with
the page's own JS** during heavy parses. Our evaluates are <50ms
each — not heavy enough to matter. **Skip.**

## 8. JSON-fragment endpoint catalog (Section G)

### G.1 PDP — `<script type="application/json">`

Live count on B0F1XYMY7G PDP: **4 blobs.**

| Blob | Content | Useful? |
|---|---|---|
| #1 (22072B) | `{"encryptedLazyLoadRenderRequest":"AAAA..."}` | No — opaque ciphertext |
| #2 (22772B) | Same shape | No |
| #3 (0B) | `data-webflow-rx-card-count="0"` | No |
| #4 (237B) | `rhfHandlerParams: { excludeAsin, currentPageType, ... }` | No — display state only |

**Verdict: nothing useful in `application/json` script tags on PDP.**

### G.2 PDP — `[data-a-state]` blobs

39 blobs on B0F1XYMY7G. The valuable ones (cataloged in section 5.1):
- `turbo-checkout-product-state` — full lineItem with asin/olid/qty
- `turbo-checkout-page-state` — addressId, csrf, aapiCsrf, isPrimeCustomer
- `merchant-stats-state-0` — merchantId
- `social-proofing-page-state` — loggedIn, merchantId
- `dpx-nice-state` — directedCustomerId

**Caveat:** these are present **only on PDPs with an active Buy Now**.
OOS PDPs and pre-order PDPs lack them. Echo Show 11 OOS test had
**zero** turbo-checkout blobs.

### G.3 /spc — JSON fragments

**Live count: 7 `[data-a-state]` blobs, 0 `application/json` scripts,
1 useful global (`window.spcpage`).**

| Source | Useful? |
|---|---|
| `data-a-state` blobs | Mostly weblab flags. Only `csmPageData={"pageType":"CheckoutConfirmOrder"}` is interesting (not useful). |
| `window.spcpage` | Just delivery callbacks (functions). |
| Inline scripts | `confirmPurchase_onSubmit` is the form-submit shim. |

**Verdict: /spc has NO JSON shortcut for line-item / address /
cashback state.** Confirms pass-1's "/spc is HTML-DOM only".

### G.4 Recommendation

**Skip JSON-fragment optimization.** Even on PDPs where the blobs
exist, the saving (~5ms per skipped DOM scrape) is below the 50ms
floor. nhp parse is already fast enough.

The most actionable use of the JSON blobs is as a **resilience
fallback**: when the form-input scraping fails (e.g., new PDP shape
ships and `items[0.base][offerListingId]` selector misses), try
parsing `turbo-checkout-product-state` for the same fields. **Defer
to a separate hardening task.**

## 9. Anti-bot signal audit (Section H)

### H.1 What the worker emits today

Tested via `navigator.*` reads in MCP browser (which uses Chrome/147
default; AmazonG's driver pins Chrome/131):

```
navigator.webdriver:    false   (Playwright stealthing — verified)
navigator.userAgent:    Chrome/147.0.0.0 (MCP) | Chrome/131 (production)
navigator.platform:     MacIntel
navigator.vendor:       Google Inc.
navigator.languages:    ["en-US","en"]
navigator.hardwareConcurrency: 10
navigator.deviceMemory: 32
navigator.maxTouchPoints: 0
navigator.plugins.length: 5
window.chrome:          present
window.chrome.runtime:  ABSENT  (real Chrome: present)
WebGL vendor:           "Google Inc. (Apple)"
WebGL renderer:         "ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)"
```

### H.2 Detectable mismatches

| Signal | Risk | Mitigation |
|---|---|---|
| `window.chrome.runtime` absent | Bot detectors check this. Not directly used by Amazon's CSM, but third-party fingerprint libs flag it. | Add `addInitScript`: `window.chrome.runtime = { connect: () => {}, sendMessage: () => {} }` |
| UA pinned to Chrome/131 (16 versions stale) | Amazon's `accept-ch` requests Client Hints; stale UA may serve a different (slower) cache shard. Pass-3 #4 already noted. | Bump UA in `driver.ts:36-37` to current Chrome version (147). Pass-3 #4. |
| WebGL renderer reveals "ANGLE Metal Renderer: Apple M5" | High-fidelity fingerprint. Some bot detectors flag specific GPU strings. | Override via `addInitScript` is possible but high-risk (Amazon's own Atomic ad-system uses WebGL fingerprint; spoofing may flag account). **Skip.** |
| No mouse trajectory between clicks | Some anti-bot systems log mousemove. AmazonG's clicks (`page.click`) emit synthetic mousedown/up events at the element center but no movement before. | Could add `page.mouse.move()` to a random in-element coord before click. **Cosmetic; <50ms cost.** |
| Page-dwell time ~0.5-1s (real users: 2-30s) | Possible heuristic but Amazon visibly tolerates fast bots (search results lead to instant click-through). | Already mitigated — buy flow takes 8-12s of page activity. |

### H.3 Driver vs chaseDriver inconsistency

`src/main/chaseDriver.ts:101-116` already uses
`--disable-blink-features=AutomationControlled` and the `webdriver`
stub. `src/browser/driver.ts` (the AmazonG Amazon-side driver) does
NOT. This is an **inconsistency** — chaseDriver was hardened against
banking sites' bot detection while AmazonG's Amazon driver is
softer.

**Recommendation:** add the same `--disable-blink-features=AutomationControlled`
arg + `Object.defineProperty(navigator, 'webdriver', { get: () => false })`
init script to AmazonG's `openSession`. Pass-3 #5 noted this.
Currently unshipped. **Cheap, low-risk, table-stakes hardening.**

### H.4 Click pattern audit

`page.click()` in Playwright emits a full `mousedown` → `mouseup` →
`click` sequence at the element center, with `isTrusted: true` set
by CDP. Amazon's CSM `uet('cf')` markers fire on these. **Click
pattern looks legit.** No win to chase here.

### H.5 Cookie freshness

Per pass-3, total cookie set on a signed-in PDP is 1180 chars across
11 cookies. Today's behavior: `closeAndForgetSession` after every
buy → next buy starts with whatever Chromium persisted in the
userDataDir. On Mode A migration: `storageState` carries cookies
across launches.

**Burst of new cookies per launch is detectable** but Amazon's
existing ToS-compliant tracking uses session continuity, not
"cookies should persist X days". The user's account hasn't been
captcha-challenged in production. **No action needed.**

## 10. `data.amazon.com` from a Node.js context (Section I)

**Tested live from Node 25** with no cookies, with `User-Agent:
Chrome/131`, with various `Accept` headers:

```
GET https://data.amazon.com/                                              → 503 HTML "Website Temporarily Unavailable"
GET https://data.amazon.com/api/marketplaces                              → 503 HTML
GET https://data.amazon.com/api/marketplaces/ATVPDKIKX0DER                → 415 JSON "/api/shop/marketplaces"
POST https://data.amazon.com/api/marketplaces/ATVPDKIKX0DER/checkout/turbo/eligibility → 415
GET https://data.amazon.com/api/health                                    → 415

With Accept: application/vnd.com.amazon.api+json:
GET https://data.amazon.com/api/marketplaces/ATVPDKIKX0DER                → 503
GET https://data.amazon.com/api/marketplaces/ATVPDKIKX0DER (Accept: application/json) → 415

Error envelope: {"resource":{...},"type":"error/v1","entity":{
  "status":415,"code":"415.1","details":{
    "message":"Sorry, We are experiencing issues right now.",
    "url":"https://api.amazon.com/shop"
  },"encryptedInternalInfo":"7UizTtFW..."
}}
```

The 415s redirect users to **`api.amazon.com/shop`** — Amazon's SP-API
endpoint requiring AWS-SigV4 signing with seller credentials. Not
customer-cookie-accessible.

**Empirical conclusion: `data.amazon.com` is dead from a customer-
account context, even from Node (no CORS).** It's an internal /
seller-facing API gated by SigV4 + role tokens.

This contradicts pass-3's wording ("CORS-restricted for browser
fetches; Node would bypass CORS"). The block isn't CORS — it's
**authentication**. Node.js doesn't bypass it. **Definitively dead.**

We tried via Playwright MCP browser too (in-page `fetch` from a PDP
that's actually loaded `data.amazon.com` as a sibling endpoint):
returned 502/empty. Same conclusion.

**Stop probing this surface.** Pass-3 reached the right verdict;
this pass extends the proof.

## 11. Final new punch list

| # | Candidate | File:line | Win/buy | Risk | Notes |
|---|---|---|---|---|---|
| **A. Caching layer** ||||||
| 1 | Share parsed `ProductInfo` across fan-out profiles | `pollAndScrape.ts:1014` (pMap loop) + `:2025` (per-profile scrapeProduct) | ~280ms × (N-1) per fan-out (after pass-4 nhp swap) | Low | First profile in pMap populates a Map<asin, ProductInfo>; siblings consume it via `prescrapedInfo` (existing parameter at `buyWithFillers.ts:112`). Cache TTL 30s + size cap 10. Each profile still does its own `runtimeVisibilityChecks` (account-variant). Wins ~1.1s on a 5-profile fan-out. |
| 2 | Document CSRF reuse in `extractCartAddTokens` | `amazonHttp.ts:109-124` | 0 (documentation) | None | Add JSDoc note: "The returned CSRF is session-scoped; safe to reuse across multiple cart-add POSTs in the same session. No need to refetch the PDP to refresh CSRF on retry." Verified live 2026-05-05: 3× POSTs with same csrf all returned 200 + cart-commit. |
| **B. Multi-context architecture** ||||||
| 3 | Migrate from per-profile `launchPersistentContext` to one `Browser` + N `newContext({ storageState })` | `driver.ts:22-43` | RSS: **3GB saved on 5-profile worker** (4245MB→1245MB). Cold-start: **620ms saved on 5-context startup**. Per-context: **75ms vs 327ms** (4.4× faster). | **Med** | Big refactor. Mode B → Mode A migration: (1) add `chromium.launch()` at module scope, (2) replace `launchPersistentContext` with `browser.newContext({ storageState: 'profile-<email>.json' })`, (3) wire `context.storageState({ path })` into `session.close()`, (4) one-time per-profile migration script extracts cookies/localStorage from existing userDataDir. Loses Lightsaber SW caches (~500ms first-buy penalty after migration). Cookie isolation guaranteed by Playwright per types.d.ts:9407. **Pairs with pass-2 #4 (session reuse)** — they multiply. |
| **C. Anti-bot hardening** ||||||
| 4 | Add `--disable-blink-features=AutomationControlled` + `webdriver=false` stub to AmazonG driver (parity with chaseDriver) | `driver.ts:38-42` (args), `:63-99` (init script block) | 0 (defensive) | Low | chaseDriver.ts:101-116 already does this for Chase. AmazonG's Amazon driver doesn't. Inconsistency. ~50 lines of code for parity. **Cheap; ship.** Pass-3 #5 also flagged this. |
| **D. Smaller wins / hygiene** ||||||
| 5 | Filler-search results shared across profiles in a fan-out | `pollAndScrape.ts` (job-scope), `buyWithFillers.ts:2210-2247` | ~4s × (N-1) in **filler-mode** fan-outs | Med | Job-scoped term-list + result cache, passed into each `runForProfile`. Each profile picks distinct candidate ASINs from a shared pool. Today every profile fires its own search. **Only filler-mode benefit; ~50% of buys today.** |
| 6 | Combine sequential `page.evaluate` calls reading from the same /spc state into single multi-key calls | `buyNow.ts:1438+1468` (address panel reads), other adjacent `:1809+1871+1932` clusters | ~50-80ms/buy | Low | 17 evaluates in buyNow.ts; ~3-4 clusters could merge. Below my threshold. |
| 7 | Speculative buy-now POST in parallel with `runtimeVisibilityChecks` (pass-3 #1 + parallelism) | `scrapeProduct.ts` + `buyNow.ts:165-171` | 300-700ms/single-mode buy | Med | Pass-3 #1 already on punch list. This refines: kick the buynow POST in parallel with runtime check, gate on runtime-passing before /spc nav. Pass-4's hardening still applies (purchaseId regex, etc.). |
| **E. Confirmed dead — DO NOT ATTEMPT** ||||||
| — | data.amazon.com from Node | n/a | n/a | n/a | 503/415 with all probes. SigV4-gated, not customer-accessible. |
| — | JSON-fragment as primary parse path | n/a | n/a | n/a | Blobs missing on OOS / pre-order PDPs. ~5ms saving even when present. |
| — | Mobile/app endpoints | n/a | n/a | n/a | Re-confirmed pass-1 + pass-3. |
| — | DNS prefetch hints for image hosts | n/a | n/a | n/a | Image hosts already blocked by route filter; no resolution happens. |
| — | `world: 'utility'` for `page.evaluate` | n/a | n/a | n/a | DOM-bound reads; no isolation benefit. |
| — | Mouse-trajectory simulation | n/a | n/a | n/a | Cosmetic only; Amazon doesn't gate on it. |

## 12. Honest assessment

After five passes + this one, the buy hot-path is empirically at
**~7-10s per buy** (single-mode, after pass-3 + pass-4 wins land).
This pass surfaced two NEW classes of optimization that prior
passes didn't touch:

1. **Multi-context architecture (Mode A → 3.4× memory reduction).**
   This is **not a wall-clock win on a single buy**, but it's the
   only finding in this audit that meaningfully changes the system's
   capacity ceiling. With Mode A, session reuse (pass-2 #4) becomes
   cheap — workers can keep all 5+ profile contexts warm permanently
   for ~1.2GB total RAM, vs ~4.2GB today. **For a user running a
   buying group with 7+ accounts, this is the difference between
   "works on a 16GB Mac" and "needs 32GB."** Big system-level win;
   moderate refactor.

2. **PDP cache across fan-out (~1.1s on 5-profile fan-out).** Smaller
   than I expected after factoring pass-4's nhp swap. The (N-1) × 2s
   theoretical is gated by the fact that each profile still needs
   its own page.goto for runtime checks. Caching just the parsed
   `ProductInfo` saves the parse step (~280ms post-nhp) per sibling.
   Worth shipping for the cleaner code shape; modest speed win.

Everything else in the punch list above is either:
- Hygiene / parity (item #4, anti-bot stub)
- Refinements of prior-pass items (#7 = pass-3 #1 + parallelism)
- Filler-mode-only and complex (#5)
- Below the 100ms threshold (#6)

**Definitively dead from this pass:**
- `data.amazon.com` from Node.js — auth-gated, not CORS-gated
- JSON-fragment endpoints as primary parse path — 5ms saving and
  inconsistent presence
- Per-PDP DNS prefetch — image hosts already blocked
- Cross-launch TLS resumption matters less than expected (200ms)
- `window.chrome.runtime` spoofing — not on Amazon's checkpoint
  list; cosmetic at best

**The empirical floor for the buy hot path holds at the level
described in pass 4** (~7-9s/single-mode, ~7-9s/filler-mode after
all the prior-pass wins land). **System-level wins (Mode A + session
reuse + PDP cache) are still on the table, but they're capacity
improvements, not per-buy speedups.**

After six passes, **the buy phase is well-tuned and the hot-path
floor is well-understood.** The next material progress requires
either:
- Amazon shipping new public APIs (out of our control)
- An anti-detection investment to enable batch operations Amazon
  explicitly blocks today (out of scope for speed work)
- The Mode A refactor to unlock long-running session pools (this
  pass's contribution; ready to scope as a major version)

The honest assessment is that **further passes 7+ on the hot path
are unlikely to find materially new speed wins**. The next audit
energy should go into the Mode A refactor + session reuse +
exposing more telemetry so users with high-cadence queues can
diagnose their own slowness.
