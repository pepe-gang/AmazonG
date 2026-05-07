# Pass 13 — Deep research, 2026-05-06 (round 7)

After pass 12 noted the diminishing-returns curve flattening, this pass
audits **failure-path code** that doesn't fire on every buy but eats
significant wall-clock when it does:

1. Retry-loop budgets across the buy lifecycle
2. Cashback-gate retry path (`toggleBGNameAndRetry`)
3. Disk-space accumulation patterns over time
4. The address-picker `selectAllowedAddressRadio` deep-read

Headline: **`FILLER_MAX_ATTEMPTS=3` can burn 4 minutes on a single
profile when cashback retries are doomed**, and the BG1/BG2 toggle has
~50s worst-case timing nobody had measured.

---

## 🔴 Critical: `FILLER_MAX_ATTEMPTS=3` retries can waste 4 minutes per profile

`pollAndScrape.ts:506-560`:

```ts
const FILLER_MAX_ATTEMPTS = 3;
for (let attempt = 1; attempt <= FILLER_MAX_ATTEMPTS; attempt++) {
  lastRaw = await buyWithFillers(page, { ... attemptedAsins });
  if (lastRaw.ok) break;
  if (lastRaw.stage !== 'cashback_gate') break;  // gate retries to cashback
  if (attempt >= FILLER_MAX_ATTEMPTS) break;
}
```

The retry premise: different filler ASINs → different shipping-group
fan-out → different cashback eligibility. Empirically (per inline
comment at line 550): each attempt costs ~60-80s. Worst case 3 ×
80s = **240 seconds (4 minutes) per profile** before bailing.

### When retries are doomed

Retries only help if the cashback miss was a **shipping-group
distribution problem**. They DON'T help when:

1. Target item itself is **0% cashback** (pageReadingPct: 0 in logs).
   No filler shuffle changes Amazon's per-item cashback baseline.
2. **Account-level promo eligibility** is exhausted (e.g. the user has
   already burned their 6% promo this period).
3. The **address has no BG1/BG2 suffix** AND `allowedAddressPrefixes`
   is empty (the inner BG-toggle path bails at `buyWithFillers.ts:922`).

In all three cases, attempt 2 and 3 will fail identically — wasting
2 × 80s = 160s per profile.

### Production trace evidence

From `cmou81rnh001mdqxqv66zgu62__cpnduy@gmail.com.jsonl` (pass 1's
production log audit):

```
15:44:29.021Z step.verify.ok
15:47:16.879Z step.buy.fail stage:cashback_gate reason:no "% back"
              shown on target B0DZ75TN5F's shipping group
```

**167 seconds elapsed.** That's ~2 attempts. With Pass 7 §1's telemetry
fix landed, we'd see the per-attempt breakdown. Today: invisible.

### Recommended fix

**Short-circuit retries when the first-attempt cashback reading was 0
or null.** Add to the retry-gate condition at `pollAndScrape.ts:551`:

```ts
if (lastRaw.stage !== 'cashback_gate') break;
// Pass 13: skip retries when no cashback was visible on attempt 1.
// Different filler mix won't surface cashback that doesn't exist.
if (attempt === 1 && lastRaw.observedCashbackPct === 0) {
  logger.info('step.fillerBuy.retry.skip.zero_cashback', { lastReason: lastRaw.reason }, cid);
  break;
}
```

Requires `BuyWithFillersResult` to surface `observedCashbackPct` on the
fail path (currently only logged, not propagated).

**Saving:** ~80-160s per "doomed" cashback failure. Frequency depends on
account state — likely 10-30% of cashback misses per the production
log pattern.

**Risk:** Low. Falls back to existing 1-attempt behavior; user can opt
out via a settings flag if needed.

**File:line:** `pollAndScrape.ts:551` + `buyWithFillers.ts` to expose
`observedCashbackPct` on failure.

---

## 🟡 `toggleBGNameAndRetry` worst-case is ~50 seconds

`buyNow.ts:1471-1700` (toggleBGNameAndRetry).

Step-by-step worst-case timing audit:

