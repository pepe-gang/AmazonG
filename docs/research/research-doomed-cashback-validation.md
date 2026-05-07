# Research: does the doomed-cashback-retry short-circuit work?

**Question:** when `verifyTargetCashback` returns `pct: null + scopeMatches: []` ("B1 case"), would the next 1-2 retry attempts ever recover the buy if we let them run? Or is filler-shuffle truly unable to help?

**Method:** mine production logs + saved /spc fixtures + parser code paths for empirical signal.

**Verdict: ~85% confident the short-circuit is correct, but the sample is too small to ship with high confidence yet. Phase-1-only (instrument, don't enable) is still the right call.**

---

## What "B1" means precisely

`verifyTargetCashback` (`buyWithFillers.ts:1740`) calls `readTargetCashbackFromDom` which:

1. Locates the target ASIN's row on /spc
2. Walks UP from that row to the innermost ancestor that contains `Arriving` text AND a radio (the target's "shipping group")
3. Reads the checked radio's label inside that group, looking for `\d+% back`
4. Records `scopeMatches` = ALL `\d+% back` substrings anywhere in the group's visible text (not just radio labels)
5. Records `bodyMatches` = same but page-wide

The B1 case = `pct: null + scopeMatches.length === 0`. Surfaces with reason `no "% back" shown on target X's shipping group` per `buyWithFillers.ts:1761`.

This means: in the target's innermost shipping group, **there is literally not a single `\d+% back` substring** — not in any radio label, not in any descriptive text, not in any promo banner.

---

## Production evidence

### Failure observations (raw counts)

3 `cashback_gate` failures across all recent production logs (~50 buys total):

| Job | Profile | Target | Reason | Elapsed |
|---|---|---|---|---|
| `cmou7zhpo008rkjfb8x56hcji` | cpnduy | B0DZ75TN5F (iPad Blue) | `no "% back" shown on target B0DZ75TN5F's shipping group` | 161s |
| `cmou81rnh001mdqxqv66zgu62` | cpnduy | B0DZ75TN5F (iPad Blue) | (same reason) | 167s |
| `cmou8eo00005zsit2syot8szu` | cpnduy | B0DZ77D5HL (iPad Silver) | `no "% back" shown on target B0DZ77D5HL's shipping group` | (similar) |

**All 3 failures hit the same B1 reason text. None hit any other `cashback_gate` failure mode** (no `target's selected delivery option has no "% back" label (group offers 6% back but a non-cashback radio is checked)` and no `target cashback X% below threshold`).

That's a strong signal that B1 is the **dominant** cashback-failure mode on this user's account. The other failure paths (Case B2: cashback option exists but a non-cashback radio is checked; Case A: % below threshold) didn't fire at all in this sample.

### Success observations (5 placements that succeeded at 6%)

iPad placements that succeeded:
- iPad **Pink** (cpnduy): 3× placed, all at 6%
- iPad **Pink** (amycpnguyen2): 1× placed at 6%
- iPad **Silver** (cpnduy): 1× placed at 6%

**Different colors of iPad show different cashback eligibility on the same account.** That's consistent with a per-SKU cashback-eligibility model — Amazon Day eligibility seems to track the ASIN, not the cart composition.

### PDP-side cashback observations

Across 80+ `job.scrape.ok` events in recent logs, **EVERY product** reports `cashbackPct: null` from the PDP scrape. Apple, Echo, MacBook, iPad, Switch, Quest — all of them. This is consistent: PDP-side cashback is not how Amazon surfaces the 6% Amazon Day uplift; it shows up at /spc as a delivery-radio option per shipping group.

---

## Saved fixture evidence

`fixtures/spc/inc-2026-05-05-ipad-target-no-amazon-day.html` is a saved /spc HTML capture from a real production B1 failure (this same iPad, same account, same shipping-group structure).

The fixture contains:
- 16 occurrences of "6% back" (in OTHER shipping groups — the fillers got Amazon Day)
- 8 occurrences of "5% back" (Prime Visa baseline)
- 7 occurrences of "1% back" (some other promo)
- ZERO `% back` substrings inside the iPad's specific innermost-Arriving-with-radio scope

A regression test (`tests/unit/cashbackGateRegression.test.ts`) exists specifically because BEFORE the parser was narrowed (commit before `1859e57`), the walk would skip past the iPad's group and falsely match the fillers' 6% — placing the order at the iPad's actual 5% standard (Prime Visa default), losing ~$12.50 per order. The fix narrowed the walk; the regression test now asserts `pct: null` for this exact fixture.

So we have ONE saved snapshot showing the B1 case in a real production capture. The user's existing fixture-test infrastructure already covers this exact scenario as a non-recoverable parser outcome.

---

## The retry-recovery question

The fix's premise: when B1 fires, retrying with different fillers cannot help because the target's underlying SKU lacks Amazon Day eligibility.

The counter-hypothesis: filler shuffle could change WHICH shipping group the target ends up in, and a different group might HAVE Amazon Day eligibility for that target.

### What the data tells us

**For:** all 3 production B1 failures exhausted their retry loop. Across 3 jobs × ~2-3 attempts each = ~6-9 total internal retries with different filler sets. ZERO recoveries.

**Against:** sample is tiny. 3 jobs is not statistically conclusive. We're missing per-attempt detail in logs (pre-telemetry-fix) so we can't see whether the SAME attempt ran, whether a different shipping-group split was attempted, or whether a different option was offered.

**Tied:** Pink iPad succeeds at 6%; Blue iPad fails at B1; Silver iPad both succeeds AND fails (different orders, possibly different SKU variants). Suggests cashback-eligibility is keyed on the ASIN itself, but with noise — could just be different storage variants having different promo treatment.

### What I CAN'T tell from current data

- Whether Amazon's cart-bundling logic ever produces different shipping-group memberships for the SAME ASIN given different filler sets. Pre-telemetry-fix logs don't show per-attempt detail.
- Whether the 6% Amazon Day uplift is item-determined or cart-determined.
- The actual frequency of B1 across longer-tail buy patterns (not just iPads).

---

## Confidence assessment

I'm **~85% confident** the short-circuit is correct. The reasoning:

- The mechanism by which retry COULD help (different fillers → different shipping groups → cashback eligibility surfaces) is plausible but not empirically observed.
- The 3 production B1 failures all exhausted retries with no recovery — small but consistent.
- Per-color cashback variation (Pink works, Blue fails) suggests Amazon's cashback is per-SKU, which would predict B1 cases never recover via filler shuffle.
- The user's own fixture (`inc-2026-05-05-ipad-target-no-amazon-day.html`) is named/structured to indicate this is a known-recurring failure mode, not a transient.

**Why not higher confidence:**

- 3 production datapoints is not enough to rule out "filler shuffle helps 5% of the time."
- Pre-telemetry logs hide per-attempt detail.
- I haven't probed Amazon directly to see whether the same iPad ASIN can be rendered with different shipping groups under different cart compositions. (That probe IS doable but would require live Amazon traffic + an account that hits B1 reliably.)

**Why not lower confidence:**

- The mechanism is plausible (per-SKU cashback eligibility is how Amazon's promo systems generally work).
- The user's own diagnostic infrastructure (the regression test) treats B1 as unrecoverable.
- The empirical 0/9 retry recoveries (even at small sample) is consistent.

---

## Recommendation

**Phase 1 only — ship the instrumentation, NOT the bail.**

Concretely:

1. Plumb `observedCashbackPct` + `observedScopeHasCashback` through `BuyWithFillersResult` failure shape (the data plumbing).
2. Add a log event at `pollAndScrape.ts:551`:
   ```ts
   logger.info('step.fillerBuy.retry.would_skip_b1', {
     attempt,
     observedCashbackPct: lastRaw.observedCashbackPct,
     observedScopeHasCashback: lastRaw.observedScopeHasCashback,
     // Don't actually break — let the existing retry continue.
   }, cid);
   ```
3. Continue the retry loop AS-IS.

After 1-2 weeks of normal production traffic:

- Count the `step.fillerBuy.retry.would_skip_b1` events
- For each one, check whether the buy ultimately succeeded (the retry worked) or failed (the retry was wasted)
- If 50/50 of "would-skip" cases recover → the fix is wrong, drop it
- If 0/N "would-skip" cases recover → the fix is correct, ship Phase 2 (enable the bail)

**Why this matters:** the Phase-1 cost is tiny — 2 fields on a return type + 1 log line. It costs us nothing in wall-clock since we don't change behavior. But it earns us empirical validation that's strictly more valuable than my 85%-confidence inference.

**The cost of being wrong without Phase 1:**

- If the fix is right (mostly correct): we save ~80-160s per B1 buy from day 1.
- If the fix is wrong: we lose buys that would have succeeded on retry. Hard to detect without telemetry — the user just reports "my orders aren't going through anymore" days later.

The asymmetry favors Phase 1.

---

## What to ship next

Skip the doomed-cashback-retry short-circuit for now. Move to **#2 (`fetchTracking` dedup)** or **Tier 1.5 BG-side bundle** instead — those have stronger empirical justification AND we can revisit doomed-cashback after Phase 1's instrumentation has run for a while in production.

Specifically:

- Phase 1 instrumentation can ride along on any future commit that touches `BuyWithFillersResult`. No rush.
- After 1-2 weeks of "would_skip_b1" data we can decide Phase 2.
- Until then, `FILLER_MAX_ATTEMPTS=3` continues to burn ~80-160s per doomed cashback failure. Acceptable cost for the data we'd be paying for.
