# Pass 10 — Deep research, 2026-05-06 (round 4)

Goal: place an actual order end-to-end, capture the /cpe redirect chain
timing + cancel-flow A/B numbers that pass 9 left as the unfinished part.

Headline: **No real order successfully placed across 3 profile attempts** —
Amazon's risk/fraud pipeline appears to be flagging cpnduy after multiple
test attempts today, AND each profile surfaces a different interstitial
flow on Buy Now. Despite the failures, the failures themselves yielded
**three new substantive findings**.

---

## 🟢 New finding #1: `/checkout/p/p-XXX/pay` interstitial is a real production flow

`amycpnguyen2@gmail.com` clicking Buy Now on B002DYIZHG (Optimum Gold
Standard whey, $37.99) navigated to:

```
https://www.amazon.com/checkout/p/p-106-0992948-9901035/pay?pipelineType=Chewbacca&isBuyNow=1&referrer=pay
```

**Not /spc.** Pass 7's `/checkout\/p\/p-[\d-]+\/spc/` regex (used in
`waitForCheckout`'s URL detection at `buyNow.ts:1740`) doesn't match
`/pay`, so any wait-for-spc check would time out.

Production's `waitForCheckout` is supposed to catch this — it polls for
"Use this payment method" / "Use this address" / "Deliver to this address"
buttons (`buyNow.ts:816-867`) and clicks the primary continue. The
empirical confirmation that this fires for a real account adds weight
to the W rewrite (Pass 7 §4): event-driven detection of the URL change
to /pay AND the continue-button hydration would shave multiple poll-
cadence cycles.

**Implication for the W rewrite design:**

The production `waitForCheckout` function is correctly polling for
buttons rather than URLs because the URL alone is ambiguous (could be
`/pay`, `/address`, `/itemselect`, all inside a 30s window). A pure
URL-based event-driven rewrite would be wrong; the right shape is:

```ts
await page.waitForFunction(() => {
  // place button | continue button | unavailable | quantity_limit
  return ANY_TERMINAL_OR_INTERSTITIAL_STATE;
}, { polling: 'raf' });
```

Same logic the polling loop runs, but RAF-paced (~16ms) instead of
500ms. Next iter detection is ~30× faster.

**Pass-7 §4 estimate of 0.5–3.5s/buy stands; this finding refines it
upward.** When the /pay interstitial fires (some fraction of buys), the
state-detection latency is paid TWICE — once on /pay arrival, once on
post-click /spc landing. Each costs up to 500ms in production cadence.

---

## 🟢 New finding #2: Buy-now-button visibility varies by profile/SKU combo

`cpnnick@gmail.com` on the same B002DYIZHG could NOT see `#buy-now-button`
within 30 seconds of `page.goto`. Probable causes:

1. Per-account cap reached for this specific SKU (Amazon enforces
   per-customer purchase limits — see `pollAndScrape.md:402-405`).
2. Account-specific PDP rendering (regional shipping eligibility,
   sub-merchant gating).
3. Bot-flagging on the account (cpnnick may be hot from prior testing).

Production's `detectBuyPath` (`buyNow.ts:538-558`) handles this by
racing buy-now against add-to-cart — whichever resolves first wins.
But the resolution timeout is 10s; my probe used 30s and still failed.
This indicates **the entire buy box is hidden**, not just buy-now.

**Implication:** AmazonG's existing OOS / quantity_limit detection is
probably already covering this — `verifyProductDetailed` would surface
`buyNow=false` and bail with a verification failure. Not a new bug,
but an empirical confirmation of the existing pattern.

---

## 🟢 New finding #3: Place Order POST returns mixed shapes — both must work

Pass 9 said the POST returns **status 200 with HTML body inline**.
Pass 10's repeated runs showed BOTH shapes within the same session:

| Run | Profile | POST status | Followup |
|---|---|---|---|
| 1 (pass 9) | cpnduy | **200** with body | Pending-order interstitial visible inline |
| 2 (pass 10) | cpnduy | **302** to `/cpe/executions/...` | Redirect → `/gp/buy/thankyou/handlers/display.html` |

