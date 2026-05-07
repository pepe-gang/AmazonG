# Pass 16 — Deep research, 2026-05-06 (round 10) — DIFFERENT ANGLE #3

After pass 15 audited BG worker + deals + deps, this pass dives into:

1. The **BG `lib/`** modules backing the heavy `/api/autog/jobs/[id]/status`
   endpoint (autoBuy, notifications, push)
2. AmazonG's **auto-update mechanism** + `electron.vite.config.ts`
3. (Skipped: re-probe Amazon surfaces — covered exhaustively in passes
   1-6, Amazon changes slowly)

Headline: **`autoSubmitTracking` is awaited inline in the status
endpoint** — every fetch_tracking phase status report blocks the BG
response by ~500ms-2s while the upstream buyinggroup.com submission
completes. Easy `waitUntil`-based fix.

---

## 🟢 BG status endpoint awaits `autoSubmitTracking` inline

`src/app/api/autog/jobs/[id]/status/route.ts:394`:

```ts
if (body.trackingIds.length > 0) {
  await autoSubmitTracking({
    userId: auth.userId,
    autoBuyJobId: existing.buyJobId,
    amazonEmail: existing.placedEmail,
    trackingIds: body.trackingIds,
  });
}
```

`autoSubmitTracking` (`src/lib/autoBuy.ts:296-...`) does:

1. DB query: `findUnique` AmazonAccount (~10-30ms)
2. DB query: `findUnique` BGAccount (~10-30ms)
3. Two parallel DB queries: parentJob + purchaseRow (~30ms)
4. **Upstream HTTP call to buyinggroup.com** to submit tracking codes
   (~500ms-2s)
5. DB write: `persistOutcome` (~10-30ms)

**The whole chain is awaited.** AmazonG's `await bg.reportStatus(...)`
on the fetch_tracking phase blocks for the full duration.

### Cost from AmazonG's perspective

When AmazonG's fetch_tracking phase reports tracking codes:
- BG-side processing: ~600ms-2.1s
- Network round-trip to BG: 50-150ms
- **AmazonG worker waits: ~700ms-2.3s**

This blocks the AccountLock for that account during the wait — meaning
no other buy can start on that profile until the status report returns.

### Recommended fix

Use Vercel's `waitUntil` from `@vercel/functions`:

```ts
import { waitUntil } from "@vercel/functions";

// ... inside status route, replace `await autoSubmitTracking(...)`:
if (body.trackingIds.length > 0) {
  waitUntil(
    autoSubmitTracking({
      userId: auth.userId,
      autoBuyJobId: existing.buyJobId,
      amazonEmail: existing.placedEmail,
      trackingIds: body.trackingIds,
    }).catch((err) => {
      console.error(`[autoSubmitTracking failed] jobId=${id}:`, err);
    }),
  );
}
```

This tells Vercel to keep the lambda alive until autoSubmitTracking
finishes, but RETURNS THE RESPONSE IMMEDIATELY. AmazonG's worker gets
a fast 200, the actual tracking submission happens async.

**Saving:** ~500ms-2s per fetch_tracking status report. Fires once per
buy lifecycle. Direct AmazonG-observable speedup.

**Risk:** Low. Idempotency is preserved because BG.com dedupes via
`duplicateTrackings`. Failure path is unchanged (already swallowed
in console.error).

**File:line:** `~/Projects/Better-BuyingGroup/src/app/api/autog/jobs/[id]/status/route.ts:394`.

### Same pattern: `createRebuyJob` loop on cashback failures

`src/app/api/autog/jobs/[id]/status/route.ts:884-914`:

```ts
if (cashbackFailures.length > 0) {
  const user = await db.user.findUnique(...);
  if (user?.autoRebuyOnCashbackGate) {
    for (const p of cashbackFailures) {
      try {
        await createRebuyJob({ ... });  // SERIAL, awaited
      } catch (err) { ... }
    }
  }
}
```

When a 5-profile filler buy hits cashback failure on multiple profiles,
this serial loop blocks the status response by 5 × ~50ms = ~250ms.

Also wrappable in `waitUntil` (rebuy schedule timing isn't time-sensitive).

**Saving:** ~100-400ms per multi-profile cashback failure status
report.

**File:line:** `~/Projects/Better-BuyingGroup/src/app/api/autog/jobs/[id]/status/route.ts:892-914`.

### Already correctly fire-and-forget

`createNotification` calls at status route line 610 + autoBuy.ts:518
already use `void createNotification(...)`. Good. The push delivery
chain runs async without blocking the status response.

---

## 🟢 AmazonG auto-update is manual, not background

`src/main/index.ts:1021-1066` — `IPC.versionCheck`:
- Calls BG `/api/autog/version`
- Compares semver
- Surfaces "update available" banner

**No background download via `electron-updater`.** User clicks the
banner → opens download URL externally → manually installs new DMG
(350MB).

`electron-builder` produces `latest-mac.yml` (auto-update manifest)
with the release artifacts (per CLAUDE.md release pipeline), but
nothing in AmazonG consumes it. The plumbing for auto-download is
half-built but unused.

### UX implication

User ships v0.13.X → user gets banner → user clicks → browser
downloads 350MB DMG → user manually quits AmazonG, mounts DMG,
drags app, restarts.

vs.
With electron-updater: AmazonG downloads in background → notifies
"restart to update" → user clicks → instant restart on new version.

### Recommendation

This is a UX improvement, not a perf candidate for buy throughput.
List under "Phase D" deferred. No code in the master ranking — out
of scope for the current research arc.

---

## 🟢 electron.vite.config.ts is minimal — no manual chunking

The config (53 lines) uses Vite defaults:
- `externalizeDepsPlugin()` for main + preload (correct — Electron loads
  deps from node_modules at runtime)
- React + Tailwind plugins for renderer
- No `manualChunks` config
- No `optimizeDeps` config

Pass 15's renderer code-split candidate (lazy route loading via React
`lazy()`) is the actionable fix here. Vite would handle the chunking
automatically once routes are wrapped.

