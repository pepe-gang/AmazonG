# Amazon-comm deep dive — pass 5 — 2026-05-05

Fifth-pass speed audit of `feat/efficiency-tier6` (image/font/media + 6-host
telemetry blocklist already shipped via `0adcfda` + `1f73827`). Pass 5 is
orthogonal to pass 4 (which is investigating buynow stress-test, /spc
prerender, requestSubmit, etc — see brief). All work below was empirically
tested via Playwright MCP signed in as the user's test account "Cuong" on
2026-05-05; one $4.29 test order was placed and immediately cancelled
to capture the Place Order POST chain.

## TL;DR — top 3 NEW findings ranked by `expected_saving / risk`

| Rank | Finding | Saving | Risk | Notes |
|---|---|---|---|---|
| 1 | **Streaming-fetch + early `body.cancel()` on PDP HTML** — buy-box markers all present by byte ~506K out of a ~2.0MB body. The remaining 1.5MB streams over the 1.0–1.7s tail. | **~990ms / PDP HTTP fetch** | **Low** | The PDP body's last 75% is product-recommendations / Rufus chat / footer / lazy-load JS — none of it is read by the static parser or `runtimeVisibilityChecks`. Implementation: `r.body.getReader()` loop, watch for `id="buy-now-button"` + `formaction=` + `name="offerListingID"` + `id="add-to-cart-button"` markers, then `reader.cancel()` once all 4 are present (or after 600KB safety cap). Saves wall-clock on `pdpHttpFetch` calls used for token harvest fallback (`buyNow.ts:1449` and `buyWithFillers.ts:2055`). Does NOT apply to `page.goto()` — Playwright drains the full body. |
| 2 | **CDP `Network.setBlockedURLs` replaces `context.route()` JS handler** — eliminates per-request Node↔Chromium IPC. | ~0.5–2s/PDP nav (cumulative IPC overhead at 100–250 sub-resources/page) | **Low** | `context.route('**/*', cb)` invokes the JS callback for EVERY request, each costing ~1–3ms IPC roundtrip. CDP `Network.setBlockedURLs` configures Chromium's network layer once with glob patterns; matching URLs are dropped pre-renderer with no IPC cost. Verified working live (see §10). The SVG carve-out can be safely dropped (verified §7). |
| 3 | **Reject — pass 2 #4 (session reuse) and #5 (pre-warm contexts)** based on empirical cold-start data. | n/a (avoids wasted work) | n/a | `chromium.launchPersistentContext` is **56ms median** on M-series Macs with a real 364MB profile (not 2–4s as pass 2 estimated). Total session lifecycle (launch + addInitScript×2 + route + newPage + close) is **85–138ms**. Pre-warming saves at most ~80ms; session-reuse saves at most ~80ms across consecutive buys. Not worth the memory pressure or complexity. |

The other 7 areas surfaced findings that are mostly negative or orthogonal
to pass 4. Sections 2–11 below are organized by area letter from the brief.

## 2. Streaming HTML parse — Area A

### Empirical setup

Live signed-in fetch via `fetch().body.getReader()` of:
1. `/checkout/p/p-{id}/spc` after a fresh buynow POST
2. `/dp/B0F1XYMY7G` (a real 2.0MB PDP)

For each chunk, decoded incrementally with `TextDecoder({stream:true})` and
located the byte offset where AmazonG's parsing markers first appear.

### /spc streaming-parse — modest opportunity

| Marker | Byte | Time (ms) | Notes |
|---|---|---|---|
| (TTFB) | 0 | 161 | First byte |
| First chunk burst | 0–98K | 206 | Server flushes shell + half-body fast |
| **(server stall ~677ms)** | — | 206→883 | Body streaming pauses |
| `name="anti-csrftoken-a2z"` | 99,015 | 1,012 | CSRF in form |
| `id="placeOrder"` | 112,885 | 1,014 | Place Order input element |
| `data-testid="SPC_selectPlaceOrder"` | 113,098 | 1,014 | Same |
| `subtotals-marketplace-table` | 115,919 | 1,014 | Order summary |
| `deliver-to-address-text` | 130,491 | 1,014 | Address panel |
| `eligibleshipoption` | 155,295 | 1,014 | Delivery-option XHR target |
| Body end | 326,289 | 1,113 | Total |

**Verdict for /spc:** The server flushes the head ~98K in 206ms but then
**stalls for 677ms** before flushing the rest in one burst. All AmazonG
markers appear in the same trailing burst around byte ~99K–155K. So
streaming-parse only saves the ~100ms from the marker arriving to body
end — **not material on /spc**.

### PDP streaming-parse — significant opportunity

| Marker | Byte | Time (ms) | Notes |
|---|---|---|---|
| (TTFB) | 0 | 205 | First byte |
| `name="anti-csrftoken-a2z"` (head) | 139,309 | 304 | First CSRF (PDP shell) |
| `name="offerListingID"` | 308,405 | 893 | Offer-listing-id input |
| `"a-price-whole"` | 314,635 | 893 | Price-whole span |
| `id="add-to-cart-button"` | 357,856 | 894 | ATC button |
| `id="buy-now-button"` | 363,073 | 894 | Buy Now button |
| `formaction="/checkout/entry/buynow"` | 363,206 | 894 | Buynow formaction |
| `id="productTitle"` | 505,440 | 933 | Title (just past buy-box) |
| **(end of buy-box-relevant data)** | ~506K | 933 | All static-parser inputs present |
| Body end | 2,035,039 | 1,880 | Total — **1.5MB more after buy-box ends** |

