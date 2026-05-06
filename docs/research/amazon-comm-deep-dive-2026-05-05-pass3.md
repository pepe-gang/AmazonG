# Amazon-comm deep dive — pass 3 — 2026-05-05

Third-pass speed audit of v0.13.14. Picks up after pass 2 shipped:
- Resource blocking via `context.route()` for image / font / media
- Telemetry + ad-system host blocklist (`fls-na`, `unagi`, `aax-us-iad`,
  `dtm`, `cs`, `aax.amazon-adsystem`)

This pass goes after the surface areas pass 1 + 2 didn't probe in
depth: mobile / app endpoints, GraphQL / WebSocket / SSE, hidden URL
parameters, batch verify, CPE warmup, /spc asset breakdown, one-click,
service worker behavior, HTTP/3, and worker-pool architecture. All
work below was empirically tested via Playwright MCP signed in as the
user's test account "Cuong" on 2026-05-05.

**No real orders were placed** — the buy-now bypass below required
posting a buy-now form to create a checkout session, which spins up
`/checkout/p/p-{id}/spc` but DOES NOT charge anything until Place
Order is clicked. The session expires unattended.

## TL;DR — top 3 NEW candidates by `expected_saving / risk`

| Rank | Candidate | Expected saving | Risk | Notes |
|---|---|---|---|---|
| 1 | **HTTP-only `/checkout/entry/buynow` POST replaces Buy Now click** | ~2-4s/buy in single-mode (no fan-out save), and removes a costly browser nav from the hot path | **Medium** | The `#buy-now-button` form on every PDP carries `formaction="/checkout/entry/buynow"` and ~30 hidden fields including the resolved `offerListingId`, `merchantID`, `customerVisiblePrice`, etc. POSTing this form via `ctx.request.post()` returns the /spc HTML directly in 2.4s with the new `/checkout/p/p-{id}` URL embedded. We then `page.goto(spcUrl)` (~1s, cookies warm) instead of paying the click + redirect chain. Verified live: a follow-up navigation to that purchase ID landed on a fully-rendered Place Order page. **The win is removing one full browser navigation from the buy hot path** + frees the visible tab to stay on the PDP through the buy-now POST (the window can scrape a NEW deal in parallel, see #2 below). The block-list-affected `eligibleshipoption` XHR fires on delivery option click only, not on first /spc load, so removing the click→/spc nav doesn't bypass an XHR we depend on. |
| 2 | **Extend route() blocklist with `unagi-na`, `aax-us-east-retail-direct`, `s.amazon-adsystem`, `pagead2.googlesyndication`, `ara.paa-reporting-advertising.amazon`, `d2lbyuknrhysf9.cloudfront.net`** + path-block in-page widgets (`/rufus/cl/*`, `/dram/renderLazyLoaded`, `/acp/cr-media-carousel/*`, `/cross_border_interstitial_sp/render`, `/rd/uedata`) | ~0.3-1s/PDP nav, ~0.2-0.5s/spc nav | **Low** | The current blocklist (`driver.ts:135`) catches `fls-na`, `unagi.amazon.com`, `aax-us-iad`, `dtm`, `cs`, `aax.amazon-adsystem`. Live PDP load (without AmazonG's blocklist) shows **6 additional 3p hosts firing 8 requests totalling ~1500ms** that AmazonG never reads: see "additional hosts to block" below. Plus, **Amazon serves Rufus AI chat XHRs** (`/rufus/cl/render`+`/rufus/cl/streaming`+`/rufus/cl/history`, total ~850ms) and a recommended-products lazy-load (`/dram/renderLazyLoaded`, 630ms) on every PDP. Path-blocking `/rufus/cl/*` and `/dram/renderLazyLoaded` saves ~1.5s/PDP. None of these endpoints feed the buy-box DOM nor `runtimeVisibilityChecks`. |
| 3 | **Bump UA to Chrome/147 + send Client Hints** (`Sec-CH-UA-Platform: "macOS"`, `Sec-CH-UA-Mobile: ?0`, `Sec-CH-UA-Full-Version-List`, `Device-Memory: 8`, `Viewport-Width: 1280`) | uncertain (likely 0.1-0.5s, more on first-fetch reduction) | Low-Med | Driver pins `Chrome/131.0.0.0` (`driver.ts:37`) — Chromium ships **Chrome/147** today (16 versions stale). Amazon's response headers explicitly request Client Hints via `accept-ch: ect,rtt,downlink,device-memory,sec-ch-device-memory,viewport-width,sec-ch-viewport-width,dpr,sec-ch-dpr,sec-ch-ua-full-version-list,viewport-height,sec-ch-viewport-height` with `accept-ch-lifetime: 86400`. Servers gated on stale UA may serve a different (slower) variant. Risk: anti-bot heuristics may flag the change. Mitigate: roll out to one profile first. |

Everything else this pass surfaced is smaller or rejected — see
sections 2-9. The 2 `Reject` items here that look attractive but
aren't:
- Mobile / app JSON APIs — **don't exist on amazon.com**.
- Pre-warming CPE — `/cpe/executions` returns 400/0-bytes without the
  Place Order context. Not pre-warmable.

## 2. Mobile API findings

### Endpoints probed (16 hosts × paths)

All return 404 HTML or CORS errors:

| URL | Result |
|---|---|
| `https://mapi.amazon.com/...` | TLS connection refused (CORS-block from amazon.com origin) |
| `https://api.amazon.com/` | TLS connection refused |
| `https://api.amazon.com/auth/o2/token` | 404 `<UnknownOperationException/>` (this is the developer auth API — not customer-scoped) |
| `https://mshop-amazon.com/...` | TLS refused |
| `https://m.amazon.com/dp/...` | TLS refused (modern mobile site is `www.amazon.com` w/ different UA) |
| `https://smile.amazon.com/...` | TLS refused (smile.amazon.com retired 2023) |
| `https://www.amazon.com/api/{cart, checkout, orders, your-orders, search, products, graphql}/...` | All HTML 404 |
| `https://www.amazon.com/cart/{api,api/cart,v1/cart}` | HTML 404 |
| `https://www.amazon.com/{checkout/api, checkout/api/cart}` | HTTP 500 with `<!-- To discuss automated access to Amazon data please contact api-services-support@amazon.com -->` boilerplate |
| `https://www.amazon.com/{your-orders/api, gp/your-orders/api/list}` | HTML 404 |
| `https://www.amazon.com/gp/your-orders/list?orderFilter=open` | HTML 404 |
| `https://www.amazon.com/gp/buy/spc/handlers/{display, static-submit-form, place-order-async, promise-validation, place-order-from-cart}.html` | All HTML 404 |
| `https://www.amazon.com/checkout/spc/place-order-async` | HTTP 500 |

### What the Amazon Shopping app uses

The native app uses a different architecture (`mss-shopping.amazon.com`,
`mw-shopping.amazon.com`, signed via SigV4 with bootstrap tokens
provisioned through a private app-attestation flow). **Not reachable
from a web origin** — those hosts return CORS errors / TLS refusals
from `amazon.com`-context fetches. Even if you spoof headers, you
lack the `x-amz-shopping-token` derived from the app's signing key.

The mobile-UA gambit (`User-Agent: Amazon/26.1.0 (iPhone; iOS 17.0; ...)`)
returned **the same desktop HTML** on every probe — Amazon does
content negotiation by URL (`/gp/aw/*` vs `/gp/*`) not by UA.

### What `/your-orders` actually returns

`https://www.amazon.com/your-orders/orders` returns a streaming HTML
response (`content-type: text/html;charset=UTF-8`, **not** the
`application/json-amazonui-streaming` reported in the first pass — that
header is set internally for some chunks but the wire content-type is
plain HTML). 826KB across ~1.8s. The user's account had 0 orders so
no rendered order count is observed; `?orderFilter=year-2024` /
`year-2025` / `archived` / `last30` all return the same shape.

**No JSON variant exists.** `?_format=json`, `?format=json`,
`?_xhr=1`, `?ajaxOnly=1` all silently ignored — the response is
identical 826KB HTML.

**Conclusion:** The mobile-API hypothesis is dead. Amazon's web
surface is HTML-only. Pass 1 already established this for cart /
order endpoints; this pass extends the proof to `/api/*`, `/aapi/*`,
`/lightsaber/*`, mobile-UA paths, and the alt-host attempts. **Stop
probing this surface.**

## 3. GraphQL / WebSocket / SSE findings

### GraphQL

- `/graphql`, `/api/graphql`, `/graphql/v1` → all HTML 404.
- `/cpe/yourpayments/wallet` returns 200 HTML (502KB) — that's the
  Wallet management page, not an API.

The service worker's source contains 59 string-literal references
to `graphql` / `gateway` / `aapi` (search `service-worker.js` for
those tokens). They're internal Lightsaber framework namespacing
**not customer-facing endpoints** — the actual gateway lives behind
`data.amazon.com` which is not CORS-accessible from `www.amazon.com`.

**Conclusion:** No GraphQL surface for AmazonG to use.

### WebSocket / SSE

- No `wss://` connections opened on PDP, /spc, or /your-orders
  (verified via `performance.getEntriesByType('resource')` and
  `WebSocket` global inspection).
- No `text/event-stream` content-types on any probed endpoint.
- The `/rufus/cl/streaming` XHR uses chunked HTTP (Rufus AI), but it's
  for the assistant chat — not a customer data feed.

**Conclusion:** Amazon doesn't use WS/SSE on the buy hot path. No
optimization opportunity.

## 4. Hidden parameters / bypass attempts

### Hidden URL params probed on PDPs

All return **identical 2.0MB HTML** to the bare URL:

| Param | Effect |
|---|---|
| `?one-click=1` | None |
| `?direct_buy=1` | None |
| `?bypass=payments` | None |
| `?ref_=ya_express` | None |
| `?light=1` | None |
| `?aod=1` | None — same body (would surface AOD slot if it differed; doesn't) |

### Hidden URL params on /spc

| Param | Effect |
|---|---|
| `?proceedToCheckout=1&one-click=1` | None |
| `?ref_=ya_express` | None |

### Header-based bypass attempts

| Header | Effect |
|---|---|
| `Accept: text/x-amazon-json` | Same HTML |
| `Accept: application/json` + `X-Requested-With: XMLHttpRequest` | Same HTML |
| `X-Amz-Rendering-Mode: json` | Same HTML / 404 |
| `Sec-CH-UA-Platform: "Android"` | Same HTML (no Lightsaber-mobile route) |
| `Accept-Encoding: br, gzip, deflate` | **Server still serves gzip only** — Amazon doesn't enable brotli on `www.amazon.com` |

### What DOES work (separate from the no-op params)

**`POST /checkout/entry/buynow`** — discovered as `formaction` on
the Buy Now button. Posting the standard PDP form fields directly to
this URL creates a checkout session and returns `/spc` HTML. See
[pass3 candidate #1](#tldr--top-3-new-candidates-by-expected_saving--risk).

**`POST /cart/add-to-cart/ref=...`** — already used by AmazonG.

**`GET /lightsaber/csrf/aapi`** — returns a fresh `anti-csrftoken-a2z`
in 149ms as `application/json;charset=UTF-8`. Useful only if a
downstream endpoint accepts a CSRF without other PDP-bound tokens
(it doesn't — cart-add needs `offerListingId` from the PDP).

## 5. Batch verify findings

### `/your-orders/orders` payload

Fetched live:
- 826KB HTML, ~1.8s response time.
- The HTML contains every order on the page (default ~10 orders);
  each order's block carries the orderID, ship-track links, status
  text, and item ASINs.

### Viability for batch verify

**In principle, yes.** A single fetch of `/your-orders/orders` could
yield N orders' active/cancelled/shipped status in one request, vs.
N separate `/gp/your-account/order-details?orderID=...` fetches
(currently ~2.1s each).

For a 5-profile fan-out where each profile's verifyOrder fires
independently, this would mean:
- Today: 5 × 2.1s = 10.5s parallel capacity. Wall-clock per
  fetchTracking job: 2.1s.
- Hypothetical batch: 1 × 1.8s = 1.8s. **Wall-clock saving of 0.3s
  per profile (small).**

**The math doesn't favor batching:**
1. Each profile has its OWN session/cookies; you can't fetch one
   account's `/your-orders` and learn another's status. Batching is
   per-account, not per-profile.
2. Within a single account, there are typically 1-3 active orders
   awaiting verify at any moment. The HTML payload is 826KB
   regardless. Net wall-clock per order: 1.8s ÷ N (where N is small).
   Versus 2.1s per single-order fetch — barely worth the parser
   complexity.
3. The existing `verifyOrder` (~2.1s) is faster than `/your-orders`
   (~1.8s). Win is at most 0.3s/order, breaks even at N=1.

**Reject** for now. Worth revisiting if user accounts ever fan out
to >5 active orders simultaneously per profile (rare with the buying
group cadence).

## 6. One-click / fast-paths

### Account state

The signed-in account does NOT expose a 1-click button on the PDP
(`#buy-now-button` is the standard "Buy Now" through SPC, not the
legacy 1-click). The form's `usePrimeHandler=0` and the lack of any
`#turbo-checkout-form` confirm this. Even if 1-click were enabled,
modern Amazon routes 1-click through the same SPC + CPE flow — the
old "skip /spc rendering" 1-click bypass is gone.

### What the Buy Now form DOES expose (and we're not using)

The `#buy-now-button` button has `formaction="/checkout/entry/buynow"`
embedded in the input itself (overrides parent `<form action>`). The
form is the same one used for both Add to Cart and Buy Now — the
submit button picks the action. Field inventory (verified live):

```
anti-csrftoken-a2z              (104 chars, fresh per PDP load)
items[0.base][customerVisiblePrice][amount]    ($4.29)
items[0.base][customerVisiblePrice][currencyCode]  (USD)
items[0.base][customerVisiblePrice][displayString]  ($4.29)
items[0.base][asin]             (B0F1XYMY7G)
items[0.base][offerListingId]   (encoded ~210 chars)
items[0.base][quantity]         (1)
clientName                      (OffersX_OfferDisplay_DetailPage)
pageLoadTimestampUTC            (ISO timestamp)
session-id                      (147-1303082-...)
ASIN, merchantID, sellingCustomerID, isMerchantExclusive, isAddon,
nodeID, qid, sr, storeID, tagActionCode, viewID, rebateId,
ctaDeviceType, ctaPageType, usePrimeHandler, smokeTestEnabled, rsid,
sourceCustomerOrgListID, sourceCustomerOrgListItemID, wlPopCommand,
pipelineType (=Chewbacca), referrer (=detail), isBuyNow (=1),
isEligibilityLogicDisabled (=1), ref_, sessionID, customerID
```

**Live POST result** (single $4.29 ASIN, no order placed):
- `POST /checkout/entry/buynow` → 200 OK
- Response: 318KB /spc HTML, 2.36s
- Embedded URL: `/checkout/p/p-106-8591021-0233859`
- Subsequent `GET /checkout/p/p-{id}/spc` → 200 OK in 980ms with
  the Place Your Order button present.
- Browser nav to that URL with `page.goto()` → fully-rendered SPC
  with `input#placeOrder` and the standard CSRF.

This is the basis for [pass3 candidate #1](#tldr--top-3-new-candidates-by-expected_saving--risk).

## 7. Service worker / HTTP optimizations

### Service worker

**`https://www.amazon.com/service-worker.js`** is registered on every
www.amazon.com session, scope `/`. Source is 625KB minified
(`Lightsaber` framework — Amazon's internal page-rendering /
prewarming engine).

Caches present after a few page loads:
- `LightsaberRenderingHintsDelegateV1` (0 entries)
- `LightsaberRenderingHintsAsinAttributesV1` (0 entries)
- `LightsaberPageShellV3` (0 entries)
- `LightsaberCachedPageV1` (0 entries)
- `LightsaberCompareCopyV1` (0 entries)
- **`checkout-prefetch` (1 entry)** — 204KB encrypted base64-like
  payload at `/checkout-prefetch/{uuid}`. Opaque to us.

Service worker has 2 `addEventListener("fetch", …)` registrations.
The Lightsaber framework intercepts navigation requests, sometimes
serving cached prewarms.

**`navigationPreload`: enabled** (verified via
`reg.navigationPreload.getState()`). `workerStart: 1ms` on every
nav — the SW intercepts but nav-preload runs in parallel, so we
don't pay extra latency.

### HTTP/3 (QUIC) support

Amazon advertises HTTP/3 via `alt-svc: h3=":443"; ma=86400` on every
response. CDN: CloudFront (`via: 1.1 ...cloudfront.net`).

- m.media-amazon.com (asset CDN): mix of h2 / h3 in resource timing
  (about 30% h3 once warmed).
- www.amazon.com: served h2 in current testing.

Playwright's bundled Chromium opts in to h3 by default once alt-svc
is cached. Currently the AmazonG launch is fresh per profile, so
alt-svc cache is empty on each launch — every request hits h2 first.
**One-time pre-warm to amazon.com on session boot would populate
alt-svc** so subsequent requests can negotiate h3.

But: pass2's [#5](#) (pre-warm sessions) was rejected as marginal.
The h3 opt-in is a partial reason to revisit, but the gain is small
(≤200ms per request × ~6 requests/buy = 1.2s upper bound, more like
0.3-0.5s realistic).

### Cookie size

Total `document.cookie` length on the signed-in PDP: **1180 chars**
across 11 cookies. Already small. No optimization opportunity.

### Compression

**Amazon serves only gzip on www.amazon.com.** Asking for brotli is
ignored. No optimization opportunity.

### Content Security Policy

Amazon's CSP is permissive (`default-src 'self' blob: https: data: …
'unsafe-inline'`) — no constraint on what we can fetch from www.

## 8. Optimistic loading viability

### `page.goto(/spc)` BEFORE the cart-add returns

Tested: fire `page.goto(/checkout/entry/cart?proceedToCheckout=1)`
**before** the cart-add POST completes. Amazon's response: empty
cart → meta-refresh to `/checkout/entry/oos`. **Confirmed not
viable.** /spc reads cart at request time; you must beat it after
the cart-add returns 200, not before.

### Pre-issue verify GET while CPE is mid-flight

The verify endpoint (`/gp/your-account/order-details?orderID=...`)
needs the orderID, which is only available **after** the
`/gp/buy/thankyou/handlers/display.html` page renders post-Place
Order. So the verify GET can't be pre-issued during CPE — there's
nothing to verify yet. **Reject.**

### Pre-launch a SECOND profile's session while the first is in /spc

This is just the existing pMap fan-out concurrency. Already covered
by `parallelism.concurrency` setting (default 3 per pass2 #7).

### Speculative `/checkout/entry/buynow` POST overlapping with PDP scrape

**THIS is interesting.** With the buy-now POST now an HTTP-only
operation (pass3 #1), it can run **in parallel with** `scrapeProduct`
once we have the PDP HTML in hand:

```
t=0   : page.goto(PDP)               [1.5-2s nav]
t=2s  : page.content() captured →
        kick off ctx.request.post(/checkout/entry/buynow)  [HTTP, ~2.4s]
        AND runtimeVisibilityChecks(page)                  [browser, ~0.3s]
t=2.4s: runtime checks done, parser results reconciled
t=4.4s: buynow POST returns /spc HTML, parse purchaseId
        page.goto(spcUrl)                                  [browser, ~1s]
t=5.4s: on /spc, ready to verify cashback / address
```

Vs. today's serial:
```
t=0   : page.goto(PDP)            [2s]
t=2s  : runtime checks            [0.3s]
t=2.3s: clearCart fire-and-forget [~1s parallel; for filler mode]
t=2.3s: cart-add (filler mode) OR click Buy Now (single mode) [~2s]
t=4.3s: page nav to /spc (browser nav after Buy Now click)    [~2s]
t=6.3s: on /spc
```

**Net saving for single-mode: ~1s** (the click + browser nav is
replaced with HTTP POST + `page.goto`). This is in addition to the
parallelism-with-scrape gain.

**Risk:** what if the user wants the live `runtimeVisibilityChecks`
to FAIL the buy (e.g., not Prime, no Buy Now button)? Then the
buynow POST has already created a checkout session but no order is
placed — same risk as the existing flow that clicks Buy Now and then
discovers a problem on /spc. The session expires on its own; no
charge until Place Order.

## 9. Custom flags + worker pool ideas

### Custom Chromium flags currently set (`driver.ts:38-42`)

```
--disable-features=WebAuthenticationPasskeys,PasskeyAutofill,
                   PasskeyFromAnotherDevice,WebAuthenticationConditionalUI
```

### Recommendations

| Flag | What it does | Recommend? |
|---|---|---|
| `--disable-blink-features=AutomationControlled` | Hides `navigator.webdriver` | YES — currently unset, low risk; minor anti-detection bonus |
| `--disable-features=Translate` | Disables Chrome's translate prompt | YES — never wanted in worker |
| `--disable-features=site-per-process` | Single process for cross-origin frames; saves memory | **Risky** — anti-fingerprinting tools detect this; some Amazon iframes (like nav-footer ad) may break. Skip. |
| `--disable-extensions` + `--disable-component-extensions-with-background-pages` | Skip extension loading | YES — persistent context shouldn't load any |
| `--disable-renderer-backgrounding` + `--disable-background-timer-throttling` | Don't pause headless tabs when off-screen | YES — relevant in headless mode; makes parallel fan-outs more deterministic |
| `--no-zygote` | Use 1 process model | DON'T — known to break Electron |
| `--no-sandbox` | Disable Chromium sandbox | DON'T — security risk, no perf gain on macOS |
| `--disable-features=AutomationControlled` | Different from blink-features above; same effect via Chrome | Maybe — duplicate of `--disable-blink-features` |

### Worker pool model

**Today (`driver.ts:33-43`): one `chromium.launchPersistentContext`
per profile.** Each profile = one Chromium process. For N=5 profiles
= 5 separate Chromium processes, each with its own renderer subtree.

**Memory cost:** ~250-400MB per process on M-series Macs (verified
empirically in pass2 — anecdotal). 5 profiles = 1.5-2GB. The
auto-update banner that pops up after each release retreats workers
end-to-end so this RAM is hot at peak buy times.

**Alternative: one Chromium, N persistent contexts via
`browser.newContext({ storageState: 'profile-N.json' })`.** Single
Chromium process, N renderer processes (still separated for security,
but 1 zygote / 1 GPU / 1 utility process shared across all 5).

**Saving estimate:** ~30-40% memory reduction. **NOT a wall-clock
speedup** — the renderer per profile still runs independently. But
it makes parallel fan-out more headroom-friendly.

**Risk:** Persistent storage today writes to per-profile
`~/Library/Application Support/AmazonG/profiles/{email}/Default/...`.
Switching to `browser.newContext({ storageState })` requires
re-architecting the cookie + storage persistence. Big refactor for
modest win. **Defer to a later major version.**

## 10. Final punch list — NEW candidates only

| # | Candidate | File:line | Win/buy | Risk | Notes |
|---|---|---|---|---|---|
| **A. The big one** ||||||
| 1 | Replace Buy Now click with `ctx.request.post('/checkout/entry/buynow')` then `page.goto(spcUrl)` | `buyNow.ts:165-171` (single-mode buy click), and as the new tier-2 fallback in `buyWithFillers.ts:483-507` | ~2-4s/buy in single-mode + parallelism with scrape | Med | New endpoint not previously documented in `amazon-pipeline.md`. The buy-now form has `formaction="/checkout/entry/buynow"`. POST returns 318KB /spc HTML. Implementation: build the form body from PDP HTML (~30 fields, all DOM-readable), POST, parse the `/checkout/p/p-XXX` URL, `page.goto` to it. Verified end-to-end: post → 200 (2.4s) → fetch landing page (980ms) → on /spc with Place Order ready. **Critical:** preserve a fallback to the click flow (today's behavior) so PDP variants without the buy-now form (some marketplace listings) still work. |
| **B. Extend route() blocklist** ||||||
| 2 | Add hosts to BLOCKED_HOSTS regex | `driver.ts:135` | ~0.3-0.5s/PDP | Low | Add `unagi-na`, `aax-us-east-retail-direct`, `s\.amazon-adsystem\.com$`, `pagead2\.googlesyndication\.com$`, `ara\.paa-reporting-advertising\.amazon$`, `d2lbyuknrhysf9\.cloudfront\.net$`. These are ad / telemetry hosts firing on every PDP that AmazonG never reads. Live counts: `unagi-na` = 4 reqs (369ms longest), `aax-us-east-retail-direct` = 2 reqs, `s.amazon-adsystem.com` = 1 iframe (553ms), `d2lbyuknrhysf9` = 1 (SFXInjectableScript, 92ms). |
| 3 | Path-block in-page widgets we never read | `driver.ts:141` (route handler) | ~1-1.5s/PDP | Low-Med | Add path-based abort for `^https://www\.amazon\.com/(rufus/cl/|dram/renderLazyLoaded\b|acp/cr-media-carousel/|cross_border_interstitial_sp/render\b|rd/uedata\b|tt/i\b)`. **Risk caveat:** `/rd/uedata` is Amazon's CSM telemetry — blocking it on a long-lived session may invite anti-bot heuristics. Mitigate with periodic allowing of /rd/uedata (e.g., 1 in 10). Cleaner alternative: only block the larger ones (Rufus + dram + cr-media-carousel + cross_border_interstitial; leave /rd/uedata alone). Saves ~1.2s; less risk. |
| **C. UA + Client Hints** ||||||
| 4 | Bump UA to current Chrome (147 today) and let Playwright auto-fill Client Hints | `driver.ts:36-37` | uncertain ~0.1-0.5s/req | Low-Med | Currently pinned to `Chrome/131`. Chromium ships `Chrome/147`. Amazon advertises `accept-ch: …, sec-ch-ua-full-version-list, …` — servers may key cache slices on these. **Implementation:** drop the explicit UA and let Playwright use its default (matches the bundled Chromium version). **Risk:** anti-bot fingerprinting may flag UA mismatches. Mitigate with one-profile rollout. |
| **D. Misc opportunistic** ||||||
| 5 | Add `--disable-blink-features=AutomationControlled --disable-features=Translate --disable-extensions --disable-renderer-backgrounding` to launch args | `driver.ts:38-42` | <100ms total, anti-detection benefit | Low | All standard hardening + perf flags for headless Chromium worker frameworks. None break Electron. |
| 6 | Pre-warm alt-svc cache by hitting `/` once at session boot for HTTP/3 negotiation on subsequent requests | `driver.ts` (after `launchPersistentContext`) | ~0.2-0.5s/buy on second+ request | Low | Reduces TLS handshake on per-request basis. Combined with session reuse (pass2 #4) makes a stronger combined case. Not worth on its own. |
| 7 | Use `ctx.request.get('/lightsaber/csrf/aapi')` to refresh CSRF before a stale-CSRF retry | `buyWithFillers.ts` (cart-add retry path) | ~0.5-1s on cart-add 403 retries (rare) | Low | Today a 403 from cart-add forces a full PDP re-fetch (~1.8s) to harvest a fresh CSRF. The `/lightsaber/csrf/aapi` endpoint returns a fresh token in 149ms. Cheap belt-and-suspenders for the rare CSRF rotation case. **But:** the token returned is page-scoped (it works for `/cart/add-to-cart/...` based on the `aapi` namespace), not always interchangeable with the PDP-form CSRF. Needs a live CSRF-rotation regression test before relying on this. |
| 8 | Drop `--disable-features=WebAuthenticationPasskeys,…` block in headless mode | `driver.ts:38-42` | 0 — same | n/a | The flag is a no-op when `headless=true` (no UI to surface a passkey dialog). Cosmetic; no perf impact. |

## 11. Honest assessment

The two big-ticket items pass 1+2 missed are:

1. **`POST /checkout/entry/buynow` as a click-bypass for single-mode
   buys.** This is genuinely new — pass 1 confirmed `/spc/place-order`
   wasn't postable directly because of CPE, and concluded "you can't
   skip the browser." That's still true for THE Place Order itself,
   but it overlooked the **earlier** browser nav (the Buy Now
   click → /spc redirect). That earlier nav IS HTTP-skippable. The
   form's `formaction="/checkout/entry/buynow"` was hiding in plain
   sight. Win: ~2-4s/buy in single-mode + the option to parallelize
   with PDP scrape.

2. **The blocklist extension** (`unagi-na`, several ad systems, and
   path-blocking the Rufus AI / dram / cross-border-interstitial
   widgets). Pass 2 introduced the blocklist concept; this pass
   identifies the residual 3p / in-page noise that pass 2 didn't
   enumerate. Win: ~0.5-1.5s/PDP.

After those, the surface is genuinely thin:
- **Mobile / app APIs:** Definitely don't exist on amazon.com. Stop probing.
- **GraphQL / WS / SSE:** Don't exist on the buy hot path.
- **CPE pre-warming:** Confirmed not possible (`/cpe/executions`
  returns 400/0-bytes without context).
- **Hidden URL params:** All no-ops.
- **Brotli compression:** Amazon doesn't serve it.
- **Service worker leveraging:** Only useful for second-nav same-URL,
  which AmazonG doesn't typically do.
- **Worker-pool refactor (one chromium, N contexts):** Memory win,
  not wall-clock. Big refactor. Defer.

**My honest read:** after passes 1 + 2 + the resource blocking that
shipped, the only ~5-second-class wins left are:
- Pass2's session reuse (#4) — still unshipped per the user
- Pass2's verifyOrder-shared-fetch (#13) — still unshipped per the user
- Pass2's multi-profile shared scrape (#6) — still unshipped per the user
- **Pass3's #1 — buy-now HTTP bypass** — new; ~2-4s/buy, single-mode

After those four, the buy hot path is genuinely at its empirical
floor for Amazon's current public surface. Further wins require:
- Amazon shipping a new public API (out of our control).
- Anti-detection hardening to enable batch-place-order behaviors that
  would today trip rate limits (out of scope for speed work).
- The worker-pool refactor + session reuse combo for system-level
  capacity (separate concern).

**Recommendation: ship pass3 #1 (HTTP buy-now), pass3 #2 (blocklist
extension), and pass3 #3 (path-blocking Rufus/dram/cross-border).**
That's ~3-6s/buy + ~0.5-1.5s/PDP nav for low-medium risk. Skip
pass3 #4 (UA bump) until anti-bot regression-tested separately.
Skip pass3 #5-8 unless adjacent work touches the same files.

The "we're at the floor" conclusion from passes 1+2 holds, but the
actual floor is one buy-now HTTP call lower than they thought.