| Step | File:line | Bound | Typical |
|---|---|---|---|
| `location.href = address picker URL` | 1488 | nav | 2-3s |
| `waitForURL(/\/address/i)` | 1496 | 15s | 200-500ms |
| Find matching radio (8s polling at 150ms) | 1506-1515 | 8s | 200-1000ms |
| Click Edit link | 1529 | (sync) | <50ms |
| Wait for edit modal (8s polling) | 1546-1551 | 8s | 200-500ms |
| Update name input (`setter?.call`) | 1587 | (sync) | <50ms |
| **`waitForTimeout(1000)` blind** | 1592 | 1s | 1s |
| Click "Use this address" | 1622 | (sync) | <50ms |
| **20s polling for button-gone** at `200ms` cadence | 1646-1648 | 20s | 1-3s |
| Total typical | | | ~5-8s |
| Total worst-case | | | ~50s |

The 1000ms blind wait at line 1592 can be replaced with `waitForFunction`
on the modal's "Use this address" button being enabled (~50-200ms typical):

```ts
await page.waitForFunction(() => {
  const btn = document.querySelector(
    '#checkout-primary-continue-button-id, #checkout-primary-continue-button-id-announce',
  );
  return btn && (btn as HTMLElement).offsetParent !== null;
}, { timeout: 2000 });
```

The 200ms polling cadence at line 1648 could be RAF (`waitForFunction`
without explicit polling). Saves another ~100-200ms.

**Saving:** ~700-900ms per BG name-toggle. Fires on every cashback-
retry path. Combined with FILLER_MAX_ATTEMPTS retries: up to 3 ×
800ms = ~2.4s saved per cashback-retry buy.

**Risk:** Low. Replaces blind waits with bounded selector waits — same
upper bound, faster typical case.

**File:line:** `buyNow.ts:1592, 1648`.

---

## 🟡 Address-picker selectAllowedAddressRadio post-click 500ms blind wait

`buyNow.ts:1188`:

```ts
await page.waitForTimeout(500);
```

Fires after `selectAllowedAddressRadio` clicks a destination radio.
Comment: "Amazon needs a beat for the radio click to register before
the submit URL on the form is updated."

The wait is reasonable but blind. Could be event-driven via
`waitForFunction` on the form's `action` attribute updating to include
the radio's destination URL. ~50-150ms typical instead of 500ms blind.

**Saving:** ~350ms per address-picker fire. Combined with the existing
3000ms blind wait at `buyNow.ts:1035` (which W proposal already covers),
this is the second smaller blind wait in the address-picker case.

**Risk:** Low.

---

## 🟡 Disk-space accumulation — `debug-screenshots/` has no cleanup

User's current disk usage (audited live):

| Path | Size | Cleanup |
|---|---|---|
| `amazon-profiles/` | **4.6 GB** | None — Chrome profile data, grows with use |
| `Cache/` | 292 MB | Chromium-managed |
| `Code Cache/` | 27 MB | Chromium-managed |
| `chase-profiles/` | 118 MB | None |
| **`debug-screenshots/`** | 5.2 MB | **None — accumulates forever** |
| `chase-snapshot-debug/` | 5.7 MB | None |
| `job-logs/` | 1 MB | 30-day startup sweep + ring buffer |
| `job-attempts.json.bak` | 104 KB | Stale migration backup |

### Findings

1. **`debug-screenshots/` has no auto-cleanup.** Each address_picker
   failure dumps a ~100KB PNG. Power users hit this dozens of times
   per week. After 1 year: ~5-50 MB. Not catastrophic but unbounded.

2. **`amazon-profiles/` 4.6 GB.** Chromium auto-cleans Cache/ but not
   IndexedDB / Service Worker caches in a per-profile context. Long-
   term, profiles can balloon to 5-10 GB+. The user's existing tooling
   doesn't surface this.

3. **`job-attempts.json.bak`** is stale migration backup; never written
   in current code (pass 13 grep confirmed no `.bak` writer). Cleanup
   candidate.

### Recommended fix

Add a startup cleanup pass that:
- Prunes `debug-screenshots/` files older than 30 days (matches existing
  job-attempts ring buffer cadence)
- Optionally surfaces total userData size via existing `snapshotsDiskUsage`
  IPC — give the user visibility before manual cleanup is needed

**Saving:** Disk-space hygiene; not wall-clock. Long-term UX for users
who'd otherwise wonder "why is AmazonG using 5GB?"

**Risk:** Low. Old debug screenshots are diagnostic-only; pruning them
loses nothing actionable.

