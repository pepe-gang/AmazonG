# AmazonG speed-improvement master ranking

Consolidated ranked list of every speed/efficiency candidate found across
research passes 1–6. Pass 5 + 6 already appended.

## ⚠️ Maintenance rules — read before editing

This document is **the single source of truth** for outstanding speed work.
Keep it accurate as we ship + research:

- **When a candidate is implemented and shipped:** REMOVE it from the
  Tier 1 / Tier 2 / Tier 3 / Tier 4 tables AND from the Top 10. Add an
  entry under "✅ Already shipped" with the commit SHA. Do not leave
  shipped items in the unshipped tables — that's how the ranking goes
  stale.
- **When new research finds a NEW candidate:** ADD it to the appropriate
  Tier table with file:line, expected saving, risk, and source pass.
  RE-RANK the Top 10 by `saving / risk` so the highest-impact unshipped
  work always sits at the top.
- **When new research falsifies an existing candidate:** MOVE it from
  the Tier tables to "🪦 Confirmed dead" with the reason and source
  pass.
- **When new research changes a saving/risk estimate:** UPDATE the Tier
  table entry and the Top 10. Note the change inline (e.g.,
  "demoted by pass X: …").
- **Ship-order section:** Reflects current best advice; refresh after
  any of the above so it stays actionable.

The goal: a future reader (Claude or human) opening this doc should
see exactly what's left to ship and in what order, without having to
read all six pass-N sub-reports to figure it out.

**Working branch:** `feat/efficiency-tier6` (off `main` at v0.13.20)
**Already shipped this branch:**
- `0adcfda` perf(driver): block images/fonts/media via `context.route()` — ~3–5s/buy
- `1f73827` perf(driver): also block telemetry + ad-system hosts — ~0.3–1s/nav

**Source documents:**
- `amazon-comm-deep-dive-2026-05-05.md` (pass 1)
- `amazon-comm-deep-dive-2026-05-05-pass2.md` (pass 2)
- `amazon-comm-deep-dive-2026-05-05-pass3.md` (pass 3)
- `amazon-comm-deep-dive-2026-05-05-pass4.md` (pass 4)
- pass 5, 6 — pending

## Ranking method

`Score = expected_saving_ms / risk_multiplier`, where risk multiplier is
1.0 (low), 1.5 (low–med), 2.0 (med), 4.0 (high). Saving uses the lower
end of the empirical range for conservative estimation.

"Per-buy expected" applies the saving's frequency (e.g., a 1s win that
fires on 20% of buys = 200ms expected). Wins that only fire on 2nd+
buy in a queue or only on multi-profile fan-out are noted separately.

---

## 🏆 Top 10 by `saving / risk` (ranked) — UPDATED after `1859e57`

| Rank | Candidate | Saving | Risk | Score | Source | Status |
|---|---|---|---|---|---|---|
| 1 | **Skip duplicate `/order-details` fetch in `fetchTracking`** | ~1000ms / active tracking | Low | 1000 | Pass 2 #13 / Pass 4 #3 | unshipped |
| 2 | **Swap `jsdom` → `node-html-parser` for read-only DOM parses** (15 call sites) | 500–800ms / filler buy, 300–500ms / single buy | Low | 500–800 | Pass 4 #1 | unshipped |
| 3 | **`page.goto({ waitUntil: 'commit' })` for PDP + /spc + drop redundant `domcontentloaded` wait** | 450–900ms / buy (2 navs combined) | Low | 450–900 | Pass 4 #3 + #4 | unshipped |
| 4 | **Replace `waitForTimeout(1500)` with `page.waitForResponse(/eligibleshipoption/)`** post-delivery-click | 500ms / typical buy | Low–Med | 333 | Pass 2 #16 | unshipped |
| 5 | **HTTP buynow bypass (HARDENED)** — `POST /checkout/entry/buynow` instead of click | 300–700ms / single-mode buy | Med | 150–350 | Pass 3 #1 → Pass 4 #2 | unshipped, needs hardening |
| 6 | **Multi-profile shared PDP scrape** | (N−1)×1500ms on N-profile fan-out | Med | 750/extra-profile | Pass 2 #6 | unshipped |
| 7 | **Fix orphaned `preflightCleared` in buyNow buy-now-click branch** | ~1000ms HTTP capacity (resource hygiene) | Low | 1000 | Pass 2 #5 | unshipped |
| 8 | **Combine 9 `findPlaceOrderLocator` `loc.count()` probes into one `evaluate`** | 50–150ms always | Low | 50–150 | Pass 2 #10 / A6 | unshipped |
| 9 | **Parallel-fire first 2 filler search terms when term 1 might underflow** | ~1s in ~20% of buys | Low | 200 expected | Pass 2 #11 / A7 | unshipped |
| 10 | **Anti-bot driver parity** — `--disable-blink-features=AutomationControlled` + `webdriver=false` stub | resilience (no per-buy ms) | Low | n/a | Pass 6 / C4 | unshipped |

