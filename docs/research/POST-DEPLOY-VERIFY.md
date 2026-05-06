# Post-deploy verification checklist

Per-commit verification steps for the perf work shipping out of
`feature/optimizing`. Run each check after the next packaged build
lands AND a real production buy fires.

Branch: `feature/optimizing` (off `main` at `c90a130` v0.13.23).
Will roll up into one release version when shipped.

---

## How to verify in general

After packaging + installing the new build:

1. Start the worker (or wait for an auto-claimed BG job).
2. Let one buy run end-to-end.
3. Find the most recent `~/Library/Application Support/AmazonG/job-logs/<attemptId>.jsonl`
   (sorted by mtime: `ls -lat ~/Library/Application\ Support/AmazonG/job-logs | head -3`).
4. Run the per-commit checks below against that file.

Capture a copy of the file before any other buy fires so the
post-deploy state is preserved for diffs.

---

## ✅ Commit `af188f9` — fix(telemetry): propagate jobId+profile

**Shipped:** 2026-05-06 on `feature/optimizing`.
**Files changed:** `src/actions/buyNow.ts`, `src/actions/buyWithFillers.ts`, `src/workflows/pollAndScrape.ts`.

**What to check:** every `step.buy.*` and `step.fillerBuy.*` event
should now appear on disk with proper jobId+profile routing.

### Pre-fix expected state (current production)

```bash
$ grep -c "^.*step\.buy\." ~/Library/Application\ Support/AmazonG/job-logs/cmou*.jsonl | awk -F: '$2!=0 {print}'
# (no output — every file shows 0 step.buy.* events)
```

### Post-fix expected state

After one new buy:

```bash
$ ls -t ~/Library/Application\ Support/AmazonG/job-logs/*.jsonl | head -1 | xargs grep -c "step\.buy\."
# Should print a non-zero number (typically 8-30 per buy depending on path)
```

### Specific events to confirm appear

Single-mode buy should land at minimum:
- `step.buy.start`
- `step.buy.path`
- `step.buy.click` (one of buy-now / add-to-cart)
- `step.buy.checkout`
- `step.checkout.price.ok`
- `step.checkout.address.check`
- `step.checkout.delivery.picked` OR `step.checkout.delivery.nochange`
- `step.buy.cashback`
- `step.buy.place.settle`
- `step.buy.place`
- `step.buy.placed` (on success) OR `step.buy.fail` (on failure)

Filler-mode buy should ALSO land:
- `step.fillerBuy.start`
- `step.fillerBuy.verify.ok`
- `step.fillerBuy.quantity.set`
- `step.fillerBuy.fillers.batch.ok`
- `step.fillerBuy.spc.shortcut.ok`
- `step.fillerBuy.spc.ready`
- `step.fillerBuy.spc.cashback.*`
- `step.fillerBuy.placed`

### What the data should look like

Each entry should have BOTH `jobId` and `profile` inside `data`:

```jsonl
{"ts":"2026-05-XX...","level":"info","message":"step.buy.start","data":{"jobId":"cmou...","profile":"cpnduy@gmail.com","dryRun":false,"productUrl":"https://www.amazon.com/dp/..."},"correlationId":"worker/cpnduy@gmail.com"}
```

If `data` lacks `jobId` or `profile`, the fix isn't actually shipping
in the running build (build was stale, or the commit didn't land in
the package).

### What to extract from the new data (the actual research payoff)

Once the events appear, compute the previously-invisible 52-second
gap breakdown:

```bash
$ ls -t ~/Library/Application\ Support/AmazonG/job-logs/*.jsonl | head -1 | xargs jq -c '[.ts, .message] | @csv' -r
```

Look for:
- Time from `job.scrape.ok` → `step.buy.start`: should be ~50-100ms
  (any setMaxQuantity + detectBuyPath race)
- Time from `step.buy.click` → `step.buy.checkout`: should be the
  Buy Now → /spc transition (~2-3s per pass-7 measurement)
- Time spent in `step.waitForCheckout.iter` events: shows the
  Chewbacca-interstitial polling (each iter is ~500ms cadence)
- Time from `step.buy.place` → `step.buy.placed`: shows the Place
  Order POST + /cpe redirect chain + thank-you DOM read (pass 9
  measured POST at ~2010ms; total to thank-you depends on whether
  pending-order interstitial fires)
- For filler buys: time from `step.fillerBuy.placed` to function
  return is the in-buy cancel sweep (pass 8: ~40-55s)

Save a copy of one full successful buy log + one full filler buy log
under `.research/post-deploy/` so subsequent perf changes have a
baseline.

---