**File:line:** `src/main/index.ts:818` (after `pruneOlderThan` already
runs at startup).

---

## 🟡 Other small findings

### `MAX_ITERATIONS = 6` (waitForConfirmationOrPending — line 2064)

Looking at `buyNow.ts:2064-2067`:

```ts
const MAX_ITERATIONS = 6;
for (let i = 0; i < MAX_ITERATIONS; i++) {
  ...
}
```

This is inside `findPlaceOrderLocator` consolidated probe (Pass 7 §
shipped). Bounded — fine.

### `MAX_DELIVER_CLICKS = 5` rationale

`buyNow.ts:665`:

> 5 rather than 3: a worst-case flow can chain several interstitials
> (address → billing → payment → /spc), each adding one click.

Each click + 3000ms blind wait. 5 clicks = up to **15s** of pure
inter-click blind wait time. The W rewrite (Pass 7 §4) handles this
by replacing the 3000ms with event-driven URL/state detection.

### `MAX_DELIVERY_RECOVERIES = 1`

`buyNow.ts:1733`:

> opts.maxDeliveryRecoveryAttempts ?? 1

When Amazon shows "delivery options changed" banner after Place Order,
we re-pick the cashback radio AND re-click Place Order (line 1822-1864).
Bounded to 1 attempt. Each attempt: re-pick (~2-3s) + click + 2500ms
blind wait. Worst case ~5s extra per recovery.

### `MAX_PENDING_CLICKS = 3`

`buyNow.ts:1731`. Each click + 2500ms blind wait + DCL load. Worst case:
3 × ~3s = **9s** of pure blind-wait tax in pending-order flows.

The W rewrite covers all of these with a unified event-driven detector.

---

## 🪦 Confirmed dead — additions from pass 13

| Hypothesis | Why dead |
|---|---|
| MAX_DELIVER_CLICKS=5 is too high | Real Amazon flows can chain 4+ interstitials; 5 is safe ceiling |
| MAX_PENDING_CLICKS=3 is too high | 3 retries match the empirical "Amazon takes a few seconds" pattern |
| Eviction of `chase-snapshot-debug/` | 5.7 MB, single-shot per redeem; auto-cleanup not worth the code |

---

## 📦 Updated MASTER ranking after pass 13

Pass 13 introduces **one new top-tier candidate** (the doomed-cashback-
retry short-circuit) and three smaller ones.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | **Doomed-cashback-retry short-circuit** ⭐ NEW | **~80–160s per failed cashback buy** (frequency: 10-30% of cashback misses) | Low | **Pass 13 §1** |
| 6 | CDP blocklist extension | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 7 | Idle-pool session lifecycle | 5–15s/consecutive | Low–Med | Pass 7 §5 |
| 8 | fetchTracking dedup | ~800ms/track | Low | A4 |
| 9 | JSDOM → node-html-parser swap | 500–800ms/buy | Low | Pass 4 #1 |
| 10 | listAmazonAccounts 60s cache | ~900ms-1.8s/burst | Low | Pass 11 §3 |
| 11 | W rewrite (waitForCheckout + waitForConfirmationOrPending) | 500ms-3.5s/buy + up to 15s on chained interstitials | Med | Pass 7 §4 + Pass 13 §"misc" |
| 12 | AccountLock acquireRead | 1–10s/collision | Low–Med | Pass 7 §6 |
| 13 | **toggleBGNameAndRetry waits → event-driven** ⭐ NEW | ~700-900ms per BG-toggle (~3 fires per cashback retry) | Low | **Pass 13 §2** |
| 14 | Drop polling: 1000 in fetchOrderIdsForAsins | ~500ms/buy | Low | Pass 9 §4 |
| 15 | loadSettings/loadProfiles mtime cache | ~150ms/min idle | Low | Pass 12 §5 |
| 16 | **selectAllowedAddressRadio 500ms blind → waitForFunction** ⭐ NEW | ~350ms/address-picker fire | Low | **Pass 13 §3** |
| 17 | Lazy pickIdsToEvict | ~50–75ms/fan-out | Low | Pass 12 §4 |
| 18 | Parallelize setMaxQuantity + detectBuyPath | ~30–50ms/buy | Low | Pass 12 §"sequential-await" |
| 19 | Multi-profile shared PDP scrape with cache | ~280ms × (N−1) | Med | Pass 2 #6 |
| 20 | **Auto-prune debug-screenshots older than 30 days** ⭐ NEW | Disk hygiene only | Low | **Pass 13 §4** |