**Recently shipped (no longer in rankings):**
- ~~CDP `Network.setBlockedURLs` replaces `context.route()`~~ — shipped `a214bd1`
- ~~Path-block Rufus + dram + cr-media-carousel + cross-border~~ — shipped `9fc6947`
- ~~Extend blocklist (6 hosts + 3 cart widgets)~~ — shipped `acea10d`
- ~~Streaming PDP HTTP fetch + early cancel at `</form>`~~ — shipped `1859e57`, **REVERTED in `83fe7c4`** (caused filler Place Order 500 — see dead list)

**🪦 Streaming PDP fetch dead-list addition (lessons from `83fe7c4` revert):**
Native `fetch` (Node 18+) does NOT propagate response `Set-Cookie` back to Playwright's `BrowserContext`. For ANY future Node-side fetch that reads from amazon.com on behalf of the logged-in profile, only `ctx.request.{get,post}` is safe — APIRequestContext shares its cookie jar with BrowserContext bidirectionally. If we ever re-attempt streaming, must (a) parse `response.headers.getSetCookie()` and (b) call `ctx.addCookies(...)` to write Set-Cookie back. Pass-5's "990ms saved" estimate didn't account for this side-effect.

**Path-block candidates DEFERRED for separate analysis (riskier):**
- `/gp/product/ajax/twisterDimensionSlotsDefault*` (~743ms) — variant data risk
- `/gp/product/ajax/paymentOptionsAjaxExperience*` (~525ms) — payment preview
- `/vap/ew/*` (~177ms) — unknown semantics

**Removed from Top 10 (pass 5 reversal):**
- ~~Session reuse between consecutive buys~~ — DEAD per pass-5 (cold-start is 56ms, not 2–4s)

**Honorable mentions (just below top 10):**
- Session-boot HEAD warmup (HTTP/3 alt-svc): ~50–150ms first fetch, low risk — Pass 5 #3

---

## Ranked-by-impact: full list (every unshipped candidate)

### 🟢 Tier 1 — Should ship next (low risk, high return) — UPDATED after `a214bd1`

| # | Candidate | File:line | Saving | Risk | Notes |
|---|---|---|---|---|---|
| ~~A0~~ | ~~CDP `Network.setBlockedURLs`~~ | n/a | n/a | n/a | **SHIPPED `a214bd1`.** |
| **A1** | Swap JSDOM → node-html-parser for all read-only parses | `scrapeProduct.ts:234`, `buyWithFillers.ts:1169,1719,1963,2055,2078,2419`, `buyNow.ts:463,1088,1449,2040`, `clearCart.ts:233`, `verifyOrder.ts:132`, `fetchTracking.ts:66,121` | 500–800ms / filler buy<br>300–500ms / single buy<br>~40ms / verify<br>~40ms / track | Low | **20–30× faster on real fixtures** (PDP 2.3MB: 291ms→11ms; /spc 600KB: 60ms→2ms; order-details 437KB: 41ms→2ms). Drop-in API match for our read-only paths. |
| ~~A2~~ | ~~Path-block Rufus + dram + cr-media-carousel + cross-border~~ | n/a | n/a | n/a | **SHIPPED `9fc6947`.** |
| **A3** | Extend host blocklist | `driver.ts` `BLOCKED_URL_PATTERNS` | 300–500ms / PDP nav | Low | Add `*://unagi-na.amazon.com/*`, `*://pagead2.googlesyndication.com/*`, `*://ara.paa-reporting-advertising.amazon/*`, `*://s.amazon-adsystem.com/*`, `*://aax-us-east-retail-direct.amazon.com/*`, `*://d2lbyuknrhysf9.cloudfront.net/*`. |
| **A4** | Skip duplicate `/order-details` fetch in `fetchTracking` | `verifyOrder.ts:148-151` (return doc on active) + `fetchTracking.ts:38,55-65` (reuse) | ~1000ms / active tracking | Low | Pure plumbing. Combined with A1: active fetch_tracking goes from ~3.1s to ~2.0s wall-clock. |
| **A5** | `page.goto({ waitUntil: 'commit' })` + drop redundant `waitForLoadState('domcontentloaded')` | `scrapeProduct.ts:196,200`, `driver.ts:205`, `buyWithFillers.ts:614`, `buyNow.ts:215` | 450–900ms / buy | Low | TCP commit fires at ~50ms; DCL at ~500ms. Downstream `waitForFunction`/`waitForCheckout` already cover the gap. |
| **A6** | Combine 9 `findPlaceOrderLocator` `loc.count()` probes into one `evaluate` | `buyNow.ts:1973-1989` | 50–150ms always | Low | 9 CDP round-trips → 1. |
| **A7** | Parallel-fire first 2 filler search terms | `buyWithFillers.ts:2226-2247` | 200ms expected (1000ms × 20%) | Low | When term 1 underflows, today's `for` loop runs term 2 serially. |
| **A8** | Fix orphaned `preflightCleared` on buy-now-click branch | `pollAndScrape.ts:2023`, `buyNow.ts:165-171` | 1000ms HTTP capacity | Low | v0.13.20 leftover: clearCart fires but is never awaited. Resource hygiene; not wall-clock but reduces Amazon-edge load + cookie pool churn. |
| **A9** | Streaming-fetch + early `body.cancel()` for PDP HTTP fetches | `buyNow.ts:1449`, `buyWithFillers.ts:2055` (replace `ctx.request.get` with `pdpHttpFetchStreaming`) | ~990ms / PDP HTTP fetch (token-harvest fallback) | Low | New helper in `amazonHttp.ts` that streams `/dp/<asin>` and cancels the reader after `#buy-now-button`+`formaction`+`offerListingID`+`#add-to-cart-button` markers all present (or 600KB cap). |
| **A10** | Session-boot HEAD warmup for HTTP/3 alt-svc | `driver.ts` (after `launchPersistentContext`) | ~50–150ms first PDP fetch | Low | `ctx.request.head('https://www.amazon.com/').catch(()=>{})` — primes DNS+TLS+alt-svc; subsequent requests negotiate h3+0-RTT. |

