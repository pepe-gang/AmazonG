# Amazon-comm deep dive — 2026-05-05

Second-pass empirical research into every step where AmazonG talks to
amazon.com. Live-tested against a real signed-in account on
2026-05-05; placed + cancelled one $6.79 order to capture the full
end-to-end timeline including verify and tracking phases.

## TL;DR

After the v0.13.19 work (batch cart-add, prescrape reuse, clearCart
reorder), the filler-mode buy is **at or near the floor of what's
extractable from Amazon's public surface**.

- **No JSON APIs exist.** Every hypothetical endpoint we probed
  (`/cart/json`, `/api/cart`, `/gp/your-orders/json`, `/huc/api/cart`,
  `/cart/web/cart-count`, etc.) returns 404 or plain HTML. Amazon
  serves HTML pages and accepts form-encoded POSTs. That's the
  surface.
- **No batch place-order or CPE bypass.** Direct POST to
  `/checkout/p/p-{purchaseId}/spc/place-order` returns 200 but the
  order doesn't finalize without browser-side CPE execution. Confirmed
  again here. Place Order needs a real Chromium tab.
- **The only meaningful unshipped optimization** is parallelizing
  `clearCart` and `scrapeProduct` in `pollAndScrape`. The two are
  independent (one is HTTP-only on `ctx.request`, the other is a
  browser tab nav). Sequential today, parallel saves ~1.5s/buy.

One important **correctness finding** worth fixing separately: the
batch cart-add response only echoes a subset of ASINs back in
`data-asin="..."` form when the batch is large (9+). The phantom-
commit guard `asinsCommittedInResponse` would falsely flag the rest
as not committed even though they ARE in the cart. See below.

## Live timing table (signed-in account, 2026-05-05)

| Phase | What | Path | Time |
|---|---|---|---|
| **Pre-checkout** | clearCart (empty cart, fast path) | HTTP GET `/gp/cart/view.html` + N POSTs | 1.1s |
| | scrapeProduct (single PDP) | page.goto `/dp/<asin>` + hydrate + parse | ~2.0s |
| | PDP token fetch (HTTP only) | HTTP GET `/dp/<asin>` | 1.8s |
| | Filler search (one term) | HTTP GET `/s?k=...` | 1.0s |
| | Cart-add POST (1 item) | HTTP POST `/cart/add-to-cart/...` | 0.3s |
| | Cart-add POST (9-item batch) | HTTP POST same endpoint | 1.4s |
| | `/spc` shortcut (HTTP fetch) | HTTP GET `/checkout/entry/cart?proceedToCheckout=1` → /spc HTML | 2.3-3.6s |
| **Checkout** | `/spc` browser nav | page.goto same URL | similar |
| | waitForCheckout hydration | DOM polling for Place Order button | 0.5-2s typical |
| | Place Order click → thank-you | submit form, CPE redirect chain | 3-5s |
| **Lifecycle** | verifyOrder (active order) | HTTP GET `/gp/your-account/order-details?orderID=...` | 2.1s |
| | ship-track (no carrier yet) | HTTP GET `/gp/your-account/ship-track?...` | 0.6s |
| | Cancel form click | browser tab nav + click | 1-2s |

## Endpoint inventory (browser nav vs HTTP-only)

### Browser tab navigations (cannot easily skip)

| URL | Why we navigate |
|---|---|
| `/ap/signin`, `/` | Login flow, cookie capture |
| `/dp/<asin>` | PDP runtime visibility checks (Prime/Buy Now bounding-rect + computed style) |
| `/checkout/entry/cart?proceedToCheckout=1` | /spc — Place Order needs CPE flow |
| `/checkout/p/p-<purchaseId>/spc` | Same as above (after redirect) |
| `/cpe/executions?...&pageType=CPEFront` | Payment authorization, browser JS required |
| `/gp/buy/thankyou/handlers/display.html?purchaseId=...` | Read latestOrderId from DOM |
| `/progress-tracker/package/preship/cancel-items?orderID=...` | Cancel items button click |
| `/gp/cart/view.html` | clearCart click-loop fallback only |
| `/gp/css/order-history` | orderId fallback when DOM read misses |

### HTTP-only `ctx.request` (no tab opens)

