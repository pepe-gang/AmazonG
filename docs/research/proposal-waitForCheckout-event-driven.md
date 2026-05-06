# Proposal: rewrite `waitForCheckout` from polling to event-driven

**Status:** unshipped, deferred research note
**Date:** 2026-05-05
**Estimated saving:** 500ms–1.5s / buy (every buy), up to 3s on address-picker flows
**Risk:** Med — rewrites the most critical function on the /spc hot path
**Effort:** ~2 hours, ~50-100 line refactor

## Problem

`waitForCheckout` (`src/actions/buyNow.ts:639`) is the gate between
"navigated to /spc" and "Place Order button is clickable". It's used by
both single-mode (`buyNow.ts`) and filler-mode (`buyWithFillers.ts`) on
every buy.

Current architecture is a polling loop with fixed-interval sleep:

```ts
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const state = await page.evaluate(detectState);   // ~50-200ms
  if (state.kind === 'place') return ...;
  if (state.kind === 'unavailable') return ...;
  // ... handle interstitials (deliver / updates / pending)
  await page.waitForTimeout(500);                    // ← lossy 500ms sleep
}
```

The 500ms sleep is dead time. Chromium might render the Place Order
button 50ms into that sleep, but we won't notice for another 450ms.

Per-buy cost on the happy path:
- Place Order shows in 1–3 polls = **500–1500ms of dead-time waiting**.

For address-picker flows (BG name-toggle, fresh accounts), there's also
a **3000ms blind sleep** at `buyNow.ts:1035` after clicking "Use this
address" — total ~4s of blind waits per address-picker pass.

## Solution: `page.waitForFunction` with the same state detector

`page.waitForFunction(fn, opts)` polls **on requestAnimationFrame**
(~16ms cadence) — natively event-driven inside Chromium. It resolves
the moment `fn` returns truthy.

Sketch:

```ts
async function waitForCheckout(page, allowedAddressPrefixes, debugDir, emit) {
  const deadline = Date.now() + 30_000;
  let deliverClickedTimes = 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();

    // Wait for ANY actionable state — terminal OR interstitial.
    // RAF-paced polling means we detect within ~16ms of the state
    // change instead of 500ms.
    const stateHandle = await page
      .waitForFunction(
        ({ placeSelectors, placeLabelPattern }) => {
          // Same detector logic as today's evaluate, returns null when
          // no actionable state — waitForFunction keeps polling at
          // RAF cadence.
          const state = detectCheckoutState({ placeSelectors, placeLabelPattern });
          return state.kind !== 'unknown' ? state : null;
        },
        {
          placeSelectors: CHECKOUT_PLACE_SELECTORS,
          placeLabelPattern: PLACE_ORDER_LABEL_RE.source,
        },
        { timeout: remaining },
      )
      .catch(() => null);

    if (!stateHandle) {
      // Timeout fall-through: snapshot + return same as today's path.
      return { ok: false, reason: 'Place Order button never appeared on /spc' };
    }

    const state = await stateHandle.jsonValue();

    if (state.kind === 'place')          return { ok: true, detected: state.sel };
    if (state.kind === 'unavailable')    return { ok: false, kind: 'unavailable', ... };
    if (state.kind === 'quantity_limit') return { ok: false, kind: 'quantity_limit', ... };

    // Interstitial states: click button, then loop to fire the next
    // waitForFunction call.
    if (state.kind === 'deliver') {
      await clickAddressContinue(page);
      // Replace 3000ms blind wait with XHR predicate. Falls back to
      // a short sleep on miss (e.g. 800ms) — still much faster than 3s.
      await page
        .waitForResponse(ADDRESS_SUBMIT_URL_PATTERN, { timeout: 5_000 })
        .catch(() => page.waitForTimeout(800));
      deliverClickedTimes++;
      continue;
    }

    if (state.kind === 'updates') {
      await clickContinue(page);
      await page
        .waitForResponse(UPDATES_SUBMIT_URL_PATTERN, { timeout: 5_000 })
        .catch(() => page.waitForTimeout(800));
      continue;
    }

    if (state.kind === 'deliver_pending') {
      // No action needed — waitForFunction loop will detect the next
      // state when Amazon's submit completes. No separate sleep.
      continue;
    }
  }

  return { ok: false, reason: 'deadline hit' };
}
```

## Estimated savings

| Path | Today | After |
|---|---|---|
| Happy path (no interstitial) | 500–1500ms polling | **~50–150ms** (RAF + 1 detector run) |
| Address picker flow | 500ms poll + 3000ms blind wait + 500ms poll ≈ 4s | **~1s** (RAF + XHR predicate) |
| Multi-interstitial flow (3 clicks) | ~5–10s | **~2–4s** |