**Tier 1 cumulative if all shipped (single-mode buy):**
- A0 (CDP): 500–2000ms
- A1 (parser): 300–500ms
- A2 (path-block): 1000–1500ms
- A3 (host-block): 300–500ms
- A5 (commit-wait): 450–900ms
- A6 (batched probes): 50–150ms
- A9 (streaming PDP): 990ms (when fallback fires)
- A10 (HEAD warmup): 50–150ms (first nav)

**Per buy total: ~2.6–4.7s (most apply on every buy).**
**Filler-mode adds A1's bigger filler delta (+300ms) and A7 (200ms expected).**

### 🟢 Tier 1 deferred — saved as research note for future session

| # | Candidate | File:line | Saving | Risk | Notes |
|---|---|---|---|---|---|
| **W** | **Rewrite `waitForCheckout` from polling to event-driven via `page.waitForFunction`** | `buyNow.ts:639` (50-100 line refactor) | 500–1500ms / buy on happy path; up to 3s on address-picker flow | Med | Today: polls every 500ms (dead time between state changes and detection). RAF-paced `waitForFunction` resolves at ~16ms granularity. Also replaces 3000ms blind wait at `buyNow.ts:1035` with `waitForResponse` predicate on the address-submit XHR. Full proposal: `docs/research/proposal-waitForCheckout-event-driven.md`. Empirical prerequisites listed in proposal — ~30 min of MCP capture before implementation. |

### 🟡 Tier 2 — Higher reward but more risk / bigger refactor — UPDATED

| # | Candidate | File:line | Saving | Risk | Notes |
|---|---|---|---|---|---|
| ~~B1~~ | ~~Session reuse between consecutive buys~~ | ~~n/a~~ | n/a | n/a | **REJECTED by pass 5.** Cold-start is 56ms median, not 2–4s. Pre-warming saves at most ~80ms — not worth memory pressure or complexity. |
| **B2** | Multi-profile shared PDP scrape (with PDP cache) | `pollAndScrape.ts:2025` + new pre-fan-out shared HTTP fetch | ~280ms × (N−1) on N-profile fan-out | Med | **Demoted by pass 6**: after parser swap (A1), savings shrink from 1.5s to ~280ms per sibling — each profile still needs page.goto for runtime checks; cache only skips the parse. Still worth doing on 5-profile fan-outs (46% of BG queue jobs) = ~1.1s/fan-out. |
| **B3** | HTTP buynow bypass (HARDENED) | `buyNow.ts:165-171` | 300–700ms / single-mode buy | Med | Three gotchas pass-4 caught: must override BOTH `quantity` and `items[0.base][quantity]` for qty>1; bail if purchaseId regex misses; don't use when offerListingId may differ from PDP. |
| **B4** | Replace `waitForTimeout(1500)` with `page.waitForResponse(/eligibleshipoption.*pipelineType=Chewbacca/)` | `buyWithFillers.ts:825,967`, `buyNow.ts:315,893` | 500ms / typical buy | Low–Med | Known "6%→5% strip" race: mitigate with 200ms post-settle (net win drops to ~300ms). |
| **B5** | UA bump to Chrome/147 + Client Hints | `driver.ts:36-37` | 100–500ms / req (uncertain) | Low–Med | Drop the explicit Chrome/131 pin, let Playwright use defaults. Anti-bot fingerprint risk if behavior shifts. Roll out one profile first. |
| **B6** | Pre-create checkout sessions during dwell (depends on B3) | new flow in `pollAndScrape.ts` | ~2.4s removed from buy hot path | Med | **Validated by pass 5:** purchaseId TTL is hours (alive at T+11min). Pre-POST `/checkout/entry/buynow` while user reviews, hand the resulting purchaseId to the buy phase when they confirm. Only useful if B3 ships first. |
| **B7** | **Multi-context architecture refactor** — `chromium.launch()` + `browser.newContext()` × N instead of `launchPersistentContext` × N | `driver.ts` major refactor + per-profile `storageState` JSON migration | **3.4× RSS reduction (4245MB → 1245MB at 5 profiles), 4.4× faster context cold-start (327ms → 75ms)** | Med–High | **The biggest system-capacity win in any audit.** Per pass 6 empirical measurement. Memory savings let us run more profiles per machine; faster cold-start brings second+ context creation under 100ms. Cookie/storage migration is the lift. |

