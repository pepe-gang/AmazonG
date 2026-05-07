# Bypass research: "Quantity limit met for this seller"

**Date:** 2026-05-06
**Test product:** `B0GR1J6T45` (Apple 2026 MacBook Air 13" M5, Starlight)
**Test profile:** Cuong @ Portland 97230 (BG2 buy-group account)
**Branch:** `research/qty-limit-bypass`

## TL;DR

For `B0GR1J6T45` on this profile **today**, **no Sold-by-Amazon / Shipped-by-Amazon bypass exists** that I could find via web surfaces. Amazon's gate is enforced server-side, account-bound, fully propagated to every surface, and not address/UA/surface dependent.

A **3p (Marketplace) AOD bypass works** — proven live, item lands in cart, no captcha — but the alternate sellers available right now (Adorama / Expercom / DataVision / 6ave) all violate the user's Amazon-only constraint.

## What's actually happening on Amazon's side

Order-history evidence: **this profile took delivery of 3× B0GR1J6T45 today**.

Amazon's gate is "**per (account, ASIN, seller-merchantId, time-window)**". Once `count(account=Cuong, asin=B0GR1J6T45, seller=ATVPDKIKX0DER, day=today) === 3`, the gate fires. The exact threshold (3/day) and window (calendar day Pacific) are inferred from today's behavior — confirm against future hits.

When the gate is on, Amazon's SSR layer strips the locked offer's `offerListingId` from every surface that could carry a buy button. The metadata (price, seller name, condition, ratings) is preserved; only the buyable token is removed.

## Surfaces probed — empirical

| Surface                                                       | Has Amazon `offerListingId`? | Has buyable form? |
|---------------------------------------------------------------|------------------------------|-------------------|
| Main PDP `/dp/B0GR1J6T45`                                     | No (input present, value="") | No                |
| Legacy `/gp/product/B0GR1J6T45`                               | No                            | No                |
| AOD overlay `/dp/<asin>?aod=1`                                | No (pinned offer present, no form) | No (for Amazon offer; YES for 3p) |
| `/gp/buyagain`                                                | No (filtered out entirely)   | No                |
| Search `/s?k=B0GR1J6T45` results card                         | No                            | No                |
| iOS UA (`Mozilla/5.0 (iPhone…)`) — all 3 URL forms             | No                            | No                |
| Android UA (`Mozilla/5.0 (Linux; Android…)`)                   | No                            | No                |
| Cart row (after 3p add)                                       | n/a — the line is the 3p one | n/a              |

In other words: SSR is consistent across surfaces and clients. The gate is not a UI strip you can route around.

## What didn't work (counter-attempts I tried)

1. **Empty `offerListingId` in cart-add POST** → 200 OK but body is Amazon's "errors.amazon.com" / "something went wrong" page — not actually added.
2. **Legacy `/gp/aws/cart/add.html?ASIN.1=...`** → same Amazon error page.
3. **Modern endpoint with `clientName: mobile-cart-add` / `BuyAgain`** → clean 400.
4. **iOS / Android UA spoofing on every PDP variant** → server-side strip identical.
5. **Address swap** (Portland 97230 → Sunnyvale 94089) → glow address-change confirmed firing; PDP fetch from Sunnyvale still shows the lock. Limit is account-bound, not address-bound.
6. **Wishlist "Add to List"** → opens the *Create List* popover (this profile has no default wishlist), not a direct cart-add path.
7. **Search-results card form harvest** → forms stripped from the card alongside the PDP.
8. **`/buyagain` direct cart-add forms** → 21 forms exist on the page, all `clientName=Personalization_BuyAgain`, but none target `B0GR1J6T45` (Amazon already filtered it out at the buyagain page level).

## What did work — but breaks the constraint

**3p AOD direct add.** Empirically verified live (test cart, item subsequently removed):

- POST `/cart/add-to-cart/ref=aod_dpdsk_new_1` with the **Adorama** seller's `offerListingId`
- Status 200, 873KB cart-page HTML, classic success markers (`Subtotal`, `addedToCart`, `smart-wagon`), 342ms
- Item lands in active cart at $1,074 (Amazon's locked offer was $949 — markup +$124, +13%)

POST shape (matches `amazonHttp.ts:CART_ADD_URL` format AmazonG already uses):

```http
POST /cart/add-to-cart/ref=aod_dpdsk_new_1
Content-Type: application/x-www-form-urlencoded

anti-csrftoken-a2z=<page-csrf>
items[0.base][asin]=B0GR1J6T45
items[0.base][offerListingId]=<3p-seller's-olid>
items[0.base][quantity]=1
items[0.base][additionalParameters][listPurchaseAttribution][listAttributionId]=
items[0.base][additionalParameters][listPurchaseAttribution][itemAttributionId]=
clientName=OffersX_AllOffersDisplay_DetailPage
submit.addToCart=
```

The `clientName` differs from AmazonG's current (`Aplus_BuyableModules_DetailPage`); the `additionalParameters[listPurchaseAttribution]` fields are sent empty.

## Additional probes (also tried, also fail)

After the first round, I pushed harder:

| Surface / endpoint                                               | Result                                                                                                  |
|------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `GET /gp/buy/buynow/handlers/display.html?asin=B0GR1J6T45`       | 404                                                                                                     |
| `GET /gp/buy/?gift=1`                                            | 404                                                                                                     |
| `GET /gp/offer-listing/B0GR1J6T45?m=ATVPDKIKX0DER&condition=new` | 200 — same redirect to AOD overlay; same locked offer + 6 3p forms, no Amazon form                      |
| `POST /checkout/entry/buynow` with `asin=B0GR1J6T45, olid=""`    | 200 (222KB) but **no** `/checkout/p/` redirect, no SPC funnel — silent fail                              |
| Exhaustive regex scan for any olid-shaped (`[A-Za-z0-9+/=%]{60,140}`) token in the PDP HTML adjacent to `offerListingId` / `olid` / `ATVPDKIKX0DER` | Zero. The only matches are unrelated CSRFs, share-URL mailto body fragments, and twister-state nonces.  |

So the locked Amazon offer's `offerListingId` is **wholesale stripped from SSR** for this ASIN on this account. There's no surface that leaks it.

## Surfaces I'd still want to probe (didn't reach this session)

These are progressively more aggressive / require more setup:

1. **Cart-conflicts / merge endpoint** — when you switch ship-to with cart contents, Amazon's merge handler runs. May handle line items via a different gate. The address popover even ships its own `cart-conflicts-anticsrf-token`. Worth a focused probe.
2. **Share-cart import** — Amazon's `/gp/cart/share` lets one account export a cart; importing into another account may not re-check the per-account counter on each item. Needs a 2nd account with B0GR1J6T45 in cart.
3. **Amazon iOS app's protobuf API** — different protocol, possibly different gates. Requires Charles/Proxyman capture from an actual iPhone.
4. **Wishlist add via direct API** (skipping the "Create List" popover by pre-creating the list, then POST to `/hz/wishlist/add-item`) — maybe the wishlist→cart move-to-cart is keyed by list-id, not by per-account counter.

## TL;DR — no bypass found that respects the constraint

For `B0GR1J6T45` on Cuong @ Portland today: **the gate is rock-solid via web surfaces**. Amazon enforces it server-side, propagates the strip everywhere, and doesn't leak the locked olid. The 3p AOD path works but violates the Amazon-only requirement.

Practically, the operator-side moves are:

- **Multi-account fan-out** (existing buy-group model) — once Cuong hits 3/day, dispatch to Amy/Huy/Nick.
- **Daily-reset retry** — record the lock with timestamp, retry at predicted window roll.
- **3p fallback as opt-in** — Plan A in this doc, gated by the constraint flags, lets operators *consciously* take a markup hit when no other account is available.

The first two are pure scheduling; the third is the only code change.

## What's shippable in AmazonG

### Plan A — 3p AOD fallback (gated by user toggle + price cap)

When `productConstraints.ts:120-130` returns `quantity_limit`, *don't* terminate the buy. Instead:

1. Fetch `/dp/<asin>?aod=1&th=1` (Node-side, `ctx.request.get`).
2. Parse the AOD HTML for `<form action="/cart/add-to-cart/...">` blocks → `[{ olid, csrf, sellerName, shipsFrom, condition, price }]`.
3. **Filter** by user's `experimental.altSellerOnQuantityLimit` flags:
   - `requireAmazonSold: boolean` (default true) — only accept sellerName === "Amazon.com"
   - `requireAmazonShipped: boolean` (default true) — only accept shipsFrom === "Amazon.com"
   - `maxAltSellerMarkupPct: number` (default 10) — drop offers above `origPrice * 1.10`
4. Pick the lowest-price surviving offer. POST cart-add with its olid.
5. If no offer survives the filter, return the existing `quantity_limit` terminal.

**Honest gotcha:** for some products on some days, *no* alternate Amazon-fulfilled offer will exist (e.g. today on B0GR1J6T45 — all 6 alt offers are 3p). Plan A just falls through cleanly in that case. It's an *opportunistic* bypass, not a guaranteed one.

### Plan B — Skip-and-record (no bypass attempt; just better telemetry)

If we accept that the constraint really is Amazon-only and no bypass exists for the locked-out hours, the cleanest thing is:

1. Detect `quantity_limit` (today's logic) — terminal.
2. Record: `{ asin, account, observedAt, todaysOrderCount }` to a local JSONL.
3. Surface a "next safe retry" estimate based on observed reset cadence.
4. Optional: schedule a retry at the predicted reset boundary.

No code path here actually bypasses Amazon — but it stops AmazonG from spinning on doomed retries and gives the operator something to plan around.

### Plan C — Multi-account hand-off (uses existing infrastructure)

When `account=Cuong` hits `quantity_limit` for `asin=X`, the buy-group's other accounts (Amy, Huy, Nick, etc.) with their own daily counters can still buy. AmazonG already supports per-account fan-out. The minimal change:

1. Detect `quantity_limit` for one profile.
2. Mark `(asin, account, dayKey)` as locked in a per-day cache.
3. When picking profiles for the same buy, skip locked ones.
4. Fan-out to the surviving profiles.

This is the existing buy-group operating model, just made explicit. Not a "bypass" but the right structural move — better than per-call retries.

## Risk + ToS notes

Amazon's per-account quantity limit is a documented commerce control. The 3p AOD path hits Amazon's normal commerce flow (UI-shape POST to a public endpoint). Operators do this every day by clicking "See All Buying Options" — it's not detection-evasion. The other angles in "what's left to probe" are progressively more aggressive; the iOS-protobuf and share-cart paths in particular start to look like surface-shopping, which I'd call out before shipping.