## ✅ Commit `48d5ff1` — perf(spc): inline 3 cashback parsers into page.evaluate

**Shipped:** 2026-05-06 on `feature/optimizing`.
**Files changed:** `src/actions/buyNow.ts`, `src/actions/buyWithFillers.ts`.
**Predicted saving:** ~1.0-1.3s per buy on /spc-side reads.

**What to check:** the three /spc-side reads should be visibly faster.
Requires the telemetry fix (`af188f9`) to be live first — without
step.buy.* on disk we can't measure these.

### Specific timings to compare (pre-fix vs post-fix)

In a captured production buy log (`<attemptId>.jsonl`):

1. **`pickBestCashbackDelivery` total time.** Look at the gap between
   the last `step.checkout.delivery.picked` (or `.nochange`) and the
   prior step that would precede the picker (typically
   `step.checkout.address.ok` or `step.buy.checkout`). Pre-fix: ~660-790ms
   per iteration with 1-3 iters. Post-fix: ~250-300ms per iter (saves
   ~400-500ms).

2. **`readCashbackOnPage` cost.** Look at the gap between
   `step.checkout.delivery.picked`/`.nochange` and `step.buy.cashback`.
   Pre-fix: ~150-300ms typical. Post-fix: ~30-80ms.

3. **For filler buys: `verifyTargetCashback` cost.** Look for
   `step.fillerBuy.spc.cashback.*` events. Pre-fix: ~150-300ms per
   call. Post-fix: ~30-80ms.

### Regression signal — what to watch for

The pure parsers stayed exported, but the inline browser versions
duplicate their logic. If Amazon ships a layout change that affects
cashback detection, BOTH paths need updating in lockstep:

- **Pure parser (Node-side):** `parsers/amazonProduct.ts:74` (findCashbackPct),
  `parsers/amazonCheckout.ts:309` (computeCashbackRadioPlans),
  `parsers/amazonCheckout.ts:369` (readTargetCashbackFromDom).
- **Inline browser version:** `buyNow.ts:1480` readCashbackOnPage,
  `buyNow.ts:2115-…` pickBestCashbackDelivery loop body,
  `buyWithFillers.ts:1739-…` verifyTargetCashback.

A cashback regression that shows up in production but NOT in fixture
tests = the inline browser version drifted. Cross-reference comments
in each location call out the partner site to update.

### Empirical signals if the fix isn't actually shipping

- Inline `page.evaluate` failures fall through to `null` / `[]`. If
  you see `step.buy.cashback` with `pct: null` for buys that were
  succeeding pre-fix, the inline scan isn't matching elements. Capture
  the page state from the failed buy and compare to a /spc fixture.

- The deleted `syncCheckedAttribute` function used to fire inside
  pickBestCashbackDelivery. If you ever see a buy where `pickBest…`
  picks an option but `verifyTargetCashback` reports a different
  selectedRadio, the live `r.checked` reads are racing the click.
  Pre-fix this was masked by the sync-then-serialize pattern. Add
  a small `await page.waitForFunction(() => /* radio.checked */)`
  gate before the next read.

---

## ✅ Commit `cd71962` — perf(cancel): drop 4 blind waits in cancel-form helpers

**Shipped:** 2026-05-06 on `feature/optimizing`.
**Files changed:** `src/actions/cancelForm.ts`, `src/actions/cancelFillerOrder.ts`, `src/actions/cancelNonTargetItems.ts`.
**Predicted saving:** ~1.35s per cancel × ~15 cancels per filler-buy lifecycle = ~20s/filler-buy.
**Deferred:** networkidle 5s removal (pass-9 fix 4, ~3-4s/cancel) — see TODO at cancelForm.ts:226.

### What to check

For a filler buy, look in the buy-phase log (or the verify-phase log if
the buy-phase sweep was clean) for cancel timing. Cancels emit:

- `step.cancelFillerOrder.start` (or `.cancelNonTargetItems.start`)
- `step.cancelFillerOrder.reason.selected` (or `.cancelNonTargetItems.reason.selected`)
- `step.cancelFillerOrder.ok` / `step.cancelNonTargetItems.ok`

### Specific timings to compare (pre-fix vs post-fix)

| Gap | Pre-fix | Post-fix |
|---|---|---|
| `step.cancelFillerOrder.start` → first `step.cancelFillerOrder.reason.selected` | ~2-3s (goto+1500ms blind) | ~600ms-1.2s (commit + waitForFunction) |
| `step.cancelFillerOrder.reason.selected` → `step.cancelFillerOrder.ok` | ~6-7s (500ms blind + click + 5s networkidle) | ~5-6s (waitForFunction submit + click + 5s networkidle) |

