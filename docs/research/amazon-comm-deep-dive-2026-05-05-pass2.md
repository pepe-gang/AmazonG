# Amazon-comm deep dive — pass 2 — 2026-05-05

Second-pass speed audit of v0.13.20. The first pass concluded the buy
phase is "well-tuned, next wins come from Amazon-side changes." This
pass looked for gaps the prior investigation didn't fully exhaust:
sub-phase timing, multi-profile fan-out, network blocking, session
reuse, dead-time pre-fetches, verify/tracking specifics, Place-Order
hydration.

The result is mixed. Most of the prior pass holds — the **buy hot
path inside one profile** is at or near its floor. But several real
wins exist outside that path:

1. **No `page.route()` blocking exists anywhere.** Images/fonts/3p
   ads load on every PDP and /spc nav. Likely the single biggest
   unshipped win.
2. **Sessions are torn down at the end of every job** and re-launched
   from scratch on the next. Cold-start cost (~2-4s of
   `chromium.launchPersistentContext`) is paid every time.
3. **Multi-profile fan-out runs scrapeProduct N times** for the same
   ASIN. One PDP HTML fetch could feed every profile.
4. **fetchTracking re-fetches the order-details HTML** that
   verifyOrder already fetched ~1 ms earlier. Pure duplicate work.
5. **`buyNow`'s buy-now-click path orphans `preflightCleared`** —
   the HTTP clearCart fires but is never awaited, doing 1-2 useless
   HTTP requests per buy.

## TL;DR — top 3 by `expected_saving / risk`

| Rank | Candidate | Expected saving | Risk | Notes |
|---|---|---|---|---|
| 1 | **Block images + fonts on PDP / search / cart / spc / order-details / ship-track via `context.route()`** | 1-3s per page nav (PDP+/spc are the big ones) — **~3-5s/buy** | Low | Standard Playwright pattern. Whitelist `text/html`, `application/json`, `application/javascript`, `text/css`. Image + font blocks save the most because Amazon ships ~50-200 images per PDP. Already proven safe by hundreds of bot-frameworks. Risk caveat: cashback radio labels include a Prime/Citi-card icon SVG — make sure SVGs aren't blocked, and verify `verifyTargetCashback` still reads the "% back" text after the route filter is on. |
| 2 | **Skip `verifyOrder`'s redundant fetch in `fetchTracking`** | ~1.0s on every active fetch_tracking job (no buys, but bulk fetches save N×1s) | Low | `verifyOrder` already fetched the same HTML. Refactor: have `verifyOrder` return the parsed Document (or HTML) on active outcomes, then `fetchTracking` reuses it for ship-track link enumeration. Pure code-shape change, no behavior change. |
| 3 | **Reuse session across consecutive jobs for the same profile** | ~2-4s on every buy after the first (session warmup + initial cookie/TLS setup) | Low-Med | Today every successful buy calls `closeAndForgetSession`. The next claim's `getSession` reopens chromium. Replace with idle-timeout (close after N minutes of inactivity) + cap-on-windows. Risk: fresh sessions are simpler — a stuck Playwright context would persist if reused. Mitigate with health-check on reuse. |

## Punch list (full)

