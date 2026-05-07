# Blocklist coverage audit — 2026-05-06

**Method:** live Playwright MCP probe (no AmazonG CDP blocking active), hit each page AmazonG touches, capture every non-static XHR/fetch via PerformanceObserver, diff against shipped `BLOCKED_URL_PATTERNS` in `src/browser/driver.ts`.

**Pages probed:**
- PDP (`/dp/B0DZ77D5HL?th=1`)
- /spc (`/checkout/p/<id>/spc?referrer=spc`)
- Cart (`/gp/cart/view.html`)
- Search results (`/s?k=whey+protein`)
- Order history (`/gp/css/order-history`)
- Order details (`/your-orders/order-details?orderID=...`) — verify-phase target
- Cancel-form (`/progress-tracker/package/preship/cancel-items?orderID=...`) — cancel-sweep target

## Findings — new candidates

| # | Pattern | Hit on | Mean ms / call | Calls / typical buy | Safety | Recommendation |
|---|---|---|---|---|---|---|
| **1** | `*://www.amazon.com/hz/rhf*` | order-details (933 ms), cancel-form (963 ms) | **~950 ms** | up to **4** (1× verify + 3× cancel-sweep across buy/verify/fetch_tracking phases) | "Recommendations Hub Frame" — pure cross-sell carousel ("You might also like"). AmazonG reads order metadata directly, never the rec panel. **SAFE** to block. | **Ship — biggest single win at ~3.8s/filler-buy** |
| **2** | `*://www.amazon.com/rd/uedata*` | EVERY page (PDP 211 ms, /spc 332 ms, cart 200 ms, search 290 ms, order-history 111 ms, order-details 229 ms, cancel-form 214 ms) | ~150-300 ms per call, **2 calls per page** | ~6-8 page loads × 2 = **12-16 calls** | RUM (Real User Monitoring) telemetry beacon. Pure metrics, no DOM. Same shape as already-blocked `fls-na.amazon.com/*`, `unagi.amazon.com/*`, `dtm.amazon.com/*`. **SAFE** to block. | **Ship — broadest cumulative win at ~1.5-2s/buy across all pages** |
| **3** | `*://pgi7j6i5ab.execute-api.us-east-1.amazonaws.com/*` | search-results only (167 ms) | ~167 ms | 1 per search nav (~6× per filler buy = 6 search terms) = **~6 calls** | AWS API Gateway "monitoring" endpoint, 3rd-party host. Same shape as already-blocked `ara.paa-reporting-advertising.amazon`. **SAFE** to block. | **Ship — moderate win at ~1s on search-heavy filler-mode buys** |
| 4 | `*://www.amazon.com/tt/i*` | every page (already 0 ms — failing with `ERR_TRUST_TOKEN_OPERATION_FAILED`) | 0 ms | n/a | Anti-bot Trust Token probe. Already failing — blocking won't save time, BUT explicitly blocking might raise the session's bot-likeness score on Amazon's side (vs the current "browser doesn't support TT" signal). **PASS** — leave alone; current state has zero cost and lowest detection profile. | DON'T ship |

## Findings — DO NOT block (auth/payment-relevant)

These fired during the probe but have functional dependencies AmazonG cares about:

| URL | Where | Why we keep it |
|---|---|---|
| `www.amazon.com/checkout/entry/cart` | cart page (2972 ms) | This is **AmazonG's own /spc entry path**. Blocking it kills checkout. |
| `www.amazon.com/hz/payment-options` | cart page (441 ms) | Payment validation. Likely needed for /spc to render the payment block correctly. |
| `www.amazon.com/ax/preauth` | cart page (140 ms) | Auth pre-check. Risky — blocking could cascade-trigger sign-out. |
| `www.amazon.com/ax/claim/webauthn/*` | order-history (203 ms) | WebAuthn passkey eligibility. Auth-flow critical. |

## Per-page coverage summary (after this batch ships)

| Page | Total events | Already blocked | Still firing post-ship | New ms saved |
|---|---|---|---|---|
| PDP | 32 | 28 | 4 (`tt/i`, `hz/payment-options` if visited) | ~410 ms (rd/uedata) |
| /spc | 41 | 39 | 2 (`tt/i`) | ~330 ms (rd/uedata) |
| Cart | 27 | 21 | 6 (`tt/i`, `entry/cart`, `payment-options`, `ax/preauth`, `rd/uedata` becomes 0) | ~200 ms (rd/uedata) |
| Search | 83 | 79 | 4 (`tt/i`) | ~460 ms (rd/uedata + monitoring) |
| Order history | 26 | 22 | 4 (`tt/i`, `ax/claim/webauthn`) | ~110 ms (rd/uedata) |
| Order details | 43 | 39 | 4 (`tt/i`) | **~1,160 ms** (rd/uedata + hz/rhf) |
| Cancel-form | 36 | 32 | 4 (`tt/i`) | **~1,180 ms** (rd/uedata + hz/rhf) |

## Total savings on a typical filler-mode buy — **revised after deeper audit**

### CDP only applies to `page.goto` paths