The biggest visible delta is the FIRST gap (form-load), saving ~1s per
cancel. The reason-pick fix saves ~300-400ms. The polling-cadence fix
saves up to ~250ms when the banner renders fast.

### Cancel **success rate** must stay unchanged

The fixes don't touch the actual cancel POST or the confirmation
detection. If cancel success rate drops:

- **Most likely**: fix 1+2 (commit + waitForFunction) is timing out on
  some cancel-form layout. Look for `step.cancelFillerOrder.fail` with
  `not on cancel-items page after navigation`. Bisect by reverting fix
  1+2 alone (the other fixes are independent and safe).
- **Less likely**: fix 5 (submit-enabled wait) is timing out. The 2s
  ceiling is generous; if it ever hits, the form is probably broken
  in a way the old 500ms wait wouldn't have helped either.

### Networkidle TODO

Pass 9 said drop the 5s networkidle entirely (saves ~3-4s/cancel).
Existing code comment (cancelForm.ts:226) says it was added to prevent
telemetry-beacon-interruption invalidating cancels server-side.

Decision criterion: after this CL ships and we have telemetry-visible
cancel timings, look at:
- Cancel success rate before/after this CL (must be ~100% on
  cancellable orders)
- If cancel success rate drops by even 1-2%, the comment was right —
  keep networkidle, just shorten to 1.5s
- If success rate is unchanged for 50+ cancels, drop networkidle in a
  follow-up CL for the full ~3-4s/cancel saving (~45-60s/filler-buy)

---

## ✅ Commit `16a21e5` — perf(driver): extend CDP blocklist with 9 patterns

**Shipped:** 2026-05-06 on `feature/optimizing`.
**File changed:** `src/browser/driver.ts`.
**Predicted saving:** ~2.0-2.3s per PDP nav (when patterns trigger; product-dependent).

### What to check

The CDP blocklist works at the network layer — Chromium drops matched
URLs before any per-request Playwright IPC fires. The `loadingFailed`
event with `errorText: 'net::ERR_BLOCKED_BY_CLIENT'` is logged in
the `blockedTotal` counter at `driver.ts:202`, surfaced in
`session.close.ok` log line.

### Specific signals to verify

1. **PDP scrape time should drop.** Look at gap from `job.profile.start`
   to `job.scrape.ok` — pre-fix typically 1.5-3s, post-fix expect
   1.0-2.0s on PDPs that previously hit the now-blocked XHRs.

2. **Heat / fan / RSS drop.** During a busy fan-out (4 concurrent
   buys), Activity Monitor's "AmazonG Helper" processes should show
   lower peak RAM. Roughly 30-100MB less per Chromium tab. Not as
   easy to measure precisely as ms savings.

3. **`blockedTotal` counter should be higher.** Search session.close.ok
   logs:
   ```
   $ jq -r '. | select(.message=="session.close.ok") | .data.blockedTotal' \
       ~/Library/Application\ Support/AmazonG/job-logs/<id>.jsonl
   ```
   Pre-fix: ~100-150 typical per buy. Post-fix expect ~110-170.
   (The biggest blockedTotal comes from already-shipped image/font
   blocks; this CL adds 5-15 incremental per PDP.)

### Regression signals

- **Buy succeeds but verify fails with "shipping group" or similar
  parse errors**: a cashback or price element was being rendered by
  one of the now-blocked XHRs. Check `step.fillerBuy.spc.cashback.fail`
  detail — if `bodyMatches=[]` AND `scopeMatches=[]` on a product
  that USED to work, suspect `paymentOptionsAjaxExperience` or
  `twisterDimensionSlotsDefault` removal broke price/variant rendering.

- **PDP nav becomes faster but `step.verify.fail` rate goes up**: an
  ACP widget we depend on. Bisect by reverting `/acp/*` only (the
  most aggressively-generalized pattern in this CL).

- **Heat/CPU ACTUALLY GOES UP**: shouldn't happen, but if Amazon
  serves an alternative when these XHRs fail (e.g. inline-rendered
  fallback), the blocked path could trigger more compositor work
  elsewhere. Unlikely — the blocked URLs are decorative, not data-
  bearing.

If any regression surfaces, revert this CL alone — the previous CDP
blocklist (passes 4-7 originals) is verified safe and stays in place.

---

## Surgical cashback recovery (flag-gated, dev-tracked)