| # | Candidate | File:line | Change | Win/buy | Risk | Notes |
|---|---|---|---|---|---|---|
| **A. Resource blocking** ||||||
| 1 | Block images on PDP nav | `scrapeProduct.ts:196` (`page.goto`); install at session level in `driver.ts:31` (after `launchPersistentContext`) | `context.route('**/*', r => imageOrFont(r) ? r.abort() : r.continue())` for image, font, media, css that's not Amazon's own. PDP-side: the `waitForFunction` at `scrapeProduct.ts:208` exits when buy-box hydrates, which is JS-driven, not image-gated. Nothing in the static parser or `runtimeVisibilityChecks` reads images. | 1-3s | Low | Test `runtimeVisibilityChecks` still reads computed style after blocking. |
| 2 | Block images on /spc nav | `buyWithFillers.ts:614` (page.goto SPC_ENTRY_URL); `buyNow.ts:215` | Same context-level route. /spc renders many product thumbnails per line item; blocking them cuts hydration. `pickBestCashbackDelivery` reads label text only. `verifyTargetCashback` reads "% back" text. Both work without images. | 1-3s | Low | Same as above. |
| 3 | Block ads/3p tracking everywhere | `driver.ts:31` | Block any URL whose host is on a known Amazon ad/analytics list (`fls-na.amazon.com`, `aax-us-iad.amazon.com`, `unagi.amazon.com`, etc.). | 0.3-1s | Low | Standard ops hygiene. |
| **B. Session reuse + warm cookies** ||||||
| 4 | Keep session alive between consecutive jobs for the same profile | `pollAndScrape.ts:2245`, `:2229`, `:2109` etc. — every `closeAndForgetSession` after a successful buy | Replace immediate close with an idle-timeout (e.g. 60s). Next claim for the same profile reuses the warm context. | 2-4s on the **2nd+ buy of a deal queue** | Low-Med | Adds memory pressure (one Chromium per active profile). Cap to N idle sessions. |
| 5 | Pre-warm sessions on worker boot for enabled profiles | `pollAndScrape.ts:644` (worker start) | When the loop starts, fire `getSession()` for each enabled+signed-in profile in parallel. Costs ~3s wall-clock; pays back the first buy. | 2-4s on the first deal after worker (re)start | Med | Prior pass rejected this as marginal. Quantify: an active worker may restart 1-3×/day after auto-update. If queue length ≥ 5 deals/day, pays for itself easily. **But** combined with #4 it's redundant. Pick one. |
| **C. Multi-profile fan-out (NEW — prior pass missed this)** ||||||
| 6 | Share PDP scrape across fan-out profiles | `pollAndScrape.ts:1014` (pMap loop), `:2025` (per-profile `scrapeProduct`) | One profile fetches the PDP HTML via HTTP `ctx.request.get(productUrl)` BEFORE pMap fan-out, parses once with `parseProductHtml`, and the shared `ProductInfo` is passed to every profile via `prescrapedInfo`. The runtime visibility check needs a real Page so each profile still does **only** the runtime check (~200-400ms via `page.goto + runtimeVisibilityChecks`), not the full `scrapeProduct` (~2s). | (N-1) × 1.5s for N-profile fan-out — **3s on a 3-profile buy, 6s on 5** | Med | Non-trivial: the runtime check still needs `page.goto`. But you can short-circuit: if static parser says `isPrime=false`, skip the runtime check entirely (the conservative reconcile rule says false wins). Potential simpler version: do ONE shared HTTP PDP fetch, every profile reuses the parsed info, ONE profile (lowest email or whatever) does the runtime override and broadcasts `isPrime`. Real check needs a fixture run to confirm runtime check is account-invariant. |
| 7 | Cap-aware parallel scrapeProduct overlap | `pollAndScrape.ts:2025` | Independent of #6: today every profile's `scrapeProduct` runs sequentially when `concurrency=1` (default for some users). When concurrency > 1, profiles already overlap natively via pMap. Settings default of 3 already gets this. Verify users haven't dropped to 1. | 0 if cap≥2 | — | Just observability — not a change. |
| **D. Sub-phase timing within scrapeProduct** ||||||
| 8 | Lower `loadProductPage` `waitForFunction` cap from 10s to 5s | `scrapeProduct.ts:226` | `.catch(() => undefined)` already suppresses timeout. Cap is a worst-case bound. Live PDPs hydrate in 1-3s; the 10s cap only fires when Amazon is broken AND we're going to fail downstream anyway. | 0 typical, **5s on degenerate cases** | Low | Pure tail-latency improvement. Not on hot path. |
| 9 | Run runtime visibility check in parallel with static parse | `scrapeProduct.ts:53-60` | After `page.content()`, `parseProductHtml` is sync, then `runtimeVisibilityChecks` runs after. They could parallel: `Promise.all([sync parseProductHtml, page.evaluate(runtimeChecks)])`. parseProductHtml is JSDOM (~50-100ms), runtime check is `page.evaluate` (~100ms). | ~50-100ms | Low | Marginal; only valuable if many in flight. |
| **E. Sub-phase timing in buyWithFillers / buyNow** ||||||
| 10 | Combine `findPlaceOrderLocator` selector probes into one evaluate | `buyNow.ts:1973-1989` | Today: 9 sequential `await loc.count()` calls — each is a CDP round-trip (~5-15ms each = 50-150ms total). Replace with one `page.evaluate(selectors => …)` that walks all selectors and returns the index of the first match. | ~50-150ms | Low | Cosmetic but adds up at scale. |
| 11 | Parallelize the first 2 filler search-term fetches | `buyWithFillers.ts:2226-2247` | Today the for-loop is sequential. ~80% of buys need only one term, but when the first term yields too few candidates (after dedup), term 2 runs serially after term 1 completes. Fire 2 in parallel; concat results; if still short, fire term 3+. | ~1s in the ~20% case where term 1 underflows | Low | Cheap; just an `await Promise.all([fetch(term[0]), fetch(term[1])])`. |
| 12 | Don't run `preflightCleared` on the buy-now path | `pollAndScrape.ts:2023`, `buyNow.ts:165-171` | When `path === 'buy-now'`, the `preflightCleared` Promise is started but never awaited. Wastes 1.1s of HTTP work per single-mode buy. Move the `clearCartHttpOnly` call to inside the `path === 'add-to-cart'` branch of `buyNow`, OR check buyability via cheap PDP-DOM scan before firing it. | ~1.1s of HTTP capacity (not wall-clock — but reduces Amazon edge load and frees the cookie pool) | Low | More about resource hygiene than wall-clock. Wall-clock impact = small (HTTP doesn't block buy-now click), but Amazon may rate-limit on too many parallel requests per cookie. Worth fixing. |
| **F. Verify + fetch_tracking** ||||||
| 13 | Skip duplicate order-details fetch | `fetchTracking.ts:38` calls `verifyOrder`; `:55-65` re-fetches the same URL | Refactor `verifyOrder` to optionally return the HTML/Document on `active` outcomes; `fetchTracking` reuses it. | ~1.0s per active fetch_tracking | Low | Pure plumbing fix. |
| 14 | Run verifyOrder + ship-track fetches in parallel for fan-out cases | `pollAndScrape.ts` verify + tracking handlers | The lifecycleInFlight cap already parallelizes across profiles. But within a single fetch_tracking run, the verifyOrder fetch is serial-before the ship-track fan-out. After fix #13 there's nothing to parallelize at this level (verify→ship-track is a dependency). Skip. | n/a | — | Documented for completeness. |
| 15 | Lifecycle cap honors current setting at promise-resolution time | `pollAndScrape.ts:691-696` | Current loop reads `cap` once per claim then fans out. Verified. No issue. | — | — | — |
| **G. /spc Place Order timing** ||||||
| 16 | Use `page.waitForResponse` on `eligibleshipoption` URL pattern instead of `waitForTimeout(1500)` | `buyWithFillers.ts:825`, `buyNow.ts:315` | `amazon-pipeline.md:227-231` confirms `eligibleshipoption` URL pattern is stable. Wait for the **actual XHR completion** via `page.waitForResponse(/eligibleshipoption.*pipelineType=Chewbacca/)` with a 2.5s cap. Most XHRs finish in 1.5-2s; on slow networks the wait holds up to the cap; on fast networks it returns at ~1.0s. | 0.5s on fast networks, **safer** on slow networks | Low-Med | The 1500ms blind wait was specifically calibrated to cover the post-XHR settle. Replacing with predicate-wait removes the magic number and is more robust. **Critical:** preserve the post-XHR-read invariant for the 6%→5% strip case. |
| 17 | Drop the `waitForSelector('#deliver-to-address-text...', 2_000)` warm-up | `buyWithFillers.ts:782-786` | This 2s wait is meant to give /spc panels time to hydrate before `ensureAddress` runs. Inside `ensureAddress`, Playwright auto-waits on its own selector ops anyway. Verify the inner waits cover the panel hydration; if so, drop the outer wait. | ~0.5-1s typical | Med | Need to verify `ensureAddress` doesn't false-fail when the panel hasn't hydrated. Read the function body. **Don't change without targeted regression testing.** |
| 18 | `setMaxQuantity` runs sequentially before `page.content()` capture | `buyWithFillers.ts:350` then `:369` | `setMaxQuantity` mutates the DOM (sets dropdown value, fires 'change'). The post-mutation HTML capture then carries the updated quantity. **But:** for the HTTP cart-add path, the quantity is threaded via the body builder, not from the DOM. So the dispatched 'change' event is purely cosmetic. The dropdown selection is read once via `qty.selected`, returned synchronously. So `setMaxQuantity` could potentially be just a `page.evaluate(() => max numeric option text)` without the dispatchEvent — saves the change-handler round-trip. | <100ms | Low | Marginal. |
| 19 | Tighten Place Order `waitFor({state: 'visible', timeout: 1_000})` | `buyWithFillers.ts:1095`, `buyNow.ts:407` | Already at 1s cap. Typical case <100ms. Already optimized. | n/a | — | — |
| **H. Reconsidered HTTP-only scrape (hybrid)** ||||||
| 20 | HTTP-fetch PDP, parse, then page.goto in parallel for runtime checks | `scrapeProduct.ts:19-61` | Hybrid: kick off `ctx.request.get(pdpUrl)` AND `page.goto(pdpUrl)` together. The HTTP fetch returns ~1s sooner; static parse runs immediately on its body. The page.goto continues for runtime visibility checks. Net: static info available 1-2s sooner; runtime check still gates the conservative reconcile. **But** info is only useful AFTER page.goto completes (since reconcile uses runtime). So no real win unless the caller can act on partial info. | 0 unless workflow is restructured | Med | Prior pass: rejected. Re-confirmed. The static parse alone isn't enough info to act on. Static + runtime is the contract. |
| 21 | Combine target + fillers into ONE batch cart-add POST | `buyWithFillers.ts:454` (target add) + `:563` (fillers add) | Today: 2 sequential HTTP POSTs (target ~0.3s, fillers ~1.4s = ~1.7s). Combine into a single `items[0..N]` POST with mixed PDP-token + search-token sources (target's csrf comes from PDP, fillers' csrf comes from search results — but Amazon accepts ONE csrf per POST per the prior research). Need to verify whether using PDP csrf with search-extracted offerListingIds actually commits all items. | ~0.5-1s | Med | Prior pass flagged a phantom-commit guard issue: 9-item batches truncate the response echo to 2-of-9 ASINs. With a follow-up cart-fetch verify (~500ms), the win is ~0-0.5s — **break-even at best**. Not worth the risk. **Reject.** |
| **I. Cosmetics / hygiene** ||||||
| 22 | Drop `setMaxQuantity`'s `dispatchEvent('change')` for filler-mode | `buyWithFillers.ts:350` calls `setMaxQuantity`, but the value is read out and threaded through HTTP body | The dispatchEvent fires Amazon's onChange handler which the HTTP path doesn't need. | <50ms | Low | Tiny. |
| 23 | Skip `cancelFillerOrdersOnly` retry waitForTimeout(8s) when terminal | `buyWithFillers.ts:1257` (in `pollAndScrape.ts`) | Already broken out via `isTerminalCancelReason`. Verify path actually fast-exits on terminal — yes (line 1259 sets `terminalRefusal = true`, breaks the loop before the 8s wait). No change needed. | 0 | — | Already optimized. |

