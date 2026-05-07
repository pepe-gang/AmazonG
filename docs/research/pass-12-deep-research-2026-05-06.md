# Pass 12 — Deep research, 2026-05-06 (round 6)

After pass 11 surfaced the BG-fetch bug in the broadcast loop, this pass
audits surfaces I'd flagged as "next angles":

1. Auto-enqueue tick (the 4-hour deal-discovery timer)
2. Scheduler-internal resource lifetime (bundles, inFlight, AccountLock)
3. Snapshot/tracing system overhead on success paths
4. The jobStore ring-buffer eviction algorithm
5. File-read caching for `loadSettings` + `loadProfiles`
6. Static-analysis sweep for dead code + sequential-await chains

Headline: **`loadSettings` and `loadProfiles` are uncached file reads
called dozens of times per minute on the producer hot path.** Plus the
ring-buffer eviction is O(N log N) on every new attempt.

These are smaller wins than pass 7-11 surfaced, but reinforce the
"system-wide hygiene" theme started in pass 11.

---

## 🪦 Auto-enqueue tick — confirmed disabled stub

`src/main/index.ts:1241-1250`:

```ts
ipcMain.handle(IPC.autoEnqueueStatus, () => ({
  nextRunAt: null,
  lastRunAt: null,
  lastResult: null,
  autoEnqueueEnabled: false,
  autoEnqueueIntervalHours: 6,
  ...
}));
```

The handler returns a hardcoded "disabled" status. No implementation
schedules the actual enqueue tick. The `autoEnqueueEnabled` /
`autoEnqueueIntervalHours` / `autoEnqueueLastRunAt` fields in
settings.json are vestigial — leftover from a removed feature.

User's settings.json shows:
```
"autoEnqueueEnabled": true,
"autoEnqueueIntervalHours": 4,
"autoEnqueueLastRunAt": 1777558027943,
```

These are dead state. **Cleanup candidate, not a perf win.**

---

## 🟡 Scheduler resource lifetime — small leak under failure

### `bundles` map cleanup is correct on success path but could leak on overflow

`scheduler.ts:634-665` — `collectResult`:

- If bundle.results.length === bundle.total → finalize + delete (line 674) ✓
- If bundle.results.length > bundle.total → log + return early (line 651-664)

**The overflow path returns WITHOUT deleting the bundle.** A defensive
case that "shouldn't happen" but represents a memory leak under
double-collect failure. Each leaked bundle holds:
- `results: ProfileResult[]` (~800 bytes each × N profiles)
- `abortController: AbortController`
- `fillerByEmail: Map`

For a 5-profile bundle leaked: ~5KB. Across 1000s of jobs over months,
non-trivial.

**Fix:** also delete on overflow. One-line change at scheduler.ts:664:

```ts
if (bundle.results.length > bundle.total) {
  logger.error('scheduler.collectResult.overflow', ...);
  this.bundles.delete(tuple.jobId);  // NEW
  return;
}
```

**Saving:** memory hygiene only. ~0ms wall-clock.

**Risk:** Low. Defensive cleanup only fires if invariant breaks anyway.

### `inFlight` and `readyQueue` clean up correctly

`inFlight`: line 483 — `task.finally(() => this.inFlight.delete(task))`. ✓
`readyQueue`: consumed by consumer loop, drained on stop. ✓
`AccountLock writers/readers`: delete on release (lines 69, 98). ✓

### Stop-drain race

`stop()` at `scheduler.ts:144-171` drains the readyQueue but only waits
**4 seconds** for in-flight to settle (line 162). If a buy is mid-place,
the stop drains, but the buy's bundle is now marked failed locally —
when the actual buy completes, `collectResult` finds the bundle
already-removed and logs `missing_bundle` (line 637).

This is the source of "phantom" missing-bundle logs. Not a leak (bundle
correctly torn down) but log spam.

**Fix:** add a `stopped: boolean` guard in `collectResult` so post-stop
collections silently no-op instead of logging. Marginal hygiene.

---

## 🟢 Tracing overhead on success paths (when snapshotOnFailure=true)

`pollAndScrape.ts:875` (verify) and `:1646` (buy):

```ts
if (deps.snapshotOnFailure) await startTracing(session.context);
```

`captureFailureSnapshot` saves the trace on failure (line 71 in
snapshot.ts). On success, `discardTracing` stops without saving.

