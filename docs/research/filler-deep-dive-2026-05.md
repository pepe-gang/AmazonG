# Filler-mode deep-dive — 2026-05-05

Empirical research into the Buy-with-Fillers pipeline focused on identifying
remaining optimizations after v0.13.18. Live-tested against a real signed-in
Amazon account on 2026-05-05.

## TL;DR

Three concrete optimizations identified, ranked by payoff:

1. **Search-result cart-add forms** — every Amazon search-result card already
   embeds a complete cart-add form (csrf + offerListingId + asin + merchantId).
   We can skip the per-filler PDP fetch entirely. Saves ~700ms × 8 = ~5.6s
   of HTTP work, ~1.5–3s wall-clock with parallel workers.
2. **Batch cart-add** — Amazon's `/cart/add-to-cart/...` endpoint accepts
   multiple items in one POST (`items[0.base][...]`, `items[1.base][...]`,
   etc.). Tested with 8 items: 200 OK in 1396ms, all 8 landed. Replaces
   8 sequential POSTs (or 4-way parallel POSTs) with one HTTP call.
3. **HTTP-only up to /spc** — combine the above with the existing
   `/checkout/entry/cart?proceedToCheckout=1` shortcut so the entire
   "load PDP + add target + add 8 fillers + enter checkout" sequence is
   ~3 HTTP calls (one search, one batch POST, one /spc fetch). The
   browser tab is only needed at /spc onward (verify, Place Order, CPE).

Estimated savings on a typical filler buy: **5–9s** (current ~17–37s →
~10–20s). Bigger simplification: no parallel filler-worker coordination,
no phantom-commit guards, no per-filler PDP fetches.

## What does NOT work (negative results)

**Direct POST to `/spc/place-order` does not actually finalize an order.**
Tested live: status 200, response is an HTML page that redirects to
`/cpe/executions?...&pageType=CPEFront&subPageType=Redirections`. The
Checkout Pipeline Executions (CPE) layer requires browser-side JS to
complete payment authorization (likely token exchange / iframe-based
challenges).

Side effect: the POST DID consume the server-side cart (cart count went to
0 immediately). So a direct-POST attempt without CPE = lost cart AND no
order. **Place Order MUST run inside a browser tab so CPE can execute.**

## Endpoint map

### Cart-add — the canonical endpoint

```
POST https://www.amazon.com/cart/add-to-cart/ref=<any-tracking-marker>
Content-Type: application/x-www-form-urlencoded
Cookie: <session>
```

Body (single-item):

```
anti-csrftoken-a2z=<csrf>
items[0.base][asin]=<ASIN>
items[0.base][offerListingId]=<token>
items[0.base][quantity]=<n>
clientName=Aplus_BuyableModules_DetailPage   ← OR any of the variants below
```

Body (batch — verified 8 items, may accept more):

```
anti-csrftoken-a2z=<csrf>
clientName=EUIC_AddToCart_Search
items[0.base][asin]=<ASIN_0>
items[0.base][offerListingId]=<token_0>
items[0.base][quantity]=1
items[1.base][asin]=<ASIN_1>
items[1.base][offerListingId]=<token_1>
items[1.base][quantity]=1
...
items[7.base][asin]=<ASIN_7>
items[7.base][offerListingId]=<token_7>
items[7.base][quantity]=1
```

`clientName` accepts at least: `Aplus_BuyableModules_DetailPage` (PDP path),
`EUIC_AddToCart_Search` (search-results path). Amazon's response is the
cart-page HTML; presence of each ASIN's `data-asin="..."` attribute confirms
commit (same phantom-commit guard as today).

### Search-result page exposes complete cart-add forms

Each `[data-asin][data-component-type="s-search-result"]` card contains a
`<form>` with action `https://www.amazon.com/cart/add-to-cart?ref=sr_atc_rt_add_d_<rank>...`
and 8 hidden inputs:

```
anti-csrftoken-a2z
clientName              (= "EUIC_AddToCart_Search")
items[0.base][asin]
items[0.base][offerListingId]   ← this is the win
items[0.base][quantity]         (default "1")
minOrderQuantity
maxOrderQuantity
merchantId
```

The `offerListingId` is the SAME token a PDP fetch would yield; both POST
to the same `/cart/add-to-cart` endpoint and behave identically.

**Implication**: a single `ctx.request.get(searchUrl)` returns ~50 cards,
each with a ready-to-POST cart-add token. The current per-filler flow does
1 search + N PDP fetches; the optimized flow does 1 search + 1 batch POST.

### `/checkout/entry/cart?proceedToCheckout=1` (already shipped in v0.13.17)

Existing optimization: server-side handler that reads the user's cart,
spins up a checkout session, and 302-redirects to `/checkout/p/p-{purchaseId}/spc`.
HTTP fetch returns the /spc HTML directly in 1–3s.

### `/spc/place-order` — REQUIRES BROWSER