## Empirical timings — new measurements

This pass did NOT place a real order (buy phase already extensively
characterized 2026-05-04). Empirical work was code-reading focused,
plus the existing fixtures referenced in `amazon-pipeline.md`. I
verified:

- **No `page.route()` calls in the codebase** (`grep -rn "context.route\|page.route" src/` → 0 hits). Confirmed gap.
- **No session reuse** — every `closeAndForgetSession` is unconditional after success or failure (verified at `pollAndScrape.ts:2109,2229,2245,2300,1529,1831`). Confirmed gap.
- **Duplicate order-details fetch** in `fetchTracking` (line 38 → verifyOrder fetches; line 57 fetches again). Confirmed.
- **Per-profile scrapeProduct** in `pollAndScrape.ts:2025` runs inside the pMap loop body, after `getSession` per profile. No shared scrape. Confirmed gap.
- **Orphaned `preflightCleared`** in buy-now path: `buyNow.ts:165-171` clicks Buy Now; nothing in this branch awaits `opts.preflightCleared`. The Promise resolves into the void. Verified.

If you want hard numbers, place a $5 order on a test ASIN with each
candidate enabled and read `pollAndScrape.ts` log timings (every step
already emits `step.*.ms`). The infrastructure is there.

## Rejected ideas

- **Direct `/spc/place-order` POST.** Confirmed dead in prior pass. CPE
  must run in browser. No change.