**Per-buy saving: ~500ms–1.5s on every buy. Up to 3s on address-picker flows.**

## Empirical prerequisites

Before implementing, capture these via Playwright MCP signed in:

1. **Address-submit XHR URL pattern.** After clicking "Use this address"
   on the Chewbacca address picker, what URL does Amazon POST to? Is
   the pattern stable across address-picker variants (the BG name-
   toggle path, the fresh-account picker, the post-buy-now address
   change)?
   - Best-effort capture: `page.on('response', cb)` while clicking
     through.
   - Verify across at least 3 variants: BG-toggle, fresh, change.

2. **`updates`-state submit URL pattern.** Same procedure for the
   "Make updates to your items" interstitial.

3. **`deliver_pending` state lifecycle.** Today we sleep 1500ms when
   detecting this state. Does Amazon's submit XHR fire on a stable URL
   we can wait on instead?

4. **State-transition timing.** After clicking an interstitial button,
   how quickly does Amazon mutate the DOM into the next state? Today's
   500ms sleep gives a buffer; the new approach jumps straight to
   `waitForFunction`. Verify the click is awaited synchronously and
   the `await clickAddressContinue` resolves AFTER the button-click
   handler has fired (not just dispatched).

## Risk profile

| Risk | Mitigation |
|---|---|
| `waitForFunction` predicate returning rich state object | Use `JSHandle.jsonValue()` to deserialize; verify the state shape is JSON-serializable |
| Interstitial click → next-state race | Existing click is awaited via Playwright's locator click. The synchronous portion completes before await resolves. Re-poll fires immediately after. |
| Address-submit XHR pattern variability | Keep the existing 3000ms blind wait as fallback (`waitForResponse.catch(() => waitForTimeout(800))` — still 2200ms faster than today) |
| Bug in the new state-machine logic | Public API unchanged (same return type, same callers). Easy revert if regressed. Ship as a single atomic replacement, not a feature flag. |
| `30_000` deadline interactions | Check that `remaining = deadline - Date.now()` arithmetic correctly threads through each `waitForFunction` call so we don't accidentally extend total wait |

## Implementation plan

1. **Empirical capture** (~30 min) — MCP-probe address-submit XHR
   patterns, confirm they're stable. Document URL patterns + which
   variant of address picker fires which.

2. **State detector extraction** (~30 min) — pull the existing
   `evaluate` body into a top-level function `detectCheckoutState()`
   so it can be reused inside `waitForFunction` without duplication.

3. **`waitForCheckout` rewrite** (~30 min) — replace polling loop
   with the structure above. Same public API, same return values.

4. **Unit-test the detector** (~15 min) — pure JS function (`detectCheckoutState`)
   can be tested against saved /spc fixtures without Playwright.

5. **MCP integration test** (~30 min) — navigate to a real /spc,
   run new `waitForCheckout`, verify it returns the same result as
   today on:
   - Happy path (Place Order visible)
   - Address picker (BG name-toggle simulation)
   - Quantity limit / unavailable cases (saved fixtures)

6. **Ship + monitor** — atomic replacement, no flag. If a regression
   surfaces, revert is a single git revert.

## Why we deferred this in 2026-05-05 work

The session that landed v0.13.21 had already shipped 7 wins (CDP block,
Sold-by-Amazon filter, commit-wait, waitForResponse for delivery click,
locator probe consolidation, preflightCleared fix, plus path-block
extensions). The user wanted to defer this to a future session for two
reasons:

1. **Test surface is large.** Rewrites the most critical function on
   the buy hot path; deserves a focused test cycle, not a tail-end
   shipment.
2. **Empirical prerequisites need their own session.** The address-
   submit XHR pattern hasn't been captured yet; doing this without
   real fixtures is guessing.

When we pick this back up, do steps 1–2 first (empirical + detector
extraction), then 3–6.

## Related items

- Pass-2 #16 (`waitForResponse(/eligibleshipoption/)`) — already
  shipped (v0.13.21 commit `b4fc79e`). Same pattern applied to the
  delivery-radio click. This proposal extends the pattern to the
  bigger /spc state-machine wait.
- The 3000ms address-submit blind wait at `buyNow.ts:1035` — this
  proposal incorporates a fix for it via the address-submit XHR
  predicate.

## Confidence

**~85%** that the architectural rewrite as described works. The 15%
uncertainty is:
- Whether the address-submit XHR URL pattern is stable across
  variants (untested as of this writing)
- Whether `waitForFunction` with rich state-object return surfaces
  any subtle JSHandle serialization issues (low risk; tested in
  similar Playwright codebases)

After the empirical capture step, confidence rises to ~95%.