```
POST https://www.amazon.com/checkout/p/p-<purchaseId>/spc/place-order?referrer=spc&ref_=chk_spc_chw_placeOrder
Body:
  anti-csrftoken-a2z=<csrf-from-place-form>
  placeYourOrder1=Place your order
  hasWorkingJavascript=1
```

**HTTP-only POST returns 200 but the order doesn't land.** Response is HTML
that triggers a JS redirect to `/cpe/executions` for payment auth. Without
a browser executing that JS, the order is consumed-but-not-finalized.
Cart goes empty either way.

**Conclusion**: keep the click-based Place Order path. The /spc HTML can
still be HTTP-fetched for cashback/price/address verification BEFORE
clicking, but the click itself must happen in a real tab.

## Live timings (2026-05-05, signed-in account)

| Step | Current code | HTTP-only experiment |
|---|---|---|
| Cart clear (HTTP path, 8 items) | ~1.5s | (same) |
| Search result HTTP fetch | n/a (per-worker) | ~1.0s |
| 8 fillers add (4-way parallel HTTP) | ~3–6s | n/a |
| 8 fillers batch POST | n/a | ~1.4s |
| Target HTTP cart-add (PDP fetch + POST) | ~1.4s | included in batch |
| `/checkout/entry/cart` → /spc shortcut | ~1.5–3s (page.goto) | ~2.2s (HTTP fetch) |
| `/spc/place-order` POST (won't actually place) | n/a | ~2.4s (but useless) |

End-to-end pre-checkout phase (cart-add + fillers + /spc shortcut):

- **Current (v0.13.18)**: ~6–11s
- **HTTP-only with batch**: ~4–5s

Savings ~2–6s, not counting the browser-tab setup overhead the current
path also incurs (scrapeProduct + setMaxQuantity).

## The big simplification (orthogonal to raw timing)

Current `addFillerItems` is ~120 lines: a state machine with parallel
async workers, queue management, search-then-add cycles, dedup tracking,
phantom-commit guards. With batch cart-add:

```ts
async function addFillerItemsBatch(page, targetAsin, fillerOpts) {
  const tokens: AddFillerToken[] = [];
  for (const term of pickTerms(fillerOpts.terms, 2)) {
    const cards = await searchAndExtractTokens(page, term);
    for (const c of cards) {
      if (tokens.length >= fillerOpts.targetCount) break;
      if (c.asin === targetAsin || tokens.some(t => t.asin === c.asin)) continue;
      tokens.push(c);
    }
    if (tokens.length >= fillerOpts.targetCount) break;
  }
  // Single batch POST
  return batchAddToCart(page, tokens);
}
```

~30 lines, no parallel coordination, no per-filler PDP fetch, one HTTP
POST instead of N. Failure modes collapse to "search returned too few
cards" (rare — Amazon always returns 50+ per term).

## Proposed implementation plan (next branch)

1. **Search-result token extractor** — pure function, mirrors the existing
   `extractCartAddTokens` shape but reads from search-result `<form>`s
   instead of PDP `<form>s`. Add to `src/actions/amazonHttp.ts`.
2. **Batch cart-add HTTP helper** — accepts an array of tokens, builds the
   `items[i.base][...]` body, POSTs to `/cart/add-to-cart`. Verify
   response contains every requested ASIN (existing phantom-commit guard
   pattern, just iterated).
3. **Refactor `addFillerItems`** — replace the parallel-worker state
   machine with the simpler "search a couple of terms, dedup, single
   batch POST" flow. Keep the existing per-filler tier 2/3 fallbacks
   gated on a feature flag during rollout.
4. **Optional**: extend the batch to include the target item's PDP-form
   tokens, so a single POST commits target + 8 fillers. This eliminates
   the separate `addFillerViaHttp(target)` call.

Risk profile: low. The endpoints are already in production use (Amazon's
own search-page Add to Cart buttons POST to the same endpoint). The
phantom-commit guard pattern transfers directly. Tier 2 (Buy Now click)
and tier 3 (cart-page click) remain available as fallbacks.

## Things still worth probing

- **Is there an upper bound on `items[N.base][...]` per POST?** Tested 8;
  may scale to 20+. Test before relying on a single batch for large
  filler counts.
- **Can we skip `scrapeProduct`?** The PDP HTML carries everything
  `verifyProductDetailed` needs (price/title/in-stock/prime/buy-now).
  Replacing `page.goto(productUrl)` with `ctx.request.get(productUrl)`
  + JSDOM verify could save ~1.5–3s, but risks missing JS-rendered state.
  Worth probing: do our verify checks actually depend on hydration?
- **CPE flow inspection**: capture the exact JS calls CPE runs after
  Place Order to understand whether we could ever bypass it. Likely not,
  but a structured capture (page.on('response') over 5s post-click)
  would settle it.
- **Place Order POST status response**: re-run the direct-POST experiment
  with a clean cart and inspect the FULL response body + the JS that
  loads on `/cpe/executions`. The JS may make POST calls to a known
  endpoint we could replicate.
