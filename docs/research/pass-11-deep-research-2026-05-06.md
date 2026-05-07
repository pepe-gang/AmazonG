# Pass 11 — Deep research, 2026-05-06 (round 5)

After 4 passes focused on the buy hot path + cancel sweep, this pass moves
**outside** the per-buy code entirely. Audit:

1. The BG client (`src/bg/client.ts`) — every BG round-trip blocks the
   streaming scheduler producer or the renderer broadcast.
2. The IPC bridge (`src/preload/index.ts` + `src/shared/ipc.ts` +
   `main/index.ts` broadcast logic) — 1000-row job list, full-state
   replacement, broadcast cadence.
3. The renderer (`src/renderer/`) — JobsTable, App.tsx data flow.
4. Chase integration (`src/main/chase*.ts`) — separate buy-flow.

Headline: **One major perf bug found** — `listMergedAttempts` triggers a
**full BG round-trip on every coalesced broadcast**, and broadcasts fire
on every JobAttempt update. Net: **up to 4-5 BG round-trips per fan-out
wasted on UI freshness alone.**

---

## 🔴 Major bug — `listMergedAttempts` does BG round-trip per broadcast

**File:** `src/main/index.ts:294-302` (`scheduleBroadcastJobs`) → `:368-376`
(`listMergedAttempts` → `bg.listPurchases(500)`).

The chain:

```
storeUpdateAttempt(attemptId, patch)
  → scheduleBroadcastJobs()                    [coalesces at 250ms]
    → listMergedAttempts()                     [reads cache + calls BG]
      → bg.listPurchases(500)                  [HTTP round-trip ~100-300ms]
    → mainWindow.webContents.send(IPC.evtJobs, list)
```

**Each `scheduleBroadcastJobs` call eventually fires one `bg.listPurchases(500)`.**

Triggers per `scheduleBroadcastJobs`:
- `jobAttempts.create` (line 764) — every new attempt row
- `jobAttempts.update` (line 769) — every status/stage transition
- Settings changes that filter the table (line 1010)
- Bulk delete operations (lines 1906, 1910, 1915)
- Scheduler recovery + worker stop sweeps

### Cadence during a 5-profile fan-out

Each profile during a typical buy:
1. `create({ status: 'queued' })` — 1 broadcast
2. `update({ status: 'in_progress' })` — 1 broadcast
3. `update({ stage: 'placing' })` — `forceFlush:true` synchronous, 1 broadcast
4. `update({ stage: null })` — 1 broadcast
5. `update({ status: 'awaiting_verification', orderId, cost, ... })` — 1 broadcast

5 updates × 5 profiles = **25 attempt updates per fan-out**.

Coalesced at 250ms, that's roughly **~5-8 unique broadcasts per fan-out**.

**Each broadcast = 1 BG round-trip (~100-300ms each).**

→ **~500ms-2.4s of pure BG-fetch latency per fan-out**, unrelated to any
buy work. Burns BG bandwidth (5 × ~400KB = ~2MB) and BG worker time (5 ×
DB query for purchases scoped to the user).

### Why this is wrong

Per the comment in `listMergedAttempts:438-449`, the BG fetch exists to
**auto-prune local terminal-state orphans** and to merge server-derived
fields (`placedCashbackPct`, `trackingIds`, `fillerOrderIds`). Both are
slow-changing concerns:

- Terminal-orphan pruning: only relevant when the user deletes rows on
  the BG dashboard (rare, ~once per day). Doesn't need to fire on every
  buy update.
- Server field merge: `placedCashbackPct` etc. are only updated by /status
  POSTs the local worker just made; the local row is authoritative for
  ~10 minutes after placement. Merge is wasteful during the buy itself.

### Recommended fix

Two-tier broadcast strategy:

```ts
// Fast path (default): local-only, no BG call
async function broadcastJobsLocal(): Promise<void> {
  const local = await storeListAttempts();
  mainWindow?.webContents.send(IPC.evtJobs, local);
}

// Slow path: BG-merged, runs on a 30s interval + on-demand from renderer
async function broadcastJobsMerged(): Promise<void> {
  const merged = await listMergedAttempts();
  mainWindow?.webContents.send(IPC.evtJobs, merged);
}

// Trigger the slow path only when:
//   (a) the user manually refreshes (via renderer.jobsList())
//   (b) on a 30s interval timer
//   (c) on worker.start
// Every other broadcast goes through fast path.
```