| URL | Method | Used by |
|---|---|---|
| `/cart/add-to-cart/ref=<any>` | POST | filler add, target add — accepts `items[N.base][...]` triplets, batch-capable |
| `/gp/cart/view.html?ref_=nav_cart` | GET | clearCart fetch |
| `/cart/ref=ord_cart_shr?app-nav-type=none&dc=df` | POST | clearCart delete (one per UUID) |
| `/s?k=<term>&rh=p_85:<prime>,p_36:<min-max>&s=review-rank` | GET | filler search — search-result `<form>` already carries `csrf + offerListingId + asin`, see filler-deep-dive doc |
| `/dp/<asin>` | GET | PDP token harvest fallback when prefetched HTML lacks form |
| `/gp/your-account/order-details?orderID=...` | GET | verifyOrder, fetchTracking parent |
| `/gp/your-account/ship-track?itemId=...&orderId=...&shipmentId=...` | GET | ship-track per-shipment, parallel |
| `/checkout/entry/cart?proceedToCheckout=1` | GET (HTTP) | /spc HTML fetch (we don't use this — we navigate the tab) |

## Hidden-endpoint hunt — all negative

Probed 16 hypothetical endpoints. **Every one returned 404 or generic
HTML.** Tested:

- Cart JSON: `/cart/json`, `/gp/cart/json`, `/api/cart`,
  `/gp/cart/view.html?_format=json` (200 OK but HTML, query ignored),
  `/huc/api/cart`, `/cart/ajax`, `/cart/get-cart`,
  `/cart/web/cart-count`, `/gp/cart/header.html`
- Order JSON: `/gp/your-orders/json`,
  `/gp/your-orders/api/getOrderList`,
  `/gp/your-account/order-details/json?orderID=...` (200 OK but HTML)
- Search API: `/s/api/search?k=test` (200 OK but HTML)
- Pre-checkout: `/pre-checkout`, `/api/checkout/cart`
- Navigation: `/gp/navmenu`

Conclusion: **Amazon's public/customer-facing surface is HTML-only.**
The internal admin API used by Amazon Business reporting is paid +
B2B-scoped and doesn't expose individual customer order placement.
The amazon.com customer flow is genuinely HTML POST-form-driven.

## Critical correctness finding — phantom-commit guard for large batches

When we POST a batch of 9 items to `/cart/add-to-cart/...`:
- Status: 200 OK
- All 9 items DO land in cart (verified via follow-up cart fetch:
  `cartCount: 9`, subtotal matches sum of 9 items)
- BUT the response body only echoes 2 ASINs as `data-asin="..."`

Our v0.13.19 `asinsCommittedInResponse(html, asins)` walks
`data-asin="<asin>"` matches in the response. **For batches of 9+ this
returns a misleading 2-of-9.**

In production, today's filler flow does **two separate POSTs** —
1 target + 1 batch-of-8 fillers. The 8-filler batch tested earlier
(2026-05-04) returned all 8 ASINs in response. So our current code
isn't broken. But:

- Fragile — Amazon's response truncation might shift to ≤7 in future.
- Limits any future "combine target + fillers in one POST"
  optimization. Combining target + 8 fillers = 9 items → guard breaks.

**Recommended remediation** (separate from speed work):
- Replace the response-echo check with a follow-up `ctx.request.get('/gp/cart/view.html')`
  that reads `nav-cart-count` + scans for the requested ASINs. Adds
  ~500ms but is robust.
- OR simply trust the 200 OK for cart-add (Amazon either commits all
  or none — partial commits weren't observed in any of the 50+ buys
  we've traced).

## What's still on the table (ranked by payoff)

### 🟢 Parallelize clearCart + scrapeProduct — ~1.5s/buy

The two are independent. clearCart's HTTP fast path uses `ctx.request`
on the BrowserContext (no tab nav). scrapeProduct uses `page.goto` to
load the PDP into the visible tab. They share cookies but don't
conflict on the network layer.

Today's flow:
```
pollAndScrape:
  clearCart (in buyWithFillers, 1.5s) →
  scrapeProduct (2s) →                  [WAIT-WAIT, this is wrong, scrape runs FIRST]
```

Actually in today's flow, the order is:
1. `pollAndScrape` calls `scrapeProduct` (2s — PDP nav)
2. `runFillerBuyWithRetries` → `buyWithFillers` 
3. `buyWithFillers` calls `clearCart` (1.5s — HTTP)

So clearCart runs AFTER scrape, sequentially. To parallelize:

- Move clearCart fire-and-forget out of `buyWithFillers`, fire from
  `pollAndScrape` after `session.newPage()` immediately.
- Pass the `Promise<ClearCartResult>` to `buyWithFillers` via opts.
- `buyWithFillers` awaits the promise just before its `addFillerViaHttp(target)`
  step.
- If clearCart's HTTP path failed → fall through to the click-loop
  AFTER `buyWithFillers` opens its own `page.content()` capture (so we
  don't lose the PDP HTML to a /cart navigation).

Single-mode (`buyNow`) gets the same benefit — it also calls clearCart.

Estimated saving: ~1.5s/buy (the smaller of clearCart and scrape
times).

### 🟡 Pre-warm sessions on worker boot — ~1s on first buy after restart

A freshly-launched profile session has a cold TCP/cookie state. The
first request pays ~500-1000ms more than warm requests. Pre-warming
by hitting a lightweight URL (e.g., `/gp/your-account`) when sessions
spin up amortizes that cost.

Marginal; only matters on worker restart.

### 🟡 Tighten waitForCheckout hydration cap — only helps degenerate cases

Current cap: 30s. Typical /spc hydrates in 0.5-2s. Lowering the cap
to 8s helps when Amazon is slow but doesn't help the typical path.

### 🔴 HTTP-only scrape for filler-mode — 1.5-2s but loses runtime checks

Scope: replace `scrapeProduct`'s `page.goto + waitForFunction +
runtimeVisibilityChecks` with `ctx.request.get(pdpUrl) + JSDOM
parse`. We did this analysis earlier in `filler-deep-dive-2026-05.md`
and rejected because the runtime visibility checks (Prime/Buy Now
bounding-rect) catch real edge cases the static parser misses. The
INC-2026-05-05 Prime gate fix made this even less attractive — we
already have the conservative reconcile that depends on the runtime
override path being trustworthy.

### 🔴 Direct CPE bypass — confirmed not possible

Direct POST to `/spc/place-order` (without browser): status 200,
response is an HTML page that triggers a JS redirect to
`/cpe/executions`. Without browser execution, the order is consumed-
but-not-finalized (cart goes empty, but no order is created). **CPE
must run in a browser tab.** This was the main finding from the prior
deep dive and re-confirmed today.

## Recommendation

Ship **only the parallel clearCart + scrape** change. Estimated 1.5s
saved per buy. No risk — failures degrade gracefully to today's
sequential behavior.

Skip everything else for now:
- HTTP-only scrape: too risky after the recent Prime gate work
- Pre-warm: marginal gain, complexity
- Hidden endpoints: confirmed don't exist
- Phantom-commit guard improvement: separate concern, log-only fix
  (not user-facing)

The next material speed wins, if any, will come from changes Amazon
makes to their page architecture. Today's stack is well-tuned.