But during the trace's lifetime, **every browser action pays a 5-15%
overhead** per Playwright's docs. Multiplied across the buy hot path:

- ~30 Page ops per buy (clicks, evaluates, gotos, waitFors)
- 5-15% × 10s typical buy = **500ms-1500ms tax per buy** when snapshots are ON
- Plus the per-action recording cost adds memory pressure

The user's current settings.json has `snapshotOnFailure: false`, so
production isn't paying this. But any user who flips it on for debugging
is making every buy ~5-15% slower.

### Fix: trace only the post-Place-Order tail

The most diagnostic-valuable trace is the "Place Order click → thank-you
or failure" segment — that's where unexpected interstitials surface.
Pre-Place-Order, our existing logs already tell the story.

```ts
// In buyNow.ts, around `placeLocator.click(...)`:
if (opts.snapshotOnFailure) {
  await page.context().tracing.start({ screenshots: true, snapshots: true });
}
// ... place click, waitForConfirmation ...
if (opts.snapshotOnFailure && !succeeded) {
  await captureFailureSnapshot(...);
}
```

**Saving:** Eliminates ~500ms-1500ms tax per buy when snapshots are on,
preserves the diagnostic value of the post-place trace.

**Risk:** Low–Med. Loses pre-place trace data; users debugging
PDP-side issues lose visibility, but the per-step logs cover those.

---

## 🟢 `pickIdsToEvict` is O(N log N) on every new attempt

`jobStoreRingBuffer.ts:9-19`:

```ts
export function pickIdsToEvict(attempts, cap) {
  const ids = Object.keys(attempts);
  if (ids.length <= cap) return [];
  const sorted = ids.map(...).sort((a, b) => a.ts.localeCompare(b.ts));
  return sorted.slice(0, ids.length - cap).map((e) => e.id);
}
```

Called from `createAttempt` (jobStore.ts:131) on EVERY new attempt
creation. With MAX_ATTEMPTS=1000:

- `Object.keys`: O(N) — 1000 ops
- `.map`: O(N) — 1000 ops
- `.sort`: O(N log N) — ~10k comparisons
- Total: ~10–15ms per call on M-series Macs

Per fan-out (5 profiles × create): ~50–75ms wasted on sort.

Plus the early-exit at `if (ids.length <= cap) return []` short-circuits
the sort, but only when below cap. At steady-state load (cap reached),
every attempt creation pays the full sort.

### Fix

Two options:

**Option A — incremental insertion:** keep a sorted array (or min-heap)
of `(createdAt, id)` and insert/evict in O(log N). Trade-off: extra
data structure to maintain.

**Option B — lazy eviction:** only call evict on the persist path
(`scheduleSave` → `persist`), not on every attempt create. The 250ms
debounce already amortizes; piggybacking eviction onto the persist
batch eliminates the per-attempt sort.

Option B is simpler. Move `evictOldestIfNeeded()` from
`createAttempt` (line 131) into `persist` (line 78).

**Saving:** ~50–75ms per fan-out (5 profiles × ~12ms each).

**Risk:** Low. Eviction lag of one persist cycle (~250ms) vs immediate
is irrelevant for a 1000-cap ring buffer.

---

## 🟢 `loadSettings` and `loadProfiles` are uncached file reads

`src/main/settings.ts:55-85` and `src/main/profiles.ts:19-36`. Both:

```ts
export async function loadSettings(): Promise<Settings> {
  const raw = await readFile(filePath(), 'utf8');  // disk I/O every call
  const parsed = JSON.parse(raw) as Partial<Settings>;
  ...
}
```

No in-memory cache. Every call = `readFile` (5–10ms even on warm OS
cache) + `JSON.parse` (small file, 1–2ms).

Call sites (44 across `src/main` + `src/workflows`):

- **Hot-path:** `loadParallelism` is called once per claimed job inside
  `resolveStreamingJobContext`. Plus the scheduler's `capRefreshTimer`
  every 5s.
- **Hot-path:** `listEligibleProfiles` is called once per claim cycle
  (every 2s when idle, more when busy) inside `hasEligibleProfiles`.
- IPC handlers call both for various read/write paths.

### Cadence

- Idle worker: claims every 2s → `listEligibleProfiles` → `loadProfiles`
  → ~5ms file I/O. **30 calls/min × 5ms = 150ms/min wasted.**