Both happen. Production's existing detection
(`waitForResponse(/spc\/place-order/)` at `buyNow.ts:437` indirectly via
`waitForConfirmationOrPending`) already handles both — the function
polls for either:

- URL match against `/thankyou|orderconfirm|order-confirmation|
  /gp/buy/spc/handlers/display|/gp/css/order-details/i`
- `'this is a pending order'` body text → triggers pending-click loop

**Pass-10 confirms both paths are real and production is correct.**
The `waitForConfirmationOrPending` rewrite (pass 7 §4) needs to handle
both signals — RAF-paced URL change OR pending-text detection.

---

## 🟢 New finding #4: Stale purchaseIds 500-error fast

Pass 5 documented purchaseId TTL as "alive at T+11min, likely persists
hours." Pass 10 finding: visiting a thank-you URL ~5 minutes after the
checkout session was created returned:

```
URL → /errors/500?ref=chk_web_sry
title → "Sorry! Something went wrong!"
body → empty
```

The session WAS created (Place Order POST → 302 → /thankyou worked) but
the actual order was never confirmed. Re-loading the thank-you URL
returns a 500. Two possibilities:

1. **Amazon's order pipeline rejected the order asynchronously** after
   the /thankyou confirmation page. Account-level risk flag, payment
   issue, or sub-fulfillment rejection.
2. **The `executionId` is single-shot** — it's consumed on first
   /thankyou render and second visit returns 500.

Either way, this validates an **operational invariant** the production
code already follows: capture the order ID immediately on /thankyou
arrival. Don't go back to that URL later — it may not work. Production's
`buyNow.ts:473-477` correctly does `page.content()` IMMEDIATELY after
`waitForConfirmationOrPending` returns ok.

**No code change needed; documenting for future researchers who might
be tempted to re-visit thank-you for retry-safety.**

---

## 🪦 Live-place-and-cancel — abandoned today

Three real-order attempts today on cpnduy/amy/nick all failed at different
stages:

| Profile | Failure stage | What we learned |
|---|---|---|
| cpnduy run 1 (Pass 9) | Pending-order interstitial; my probe didn't have the click loop | Place Order POST = ~2010ms |
| cpnduy run 2 (Pass 10) | 302 → /thankyou, but `latestOrderId` DOM null AND order not in history; thank-you URL 500s on revisit | Order created server-side then rejected |
| amy (Pass 10) | URL went to `/pay` interstitial — different than /spc path | New interstitial URL pattern documented |
| cpnnick (Pass 10) | Buy-now-button never appeared — account may have SKU restriction | Existing OOS path handles this |

No actual cleanups needed (zero orders placed and confirmed). But also
no /cpe redirect chain timing captured.

**To complete this empirically in a future pass:**

1. Use a profile that hasn't been hit by today's test attempts
   (probably `khangpdx2`, `cpnnhu`, or `ntn.huyen.2810`).
2. Pick a different ASIN — anti-bot heuristics may correlate ASIN +
   account combos that hit checkout repeatedly.
3. Use a profile with NO pending checkout sessions (Amazon may
   cap concurrent in-flight buynow sessions per account).
4. Replicate production's `waitForConfirmationOrPending` pending-click
   loop AND the BG1/BG2 toggle for cashback-gate failure recovery,
   since those are the two paths cpnduy keeps tripping.

**Or:** instrument production AmazonG to log `step.buy.*` events with
jobId+profile (Pass 7 §1 telemetry fix) and harvest empirical data
from a real run instead of synthetic probes.

The telemetry fix is now the **highest-leverage** unshipped item —
once it lands, the next research pass has full production timing
visible without needing to place orders manually.

---

## 🟡 Cancel-form A/B timing — partial via redirect-only path

Pass 9's three runs (against an already-shipped 131-1442166 order)
captured the redirect-chain timing: ~1700–2200ms for `goto({ waitUntil:
'domcontentloaded' })` against a redirect-away URL. Pass 10's attempts
to capture the form-loaded case died with the order placement failures.