---

## 📦 Updated MASTER ranking after pass 16

Pass 16 introduces **two new BG-side candidates**, both `waitUntil`-
based async-ification of inline awaits in the status endpoint.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | Doomed-cashback-retry short-circuit | ~80-160s/failed cashback buy | Low | Pass 13 §1 |
| 6 | BG AutoBuyJob compound index | ~250ms-2.4s/fan-out per user | Low | Pass 14 §1 |
| 7 | **BG `autoSubmitTracking` → `waitUntil`** ⭐ NEW | ~500ms-2s per fetch_tracking status report | Low | **Pass 16 §1** |
| 8 | CDP blocklist extension | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 9 | Idle-pool session lifecycle | 5–15s/consecutive | Low–Med | Pass 7 §5 |
| 10 | fetchTracking dedup | ~800ms/track | Low | A4 |

Plus pass 16's smaller candidate:

- **BG `createRebuyJob` loop → `waitUntil`** (Pass 16 §1 second half)
  — ~100-400ms per multi-profile cashback failure

Both bundle naturally with the existing Phase A.0 BG ship (pass 14 +
pass 15 + pass 16 BG fixes ship together via `vercel --prod`).

---

## 🛣️ Recommended ship order — UPDATED after Pass 16

### Phase A.0 (BG repo bundle, ships via `vercel --prod`)

1. Pass 14 §1 — AutoBuyJob `(userId, phase, createdAt DESC)` index
2. Pass 15 §3 — SharedDeal `storeSlugs` GIN index
3. **Pass 16 §1 — `autoSubmitTracking` → `waitUntil`** ⭐ NEW
4. **Pass 16 §1 — `createRebuyJob` loop → `waitUntil`** ⭐ NEW

All four ship in one BG-side migration + code change. The two index
additions are a single Prisma migration. The two `waitUntil` swaps
are two-line code changes in the status route.

### Other phases unchanged from prior pass

---

## 🏁 Honest assessment after pass 16

Ten passes in. Pass 16 found one substantial new candidate (autoSubmitTracking
→ waitUntil) and one smaller one (createRebuyJob loop). Both are
BG-side fixes that bundle naturally with pass 14/15.

### Key insight from pass 16

The pattern across passes 14, 15, 16 (the BG-side "different angle"
trio):
- Pass 14: missing index → server-side query latency
- Pass 15: missing index for deals + dependency tree
- Pass 16: inline awaits that should be waitUntil

**These BG-side fixes have a multiplier effect.** Every AmazonG client
benefits proportionally. The user's setup (single AutoG key, modest
job volume) sees small absolute time savings; a multi-tenant scale BG
deployment would see them magnified across users.

### Ten-pass trajectory (consolidated)

| Pass | Surface | New top-10? | Marginal saving |
|---|---|---|---|
| 7 | buy hot path | 5 | 8-15s |
| 8 | cancel sweep | 1 | +25-55s |
| 9 | verify + fetch_tracking | 0 | +30-40s revised |
| 10 | live A/B blocked | 0 | unchanged |
| 11 | system-wide IPC + BG client | 1 | +500ms-2.4s/fan-out |
| 12 | hygiene | 0 | +200-300ms |
| 13 | failure paths + retries | 1 | +80-160s on failures |
| 14 | BG endpoints + indexes | 1 | +250ms-2.4s/fan-out |
| 15 | BG worker + deals + deps | 0 | +100-500ms (Deals tab) |
| 16 | BG lib + auto-update | 1 | +500ms-2s/fetch_tracking |

**4 of the 10 passes since #7 found a new top-10 candidate.** The other
6 yielded refinements without new top-tier finds.

### Diminishing-returns curve — ten-pass view

The "different angle" passes (8, 11, 13, 14, 16) yielded substantial
candidates. The "deeper into same code" passes (9, 10, 12, 15) yielded
refinements only.

If continuing: the next "different angle" surfaces would be:
- **Network packet capture** on a live AmazonG run — would surface
  things only visible at the wire (TCP behavior, TLS session reuse,
  HTTP/2 vs HTTP/3 negotiation).
- **Memory profile** of a long-running session — would surface leaks.
- **AmazonG → Chase integration** during a buy that uses Chase Visa
  (the cashback-eligible card) — does Chase's rewards system have any
  perf interaction with the buy flow?
- **The BG Vercel deploy pipeline itself** — Vercel function cold
  starts contribute to the variance in BG round-trip times AmazonG
  observes.

Each of these is genuinely possible to audit but at substantial setup
cost (live capture, memory profiler, end-to-end Chase + Amazon flow).

After 10 passes, the master ranking is comprehensive. Real production
telemetry would unlock more empirical grounding than any single
additional research pass. **Ship the telemetry fix (Pass 7 §1). Then
re-research with data.**
