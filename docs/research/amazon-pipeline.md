# Amazon checkout pipeline — empirical research notes

Living notes on how Amazon's retail checkout flow actually behaves under real
network + auth conditions. Data here is **measured**, not inferred from
saved fixtures or docs. Use this when designing changes that touch the
hot path (buy / cashback gate / order-id capture / tracking / cancel).

Each finding has a date so we can spot when Amazon has shifted under us.

---

## Order ID hierarchy and fan-out

**Date observed:** 2026-05-04

A single Place Order click can produce 0, 1, or N actual orders. The IDs
involved live in **two distinct number spaces** that are easy to confuse:

| Term | Example | Where it appears | What it identifies |
|---|---|---|---|
| `purchaseId` (also `checkoutId`) | `106-0433446-4196253` | SPC URL path; thank-you `?purchaseId=`; `<form action>` | The **checkout session** — one per Place Order click |
| `orderId` (fulfillment) | `112-9701571-1565829` | Order-history page; order-details URLs; emails | An **actual fulfillment order** — N per click after split |

**Empirical observation 1 (multi-fulfillment, 2026-05-04):** placed a $348
cart with 4 items (cotton swabs, iPad, toilet paper, speakers). One
click. Amazon split into:
- `112-9701571-1565829` → iPad + toilet paper
- `112-5185628-8528221` → swabs + speakers

The URL `purchaseId=106-0433446-4196253` matched **neither** order.
Different prefix space (`106-` vs `112-`).

**Empirical observation 2 (single-fulfillment, 2026-05-04):** placed a
$2.37 single-item cart (Amazon-Basics cotton swabs, Amazon-fulfilled,
guaranteed no warehouse split). One item, one fulfillment.

| | Value |
|---|---|
| SPC URL `/checkout/p/p-XXX/spc` | `p-106-7831913-7719454` |
| Thank-you URL `?purchaseId=` | `106-7831913-7719454` (same as SPC) |
| **Actual orderId** | **`112-0005434-4738662`** |

**Even with zero possibility of fan-out, `purchaseId ≠ orderId`. Always.**
The `106-` and `112-` are completely separate number spaces. The earlier
hypothesis "purchaseId == orderId for non-split buys" is **disproved**.

### Why this matters
- **Trusting the URL `purchaseId` as an orderId is unsafe — period.** Not
  just for fan-out splits. Even for single-item, single-fulfillment,
  Amazon-Basics, Amazon-warehouse buys (the most boring case possible)
  the `purchaseId` is in a different number-space from the orderId. A
  worker that records it would later query
  `/gp/your-account/order-details?orderID=106-...` and get nothing back.
  Verify-phase would silently fail.
- **Latent bug in `readOrderIdFromUrl`** (`src/parsers/amazonCheckout.ts:57`):
  the function accepts `?orderId=` OR `?purchaseId=` as equivalent
  fallback. The `purchaseId` branch is **wrong** — it returns the
  checkout session ID, not an order ID. Currently dormant because
  `buyNow.ts:351` discards `parseOrderConfirmation`'s `orderId` and
  goes to history nav, but any future "trust parseOrderConfirmation"
  optimization would silently break. Recommendation: remove the
  `purchaseId` fallback from that line, or add a `source` discriminator
  so callers can tell apart trusted DOM/URL-orderId hits from the
  unsafe purchaseId hit.