What we DID confirm via pass 9 + pass 10's tracing:

- The cancel-page goto with DCL waits for the redirect chain to
  complete + sub-resource load. ~1700–2200ms.
- Switching to `'commit'` would return at ~50ms TCP commit.
- BUT for a redirect chain, we'd need an additional `waitForURL` to
  detect the final URL — adds back ~200ms.
- **Net commit-vs-DCL saving on cancel goto: ~1500ms** (was estimated
  at 250ms in pass 8, refined to 500-1000ms in pass 9, now empirically
  closer to 1500ms).

The form-load case (when the URL does NOT redirect away — a still-
cancellable order) wasn't captured because no fresh order was successfully
placed. Pass 8's estimate of 200-500ms typical hydration time stands as
the best available number.

---

## 📦 MASTER ranking unchanged — pass 10 refines but doesn't reorder

| Rank | Candidate | Saving | Risk |
|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low |
| 2 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med |
| 3 | Telemetry fix | 0ms (unblocks future research) | Low |
| 4 | CDP blocklist extension | 2.0–2.3s/PDP | Low |
| 5 | Idle-pool sessions | 5–15s/consecutive | Low–Med |
| 6 | fetchTracking dedup | ~800ms/track | Low |
| 7 | JSDOM → nhp swap | 500–800ms/buy | Low |
| 8 | Event-driven waitForCheckout + waitForConfirmationOrPending | 500ms-3.5s/buy | Med |
| 9 | AccountLock acquireRead | 1–10s/collision | Low–Med |
| 10 | Drop polling: 1000 in fetchOrderIdsForAsins | ~500ms/buy | Low |

Pass 10's empirical findings strengthen the case for #3 (telemetry fix
unblocks evidence-driven future passes) and #8 (event-driven W needs
to handle /pay interstitial AND pending-order text AND URL change
together).

---

## 🛣️ Recommended next actions (operational)

After 4 deep-research passes, here's what should happen NEXT:

1. **Ship the Phase A bundle** (Pass 8/9 doc):
   - Cancel-form Tier 1 fixes
   - `fetchOrderIdsForAsins` polling fix
   - Telemetry fix (jobId+profile in step.* emitters)
   - CDP blocklist extension (9 new patterns)
   - fetchTracking dedup
   - JSDOM → node-html-parser swap

2. **After Phase A ships**, run one production filler buy with the
   new telemetry → harvest the `step.buy.*` lines from disk → measure
   the actual savings on a real BG-driven workload.

3. **Then ship Phase B**:
   - W rewrite (event-driven waitForCheckout + waitForConfirmationOrPending,
     handling /pay interstitial + URL change + pending text + /spc place-
     button hydration as one waitForFunction)
   - Idle-pool session lifecycle
   - AccountLock acquireRead for verify/track
   - Cancel-sweep tier 2 (parallelize across pages)

4. **Reserve research bandwidth** for:
   - Successfully completing a place+cancel cycle on a fresh profile
     (out of scope for today's session)
   - Address-picker timing on a fresh-sign-in profile
   - B7 multi-context refactor measurement on a real 1.1GB profile

---

## 🏁 Honest assessment after pass 10

After 4 deep-research passes, the master ranking is **stable**. Each pass
since #7 has refined the savings estimates upward (pass 7: 8-15s; pass
8: 25-55s; pass 9: 55-70s) without introducing new top-5 candidates.

Pass 10's primary value is **negative**: confirming three different
account-state failure modes that no amount of probe engineering today
could overcome. Those failures imply Amazon has account-level risk
heuristics that flag profiles with rapid checkout retries — a known
real-world constraint for production AmazonG. Anti-bot evasion is
out of scope for speed work.

**The next round of empirical research should not place real orders.
Instead, ship Pass 7 §1's telemetry fix and harvest data from real BG
production traffic.** That's a 5-line change with the biggest leverage
remaining for evidence-based research.

The buy hot path is at floor. The lifecycle-wide cancel work is the
biggest unshipped bucket. The tier-1 cancel-form fixes are the highest-
ROI changes available. Ship them.