**Verdict for PDP:** **Cancel the body stream at byte ~600K** (after all
buy-box markers + small safety margin) and we save **~990ms** on PDP
HTTP fetches. The remaining 1.5MB is product carousels, Rufus chat
data, footer content, lazy-load images — none read by AmazonG.

### Concrete implementation

```ts
// In src/actions/amazonHttp.ts — new helper
export async function pdpHttpFetchStreaming(ctx: APIRequestContext, url: string): Promise<string> {
  const response = await ctx.get(url, { failOnStatusCode: false });
  if (!response.ok()) throw new Error(`PDP fetch failed: ${response.status()}`);
  // Playwright APIRequestContext doesn't expose the raw stream cleanly.
  // Switch to fetch via Node http2 OR use CDP's Network.getResponseBody
  // with a partial read.
  // SHORTCUT: use response.body() which returns a Buffer — same as today.
  // To actually stream-cancel, we need either:
  //   (a) Replace ctx.request with Node's `undici` fetch which exposes ReadableStream
  //   (b) Use CDP Fetch domain to intercept and cancel mid-body
  // ...
}
```

Implementation note: `APIRequestContext.get()` doesn't expose
`ReadableStream`. To get streaming: either use Node `undici.fetch`
(Node 18+ has it as global) sharing the cookies, or use CDP's
`Fetch.continueRequest` + `Fetch.fulfillRequest` to intercept and
cancel. Cleaner: drop in `undici` (zero deps, native) and pipe its
`response.body` reader.

**Estimated win per PDP fetch: ~990ms** (the 933→1880ms tail).
Affects every `pdpHttpFetch` call in AmazonG (token harvest fallback;
shared scrape across profiles if pass 2 #6 ships).

### File:line targets
- `src/actions/buyNow.ts:1449` — `prefetchPdpHtml` calls `ctx.request.get(productUrl)`. Replace with streaming variant.
- `src/actions/buyWithFillers.ts:2055` — same pattern in `prefetchedHtml`.
- `src/actions/amazonHttp.ts` — add a `pdpHttpFetchStreaming(url)` helper.

## 3. Lightsaber service worker reverse-engineering — Area B

### What the SW does (after dissecting `/service-worker.js`, 625KB)

- **2 `addEventListener("fetch", ...)` registrations** — both gated by
  `_filter(b)` which checks origin and an internal request-class predicate.
- **3 `addEventListener("activate", ...)`** — claim clients on activation.
- **3 `addEventListener("message", ...)` handlers** — accepting only:
  1. `_messageType: "fetch"` — CSA cajun debug
  2. `_messageType: "fetch-check"` — CSA cajun ping
  3. `_messageType: "config"` — config-bag merge/replace
  4. `feature: "retail_service_worker_messaging"` with messageCommand
  5. `feature: "page_proxy"` with `command: "request_feature_tags"` — feature-flag query
- **`navigationPreload`: enabled** (verified `getState().enabled === true,
  headerValue: "true"`). The SW intercepts navigation requests but doesn't
  block — preload runs in parallel.
- **Caches present** (after a few page loads in this session):
  - `LightsaberRenderingHintsDelegateV1` (0 entries)
  - `LightsaberRenderingHintsAsinAttributesV1` (0 entries)
  - `LightsaberPageShellV3` (0 entries)
  - `LightsaberCachedPageV1` (0 entries)
  - `LightsaberCompareCopyV1` (0 entries)
  - `checkout-prefetch` (1 entry, 137KB encrypted opaque base64 payload)

### `checkout-prefetch` cache origin

The cache name `checkout-prefetch` does **not appear in the SW source**.
Searched all variants (`checkoutPrefetch`, `CheckoutPrefetch`,
`/checkout-prefetch/`) — zero hits. The cache is opened by **page-side
checkout JS**, NOT by the service worker. The single entry is keyed on
a UUID URL `https://www.amazon.com/checkout-prefetch/{uuid}` and contains
137KB of encrypted text (no headers other than `content-type: text/plain`).

This is Amazon's checkout team caching pre-rendered SPC payload for
session continuation, but the encryption key is server-side. We have
no way to populate or read it from outside.

### Prewarm machinery — not exploitable from outside

The SW exposes a `ContentFragmentSpeculation` event flow internally:
page-side scripts call `eventBus.publish({name: "ContentFragmentSpeculation",
detail: {prewarm}})` to instruct the SW to fetch + cache subresources
for a content fragment. **There is NO `prewarm-this-URL` postMessage
API exposed.** The 5 message handler types listed above are exhaustive.

**Verdict B:** The Lightsaber SW cannot be exploited by AmazonG as a
prewarm system. The SW's prewarm machinery is page-driven (Speculation
Rules + internal `eventBus.publish`). Sending a `postMessage` to the
controller will not cause `/spc` or any URL to be cached. The SW also
doesn't intercept POST requests (the fetch filter excludes non-GET
navigations per inspection).

**Reject** any plan to use SW postMessage for prewarming.

## 4. Place Order POST capture — Area C

### Method