- **Cart batch with target+fillers in one POST (#21).** Phantom-commit
  guard issue + follow-up cart-fetch needed = breaks even. Not worth
  the complexity.
- **HTTP-only PDP scrape (#20).** Reconcile rule depends on runtime
  override; can't act on static-only info.
- **Pre-warm sessions if #4 ships.** Redundant.
- **Lower `waitForCheckout` deadline below 30s.** Typical /spc hydrates
  in 0.5-2s; the 30s deadline only matters when Amazon is broken AND
  we're going to fail downstream regardless. Tail-latency only.
- **Dropping the 1500ms post-delivery-pick wait outright.** Pipeline
  doc explicitly preserves this for the 6%→5% strip case. Replaceable
  by waitForResponse predicate (#16) but not removable.
- **Header dropdown / mini order list.** Doesn't solve ASIN→orderId
  mapping for filler mode. Already noted in `amazon-pipeline.md:597`.

## Open questions (would need empirical data to resolve)

1. **Does image+font blocking break `runtimeVisibilityChecks`?** The
   computed-style + bounding-rect logic is layout-dependent. Prime
   badge is a CSS-styled span (no image). Buy Now button is a styled
   `<input>`. Bounding-rect on these should not change with images
   blocked, but needs a fixture-style run.

2. **Is the `runtimeVisibilityChecks` result account-invariant?**
   Prime badge visibility depends on the listing, not the account.
   But `isSignedIn` reads the account header. So a one-fetch-feeds-all
   approach must keep `isSignedIn` per-profile. Easy: do that one
   check per page, share the rest.

3. **What's the actual cold-start cost for `chromium.launchPersistentContext`?**
   Anecdotal estimates: 2-4s on M1, 4-6s on first launch after long
   idle. Worth measuring if #4 ships.

4. **How often does the filler-search first term underflow?** If it's
   <5% of buys, #11 saves nothing; if 20%+, it's worth doing.
   Logger already emits `step.fillerBuy.fillers.searchHit { fresh, totalCandidates, of }` —
   pull last 50 buys' logs to estimate.

5. **Is `eligibleshipoption` URL pattern stable enough to predicate-wait
   on (#16)?** Pipeline doc says "Stable. 5/5 saved /spc fixtures
   match." Worth re-verifying against current /spc one more time
   before relying on it.

## Honest assessment

The prior pass was directionally right: **the inner buy phase
(scrape → cart → /spc → Place Order) for one profile is at or near
the floor.** All the wins they found shipped. What this pass surfaces
is mostly OUTSIDE that loop:

- **Resource blocking** is a category the prior pass simply didn't
  touch. It's table-stakes for any Playwright bot framework and is
  currently absent. **Single biggest unshipped win.** ~3-5s/buy.
- **Session reuse** wasn't audited. Cold-start tax is real.
- **Multi-profile work-sharing** wasn't audited. Today every profile
  duplicates the PDP scrape.
- **Lifecycle phase duplicate fetch** in `fetchTracking` wasn't
  audited. ~1s/active-fetch-tracking.

If you ship just **#1 (resource blocking) + #4 (session reuse) +
#13 (skip duplicate fetch in fetchTracking)** you'd see ~5-9s/buy
and ~1s/active-tracking, with low risk on each.

Everything else in the punch list is small (#10, #11, #12, #18) or
risky (#16, #17). The really big swings (HTTP-only scrape, batch
target+fillers) remain rejected for the same reasons the prior pass
rejected them.

The "we're at the floor for the buy phase" conclusion stands. The
floor for the **rest of the system** is lower than the prior pass
acknowledged.