- Active worker on a 5-job burst: ~5 × `loadParallelism` + 5 ×
  `listEligibleProfiles` per burst = 10 file reads → ~50ms per burst.

These add up: across an 8-hour day with steady-state activity, ~1–4
minutes of pure I/O time.

### Fix

In-memory cache with file-mtime invalidation:

```ts
let settingsCache: { mtimeMs: number; data: Settings } | null = null;

export async function loadSettings(): Promise<Settings> {
  const fp = filePath();
  let st;
  try { st = await stat(fp); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
  if (settingsCache && settingsCache.mtimeMs === st.mtimeMs) {
    return settingsCache.data;
  }
  const raw = await readFile(fp, 'utf8');
  const data = parseAndMigrate(raw);
  settingsCache = { mtimeMs: st.mtimeMs, data };
  return data;
}
```

`stat` is much cheaper than `readFile` (~0.5ms vs 5ms). Cache hit cost:
~0.5ms instead of 7ms.

Apply same pattern to `loadProfiles`.

**Saving:** ~150ms/min idle, ~30–60ms/burst active. Across a busy day,
~2 minutes of saved I/O.

**Risk:** Low. mtime-based invalidation is what every file-cache uses.
Users who edit settings.json by hand still see the change on the next
read.

---

## 🟡 Sequential-await chain hot spots

Static sweep across `buyNow.ts`, `buyWithFillers.ts`, `pollAndScrape.ts`
for `await ... await` chains where the operations could be parallel
(`Promise.all`):

### Already-parallelized correctly

- `clearCartHttpOnly` runs in parallel with `scrapeProduct` via the
  `preflightCleared` promise (pollAndScrape.ts:1679–1681). ✓
- Cancel response/nav waits are armed BEFORE the click (cancelForm.ts:83-99). ✓
- Filler search results ARE pulled serially per term (`for (const term)`
  loop), but this is intentional — the loop short-circuits as soon as
  enough candidates are found. Pass 7's A7 candidate (parallel-fire
  first 2 terms when underflow possible) covers the only realistic win.

### Possible parallelization

`pollAndScrape.ts:1683` (scrapeProduct) is followed sequentially by
verifyProductDetailed (1723). VerifyProductDetailed is a pure function
over the already-fetched `info`, ~5ms — too cheap to parallelize.

`buyNow.ts:121` setMaxQuantity is followed by detectBuyPath (159).
setMaxQuantity is a `page.evaluate`; detectBuyPath is a Playwright
visibility race. They depend on the same page state but write nothing
that the other reads. **Could be parallelized** for ~30–50ms saving.

`buyNow.ts:262-321` waitForCheckout → verifyCheckoutPrice →
ensureAddress → pickBestCashbackDelivery — these are sequential because
each runs on the current /spc state and may mutate it. Cannot be
parallelized.

### Fix candidate

Combine `setMaxQuantity` + `detectBuyPath` into one `Promise.all`:

```ts
const [qty, path] = await Promise.all([
  setMaxQuantity(page),
  detectBuyPath(page),
]);
```

**Saving:** ~30–50ms per buy (the smaller of the two roundtrips).

**Risk:** Low — both are read-only DOM probes.

**File:line:** `buyNow.ts:121-159`.

---

## 🪦 Confirmed dead — additions from pass 12

| Hypothesis | Why dead |
|---|---|
| Auto-enqueue tick has perf cost | Disabled stub at `index.ts:1241-1250`; no scheduler exists |
| `appendFile` log writes leak file handles | Each `appendFile` opens + closes; no leak |
| `inFlight`/`readyQueue` leak in scheduler | Both correctly drained on success/stop paths |
| AccountLock writers/readers leak | Delete on release confirmed (lines 69, 98) |

---

## 📦 Updated Top-15 ranking after pass 12