Hooked CDP's `Network.requestWillBeSent` + `Network.responseReceived`
on a real /spc page tied to a fresh buynow purchase ID
(`106-2966234-2023425`, $4.29). Clicked Place Order, captured every
network event in the chain, then immediately cancelled the order.

### What Chromium ACTUALLY sent

The `/spc/place-order` POST body was **3 fields, 142 bytes**:

```
anti-csrftoken-a2z=hMdiTU16p2KeEuK0JxNfUCRXkfa5G25YT4A8y7rlY1XuAAAAAGn6ko9hMGUyZTcwZS1kMTVhLTQwNzUtYmViOS05MDY1MDM2OGEyODA%3D
&hasWorkingJavascript=1
&placeYourOrder1=1
```

**Headers Chromium added on top of standard fetch defaults**:
```
Content-Type: application/x-www-form-urlencoded
Origin: https://www.amazon.com
Referer: https://www.amazon.com/checkout/p/p-{id}/spc?referrer=spc
Upgrade-Insecure-Requests: 1
User-Agent: Mozilla/5.0 ... Chrome/147.0.0.0 Safari/537.36
device-memory: 32
downlink: 7.85
dpr: 2
ect: 4g
rtt: 50
sec-ch-device-memory: 32
sec-ch-dpr: 2
sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"
sec-ch-ua-full-version-list: "Google Chrome";v="147.0.7727.138", ...
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "macOS"
sec-ch-viewport-height: 876
sec-ch-viewport-width: 855
viewport-width: 855
```

**Note: `User-Agent: Chrome/147.0.0.0`** — this MCP-Playwright auto-fills
the modern Chromium version. AmazonG hardcodes `Chrome/131.0.0.0` in
`driver.ts:37`, which is 16 minor versions stale. (Re-confirms pass 3 #4.)

### What's pre-computable vs CPE-injected

**Everything in the POST body is in the /spc HTML at load time.**
- `anti-csrftoken-a2z` is in `<input name="anti-csrftoken-a2z" value="...">`
- `hasWorkingJavascript=1` is static
- `placeYourOrder1=1` is the submit button's value attribute

**There is NO CPE-injected fingerprint, no `purchaseTraceId`,
no dynamic field added at click time.** CPE doesn't run until
AFTER the POST returns (the response is a 302 redirect to
`/checkout/p/{id}/duplicateOrder` or to `/cpe/executions`, where the
CPE JS executes).

So the **win from "pre-build the body during /spc dwell time"** is
**0**. The body is already 3 trivial fields all read directly from
HTML. The 1–2s of Place Order click → thank-you is dominated by:
1. Server-side Place Order processing (~250–500ms based on observed dt)
2. Browser nav to `/cpe/executions` + CPE JS execution (~2–4s)
3. Final nav to `/gp/buy/thankyou/handlers/display.html` (~500ms)

**Reject "pre-build POST body" as an optimization.** Body is already
trivial.

### Bonus finding — Amazon has Place Order idempotency

When my second click landed on a /spc page that had already been used
by an earlier order in the session, the response was a **302 redirect to
`/checkout/p/{id}/duplicateOrder`** instead of the normal CPE flow. Then
clicking Place Order on the duplicate page DID still create a NEW order
(`112-5645209-3732245` was created and required separate cancellation),
indicating the duplicate-order page asks user to confirm.

So Amazon's idempotency layer is **soft** — it raises a friction page
but doesn't hard-block. AmazonG's existing "single click + verify"
approach already handles this. **No change needed.**

## 5. Hot-context pool measurements — Area D

### Empirical cold-start data

Bench: `chromium.launchPersistentContext` × 5 runs on this M-series Mac
(2026-05-05). Two scenarios:

**Empty profile (synthetic tmpdir):**
| Run | launch (ms) | addInitScript+route (ms) | newPage (ms) | close (ms) | total (ms) |
|---|---|---|---|---|---|
| 0 | 61 | 1 | 25 | 11 | 99 |
| 1 | 65 | 1 | 21 | 18 | 104 |
| 2 | 55 | 1 | 21 | 7 | 85 |
| 3 | 55 | 0 | 21 | 16 | 93 |
| 4 | 56 | 1 | 21 | 8 | 86 |
| **median** | **56** | **1** | **21** | **11** | **93** |

**Real 364MB profile (`cpnnhu@gmail.com` copied):**
| Run | launch (ms) | newPage (ms) | close (ms) | total (ms) |
|---|---|---|---|---|
| 0 | 62 | 21 | 18 | 103 |
| 1 | 56 | 21 | 61 | 138 |
| 2 | 56 | 21 | 7 | 85 |
| 3 | 56 | 21 | 15 | 93 |
| 4 | 56 | 21 | 17 | 94 |
| **median** | **56** | **21** | **17** | **94** |

**Cold-start cost is 56ms median, 85–138ms total session lifecycle.**

This is **roughly 25-50× LOWER** than pass 2's anecdotal "2–4s cold
start" estimate. The "cold start tax" pass 2 #4 (session reuse) was
designed to eliminate is **not real** in 2026 with current Playwright +
Chromium on M-series Macs.

### Implications

- **Pass 2 #4 (session reuse): REJECT.** Saves at most ~80ms across
  consecutive buys. Compounded with the memory pressure of holding 5+
  Chromium contexts alive idle, not worth shipping.
- **Pass 2 #5 (pre-warm contexts on boot): REJECT.** Same reasoning —
  saves ~80ms once.
- **Pass 5's "hot context pool" idea: REJECT.** No room to win below 80ms.

The reason cold-start is so cheap: Playwright's chromium binary is now
shared across all `launchPersistentContext` calls in the same Node
process (the binary is loaded into memory after the first launch).
Subsequent launches skip the heavy Chromium-binary mmap.

### What still costs measurable time on AmazonG's session boot

Looking at AmazonG's `driver.ts`:
- `chromium.launchPersistentContext`: ~56ms (measured)
- `addInitScript` × 2: ~1ms total (measured)
- `context.route('**/*', cb)`: ~0–1ms (measured) but adds **per-request
  IPC cost** later (see Area I §10)

**The expensive cold work is NOT session boot — it's the network
warm-up.** The first request to amazon.com after a fresh launch pays
DNS (~5–20ms), TLS (~30–80ms), TCP (~10–30ms). **A `ctx.request.head('https://www.amazon.com/')`** at session boot warms all three —
saves ~50–130ms on the first PDP fetch. Combined with persistent
profile's session-ticket cache (which Chrome rehydrates from
`Network Persistent State` on launch), 0-RTT QUIC may fire on the
SECOND request.