---

## 🛣️ Recommended ship order — UPDATED after Pass 13

The doomed-cashback-retry short-circuit (#5) is the biggest pass-13
finding and slots into Phase A naturally — same surface as the
cancel-form fixes (failure path code) and similar low-risk profile.

### Phase A (next CL — bundle)

1. Cancel-form Tier 1 fixes (Pass 8/9)
2. **Doomed-cashback-retry short-circuit** (Pass 13 §1) — exposes
   `observedCashbackPct` on `BuyWithFillersResult`
3. listMergedAttempts two-tier broadcast (Pass 11 §1)
4. Telemetry fix (Pass 7 §1)
5. CDP blocklist extension (Pass 7 §3)
6. fetchTracking dedup (A4)
7. JSDOM → node-html-parser swap (A1)

**Phase A cumulative on filler-mode:**
- ~55-70s saved per filler buy (cancel-form)
- ~80-160s saved per doomed-cashback failure (frequency-dependent)
- ~500ms-2.4s saved per fan-out (BG broadcast)
- ~2.3s saved per PDP nav (blocklist)
- ~800ms per active tracking
- ~500-800ms per buy (parser swap)
- 95% reduction in BG request rate

### Phase A.1 (follow-up hygiene CL)

8. loadSettings/loadProfiles mtime cache
9. Lazy pickIdsToEvict
10. Parallelize setMaxQuantity + detectBuyPath
11. listAmazonAccounts 60s cache
12. **toggleBGNameAndRetry event-driven waits** (Pass 13 §2)
13. **selectAllowedAddressRadio 500ms blind → waitForFunction** (Pass 13 §3)
14. **debug-screenshots auto-prune** (Pass 13 §4)
15. Drop polling: 1000 in fetchOrderIdsForAsins

### Phase B (separate CLs)

- Pass 7 §4 W rewrite — covers MAX_DELIVER_CLICKS, MAX_PENDING_CLICKS,
  MAX_DELIVERY_RECOVERIES blind waits all in one
- Pass 7 §5 Idle-pool sessions
- Pass 7 §6 AccountLock acquireRead
- Pass 8 §2 Tier 2 cancel-sweep parallelize
- HTTP timeouts on BG client

### Phase C / D (architectural)

- Defer cancel sweep to scheduler tuple
- IPC delta broadcasts
- Trace-only-the-tail (snapshotOnFailure=true users)
- B7 multi-context refactor

---

## 🏁 Honest assessment after pass 13

The savings curve is now genuinely close to flat for buy-hot-path
optimizations:

| Pass | New top-5 | Marginal saving |
|---|---|---|
| 7 | 5 | 8-15s |
| 8 | 1 (cancel sweep) | +25-55s |
| 9 | 0 (×3 multiplier) | +30-40s revised |
| 10 | 0 (live tests blocked) | unchanged |
| 11 | 1 (BG broadcast) | +500ms-2.4s/fan-out |
| 12 | 0 | +200-300ms hygiene |
| 13 | 1 (doomed-retry) | +80-160s on failure cases (frequency-dependent) |

**Pass 13's doomed-cashback-retry short-circuit is potentially the
2nd-biggest absolute saving in the master ranking** — it just doesn't
fire on every buy, only on cashback failures. For users where ~30% of
buys hit cashback misses (rough estimate from production logs), the
expected per-buy saving is ~24-48s. That's competitive with the cancel
sweep tier-1 fixes for some workloads.

**The pattern across Pass 7-13:** every other pass finds a
non-buy-hot-path candidate that's worth as much as 5-10 buy-hot-path
candidates. The lifecycle-wide cancel work (pass 8/9), the system-wide
BG broadcast (pass 11), and now the doomed-retry short-circuit (pass 13)
are all examples.

This pattern will likely continue if research continues — there are
always more failure paths to audit. But the diminishing-returns on
production traffic remain the biggest argument for shipping Phase A
before the next research round.

**Recommend:** ship Phase A. The doomed-cashback-retry fix, in
particular, has empirical signal in existing production logs (pass 1
trace showed ~167s on a `cashback_gate` failure). Shipping it would
save real seconds on every cashback miss, with a clear A/B comparison
possible.