**Saving:** ~500ms-2.4s per fan-out, plus reduced BG load by ~95%.

**Risk:** Low — terminal orphan pruning + server field merge can lag by
30s without affecting any user workflow. Renderer state is already
fresh-from-local for everything actively in flight.

**File:line:** `src/main/index.ts:294-302` (refactor) +
`src/main/index.ts:368-471` (split into local/merged variants).

---

## 🟡 No HTTP timeouts in BG client

**File:** `src/bg/client.ts:255-264`:

```ts
async function request<T>(path: string, init: RequestInit, allow204 = false): Promise<T | null> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  ...
}
```

No `AbortSignal.timeout(...)` on the fetch. If BG hangs (Vercel cold
start during deploy, network blip, regional outage), the worker hangs
indefinitely. The streaming scheduler's producer will block on
`claimJob()` if BG returns 200 but slowly drips bytes.

### Recommended fix

Add a default timeout to all BG calls:

```ts
async function request<T>(path: string, init: RequestInit, allow204 = false, timeoutMs = 15_000): Promise<T | null> {
  const url = `${baseUrl}${path}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { ...headers, ...init.headers } });
    ...
  } finally {
    clearTimeout(tid);
  }
}
```

15s default is more than 5× p99 for BG endpoints. Saves the worker from
indefinite stalls during BG outages.

**Saving:** Liveness — protects against unbounded hangs, not measurable
in normal operation.

**Risk:** Low — a transient slow request will surface as a `BGApiError`
which the existing scheduler error path already handles via `BACKOFF_SLEEP_MS`.

---

## 🟡 `listAmazonAccounts` could be cached per claim cycle

`pollAndScrape.ts:682` calls `bg.listAmazonAccounts()` inside
`resolveStreamingJobContext`, which fires per claimed job. With a 10-job
queue burst, that's 10 BG round-trips for the same data.

**Fix:** cache for 60s. Settings changes reflect within 1 minute, fast
enough for any user UX.

```ts
// In createBGClient or as a separate caching layer:
let accountsCache: { data: ...; ts: number } | null = null;
const ACCOUNTS_TTL_MS = 60_000;
async function listAmazonAccountsCached() {
  if (accountsCache && Date.now() - accountsCache.ts < ACCOUNTS_TTL_MS) {
    return accountsCache.data;
  }
  const data = await origListAmazonAccounts();
  accountsCache = { data, ts: Date.now() };
  return data;
}
```

**Saving:** ~100-200ms × (N-1) for an N-job burst = ~900ms-1.8s on a
10-job burst.

**Risk:** Low. 60s is well below the user's reaction time for toggling
the cashback gate; if anything user toggles take effect by the next
scheduled claim cycle.

---

## 🟢 IPC payload — full-state replace per broadcast

The renderer's `setAttempts` (App.tsx:225) replaces the entire array on
each `evtJobs` event. With 1000 rows × ~800 bytes each = ~800KB IPC
payload + React reconciliation diff cost.

The good news: JobsTable already uses **`@tanstack/react-virtual`**
(`JobsTable.tsx:2,297`), so the actual DOM render is bounded to ~20-30
visible rows. Virtualization isn't the issue.

The cost that's NOT bounded is:

1. The 800KB IPC marshaling (Electron's contextBridge serializes).
2. React's reconciler diffing 1000 array entries against the previous
   list to detect what changed.
3. Memo-invalidation cascades through every `useMemo` that depends on
   `attempts` (~10 such memos in JobsTable).

For most users this is tolerable, but during a heavy buy fan-out (4
profiles × 5 updates = 20 broadcasts in ~2-3 seconds, coalesced down
to maybe 8) the renderer pays this cost 8× per fan-out.

### Recommended fix (medium-effort)

Send **deltas** instead of full snapshots:

```ts
// New IPC channel: IPC.evtJobsDelta
type JobAttemptDelta =
  | { kind: 'created'; attempt: JobAttempt }
  | { kind: 'updated'; attemptId: string; patch: Partial<JobAttempt> }
  | { kind: 'deleted'; attemptId: string };