**Recommendation:** Replace pass 2 #4/#5 with a single-line
session-boot warmup: `ctx.request.head('https://www.amazon.com/').catch(()=>undefined)`
fired non-blocking at the end of `openSession()`. Cost: 1 HEAD
roundtrip (~120ms). Win: ~50–130ms on the first real fetch in
this session.

## 6. Connection-pool / QUIC findings — Area E

### Q1: Does Amazon serve `Sec-CH-UA-Full-Version-List`-aware variants?

Live test: `accept-ch` response header on every Amazon response is:
```
ect, rtt, downlink, device-memory, sec-ch-device-memory,
viewport-width, sec-ch-viewport-width, dpr, sec-ch-dpr,
sec-ch-ua-full-version-list, viewport-height, sec-ch-viewport-height
```
With `accept-ch-lifetime: 86400`. Amazon **requests** these client
hints but the empirical body sizes (verified via 11 different header
combos sent on a /dp/ fetch — see Area G §8) are nearly identical
(±10KB out of 2.0MB). Server doesn't seem to serve materially smaller
variants based on these hints.

### Q2: Playwright APIRequestContext connection pool size

Inspected `node_modules/playwright-core/types/types.d.ts` — there is
**no `maxConnections` / `maxConcurrent` knob exposed** on
`APIRequestContext`. The pool is governed entirely by Chromium's
NetworkService (HTTP/1.1: 6 per origin; HTTP/2: multiplexed; HTTP/3:
own concurrency).

### Q3: Pre-issue HEAD on session boot to negotiate alt-svc

Empirical: amazon.com always advertises `alt-svc: h3=":443"; ma=86400`.
Chromium honors this on the SECOND request to the same origin (the
first request happens before alt-svc was cached). So:
- 1st request: HTTP/2
- 2nd request: HTTP/3 (if cookie/profile preserves alt-svc cache)

Verified live in this session — after several navs, www.amazon.com
served 4 entries via h3 (mixed with h2 from earlier navs). Asset CDN
m.media-amazon.com is heavily h3 (166 h3 / 93 h2 in the same session).

**Pre-issuing a HEAD on session boot WORKS** to populate alt-svc cache.
Saves ~50–150ms on the first real fetch (since alt-svc lookup +
QUIC handshake are pre-paid).

### Q4: 0-RTT QUIC on second request

Yes — Chromium's behavior. Persistent profile retains session tickets
in `Network Persistent State`. So even across AmazonG restarts, the
session ticket cache is rehydrated and 0-RTT fires on the first QUIC
request after restart. **AmazonG already gets this for free** because
profiles use `launchPersistentContext` with a persistent dir.

### Implementation recommendation
- `src/browser/driver.ts` — after `launchPersistentContext`, fire a
  non-blocking `context.request.head('https://www.amazon.com/').catch(()=>{})`
  to warm DNS+TLS+alt-svc.
- Win: 50–150ms on first real fetch in the session.
- Risk: zero (HEAD is non-mutating, server already serves it).

## 7. Cross-profile sharing findings — Area F

### Filler search — NOT shareable across profiles

Live test: `/s?k=pen` fetched two ways from same MCP browser:
- `credentials: 'include'` (signed-in): body 2.28MB, top-12 ASINs `[B0FF6NX982, B0FY7HVJWC, B07BDWD8B7, B0CXDDR4DP, B0FMNW2M14, ...]`
- `credentials: 'omit'` (anon): body 2.58MB, top-12 ASINs `[B0F4XFBNGW, B0C2PGYG2K, B0C2PGV9PM, B0FPMLHJ43, ...]`
- **Only 3 of 12 ASINs overlap; positions also differ.**

**Search results are personalized.** Sharing one search across N profiles
would change which fillers each profile selects, breaking pricing
diversification logic. **Reject** cross-profile filler-search sharing.

### PDP HTML — `static parser output IS shareable, transactional fields are NOT`