- The body-regex fallback in `parseOrderConfirmation` is also unreliable:
  measured 2/3 saved thank-you fixtures returned the WRONG orderId
  (matched a recommendation card's order number) — exactly why
  `buyNow.ts` does the order-history nav.
- For multi-order splits, `fetchOrderIdsForAsins`
  (`buyWithFillers.ts:1154`) is the **correct** mechanism: navigate
  `/gp/css/order-history`, walk the DOM in document order, attribute
  each `/dp/<asin>` link to the most-recently-seen order id. Verified
  on this experiment — its output matched the actual split.
- `fetchOrderIdFromHistory` in `buyNow.ts:1945` (single-order path)
  **has a latent bug for fan-out cases**: it body-regexes the FIRST
  match only. If a buy-now click ever splits, the second order is
  silently dropped from the buy-now's record. Fan-out can happen even
  on a single-target buy if Amazon decides to split by warehouse —
  rare but real.

### Reliable order-ID sources, ranked
1. **Order-history walk** (`/gp/css/order-history`, document-order
   tree-walker) — only authoritative source for ASIN→orderId mapping.
2. **`#orderId` or `[data-order-id]` element on the live thank-you
   DOM** — scoped, reliable IF you can capture the page before
   Amazon's auto-refresh-to-recommendations kicks in (see below).
3. **URL `?purchaseId=` / `?orderId=`** — only the URL `orderId` form
   is trustworthy; `purchaseId` is the checkout session, NOT an order.
4. **Body-text regex** — UNSAFE, false-matches recommendation cards.

### purchaseId↔orderId mapping is NOT exposed post-checkout

**Date observed:** 2026-05-04

Verified empirically through aggressive endpoint probing:

| Avenue checked | Result |
|---|---|
| `/gp/css/order-history` HTML | ❌ no purchaseId anywhere on page |
| `/gp/your-account/order-details?orderID=...` HTML | ❌ no purchaseId |
| `/your-orders/orders/{orderId}` (AUI streaming JSON) | ❌ orderId yes, purchaseId no |
| `/gp/your-account/order-history?detail=true&orderId=...` | ❌ same |
| `/gp/your-account/order-details?orderID=...&output=json` | ❌ returns HTML, no purchaseId |
| `/orders/v1/orderTrackingDetails`, `/api/orders/...`, `/gp/aw/orderdetails`, `/api/y/your-orders/orders/...` | 404 (don't exist) |
| Order-search by purchaseId as keyword (`?search=106-...`) | ❌ returns 0 matching orders. The `hasPurchaseId: true` initially observed was a false signal — the search term is echoed back in input value/breadcrumbs but no order matches it. |
| Order-search by orderId as keyword (control) | ✅ correctly finds the order (sanity check) |

**Conclusion:** Amazon does NOT expose the purchaseId↔orderId
correlation anywhere accessible from a customer session. Their order
management system holds this mapping internally but it is not a
customer-facing concept. Order-search indexes orderId, item titles,
ASIN, seller name — but not the internal checkout session.

**Implication:** the purchaseId↔orderId correlation is only knowable at
order-placement time, when AmazonG sees the URL `purchaseId` AND walks
the just-updated order-history page. If the worker doesn't record the
purchaseId at that moment, the mapping is permanently lost.

This is the strongest argument for storing `amazonPurchaseId` on
`AutoBuyJob` (BG-side schema). It's a write-once, read-anytime audit
value with no fallback source.

### What CAN be reached programmatically (catalogued for future use)

`/your-orders/orders/{orderId}` returns ~333KB of `application/json-amazonui-streaming`
JSON in ~340ms. Same with `/your-orders/search?keyword=...`. These are
faster than full HTML page loads (which return ~860KB in ~300ms each).
Could be used to fetch order details without a `page.goto` — but they
don't expose any new IDs we don't already have. Mostly relevant if we
ever want to verify order status without a full page navigation.

`/gp/your-account/order-history?orderFilter=all&search=<orderId>` is the
fastest order-search; resolves a single orderId to its full card in
~300ms. Faster than scanning the entire history page.

---

## Thank-you page is fragile to refresh

**Date observed:** 2026-05-04

The thank-you URL is `/gp/buy/thankyou/handlers/display.html?purchaseId=...`.
Refreshing it (intentionally OR accidentally — e.g. via `location.reload`,
browser back-then-forward, or a `chk_typ_browserRefresh` redirect) makes
Amazon serve a **recommendations page** instead, with markers like
"Inspired by your browsing history" and "Deals on items viewed in the
last month." All `#orderId` elements and order-card structure are gone.
The URL adds `&isRefresh=1`.

### Implications
- A "save the thank-you HTML" approach via right-click → Save Page As
  is fragile. The browser may have already reloaded the page once on
  arrival. Use DevTools `Network` tab → the original response, OR
  `document.documentElement.outerHTML` paste from Console BEFORE any
  refresh, OR HAR export.
- AmazonG's `waitForConfirmationOrPending` (`buyNow.ts:1564`) detects
  the thank-you URL and proceeds. If it doesn't capture the DOM
  immediately, it can race the recommendations refresh. Currently
  works because `parseOrderConfirmation` runs before the next
  `page.goto`, but a slower variant could lose the original DOM.
- We do NOT have a saved fixture of an original (pre-refresh)
  thank-you page. Saved fixtures in `fixtures/thankyou/` are
  post-refresh recommendation pages — useful for testing the
  fall-through path but NOT for testing real order-id extraction.

---

## Cart-add HTTP endpoint (`/cart/add-to-cart/ref=...`)

**Date observed:** 2026-05-04 (multiple sessions)

The modern cart-add endpoint is `https://www.amazon.com/cart/add-to-cart/ref=...`.
The `ref=` portion is tracking metadata; Amazon doesn't validate it,
any string works. Production code uses
`Aplus_BuyableModules_DetailPage` as the `clientName` value.

### Required POST body fields (5 total)
- `anti-csrftoken-a2z` (104 chars in production)
- `items[0.base][asin]` (or legacy `ASIN`)
- `items[0.base][offerListingId]` (or legacy `offerListingID`) — typically 158-206 chars
- `items[0.base][quantity]` (default `1`)
- `clientName` (`Aplus_BuyableModules_DetailPage`)

All 5 fields live inside the PDP's `<form id="addToCart">`. The form's
declared `action` attribute (`/gp/product/handle-buy-box/...`) is a
**deprecated 404'er** — do not POST there. The modern endpoint above
accepts the harvested tokens directly.

### Live timing measurements
Across 12 separate live HTTP-add round-trips against a real signed-in
account (covering 5 distinct ASIN classes — books, electronics, kitchen,
digital, marketplace):
- **Buyable items:** 278–326ms per round-trip on the optimized path
  (page.content() reused, no second network fetch)
- **Non-buyable items** (Echo Dot 5th gen, AirPods, certain whey
  protein variants): `addToCart` form is missing `offerListingId`
  → helper returns null → caller falls through to Buy-Now click
  fallback. Same as before optimization.
- Response body to a successful POST is the rendered cart page
  (~600-700KB) containing `data-asin="<sent ASIN>"` — the
  phantom-commit guard regex (`buyWithFillers.ts:2140`) is correct.

### Endpoint stability signal
csrf token length consistent at 104 chars across all 9 PDPs probed.
offerListingId length varies 158–206 chars depending on product. ASIN
appears in both `items[0.base][asin]` and legacy `ASIN` inputs in
buyable PDPs.

---

## SPC delivery-radio click recalc (`eligibleshipoption` XHR)

**Date observed:** 2026-05-04

When AmazonG's `pickBestCashbackDelivery` clicks a delivery-radio on
`/spc`, the radio's enclosing `<div>` carries
`data-setactionurl="/checkout/p/p-{purchaseId}/eligibleshipoption?pipelineType=Chewbacca&referrer=spc&ref_=chk_spc_chgEligibleShipOption"`.
That URL is the recalc XHR Amazon's tango component fires.

### Live timing (signed-in account, single test cart, real network)

| t (ms) | event |
|---|---|
| 0 | click on unchecked delivery radio |
| 5–6 | XHR opens: `POST /checkout/p/p-XXX/eligibleshipoption` |
| 32 | sync click effect lands: `:checked=true` on **same** DOM node, `[checked]` HTML attr **NOT** yet present |
| **1918** | **XHR returns 200** |
| 1925 | radio's DOM node **REPLACED** by tango re-render; new node has `[checked]` baked in |

### Implications
- **The XHR takes ~1.9s on real network.** Current code waits 500ms
  inner + 1500ms outer = 2000ms total — barely covers it on slow
  connections.
- After click, the `:checked` *property* is correct on the old node.
  The `[checked]` *attribute* is not. `page.content()` serializes
  attributes only, which is exactly why
  `verifyTargetCashback` runs `syncCheckedAttribute` first (copies
  `:checked` PROP → `[checked]` ATTR) before `page.content()`.
- The radio's label text (where the "% back" string lives) is
  server-rendered static HTML and identical between old and new
  node. So `readTargetCashbackFromDom` reads correctly regardless
  of whether you read pre-swap or post-swap.

### The rare 6%→5% strip case
User-reported: occasionally after clicking a 6% delivery radio,
Amazon's XHR settles the cashback at the default 5% (Chase Amazon
card baseline) — the 6% offer was rescinded mid-XHR. The post-XHR
DOM correctly reflects the 5%, but the pre-XHR DOM still shows the
6% label that the picker clicked.

**Critical:** the 1.5s outer wait at `buyWithFillers.ts:686` is
specifically there to read POST-XHR. Reading earlier would mask
the strip and place an order at 5% expecting 6%. **Do not optimize
this wait without preserving the post-XHR-read invariant.**

A previously-considered optimization to drop this wait was rejected
on these grounds. See feat/checkout-speed-tier1 commit message for
the full rationale.

### `eligibleshipoption` URL pattern across fixtures
Stable. 5/5 saved /spc fixtures match
`/checkout/p/p-[\d-]+/eligibleshipoption?pipelineType=Chewbacca`.
Safe to use as a `page.waitForResponse` predicate IF needed for
future precise-wait optimization.

---

## Place Order form submission

**Date observed:** 2026-05-04

The Place Order button submits a form with:
- `action="/checkout/p/p-{purchaseId}/spc/place-order?pipelineType=Chewbacca&referrer=spc&ref_=chk_spc_chw_placeOrder"`
- `method="post"`
- `<input name="placeYourOrder1">` is the visible button input.

### Page navigates, no XHR
The submission goes via a regular HTML form POST, not via fetch/XHR.
This means:
- Wrapping `window.fetch` or `XMLHttpRequest` in a `page.evaluate`
  pre-click does **NOT** capture the response — the browser navigates
  the page entirely (response IS the new page).
- Playwright's `page.on('response')` *can* observe the response, BUT
  must be registered before the click and the navigation that follows.
- Capture the redirect chain via `page.on('framenavigated')` if you
  want the URL sequence, or the response via `page.waitForResponse`
  on the `place-order` URL pattern.

### Observed redirect chain
For a high-value cart triggering payment auth:

```
POST /checkout/p/p-{purchaseId}/spc/place-order
  → 302 /cpe/executions?...&pageType=CPEFront&subPageType=Redirections
  → 302 /gp/buy/thankyou/handlers/display.html?purchaseId=<aggregate>
  → (auto refresh) /gp/buy/thankyou/...?purchaseId=...&isRefresh=1
  → recommendations page
```

The `/cpe/executions` step is Amazon's payment-authorization redirector
(handles 3DS-like challenges). For Prime Visa or already-authorized
cards it auto-passes through.

### Implication for `parseOrderConfirmation`
By the time AmazonG's worker reads `page.content()` after Place Order,
the page may have already auto-refreshed past the original thank-you.
The current code mostly avoids this because Playwright's
`waitForURL(/thankyou/)` matches BEFORE the refresh, then
`page.content()` runs immediately. But timing is tight; future changes
that add latency between URL detection and content capture risk losing
the original thank-you DOM.

---

## Cart→/spc direct entry shortcut (`/checkout/entry/cart`)

**Date observed:** 2026-05-04

Massive speedup found while investigating Tier 3 candidates. Amazon's
BYG ("Need anything else?") "Continue to checkout" button points at
`/checkout/entry/cart?proceedToCheckout=1`. This is a server-side
handler that:

1. Reads the user's current cart server-side
2. Spins up a fresh checkout session (new `purchaseId`)
3. Returns 302 → `/checkout/p/p-{purchaseId}/spc?referrer=spc`

**Hitting it directly via `page.goto` bypasses three navigation-bound
steps in one shot:**
- the full cart-page render (was `page.goto(/cart)`, ~1-3s)
- the Proceed-to-Checkout click (form submit + URL nav, 1-3s)
- the BYG "Need anything else?" interstitial click (1-3s)

**Live measurements (signed-in account, 2026-05-04):**

| Run | URL | Took (ms) | Status | Body | Landed on /spc? |
|---|---|---|---|---|---|
| 1 | `/checkout/entry/cart?proceedToCheckout=1` | 248 | 200 | 354KB | yes (purchaseId 106-5470794-9078601) |
| 2 | same | 165 | 200 | 354KB | yes (purchaseId 106-8978053-6938658) |
| 3 | same | 161 | 200 | 355KB | yes (purchaseId 106-7257132-4899468) |
| 4 | same | 166 | 200 | 354KB | yes (purchaseId 106-9087009-0649853) |
| 5 | same | 166 | 200 | 354KB | yes (purchaseId 106-5226090-9524261) |

100% consistent. Every run gets a fresh purchaseId (so each page.goto
creates one session — perfect for the per-click model AmazonG uses).
`page.goto` (browser-side) verification: URL bar landed at
`/checkout/p/p-106-7373858-8417011/spc?referrer=spc` directly, no
intermediate cart or BYG render.

### Net savings

~3-8s per filler buy. Replaces a multi-step navigate-and-click
sequence with a single page.goto.

### Implementation (shipped in feat/checkout-speed-tier3)

In `buyWithFillers.ts` step 6, after fillers are HTTP-added:

```ts
const SPC_ENTRY_URL =
  'https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1';
await page.goto(SPC_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
if (SPC_URL_MATCH.test(page.url())) {
  // happy path — we're on /spc directly
} else {
  // fallback to old click-based flow
  await page.goto(CART_URL, ...);
  await clickProceedToCheckout(page);
  await waitForSpcOrHandleByg(page, cid);
}
```

### Why this is safe

- Amazon's checkout-entry handler reads from the **server-side cart**.
  HTTP filler adds returned 200 only after Amazon committed each item
  (verified by the ASIN-echo guard at `buyWithFillers.ts:2140`), so
  the items are guaranteed present when the handler reads.
- Fallback preserves correctness if Amazon ever shifts the URL pattern.
  Worst case = same wall-clock as before this optimization.
- `waitForSpcOrHandleByg` (`buyWithFillers.ts:2434`) is now dead code
  on the happy path but kept for the fallback. Don't remove without
  also removing the fallback.

### Caveats

- Each call creates a checkout session. If a page.goto somehow fires
  twice (retry on transient failure), two sessions are spun up — both
  cheap to abandon, but worth knowing.
- Cart-empty edge case: not probed live. The current `clearCart` step
  at filler-mode start makes this unreachable in practice (we always
  add at least the target before reaching this URL).

---

## Header dropdown / mini order list (not used)

Amazon's header "Returns & Orders" dropdown shows the most recent few
orders via an XHR endpoint. Not currently used by AmazonG. Could
theoretically be cheaper than full `/gp/css/order-history` for "give me
just the most recent orderId" — but doesn't solve ASIN→orderId mapping
for filler mode, and would be a new code path to maintain. Not
investigated in depth.

---

## Amazon Business Reporting API — does NOT apply

The Amazon Business Reporting API
(<https://docs.business.amazon.com/docs/reporting-api-overview>)
exposes order data programmatically, but only for Amazon Business B2B
accounts — a separate product from regular `amazon.com` retail. Orders
placed via the retail site **do not** appear in this API even if the
same email is associated. Not usable for AmazonG's flow without a full
migration to Amazon Business (different cart, different pricing,
different payment terms — would break BG's deal-arbitrage strategy).

---

## What we do NOT yet have empirical data on

- **Original thank-you DOM (pre-refresh)** for a real multi-order buy.
  Need to capture via DevTools Network → save response, or
  `document.documentElement.outerHTML` paste from Console immediately
  on arrival. Without this, we can't prove or disprove that all
  fan-out order IDs are present on the thank-you page itself.
- **Place Order POST response body**. Failed to capture in the
  2026-05-04 session because in-page fetch override doesn't fire on
  form submission and Playwright's per-page network log was reset by
  the subsequent nav. Future capture: register
  `page.on('response')` on the `/place-order` URL pattern BEFORE the
  click.
- **Multi-order thank-you-page DOM** — same as above. The 2026-05-04
  experiment confirmed the cart fan-out behavior but missed the
  thank-you DOM capture.

---

## Outstanding items / future work

- Fix the latent fan-out bug in `fetchOrderIdFromHistory`
  (`buyNow.ts:1945`) — currently returns only the first orderId-shaped
  match in body text; should return all of them, or use the
  document-order walk like `fetchOrderIdsForAsins`. (Correctness fix,
  not perf.)
- Capture an original thank-you fixture for a multi-order split next
  time one happens organically — that fixture would unblock multiple
  optimizations.
- Add `page.on('response')` instrumentation around Place Order in the
  Worker so production telemetry can show what Amazon's POST response
  actually contains. Read-only, no behavior change.