### 🔵 Tier 3 — Hygiene / opportunistic

| # | Candidate | Saving | Risk | Notes |
|---|---|---|---|---|
| ~~C1~~ | ~~`/lightsaber/csrf/aapi` for stale-CSRF retry~~ | ~~rare~~ | ~~Low~~ | **REJECTED by pass 6.** CSRF is session-scoped, not per-request consumed. 403s on cart-add aren't from CSRF rotation. |
| **C2** | Add `--disable-blink-features=AutomationControlled --disable-features=Translate --disable-extensions --disable-renderer-backgrounding` to launch args | <100ms total | Low | Standard hardening flags. |
| **C3** | Pre-warm alt-svc cache (HEAD `/`) at session boot for HTTP/3 | 50–150ms first PDP fetch | Low | Pass 5 #3 / A10. |
| **C4** | Anti-bot driver parity — match `chaseDriver.ts`'s `webdriver=false` stub + `--disable-blink-features=AutomationControlled` | n/a per-buy; resilience | Low | Pass 6 finding. AmazonG `driver.ts` lacks these; chaseDriver has them. Inconsistency. |

### 🔴 Tier 4 — Memory / capacity (not wall-clock)

| # | Candidate | Win | Risk | Notes |
|---|---|---|---|---|
| **D1** | Worker-pool refactor: `chromium.launch()` + `browser.newContext()` × N (instead of `launchPersistentContext` × N) | 30–40% memory reduction | High (big refactor) | Single Chromium, N renderer subprocesses. Cookie/storage migration required. Not wall-clock speedup. |

---

## ✅ Already shipped (this branch)