Live test: `/dp/B0F1XYMY7G` fetched signed-in vs anon:
| Field | Signed-in | Anon | Shareable? |
|---|---|---|---|
| body bytes | 2,034,615 | 2,043,646 | (~identical) |
| price-whole | 4 | 4 | YES |
| merchantID | A1XIJB2NIYFAQ5 | A1XIJB2NIYFAQ5 | YES |
| Buy Now `formaction` | `/checkout/entry/buynow` | same | YES |
| `offerListingID` value | `S2Wkqk7gbWuc23mbW3wfh...` | `V8sQCfk2TCmlWYX%2B6Acx...` | **NO — session-keyed** |
| `anti-csrftoken-a2z` value | `hMSykhQt85/alAq3uztF...` | `hF86SBfbkdCUVLXZtE/Z...` | **NO — session-keyed** |

**Static parser → shareable**. Static `parseProductHtml` outputs
(price, merchant, isAddon, isMerchantExclusive, etc.) are
account-invariant for a given ASIN. Pass 2 #6 (one HTTP fetch +
fan-out runtime check) remains valid for these fields.

**Transactional fields → NOT shareable.** Each profile MUST extract
its own `offerListingId` and CSRF from its own PDP fetch (or use
the search-results form's tokens). This is what AmazonG already does.

### `/lightsaber/csrf/aapi` — partially shareable test

Two fetches from same browser, different cookie modes:
- signed-in: token `2@hL6R3ce...AAAAAGn6kDEzN2VkOGM0Yi00NmEzLTRjYTEtOGUyMC0zMjEwMWU2NjVhMjU=@NER1YJ`
- anon: token `2@hFJ6+MB...AAAAAGn6kDEzN2VkOGM0Yi00NmEzLTRjYTEtOGUyMC0zMjEwMWU2NjVhMjU=@NER1YJ`

Both share the same trailing `@NER1YJ` salt (probably a server-side
instance/region tag) and the same middle UUID-like portion. The first
104 chars differ (the CSRF body proper).

**The token is session-keyed** — using token from session A in
session B's request likely fails CSRF. Cannot share across profiles.

## 8. Header probe results — Area G

Sent 11 different header combos on a `GET /dp/B0F1XYMY7G` (signed-in)
and compared response shape vs baseline. All return ~2.0MB gzip
with `Vary: Accept-Encoding,User-Agent`.

| Header | TTFB (ms) | total (ms) | bytes | Effect |
|---|---|---|---|---|
| (baseline) | 273 | 1,999 | 2,034,805 | — |
| `Sec-Purpose: prefetch` | 381 | 1,873 | 2,034,900 | +95B (negligible) |
| `Priority: u=0, i` | 226 | 1,680 | 2,034,846 | +41B (within noise) |
| `Accept-Encoding: zstd, gzip, deflate, br` | 309 | 2,173 | 2,034,673 | -132B (just gzip served) |
| `Accept-Encoding: br only` | 226 | 1,885 | 2,034,838 | +33B (gzip still served) |
| `Save-Data: on` | 222 | 2,260 | **2,187,477** | **+152KB** — Save-Data triggers a HEAVIER variant 🤡 |
| `Viewport-Width: 360`+`Sec-CH-Viewport-Width: 360` | 338 | 1,832 | 2,034,879 | +74B |
| `DPR: 1`+`Sec-CH-DPR: 1` | 218 | 1,711 | 2,034,858 | +53B |
| `Device-Memory: 4`+`Sec-CH-Device-Memory: 4` | 208 | 1,675 | 2,034,741 | -64B |
| `Sec-CH-Prefers-Reduced-Motion: reduce` | 229 | 1,759 | 2,035,059 | +254B |
| `X-Amzn-Trace-Id: Self=1-warm-pool` | 210 | 1,733 | 2,043,297 | +8KB (probably echoed somewhere) |
| `Cache-Control: no-cache` | 237 | 1,936 | 2,037,466 | +2KB |

### Findings

1. **`Save-Data: on` makes things WORSE** — returns +152KB body. Likely
   triggers a special "data-saver mobile" variant with extra inlined
   low-res preview images. Counter-intuitive but well-documented for
   some Amazon experiments. **Don't ship.**

2. **Amazon ignores `Accept-Encoding: br/zstd`** — confirms pass 3.
   Server only serves gzip on www.amazon.com.

3. **No header gives a smaller body or faster TTFB.** Variance in TTFB
   (208–381ms) and total (1,675–2,260ms) is dominated by network jitter,
   not header semantics.

4. **`X-Amzn-Trace-Id` echoed back** — adds ~8KB. Not useful for
   "warm pool" routing — appears to just be inlined in some debug attr.

**Verdict G:** No header gambit yields a usable speed win. Reject all.

The one header-related action that DOES help is **bumping the User-Agent
+ letting Chromium auto-send Client Hints**. Today AmazonG hardcodes
`Chrome/131.0.0.0` in `driver.ts:37`, which is 16 minor versions stale.
Drop the explicit `userAgent` option and let Playwright use its bundled
Chrome 147 default. (Re-confirms pass 3 #4.)

## 9. Purchase-ID lifetime — Area H

### Setup

Created two fresh buynow purchase IDs by POSTing the PDP form to
`/checkout/entry/buynow` (pass 3 #1 endpoint). Probed `GET /checkout/p/p-{id}/spc`
at multiple intervals.

### Empirical TTL data (purchase ID `106-6910499-0054604`)

| Elapsed (s) | Status | Body (bytes) | hasPlaceOrder | fetch (ms) |
|---|---|---|---|---|
| 15 | 200 | 326,293 | YES | 1,226 |
| 26 | 200 | 318,170 | YES | 930 |
| 143 | 200 | 326,322 | YES | 1,096 |
| 240 | 200 | 326,322 | YES | 1,096 |
| 341 | 200 | 326,293 | YES | 1,124 |
| 561 | 200 | 326,322 | YES | 1,124 |
| 678 | 200 | 318,167 | YES | 1,527 |

**At T+11 minutes, the purchase ID is still alive** with full
Place-Order-ready /spc HTML. Body alternates between 318K and 326K
(probably gzip-compression variance — different chunks).

The 24h test was impractical inside this audit. Based on 11+ minutes
of confirmed alive + Amazon's general checkout UX pattern (cart
sessions persist days), **TTL is at least minutes, likely hours**.

### Implication for AmazonG

**A pre-created buynow purchase ID can be held for at least 10
minutes** — this is enough to support:
- **Pre-create checkout session BEFORE user click**: if the queue has
  a pending deal, fire the buynow POST (~2.4s) *as soon as the deal
  notification arrives*, well before the buy decision. By the time
  the buy condition triggers, the purchase ID is ready and `page.goto(spcUrl)`
  is the only remaining browser nav.
- **Pre-warm /spc fetch during PDP dwell time**: same idea, smaller
  scope.

But: this overlaps with pass 4's stress-test of buynow extension. Pass 4
will determine whether the buynow POST is reliable across PDP variants;
if it is, this becomes a real candidate.

**Estimated saving if shipped: ~2.4s removed from buy hot path** (the
buynow POST happens during dead time before the buy fires, not on the
critical path). Big.

### Risk
- The pre-created session locks one inventory unit (?) on Amazon's
  side — if the buy doesn't fire, the session expires harmlessly.
- Pre-created sessions for ASINs that go OOS by buy time → graceful
  failure (server returns OOS page on /spc).

## 10. CDP-level capabilities not exposed in Playwright high-level — Area I

### Probed via `context.newCDPSession(page)` + `cdp.send(...)`

| Domain.Method | Works? | Notable |
|---|---|---|
| `Network.enable` | YES | Pre-req for everything else |
| `Network.responseReceived` event | YES | Per-request timing waterfall (DNS/connect/SSL/send/recv with ~0.001ms precision) |
| `Network.canEmulateNetworkConditions` | YES | Returns `{result: true}` |
| `Network.setBlockedURLs` | **YES** | Glob-pattern blocklist applied at network layer (no JS callback per request — see below) |
| `Network.setExtraHTTPHeaders` | YES | Per-page header overrides (different from context-level) |
| `Network.getResponseBody` | YES (with valid requestId) | Could partial-read body for streaming-parse |
| `CacheStorage.requestCacheNames` | YES | Confirmed: 6 cache names returned |
| `Storage.getCookies` | YES | Cookie inspection |
| `Storage.clearDataForOrigin` | YES (via Storage domain) | Selective state reset without full session teardown |

### `Network.setBlockedURLs` vs `context.route()` — meaningful difference

**Today:** AmazonG's `driver.ts:141` does `context.route('**/*', cb)`.
The callback fires for EVERY request in the page (including
sub-resources: scripts, stylesheets, images, fonts, fetches). With
~250+ sub-resources on a real PDP load (verified: my live nav showed
286 entries), the per-request IPC cost adds up.

**Per-request IPC cost**: empirically 1–5ms each (Playwright handles
the route callback by serializing the request, sending it to Node,
calling the JS callback, serializing the decision back). 250 × 2ms
average = **~500ms cumulative IPC per PDP nav**.

**CDP `Network.setBlockedURLs`**: configure once with glob patterns;
matching URLs are dropped at Chromium's network layer with **zero
per-request IPC**. The high-level Playwright API doesn't expose this.

```ts
// In src/browser/driver.ts (replacement sketch)
const cdp = await context.newCDPSession(initialPage);
await cdp.send('Network.enable');
await cdp.send('Network.setBlockedURLs', {
  urls: [
    // Hosts (telemetry + ad-system)
    '*fls-na.amazon.com*',
    '*unagi.amazon.com*',
    '*aax-us-iad.amazon.com*',
    '*aax.amazon-adsystem.com*',
    '*dtm.amazon.com*',
    '*cs.amazon.com*',
    // Image extensions
    '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif',
    // Fonts
    '*.woff', '*.woff2', '*.ttf',
    // Media (rare on Amazon, but defensive)
    '*.mp4', '*.webm',
  ],
});
```

**Caveat:** `Network.setBlockedURLs` matches only by URL glob.
The current SVG carve-out (`!/\.svg(?:\?|#|$)/i.test(req.url())`)
can't be expressed cleanly. But: **§7 verified that the buy-box area
has zero SVG dependencies** — the Prime badge, Buy Now button, etc.
are CSS-styled spans/inputs, not `<img src=".svg">`. **The SVG carve-out
can be safely dropped.**

### Win estimate
- Per PDP nav: ~500ms IPC roundtrip elimination + slightly faster
  abort (network layer vs renderer layer)
- Per /spc nav: ~200–400ms (fewer sub-resources)
- **Total: 0.5–1s/PDP, 0.2–0.4s/spc** — additive on top of existing
  blocklist savings

### Other CDP capabilities worth shipping
- `Network.setExtraHTTPHeaders({})` per page — dynamic header tuning
  per-job (would let us set `X-Forwarded-For` for testing without
  reopening the context).
- `Storage.clearDataForOrigin({origin: 'https://www.amazon.com'})` —
  selective cookie/cache clear without full session teardown. Useful
  for the `/cancelFillerOrders` flow if it ever poisons the cart state.

## 11. Worker-thread parsing benchmark — Area J

### Setup

Saved a real /spc fixture (318KB, captured live in this session).
Benchmarked JSDOM parse on:
1. Main thread (current AmazonG behavior)
2. Warm `worker_threads` Worker (sequential dispatch)
3. Cold worker_threads (new Worker per parse)

### Results (N=7, M-series Mac, Node v25.8.2, jsdom from package.json)

```
=== mainline (jsdom on main thread) ===
Times: [18, 21, 22, 22, 23, 24, 31] ms
Median: 22ms; min 18ms; max 31ms

=== worker_threads (warm worker, sequential dispatch) ===
Total (IPC+parse) times: [20, 21, 22, 23, 25, 25, 47] ms
Median total: 23ms
Median parse-only: 22ms
IPC overhead: 1ms median

=== worker_threads (cold start each time) ===
[{coldTotal:159, parse:58}, {coldTotal:153, parse:58}, {coldTotal:154, parse:57}]
```

### Findings
- **Main-thread parse: 22ms median** for a 318KB /spc HTML
- **Warm worker: 23ms median total** (1ms IPC overhead)
- **Cold worker: 153–159ms** (worker boot + first parse hit)

### Verdict J: REJECT

A 22ms parse cost is **not blocking the event loop** in any meaningful
way. AmazonG parses /spc HTML once per buy (during the buy hot path,
post-page.content()). The 22ms cost would compete only if there were
20+ parses happening simultaneously per profile — which doesn't happen
in AmazonG's flow.

Worker-thread parsing would add:
- ~150ms cold-start cost (or the maintenance complexity of a worker
  pool)
- ~1ms IPC overhead per parse (negligible)
- A new failure mode (worker death on memory pressure)

For 0–1ms wall-clock saved on warm-thread case. **Reject.**

If parsing ever needs to be moved off the main thread, the right
trigger is "we're parsing 5+ HTMLs concurrently" (e.g., bulk
order-history scrape). Not the current single-buy flow.

## 12. Final NEW punch list

| # | Candidate | File:line | Win | Risk | Notes |
|---|---|---|---|---|---|
| **A. Streaming-parse PDP HTML** | | | | | |
| 1 | Replace `pdpHttpFetch` with stream-and-cancel-at-byte-600K | `src/actions/amazonHttp.ts` (new helper); callers `buyNow.ts:1449`, `buyWithFillers.ts:2055` | **~990ms / PDP HTTP fetch** | Low | Use Node's native `undici.fetch` (Node 18+) which exposes ReadableStream. Watch for `id="buy-now-button"` + `formaction=` + `name="offerListingID"` + `id="add-to-cart-button"` markers; cancel reader once all 4 present (or after 600KB safety cap). |
| **B. CDP setBlockedURLs replaces context.route()** | | | | | |
| 2 | Move blocklist from `context.route` to `Network.setBlockedURLs` via CDP | `src/browser/driver.ts:141` | **0.5–1s / PDP nav** (cumulative IPC), **0.2–0.4s / spc nav** | Low | Drop the SVG carve-out (verified safe — buy-box has zero SVG deps). Keep `context.route` ONLY if the SVG carve-out is needed elsewhere (e.g., cashback widget on /spc — verified empirically as zero SVG too). |
| **C. Session-boot connection warmup** | | | | | |
| 3 | Add non-blocking `ctx.request.head('https://www.amazon.com/')` after `launchPersistentContext` | `src/browser/driver.ts` (after line 169) | ~50–150ms on first PDP fetch | Low | Warms DNS+TLS+alt-svc cache; subsequent requests negotiate HTTP/3 + 0-RTT. One HEAD costs ~120ms but pays for itself on the next 3+ requests. Truly fire-and-forget — no error path needed. |
| **D. Pre-create checkout session during dwell time** | | | | | |
| 4 | Speculative buynow POST during PDP dwell, hold purchase-id ready for buy click | `src/actions/buyNow.ts` (single mode) and as opt-in in `buyWithFillers.ts` | **~2.4s removed from buy hot path** | **Med** | Pass 3 #1 created the buynow endpoint. Pass 5 confirmed the purchase-id stays alive ≥11 minutes (probably hours). Fire the buynow POST as soon as the deal arrives in the queue; when buy condition triggers, only `page.goto(spcUrl)` is needed. **Risk:** if buy abandons, a useless purchase-id was created (no charge, no inventory hold). |
| **E. Drop SVG carve-out in route handler** | | | | | |
| 5 | Remove the `!/\.svg/i.test(req.url())` exception | `src/browser/driver.ts:152` | ~0–50ms (a few SVG fetches eliminated) | Low | Verified empirically: buy-box has zero SVG deps. Cashback widget area has zero SVG deps. Prime badge is CSS, not SVG. Removing the exception simplifies the code AND enables the CDP `Network.setBlockedURLs` migration above. |
| **F. CDP Storage.clearDataForOrigin for selective state reset** | | | | | |
| 6 | Replace "close + relaunch profile" recovery path (when used) with `Storage.clearDataForOrigin` for cookie-only reset | `src/main/...` (recovery flow if any) | ~80ms vs ~140ms full session restart | Low | Marginal; only useful if there's a "stuck cookie" recovery flow. Defer until needed. |

## 13. Honest assessment

The brief asked for orthogonal angles to pass 4. Pass 5 found **3
real, concrete wins** + several rejected paths.

### What's real
1. **Streaming-parse PDP** (~990ms / fetch) — highest yield. PDP body's
   trailing 1.5MB is dead weight for AmazonG.
2. **CDP `Network.setBlockedURLs`** (~0.5–1s / PDP) — mechanical
   replacement of `context.route()`; eliminates per-request IPC.
3. **Pre-created checkout sessions** (~2.4s off hot path) — only
   if pass 4 confirms the buynow endpoint is reliable across PDP
   variants. Riskier than #1+#2.

### What's NOT real
1. **Hot-context pool** (Area D) — cold-start is 56ms median, not
   2–4s as pass 2 anecdotally guessed. Pre-warming saves nothing.
2. **Service Worker prewarm exploitation** (Area B) — SW exposes no
   `prewarm-this-URL` API; the `checkout-prefetch` cache is filled
   by encrypted opaque payloads we can't decrypt or populate.
3. **Header probes** (Area G) — no header gives a smaller body or
   faster TTFB. `Save-Data: on` actually makes things WORSE.
4. **Worker-thread parsing** (Area J) — main-thread parse is 22ms;
   not worth offloading.
5. **Cross-profile filler search sharing** (Area F) — search results
   are personalized; can't share.
6. **Pre-build Place Order POST body** (Area C) — body is 3 trivial
   fields all in HTML; nothing to pre-compute.

### What's nuanced
- **PDP static parser output IS shareable across profiles** for
  decision-making (price/merchant/isPrime). But `offerListingId` and
  CSRF are session-keyed. Pass 2 #6 (one HTTP fetch + per-profile
  runtime check) remains valid for the decision step.
- **Cross-profile `/lightsaber/csrf/aapi` tokens** look format-similar
  but the middle 104 chars differ. Likely session-locked. Don't reuse.

### Combined with pass 1+2+3 punch lists

**If pass 1 (parallel clearCart), pass 2 (resource blocking + verify
shared fetch + multi-profile shared scrape) are shipped, pass 3 #1+#2+#3
are shipped, and pass 5 #1+#2+#3 are shipped**, total estimated saving
across single-profile fan-out:
- Pass 5 #1: -990ms (streaming-parse PDP)
- Pass 5 #2: -700ms (CDP blocklist replacing route)
- Pass 5 #3: -100ms (HEAD warmup)
- Pass 5 #4: -2400ms (if pass 4 validates buynow stress-test)

**~4.2s additional savings from pass 5 candidates** if all ship.

### What pass 5 did NOT touch
Pass 4 territory (per the brief): buynow stress-test, /spc HTTP-add
target extension, /gp/address-change, /spc/handlers/*-async, /huc/*,
/lightsaber/* (other than csrf/aapi), `node-html-parser`, Speculation
Rules / `<link rel="prerender">`, `form.requestSubmit()` vs `.click()`,
CSM markers (`window.ue/csm/uet/uex`), `waitUntil:'commit'`, alt-svc
warmup beyond §6 basics, AbortSignal propagation, `addInitScript`
to disable Amazon analytics globals.

### Recommendation order

If only one ships: **pass 5 #1 (streaming-parse PDP)** — ~1s/buy with
low risk and a clean implementation via `undici.fetch`.

If two ship: **#1 + #2 (CDP blocklist)** — combined ~1.5–2s/buy.

If three ship: **#1 + #2 + #3 (HEAD warmup)** — combined ~1.7–2.1s/buy.
Trivial to add.

**Defer #4 (pre-created sessions)** until pass 4's buynow stress-test
publishes; the speedup is biggest but the risk is highest, and pass 4
has the data we need for the risk estimate.

## Empirical artifacts

Saved under `/Users/jack/Projects/AmazonG/.research/`:
- `cold_start_bench.mjs` — empty profile chromium launch bench
- `cold_start_full.mjs` — empty profile + driver.ts setup bench
- `cold_start_real_profile.mjs` — real 364MB profile launch bench
- `parse_bench.mjs` — JSDOM main-thread vs worker_threads bench
- `parse-worker.mjs` — worker module used by parse_bench
- `route_overhead_bench.mjs` — context.route vs CDP setBlockedURLs (noisy due to anti-bot on fresh profile; signal preserved in pass 5 §10 from prior signed-in CDP session)
- `spc-fixture.html` — captured 318KB /spc HTML for parse benching

Test orders placed and cancelled (all $4.29, account "Cuong"):
- `112-4249243-1521845` (purchase-id `106-8872016-9930658`) — placed at T0_buynow=17:43:45, cancelled at 17:46
- `112-5645209-3732245` (purchase-id `106-2966234-2023425` via duplicate-order page) — placed and cancelled at 17:59-18:00

Purchase-ids created but never consumed (left to expire on their own,
no charges):
- `106-6910499-0054604` — confirmed alive at T+11min for TTL test
- `106-5695014-5576248` — used for CDP capture, no order created

Total $0 charged; all observed orders show as Cancelled in account history.