**Commit:** `90dfb7d`
**Files:**
- `src/shared/ipc.ts` — added `experimental.surgicalCashbackRecovery` to Settings
- `src/shared/researchLog.ts` — NEW: dev-only JSONL writer (allowlist: `cashback-experiments`)
- `src/parsers/amazonCheckout.ts` — `CashbackHit.groupAsins?: string[]` populated from /spc shipping group scope
- `src/actions/buyWithFillers.ts` — inline `runSurgicalCashbackRecovery` (Phase A: linear remove; Phase B: replacement up to 3 items, only if removal didn't reach minimum); `BuyWithFillersOptions.surgicalCashbackRecovery`
- `src/actions/clearCart.ts` — `removeCartItemsByAsin` HTTP delete helper (~150 LOC)
- `src/workflows/pollAndScrape.ts` — `Deps.loadParallelism` returns `surgicalCashbackRecovery`; threaded through `runFillerBuyWithRetries`; when flag is on, outer `FILLER_MAX_ATTEMPTS` is forced to 1 so the inline recovery is the only retry path
- `src/workflows/scheduler.ts` + `src/workflows/runners.ts` — extended `JobContext`, `Tuple.buyCtx`, `BuyTupleCtx` with `surgicalCashbackRecovery: boolean`
- `src/main/index.ts` — `loadParallelism` injection reads `s.experimental?.surgicalCashbackRecovery === true`
- `tests/unit/scheduler.test.ts` — fixture extended with `surgicalCashbackRecovery: false`

### What ships

The flag is OFF by default (`experimental?.surgicalCashbackRecovery !== true`).
Existing buy flow is byte-equivalent when off — the new branch only runs
when the user opts in via `settings.json`.

When ON and the cashback gate fails with B1 mode (target's group has no
`% back` substrings), the flow:
1. Records the pre-recovery state (baseline cashback, group ASINs) to
   `userData/research-logs/cashback-experiments.jsonl` (dev mode only).
2. Phase A: removes group ASINs one at a time (sequential HTTP delete via
   `submit.delete-active.<UUID>`), reverifying after each removal. Stops as
   soon as cashback ≥ minimum.
3. Phase B (only if Phase A didn't hit minimum): adds up to 3 replacement
   filler items via `runSurgicalCashbackRecovery`'s replacement helper.
4. Records the outcome (which removals worked / how many, ms elapsed) to
   the JSONL for later mining.

If the flag is OFF, the legacy retry path (`FILLER_MAX_ATTEMPTS=3`) is
unchanged. **No production user is affected** until they opt in by
editing `settings.json`.

### What to look for

- Filler-mode buys with the flag off: identical behavior to pre-commit
  (still retries up to 3× on cashback_gate). Verify with
  `step.fillerBuy.cashback.fail.b1` log frequency unchanged.
- Filler-mode buys with the flag on: only ONE outer attempt now, but
  inline recovery may run several inner remove iterations. Look for
  `step.fillerBuy.surgicalRecovery.start` / `.removed` / `.replaced` /
  `.success` / `.giveup` events.
- Single-mode (`useFillers=false`) buys: completely untouched — the
  flag only gates the filler-buy retry loop.
- `userData/research-logs/cashback-experiments.jsonl`: only ever written
  in `npm run dev` (NODE_ENV==='development'). Production-installed DMG
  must NOT create this directory.

### Gotchas observed during implementation

- `loadParallelism` is re-read per claim, so toggling the setting
  doesn't require a worker restart — but the toggle does require the
  next claim to actually exercise the new path.
- Each HTTP delete invalidates the current `/spc` URL because
  `purchaseId` rotates with cart contents. The recovery helper navigates
  back to `SPC_ENTRY_URL` after each remove batch.
- Saved-for-Later items are left alone (they don't have an active-cart
  UUID).
- `appendResearchEvent` is fire-and-forget. A failed write must never
  affect the buy flow.

### Pattern mining

Once the JSONL has 50+ events from real recovery attempts, prompt the
user to mine patterns (e.g. "what proportion of B1 failures are
recoverable by removal alone?", "which ASINs are the dominant grouping
culprits?"). Memory file:
`memory/project_cashback_research_pattern_mining.md` reminds future
sessions of this.

---

## (next commit) — placeholder

When the next commit ships, append its verification block here in
the same format.

---

## Ship-time consolidated check

When the full Phase A bundle is ready to ship as a single release:

1. Bump `package.json` version (per CLAUDE.md release pipeline).
2. `npm run package:signed` — produce DMG + zip + latest-mac.yml.
3. Install locally + run one production buy.
4. Walk the per-commit checks in this doc against the captured log.
5. If all pass → `gh release create vX.Y.Z ...` + bump BG manifest +
   `vercel --prod` (per CLAUDE.md).

Do NOT ship a release that has unmerged verification failures from
this doc — fix the regressing commit first.