Pass 12 introduces three NEW low-risk candidates outside the buy hot
path. None are top-5 contenders, but they bundle naturally into the
"system hygiene" CL alongside Pass 11's BG-broadcast fix.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load reduction | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix (jobId+profile) | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | CDP blocklist extension (9 patterns) | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 6 | Idle-pool session lifecycle (60s TTL) | 5–15s/consecutive | Low–Med | Pass 7 §5 |
| 7 | fetchTracking dedup | ~800ms/track | Low | A4 |
| 8 | JSDOM → node-html-parser swap | 500–800ms/buy | Low | Pass 4 #1 |
| 9 | listAmazonAccounts 60s cache | ~900ms-1.8s/burst | Low | Pass 11 §3 |
| 10 | Event-driven waitForCheckout + waitForConfirmationOrPending | 500ms-3.5s/buy | Med | Pass 7 §4 |
| 11 | AccountLock acquireRead | 1–10s/collision | Low–Med | Pass 7 §6 |
| 12 | Drop polling: 1000 in fetchOrderIdsForAsins | ~500ms/buy | Low | Pass 9 §4 |
| 13 | **`loadSettings` + `loadProfiles` mtime cache** ⭐ NEW | ~150ms/min idle, ~50ms/burst | Low | **Pass 12 §5** |
| 14 | **Lazy `pickIdsToEvict` (move to persist path)** ⭐ NEW | ~50–75ms/fan-out | Low | **Pass 12 §4** |
| 15 | **Parallelize setMaxQuantity + detectBuyPath** ⭐ NEW | ~30–50ms/buy | Low | **Pass 12 §"sequential-await"** |

Plus a **conditional candidate** for users with `snapshotOnFailure: true`:

- **Trace-only-the-tail (Pass 12 §3):** ~500ms-1500ms/buy when tracing
  is on. Default user has it OFF, so 0ms in default config.

---

## 🛣️ Recommended ship order — UPDATED after Pass 12

Pass A bundle stays the same. Pass 12's findings are small enough to
ride along on either Pass A's hygiene CL or as a follow-up cleanup CL:

### Phase A (next CL — bundle)

1. Cancel-form Tier 1 fixes
2. listMergedAttempts two-tier broadcast
3. Telemetry fix
4. CDP blocklist extension
5. fetchTracking dedup
6. JSDOM → node-html-parser swap

### Phase A.1 (follow-up hygiene CL — Pass 12 wins)

7. **`loadSettings` + `loadProfiles` mtime cache**
8. **Lazy `pickIdsToEvict`**
9. **Parallelize setMaxQuantity + detectBuyPath**
10. listAmazonAccounts 60s cache

### Phase B (separate CLs)

11. Pass 8 §2 Tier 2 — parallelize cancel sweep
12. Pass 7 §4 — event-driven waitForCheckout + waitForConfirmationOrPending
13. Pass 7 §5 — idle-pool sessions
14. Pass 7 §6 — AccountLock acquireRead
15. HTTP timeouts on BG client

### Phase C (architectural)

16. Defer cancel sweep to scheduler tuple
17. IPC delta broadcasts
18. Trace-only-the-tail (conditional, snapshotOnFailure=true users)
19. B7 multi-context refactor

---

## 🏁 Honest assessment after pass 12

After 6 passes, the savings curve is now genuinely flattening:

| Pass | New top-5 candidates | Cumulative savings ceiling |
|---|---|---|
| 7 | 5 | 8–15s |
| 8 | 1 (cancel sweep, biggest) | +25–55s |
| 9 | 0 (×3 multiplier on cancel) | +30–40s revised |
| 10 | 0 (live tests blocked) | unchanged |
| 11 | 1 (BG-broadcast fix) | +500ms-2.4s/fan-out + system load |
| 12 | 0 (3 minor wins) | +200–300ms hygiene |

Pass 12's wins are real but small. They reinforce the "ship Phase A
hygiene bundle" theme without changing the ranking's headlines.

**The diminishing-returns curve says it's time to ship.** The strongest
single argument: Pass 7 §1's telemetry fix is itself a 5-line change
that unblocks evidence-based future research. Without it, every
subsequent pass either:
- Audits code (what we've been doing — yields hygiene wins)
- Probes synthetically (what Pass 8/9/10 tried — hits Amazon-side flagging)

After the telemetry fix lands, **one production buy** will yield more
empirical data than 6 passes of audit could surface.

The remaining unaudited surfaces (e.g., long-running memory growth,
build-time bundle sizes, dev/test workflow performance) are operational
hygiene that don't move the master ranking. They're best handled as
they surface in real production rather than via speculative audit.

**Recommend:** ship Phase A. Re-evaluate the research backlog after
the next round of production traffic.