A close re-read of `verifyOrder.ts` and `fetchTracking.ts` confirms they fetch via `context.request.get` (APIRequestContext), which **never triggers sub-resource loading** and **bypasses CDP entirely**. So my earlier claim "blocks `hz/rhf` on verify + fetch_tracking" was wrong.

Real CDP-affected pages AmazonG navigates via `page.goto`:

| File:line | URL | Phase |
|---|---|---|
| `buyNow.ts:244`, `buyWithFillers.ts:690` | `SPC_ENTRY_URL` → /spc | Buy |
| `buyWithFillers.ts:586`, `:719` | `/gp/cart` (fallback) | Buy |
| PDP nav (driver.ts session) | `/dp/<asin>` | Buy |
| Search-result nav (filler harvest) | `/s?k=...` | Buy |
| `cancelFillerOrder.ts:244` | `/gp/your-account/order-details?orderID=...` | Buy / Verify / FT (when cancel fires) |
| `cancelForm.ts:33`, `cancelFillerOrder.ts:347` | `/progress-tracker/package/preship/cancel-items?...` | Buy / Verify / FT (when cancel fires) |

### Revised per-buy savings

| Pattern | Where it fires (CDP-affected) | Calls per filler buy | ms per call | Total ms |
|---|---|---|---|---|
| `hz/rhf*` | order-details (in cancel paths) + cancel-form | up to 6 (2 per phase × 3 phases when cancel fires) | ~950 | up to **~5,700** |
| `rd/uedata*` | EVERY browser nav (PDP + ~6 search-result navs + /spc + cancel paths) | ~14-20 | ~200 | **~2,800-4,000** |
| `pgi7j6i5ab.execute-api...amazonaws.com/*` | search-results | 6 | ~167 | **~1,000** |

**Worst-case filler buy: ~10s saved**. Common case (cancellations don't fire on every phase): ~3-5s saved.

Single-mode (non-filler) buy: ~600-1,000ms saved (no filler-search loop, often no cancel sweep — mostly `rd/uedata` on PDP + /spc).

## Verification pass — structural + URL-shape proofs

### `hz/rhf` structural proof

On `/gp/your-account/order-details?orderID=...` with `#rhf` rendered:

- `#rhf` occupies vertical box `top: 1317px, bottom: 2433px` (below the fold).
- ZERO of AmazonG's parser selectors land inside `#rhf`:

```js
findingsAtRisk: []   // none of these fall inside #rhf
findings: [
  { sel: '[data-component="cancelled"]', count: 1, insideRhf: 0 },
  { sel: '[data-asin]',                 count: 5, insideRhf: 0 },
  { sel: '#orderDetails',               count: 1, insideRhf: 0 },
]
```

The `#rhf` widget is `<div role="complementary" aria-label="Your recently viewed items and featured recommendations">` — explicitly tagged as non-essential WCAG complementary content.

### `rd/uedata` URL-shape proof

The endpoint serves `<img>` beacons (`<img src="https://www.amazon.com/rd/uedata?...">`). The `responseEnd - startTime` is ~100-300ms but the response body is 371 bytes of empty image data — pure telemetry. CDP `Network.setBlockedURLs` matches by URL regardless of resource type.

### `pgi7j6i5ab.execute-api.us-east-1.amazonaws.com` URL-shape proof

Non-Amazon-com host (AWS API Gateway), path `/prod/v1/monitoring`. 167ms / 1 call on every search-results nav. Identical shape category to already-blocked `ara.paa-reporting-advertising.amazon`. If Amazon migrates this elsewhere, the block becomes a silent no-op — nothing breaks.

### Pages where I confirmed NO new candidates beyond these 3

After scrolling, waiting 8s, and clicking delivery radios on /spc to surface late-firing XHRs:

- **PDP** (8s + scroll): only `rd/uedata`, `tt/i`, `m.media-amazon.com/.../vse-vms-transcoding-artifact*.ts` (HLS video chunk — 1ms, not worth blocking)
- **/spc post-delivery-click**: only `eligibleshipoption` (2399ms — **DO NOT block** — AmazonG explicitly waits on this XHR)
- **Order-details / tracking-page redirect**: same `hz/rhf` + `rd/uedata` signature

## Auth/payment URLs to LEAVE ALONE

| URL | Why we keep it |
|---|---|
| `www.amazon.com/checkout/entry/cart` | AmazonG's own /spc entry path |
| `www.amazon.com/hz/payment-options` | Payment validation |
| `www.amazon.com/ax/preauth`, `ax/claim/webauthn/*` | Auth pre-checks; risk of cascade sign-out |
| `www.amazon.com/checkout/p/<id>/eligibleshipoption` | Critical — AmazonG explicitly waits on it |
| `www.amazon.com/tt/i` | Trust Token (already failing). Blocking might raise bot-likeness vs current "browser doesn't support TT" signal. |

## Suggested commit shape

One commit, three patterns added to `BLOCKED_URL_PATTERNS` with clear comments. Same shape as `16a21e5` and `a3fb183`. No code-path changes elsewhere.