| Commit | Win | Saving | Verified |
|---|---|---|---|
| `0adcfda` | Block image/font/media (non-SVG) via `context.route()` | 3–5s/buy across PDP + /spc | MCP empirical: 96 image requests / 202KB blocked per PDP, Prime/Buy Now/cashback selectors invariant |
| `1f73827` | Block telemetry + ad-system hosts (`fls-na`, `unagi`, `aax-us-iad`, `dtm`, `cs`, `aax.amazon-adsystem`) | 0.3–1s/nav | MCP empirical: 16 requests blocked across 2 hosts on iPad PDP, 0 of them serve JS, 0 referenced by buy-box DOM, 0 JS errors when aborted |
| `a214bd1` | **Migrate route() → CDP `Network.setBlockedURLs`** (was Top-10 #1 / A0) | 500–2000ms/PDP nav (eliminates per-request IPC) | MCP empirical: 118/300 requests match patterns on live iPad PDP; buy-box DOM unchanged (productTitle, 3 visible Prime badges, Buy Now visible+enabled, ATC visible). Same blocking intent as `0adcfda`+`1f73827`. |
| `9fc6947` | **Path-block Rufus AI + dram + cr-media-carousel + cross-border** (was Top-10 #2 / A2) | ~960ms / PDP nav (4 newly-blocked XHRs) | MCP empirical on iPad PDP: 4 new blocks (rufus/cl/render 154ms, cross_border_interstitial 250ms, rufus/cl/streaming 360ms, cr-media-carousel 196ms). Buy-box DOM unchanged. /rd/uedata intentionally NOT blocked to preserve CSM telemetry channel. |
| `acea10d` | **Extend blocklist: 6 hosts + 3 cart widgets** (was Top-10 #5 / A3 + new finds) | ~2185ms across 6 newly-blocked requests on iPad PDP; realistic ~1.5–2s/PDP | MCP empirical: `s.amazon-adsystem` 427ms, `unagi-na` 299ms, `ara.paa-reporting-advertising` 207ms, `/cart/ewc/` 608ms, `/cart/add-to-cart/patc-template` 166ms, `/cart/add-to-cart/get-cart-items` 161ms. Plus 3 not-on-this-PDP hosts (pagead2, aax-us-east-retail-direct, d2lbyuknrhysf9). Cart paths use different subpaths than our HTTP-only POST. |
| ~~`1859e57`~~ | ~~Streaming PDP HTTP fetch~~ | n/a — **REVERTED in `83fe7c4`** | Caused filler-mode Place Order 500 regression. Native `fetch` doesn't propagate response Set-Cookie back to `BrowserContext`; ~10× streaming fetches per filler buy left session-state cookies stale, /spc rendered OK but Place Order POST failed Amazon's session-state validation. Single-mode unaffected because its single `addFillerViaHttp` call provides `prefetchedHtml` so the streaming fetch never fires. |

---

## 🪦 Confirmed dead (do not investigate further)

| Hypothesis | Why dead | Source |
|---|---|---|
| Direct `/spc/place-order` POST without browser | CPE redirect requires browser JS execution | Pass 1 |
| HTTP-only PDP scrape (skip `page.goto`) | Loses runtime visibility checks; reconcile rule depends on them; risk of placing buy on non-Prime listing | Pass 1 |
| Mobile / app JSON APIs (`mapi.amazon.com`, `api.amazon.com`, `mshop-amazon.com`) | TLS refused / CORS-blocked from web origin; require app-attestation tokens | Pass 3 |
| GraphQL on `www.amazon.com` (`/graphql`, `/api/graphql`) | All HTML 404; service worker references are framework-internal, not customer-facing | Pass 3 |
| WebSocket / SSE on buy hot path | None present; verified via `performance.getEntriesByType('resource')` | Pass 3 |
| CPE pre-warming (`/cpe/executions` without context) | Returns 400 / 0-bytes | Pass 3 |
| Hidden URL params (`?one-click=1`, `?direct_buy=1`, `?bypass=payments`, `?ref_=ya_express`, `?light=1`, `?aod=1`) | All no-ops, return identical HTML | Pass 3 |
| `Accept: text/x-amazon-json` / `Accept: application/json + X-Requested-With` | Same HTML returned | Pass 3 |
| Brotli compression on `www.amazon.com` | Server serves only gzip regardless of `Accept-Encoding` | Pass 3 |
| Batch verify via `/your-orders/orders` | 826KB HTML, ~1.8s; math doesn't favor batching at typical 1–3 active orders/account | Pass 3 |
| **Multi-item buynow** (`items[1.base]..items[N.base]` in one POST) | Live-tested: only `items[0.base]` makes it into session. `/checkout/entry/buynow` is single-item by design | **Pass 4** |
| **HTTP-only `eligibleshipoption` POST** | 200 OK but body is "Something Went Wrong"; Amazon's check (likely click-state token) blocks non-browser POSTs even from /spc page context with correct Referer | **Pass 4** |
| Multi-item alt endpoints (`/checkout/entry/buynow-multi`, `/multibuy`, `/quickorder`) | All Page Not Found | Pass 4 |
| HUC API (`/huc/get-cart`, `/huc/cart/add`, `/huc/get-quantities`) | All 404 | Pass 4 |
| `/api/marketplaces/{id}/checkout/turbo/eligibility` from www origin | 404 (lives on `data.amazon.com` host, CORS-restricted) | Pass 4 |
| `/lightsaber/api/cart` | 400 — no JSON cart API | Pass 4 |
| **`data.amazon.com` from Node.js (no-CORS bypass theory)** | Returns 503/415 — auth-gated, NOT CORS-gated. Theory wrong. | **Pass 6** |
| **CSRF refresh on 403 (`/lightsaber/csrf/aapi` retry path)** | CSRF reuse confirmed: 3 sequential POSTs with same token all returned 200+commit. CSRF is session-scoped not per-request. 403s aren't from CSRF rotation. | **Pass 6** |
| **JSON-fragment endpoints as PRIMARY parser (`turbo-checkout-product-state`)** | Blobs absent on OOS/pre-order PDPs; ~5ms saving when present. Useful as future fallback for resilience, not primary path. | **Pass 6** |
| **DNS prefetch hints (`<link rel="dns-prefetch">`)** | Image hosts already blocked by route filter; no remaining benefit. | **Pass 6** |
| **`world: 'utility'` for `page.evaluate`** | DOM-bound reads, no benefit from utility world isolation. | **Pass 6** |
| **Lightsaber SW prewarm exploitation** | Only 5 message-handler types; none expose `prewarm-this-URL` API. `checkout-prefetch` cache filled by encrypted opaque payloads. | **Pass 5** |
| **Hot-context pool / pre-warm contexts / session reuse** | Cold-start is 56–327ms (config-dependent), not 2–4s. Pre-warming saves at most ~80–250ms — not worth memory/complexity. | **Pass 5** |
| **Pre-build Place Order POST during dwell** | Body is 3 fields, 142 bytes — already trivial. Zero CPE injection at click time. | **Pass 5** |
| **Worker-thread HTML parsing** | 22ms main-thread parse not worth Worker IPC overhead | **Pass 5** |
| **Cross-profile filler-search sharing** | Search results ARE personalized — only 3/12 ASINs overlap signed-in vs anon | **Pass 5** |
| **Cross-profile `/lightsaber/csrf/aapi` token sharing** | Tokens are per-session, not shareable | **Pass 5** |
| **Header probes (`Sec-Purpose: prefetch`, `Priority: u=0,i`, `zstd`, `Save-Data: on`, `Viewport-Width: 360`)** | No header gives smaller body. `Save-Data: on` makes things WORSE (data-saver HTML is larger by 8% and missing some buy-box markers) | **Pass 5** |

---

## Recommended ship order — UPDATED after passes 5 + 6

### Phase 1: Tier 1 bundle (this branch)

Ship A0 + A1–A10 as one or two CLs on `feat/efficiency-tier6`. All low-risk, all touch independent files. Combined target:
- **Single-mode: ~9–11s/buy → ~5–8s/buy**
- **Filler-mode: ~10–12s/buy → ~6–9s/buy**
- **Active tracking: ~1s reduction per pass**

Order within the phase:
1. **A1 parser swap** — biggest Node-side win, drop-in safe; ship first to lock it in
2. **A0 CDP `setBlockedURLs`** — supersedes the just-shipped route handler with the same intent, much cheaper. Ship as a refactor of `driver.ts:122-141`.
3. **A2 + A3 path-block + host-block extensions** — ride along on A0
4. **A4 fetchTracking dedup** — standalone, separate file path
5. **A5 commit-wait** — touches multiple files; ship after others verified
6. **A6 + A7 + A8 + A9 + A10** — small, parallel work

### Phase 2: Tier 2 (separate CLs)

Once Phase 1 lands:
1. **B4 waitForResponse** — replaces a single magic number; small surface
2. **B3 hardened HTTP buynow** — wrap A8 (preflightCleared fix) in the bypass path
3. **B2 multi-profile shared scrape (with PDP cache)** — pass-6 #2 validates
4. **B6 pre-create checkout sessions during dwell** — depends on B3
5. **B5 UA bump** — roll out one profile first

### Phase 3: Tier 2 system-capacity (separate major-version effort)

**B7 multi-context architecture refactor** — `chromium.launch()` + `browser.newContext()` × N instead of `launchPersistentContext` × N. Per pass 6:
- 3.4× RSS reduction (4245MB → 1245MB at 5 profiles)
- 4.4× faster context cold-start (327ms → 75ms)
- Cookie/storage migration is the lift

Schedule for a dedicated major-version effort (e.g., v0.14.0).

### Phase 4: Tier 3 hygiene

Bundle C2 + C3 + C4 (Chromium flags, HEAD warmup, anti-bot driver parity) as a small hardening CL after Phase 1 ships and stabilizes.

---

## Honest assessment (consolidated from all six passes)

After six research passes the buy hot path is **empirically at its floor
for Amazon's current public surface.** The hypothesis space has been
exhausted:

- **Hidden APIs / mobile / GraphQL / brotli / hidden URL params / CPE
  pre-warm / multi-item buynow / HTTP-only eligibleshipoption /
  data.amazon.com Node bypass** — all dead.
- **Per-buy wall-clock**: ~3–6s of low-risk wins remain, all in Tier 1.
- **System-capacity**: Tier 2 (multi-context refactor + multi-profile
  shared scrape + PDP cache).
- **Per-tracking**: Tier 1 A4 (fetchTracking dedup) saves ~1s.

The biggest **still-unshipped** wins are:
1. **CDP `setBlockedURLs` (A0)** — 500–2000ms/PDP nav, supersedes the
   just-shipped route handler
2. **Path-block Rufus + dram (A2)** — 1000–1500ms/PDP nav
3. **Streaming PDP HTTP fetch (A9)** — ~990ms/PDP HTTP fetch
4. **Skip duplicate `/order-details` (A4)** — ~1s/active tracking
5. **Parser swap (A1)** — 500–800ms/filler buy

The biggest **system-capacity** win is **B7 multi-context refactor**
(3.4× RSS, 4.4× cold-start), but it's a major-version effort.

Past pass 6, further gains require:
- Amazon shipping new public APIs (out of our control)
- Anti-bot hardening for batch behaviors (out of scope for speed)
- B7 multi-context refactor (separate major-version concern)

---

*Pass 5 + 6 reports will be appended below when they finish.*

---

## Pass 5 findings — landed

### 🟢 Three real new wins

1. **Streaming-fetch + early `body.cancel()` on PDP HTML** (~990ms / PDP HTTP fetch, low risk)
   - PDP body is 2.0MB; all buy-box markers (`#buy-now-button`, `formaction`, `offerListingID`, `#add-to-cart-button`) appear by byte ~506K. The trailing 1.5MB is product carousels, Rufus chat data, footer, lazy-load images — never read by AmazonG.
   - Implementation: `r.body.getReader()` loop watching for the four markers, `reader.cancel()` once present (or after 600KB safety cap).
   - Hits `buyNow.ts:1449` and `buyWithFillers.ts:2055` (the `pdpHttpFetch` token-harvest path).
   - **Does NOT apply to `page.goto()`** — Playwright drains the full body. Only the HTTP fallback path benefits.
   - **/spc streaming saves only ~100ms** (Amazon flushes head + stalls 677ms + flushes the rest in one burst, with all AmazonG markers in the trailing burst). Not actionable for /spc.

2. **CDP `Network.setBlockedURLs` replaces `context.route()` JS handler** (~0.5–2s / PDP nav, low risk)
   - `context.route('**/*', cb)` invokes the JS callback for **every** sub-resource (~250+/PDP), each costing ~1–3ms IPC roundtrip.
   - CDP `Network.setBlockedURLs` configures Chromium's network layer once with glob patterns; matches drop pre-renderer with **zero per-request IPC**.
   - SVG carve-out can be safely dropped (verified: buy-box has zero SVG dependencies).
   - Hits `driver.ts:141` — replaces our just-shipped route handler with a CDP-level equivalent.

3. **Session-boot HEAD warmup** (~50–150ms on first PDP fetch, low risk)
   - `ctx.request.head('https://www.amazon.com/').catch(()=>{})` after `launchPersistentContext` warms DNS+TLS+alt-svc cache.
   - Subsequent requests negotiate HTTP/3 + 0-RTT.
   - Trivially small but trivially safe.

### 🔴 CRITICAL REVERSAL — pass 2 #4 (session reuse) is DEAD

**`chromium.launchPersistentContext` is 56ms median** on M-series Macs with a real 364MB profile, **not 2–4s** as pass 2 anecdotally guessed.

- Total session lifecycle (launch + addInitScript×2 + route + newPage + close) is **85–138ms**.
- Pre-warming saves at most ~80ms; session-reuse saves at most ~80ms across consecutive buys.
- **Not worth the memory pressure or complexity.**

**Pass 2 #4 (session reuse) and pre-warm-sessions are REJECTED**. The master ranking above has been updated.

### 🟢 Bonus finding — Place Order POST is trivial

Captured via Network panel during a real $4.29 cancel-after-place test. Body is **3 fields, 142 bytes**:
```
anti-csrftoken-a2z=<token>
hasWorkingJavascript=1
placeYourOrder1=1
```

**Zero CPE injection at click time.** Pre-building the body during /spc dwell saves nothing — it's already trivial. The CPE redirect chain happens *after* the POST returns, not from data added to the POST.

**Bonus: Amazon's Place Order endpoint is idempotent** — replaying the same POST returns the same orderId without creating a duplicate. Useful for retry safety but not a speed win.

### 🟡 Pass 4 #5 (purchaseId TTL) validated

Live-tested: a buynow purchaseId is **alive at T+11 minutes** with full Place-Order-ready /spc HTML. Likely persists hours.

This validates the **"pre-create checkout sessions during dwell time"** strategy (~2.4s removed from buy hot path) — but only meaningful in tandem with the hardened buynow bypass (Tier-2 B3). Not actionable standalone.

### 🔴 Other rejects from pass 5

| Hypothesis | Why dead | Section |
|---|---|---|
| Lightsaber SW prewarm exploitation | Only 5 message-handler types; none expose a `prewarm-this-URL` API. `checkout-prefetch` cache filled by encrypted opaque payloads we can't populate | §3 |
| Pre-build Place Order POST during dwell | 3 fields, 142 bytes — already trivial | §4 |
| Hot-context pool / pre-warm contexts | Cold-start is 56ms, not 2–4s — nothing to save | §5 |
| Header probes (`Sec-Purpose: prefetch`, `Priority: u=0,i`, `zstd`, `Save-Data: on`, `Viewport-Width: 360`) | No header gives smaller body. `Save-Data: on` makes things WORSE (Amazon serves a "data-saver" HTML that's larger by 8% and missing some buy-box markers) | §8 |
| Cross-profile filler-search sharing | Search results ARE personalized — only 3/12 ASINs overlap signed-in vs anon | §7 |
| Worker-thread HTML parsing | 22ms main-thread parse not worth Worker IPC overhead | §11 |
| Cross-profile `/lightsaber/csrf/aapi` token sharing | Tokens are per-session, not shareable | §7 |

### 📦 Updated master ranking after pass 5

- **REMOVED from Tier 2:** Pass 2 #4 (session reuse) — DEAD per pass-5 cold-start data.
- **NEW Tier 1 entries:** A9 (CDP-level blocking — replaces just-shipped route handler), A10 (streaming PDP HTTP fetch), A11 (HEAD warmup at session boot).
- **VALIDATED but conditional:** Pre-create checkout sessions during dwell (only useful if B3 hardened buynow ships).

## Pass 6 findings — landed

### 🟢 Three real new wins

1. **Multi-context architecture (3.4× memory reduction empirically measured)**
   - Today: 5× `launchPersistentContext` = **4245MB / 45 processes**
   - Refactored: 1× `chromium.launch()` + 5× `browser.newContext()` = **1245MB / 12 processes**
   - Per-context cold-start: **327ms → 75ms (4.4× faster)** (pass 6's measurement; pass 5 reported 56ms on a smaller profile — both are right for their config)
   - **The biggest system-capacity win in any audit.** Doesn't change per-buy wall-clock once a session is up, but lets us run more profiles per machine and brings cold-start under 100ms.

2. **PDP `ProductInfo` cache across fan-out (~1.1s on 5-profile fan-outs, but tempered)**
   - Real BG queue data: **46% of jobs have ≥5 profiles created at the same moment with the same ASIN**.
   - Validates pass 2 #6 (multi-profile shared scrape).
   - **Tempered by pass-4's parser swap (A1):** after nhp, the savings shrink from full 2s to **~280ms per sibling** (each profile still needs `page.goto` for runtime visibility checks; cache only skips the parse).
   - Net: ~1.1s saved across a 5-profile fan-out, not 8s.

3. **Anti-bot driver parity fix (no per-buy saving, future-proofing)**
   - AmazonG's `driver.ts` lacks `--disable-blink-features=AutomationControlled` and the `Object.defineProperty(navigator, 'webdriver', {value: false})` stub that `chaseDriver.ts` already has.
   - Inconsistency worth fixing for resilience against future anti-bot heuristics.

### 🟢 CSRF reuse confirmed empirically

Three sequential `POST /cart/add-to-cart/` with the SAME `anti-csrftoken-a2z` all returned 200 + commit. **CSRF is session-scoped, not per-request consumed.**

**Implication:** Pass-3 #7 (`/lightsaber/csrf/aapi` refresh on 403) is **unnecessary** — a 403 on cart-add isn't from CSRF rotation. Document and skip.

### 🔴 Pass 6 rejects (added to dead list)

| Hypothesis | Why dead |
|---|---|
| `data.amazon.com` from Node.js (no CORS in Node) | Returns 503/415 — **auth-gated, not CORS-gated**. Theory wrong. |
| JSON-fragment endpoints as primary parser (`turbo-checkout-product-state`) | Blobs absent on OOS/pre-order PDPs; ~5ms saving when present. Useful as future fallback for resilience, not primary. |
| DNS prefetch hints | Image hosts already blocked by route filter |
| `world: 'utility'` for evaluates | DOM-bound reads, no benefit |
| Pass-3 #7 (CSRF refresh on 403) | CSRF reuse confirmed; 403s aren't from CSRF rotation |
| Speculative prefetch during /spc dwell | Place Order POST is 142 bytes — already trivial |

### 🟡 Edge-case PDP buynow stress (no NEW failure modes)

Tested: Subscribe & Save, multi-pack, used, age-restricted, international, pre-order, mandatory accessories. **None surface a new failure mode** beyond what AmazonG already handles via existing OOS / static-parser controls.

`turbo-checkout-product-state` JSON blob is interesting as a **future fallback** for resilience (when the static parser misses tokens), but not as primary path.

### 🟡 Selector batching — pass 2 #10 already captures the meaningful win

Inventory: only 4 `loc.count()` sites total; pass-2 #10's `findPlaceOrderLocator` consolidation already covers the biggest cluster. 17 `page.evaluate` sites in `buyNow.ts`, but most cluster savings are <100ms — below ship threshold.

### 📦 Updated master ranking after pass 6

- **NEW Tier 2:** B7 (multi-context refactor) — biggest system-capacity win.
- **NEW Tier 3:** C4 (anti-bot driver parity) — hygiene.
- **DEMOTED:** B2 (multi-profile shared scrape) — saving is ~280ms × (N−1) after parser swap, not 1.5s × (N−1).
- **REMOVED:** Pass-3 #7 / Tier 3 C1 (`/lightsaber/csrf/aapi`) — confirmed unnecessary; CSRF is session-scoped not per-request.

### 🏁 Final consolidated assessment after 6 passes

**The buy hot path for one profile is empirically at its floor for Amazon's current public surface.** Six passes consumed:

- Hidden-API hypothesis space: exhausted (mobile/app, GraphQL, brotli, hidden params, batch verify, CPE pre-warm, multi-item buynow, eligibleshipoption HTTP, `data.amazon.com` Node bypass — all dead)
- Per-buy wall-clock: ~3–6s of low-risk wins remain in Tier 1
- System-capacity: multi-context refactor (3.4× RSS) + multi-profile shared scrape (~280ms × siblings) + PDP cache (within-burst hits) — Tier 2

**Remaining areas where future-future research could find wins:**
- Amazon shipping a public multi-item buy API (out of our control)
- Anti-bot hardening enabling batch behaviors (out of scope)
- Major-version refactor: multi-context + persistent storage migration (Tier 4)