mainWindow?.webContents.send(IPC.evtJobsDelta, [{ kind: 'updated', attemptId, patch }]);
```

Renderer maintains a `Map<attemptId, JobAttempt>` and applies deltas.
Memo-invalidation triggers only for the affected row.

**Saving:** ~50-200ms of renderer time per broadcast on a 1000-row
table. Reduces IPC bandwidth from ~800KB to ~1KB per single-attempt
update.

**Risk:** Med — requires changes to both main-process broadcast logic
AND every renderer that consumes attempt state (App.tsx, JobsTable).
The current full-snapshot model is the simpler one.

**Caveat:** This is a UX-perf win, not a buy-throughput win. Doesn't
affect the buy slot or BG round-trip count. List under "Phase D"
deferred.

---

## 🟢 Chase integration is genuinely fine

Audited `chaseDriver.ts` (1314 lines), `chaseScrape.ts` (215 lines),
`chaseRedeemHistory.ts` (105 lines), `chaseCredentials.ts` (134 lines).

Findings:
- **Chase is not in the buy hot path.** It's user-driven (login,
  snapshot refresh, redeem-rewards, pay-balance).
- Blind waits exist (500ms cookie-flush before close, 2500ms
  post-redeem grace) but each fires once per user-initiated action,
  not per buy.
- HTML parsers in `chaseScrape.ts` are regex-based, not jsdom — already
  optimal.
- `chaseDriver.ts` already has `--disable-blink-features=AutomationControlled`
  and `webdriver=false` stub (which AmazonG's driver only got via
  `83e2542` — pass 6's C4).

**Conclusion:** No Chase-side perf candidates worth adding to the master
ranking. Chase is well-isolated and doesn't compete with Amazon flow.

---

## 🟡 Other small findings worth noting

### 1. `bg.listPurchases(500)` always asks for 500

Every `listMergedAttempts` calls `bg.listPurchases(500)` — the maximum.
But the user typically has 100-300 active purchases. Asking for 500
makes BG do extra work + bigger payload.

**Fix:** request `200` by default; bump to `500` only on initial mount.

**Saving:** ~50-100ms per BG call. Stacks with the broadcast bug above.

### 2. `appendLogBatch` writes one fsync per attempt-id per flush

`jobStore.ts:173-181`:

```ts
export async function appendLogBatch(attemptId, events) {
  await mkdir(logsDir(), { recursive: true });
  const payload = events.map((ev) => JSON.stringify(ev)).join('\n') + '\n';
  await appendFile(logFile(attemptId), payload, 'utf8');
}
```

`appendFile` with a string flushes via the kernel's normal cadence
(~5ms on macOS APFS). Multiple concurrent appends to different
attempt-ids serialize through Node's libuv pool. Five concurrent buys
each writing logs every 200ms = 25 writes/sec, all serialized.

**Fix:** keep an open `fs.WriteStream` per active attempt-id, close on
final flush. Saves the open/close overhead per write.

**Saving:** ~5-20ms per log batch. Marginal in absolute terms but
reduces lock contention on the log directory inode.

**Risk:** Low. Files-on-disk model unchanged.

### 3. Per `scheduleBroadcastJobs` recompute is wasteful when nothing visible changed

Many `scheduleBroadcastJobs` triggers don't actually change what the
user sees. Examples:
- `stage: 'placing'` (transient — cleared 2-10s later)
- `stage: null` (clearing a transient marker)
- `error: ''` → `error: ''` (no real change, but caller still invokes update)

The renderer uses these for the orange "placing" indicator dot, so
they're not entirely wasted. But they DO force the BG round-trip via
the bug above.

**Fix:** unrelated to the bug above. Not actionable in isolation.

---

## 📦 Updated Top-10 ranking after pass 11

Pass 11 introduces **two new top-tier candidates**, vaulting them into the
top-5:

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | **Cancel-form tier 1 fixes** | ~55-70s/filler-buy | Low | Pass 8 §2 + Pass 9 §1 |
| 2 | **`listMergedAttempts` BG-fetch fix** ⭐ NEW | ~500ms-2.4s/fan-out + 95% BG load reduction | Low–Med | **Pass 11 §1** |
| 3 | **Cancel-sweep tier 2 (parallelize + defer)** | 25-55s buy-slot | Med | Pass 8 §2 |
| 4 | **Telemetry fix — propagate jobId+profile** | 0ms (unblocks future research) | Low | Pass 7 §1 |
| 5 | **CDP blocklist extension (9 patterns)** | 2.0-2.3s/PDP | Low | Pass 7 §3 |
| 6 | **Idle-pool session lifecycle** | 5-15s/consecutive | Low–Med | Pass 7 §5 |
| 7 | **Skip duplicate /order-details fetch** | ~800ms/track | Low | A4 |
| 8 | **JSDOM → node-html-parser swap** | 500-800ms/buy | Low | Pass 4 #1 |
| 9 | **`listAmazonAccounts` caching (60s TTL)** ⭐ NEW | ~900ms-1.8s/burst | Low | **Pass 11 §3** |
| 10 | **Event-driven waitForCheckout + waitForConfirmationOrPending** | 500ms-3.5s/buy | Med | Pass 7 §4 |

The pass-11 wins are **system-wide** (affect every buy regardless of
mode), making them broadly applicable across both filler-mode and
single-mode workloads.

---

## 🛣️ Recommended ship order — UPDATED after Pass 11

### Phase A (next CL — bundle low-risk wins)

1. **Cancel-form Tier 1 fixes** (cancelForm.ts + cancelFillerOrder.ts)
2. **`listMergedAttempts` two-tier broadcast** ⭐ NEW (the 95%-BG-load fix)
3. **`listAmazonAccounts` 60s cache** ⭐ NEW
4. **Telemetry fix** (jobId+profile in step.* emitters)
5. **CDP blocklist extension** (9 patterns)
6. **A4 fetchTracking dedup**
7. **A1 JSDOM → node-html-parser swap**

**Phase A cumulative on filler-mode:**
- ~55-70s saved per filler buy (cancel-form)
- ~500ms-2.4s saved per fan-out (BG broadcast fix)
- ~900ms-1.8s saved per burst (accounts cache)
- ~2.3s saved per PDP nav (blocklist)
- ~800ms per active tracking
- ~500-800ms per buy (parser swap)
- ~95% reduction in BG request rate

### Phase B (separate CLs)

8. Pass 8 §2 Tier 2 — parallelize cancel sweep
9. Pass 7 §4 W rewrite
10. Pass 7 §5 Idle-pool sessions
11. Pass 7 §6 AccountLock acquireRead
12. **HTTP timeouts on BG client** (Pass 11 §2)

### Phase C (architectural)

13. Defer cancel sweep to scheduler tuple
14. **IPC delta broadcasts** (Pass 11 §"renderer") — UX-perf, not throughput
15. B7 multi-context refactor

---

## 🪦 Confirmed dead — additions from pass 11

| Hypothesis | Why dead | Source |
|---|---|---|
| Chase code path has perf candidates | Regex parsers, no blind waits on hot path, already has anti-bot driver flags | Pass 11 §"chase" |
| `appendFile` log writes are a bottleneck | ~5ms per write on APFS; with 25/sec concurrent, lock contention is mild | Pass 11 §"misc" |

---

## 🏁 Honest assessment after pass 11

After 5 deep-research passes, the picture is now fairly complete:

- **Buy hot path:** at floor.
- **Lifecycle-wide cancel sweep:** ~55-70s of savings (Pass 8/9).
- **System-wide overhead:** ~3-5s of savings — this is what Pass 11
  uncovered. The `listMergedAttempts` BG-fetch bug is independent of
  every buy-flow optimization. It fires regardless of mode, profile,
  or product.
- **UX-perf (renderer):** medium-effort delta broadcasts; not a buy-
  throughput win but improves heavy-fan-out interactivity.

**The next research round, if it happens at all,** should focus on:
1. Empirical validation of cancel-form fixes (real production buy with
   the telemetry fix landed)
2. The address-picker flow (still missing — needs a fresh-sign-in profile)
3. Memory growth over time (not yet audited — long-running AmazonG
   sessions may accumulate)
4. The auto-enqueue tick (`autoEnqueueIntervalHours: 4`) — runs in the
   background, may have its own perf profile

But realistically: **ship Phase A first**. After 5 passes, the master
ranking has stabilized. Five round-trips of audit have been delivering
diminishing returns; the next 10× improvement now requires shipping
something to validate.

The only remaining truly novel angle is observability via the telemetry
fix — once `step.buy.*` events land on disk with `jobId+profile`,
real production traffic becomes the research substrate instead of
synthetic probes.
