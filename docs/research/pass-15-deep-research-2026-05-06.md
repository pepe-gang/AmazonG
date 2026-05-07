# Pass 15 — Deep research, 2026-05-06 (round 9) — DIFFERENT ANGLE #2

After pass 14 audited the BG Next.js endpoints, this pass goes further out:

1. The **BG Railway worker** (`~/Projects/Better-BuyingGroup/worker/`) —
   the Node process that creates AutoBuyJob rows AmazonG eventually claims
2. The **deals catalog flow** — `/api/public/deals/amazon` endpoint
3. **Dependency tree + bundle size** for AmazonG — startup cost,
   tree-shaking, code splitting

Headline: **BG worker auto-poll cadence is 6 minutes — that's the
discovery-latency floor for new deals.** Plus one BG-side missing index
on the deals endpoint.

---

## 🟡 BG worker auto-poll cadence sets discovery latency floor

`worker/index.ts:49-56`:

```ts
const AUTO_POLL_INTERVAL_MS = parseInt(
  process.env.AUTO_POLL_INTERVAL ?? process.env.POLL_INTERVAL ?? "360",
  10
) * 1000;
const WATCHLIST_POLL_INTERVAL_MS = parseInt(
  process.env.WATCHLIST_POLL_INTERVAL ?? "60",
  10
) * 1000;
```

- Auto tick: every **360 seconds (6 minutes)** — discovers new BG
  commitments + creates AutoBuyJob rows for AmazonG to claim
- Watchlist tick: every **60 seconds** — polls user-configured
  watchlists for changes

The BG worker locks each tick (`autoRunning` / `watchlistRunning`
flags at `worker/index.ts:1850-1882`) so overlapping ticks skip. A
slow tick can extend the effective cadence beyond 6 minutes.

### Implication for AmazonG

When a deal becomes available on buyinggroup.com:
- Worst case: 6 min until BG worker scouts it
- Plus AmazonG's claim cadence (2s when idle)
- = **6+ minute floor between deal availability and AmazonG seeing the job**

For users running rebuy-heavy workloads, this delay is invisible
(rebuy jobs go through different code paths and bypass the auto-tick).
For new-deal workloads, this is the latency lower bound.

### Optimization (BG-side, out of scope for AmazonG)

If BG team wanted to reduce this:
- Drop `AUTO_POLL_INTERVAL` env to 120s (2 min) — 3× faster discovery
- Cost: 3× upstream API load on buyinggroup.com + proxy resources

Probably already tuned for cost. Not actionable on AmazonG side.

---

## 🟢 BG worker is well-locked, no concurrency wins

The auto + watchlist ticks both:
- Skip if previous run is still in flight
- Catch errors and continue
- Reset stuck `in_progress` rows older than 10min (`DETAIL_SYNC_STALE_MS`)

`DETAIL_SYNC_BATCH = 200` and `DETAIL_SYNC_CONCURRENCY = 20` are
already aggressive for the upstream BG API rate limits. No obvious
parallelism wins on the worker side.

---

## 🟡 `/api/public/deals/amazon` missing storeSlugs index

`src/app/api/public/deals/amazon/route.ts:24-50`:

```ts
const rows = await db.sharedDeal.findMany({
  where: {
    storeSlugs: { has: AMAZON_SLUG },
    enabled: true,
  },
  ...
  orderBy: { discoveredAt: "desc" },
});
```

Existing SharedDeal indexes (`prisma/schema.prisma`):
```prisma
@@index([lastSyncedAt])
@@index([lastChangedAt])
```

**No index on `storeSlugs`.** Postgres has to sequential-scan SharedDeal
+ filter by array containment + `enabled=true`. SharedDeal could have
10000+ rows.

### Fix

Add a partial GIN index for the array containment query:

```prisma
@@index([storeSlugs], type: Gin)
```

Or for Prisma's Postgres provider:
```sql
CREATE INDEX "SharedDeal_storeSlugs_idx" ON "SharedDeal" USING GIN ("storeSlugs");
```

**Saving:** ~100-500ms per `/api/public/deals/amazon` call — fires
once per Deals tab open per AmazonG user. Not buy-throughput-affecting,
but improves Deals tab loading for the user.

**Risk:** Low. Adding an index doesn't change query semantics.

**File:line:** `~/Projects/Better-BuyingGroup/prisma/schema.prisma`
SharedDeal model.

---

## 🟢 AmazonG dependencies are clean

`package.json` declares 16 runtime + 12 dev deps. Heavy node_modules:

| Dep | Size | Where |
|---|---|---|
| `electron` | 245 MB | Build-only (not shipped in app) |
| `app-builder-bin` | 207 MB | Build-only |
| `lucide-react` | 36 MB | Source — tree-shaken to ~10s of icons in build |
| `electron-winstaller` | 31 MB | Build-only |
| `typescript` | 23 MB | Build-only |
| `playwright-core` | 11 MB | **Runtime — bundled with app** |
| `vitest` | 15 MB | Test-only |

### Build outputs

```
out/renderer/assets/index-DwHas9Ch.js   1.29 MB
out/main/index.js                        337 KB
out/main/chunks/scheduler-DEFmnQsF.js     22 KB
out/preload/index.js                      12 KB
```

- Renderer bundle is **1.29 MB** — moderate for an Electron app. Could
  be code-split per-route (Deals, Accounts, Bank, Logs each are heavy
  pages with their own deps).
- Main process bundle is 337 KB. The scheduler is correctly code-split
  into a dynamic chunk (`scheduler-DEFmnQsF.js`).

### Lucide tree-shaking

Audited every lucide-react import. All use named imports
(`import { XIcon } from "lucide-react"`) which Vite/Rollup tree-shakes
to per-icon imports. The 36MB source becomes ~50KB shipped.

**Verdict:** dependency hygiene is fine. No actionable wins.

---

## 🟡 Renderer bundle could be code-split per route

The 1.29 MB renderer bundle includes ALL pages (Dashboard, Deals,
Accounts, Bank, Settings, Logs) bundled together. Initial render
of the dashboard loads code for Bank.tsx (1198 lines), Deals.tsx (537
lines), etc. that the user may never visit.

Vite supports lazy route-loading via React's `lazy()`:

```tsx
const Bank = lazy(() => import('./pages/Bank'));
const Deals = lazy(() => import('./pages/Deals'));
```

Saves ~300-500 KB from the main chunk. Initial dashboard render
becomes faster.

**Saving:** ~50-100 ms parse time on initial Electron window open.
Per app launch, not per buy.

**Risk:** Low. React's `<Suspense>` fallback is the standard pattern.

**File:line:** `src/renderer/App.tsx` route imports.

### Caveat

This is a UX improvement on app startup. Doesn't affect buy throughput
or BG round-trip count. List under "Phase D" with the IPC delta
broadcasts.

---

## 📦 Updated MASTER ranking after pass 15

Pass 15's findings are smaller than pass 14's. One BG-side index for
the deals endpoint, one AmazonG-side code-split candidate. Neither
displaces the top 10.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | Doomed-cashback-retry short-circuit | ~80-160s/failed cashback buy | Low | Pass 13 §1 |
| 6 | BG-side AutoBuyJob compound index | ~250ms-2.4s/fan-out per user | Low | Pass 14 §1 |
| 7 | CDP blocklist extension | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 8 | Idle-pool session lifecycle | 5–15s/consecutive | Low–Med | Pass 7 §5 |
| 9 | fetchTracking dedup | ~800ms/track | Low | A4 |
| 10 | JSDOM → node-html-parser swap | 500–800ms/buy | Low | Pass 4 #1 |

New entries (low priority):

- **BG-side `storeSlugs` GIN index** (Pass 15 §3) — ~100-500ms per
  Deals tab open. Low risk; ride-along on the Pass-14 BG-side ship.
- **Code-split renderer per route** (Pass 15 §5) — ~50-100ms parse
  time per app launch. UX-only, not buy throughput.

---

## 🛣️ Recommended ship order — UPDATED after Pass 15

No structural change. Pass 15's BG-side fix bundles with Pass 14's:

### Phase A.0 (BG repo bundle)

1. Pass 14 §1 AutoBuyJob `(userId, phase, createdAt DESC)` index
2. **Pass 15 §3 SharedDeal `storeSlugs` GIN index** ⭐ NEW

Both ship via `~/Projects/Better-BuyingGroup` → `vercel --prod`.
One Prisma migration covers both.

### Phase D (renderer UX improvements)

- IPC delta broadcasts (pass 11)
- Trace-only-the-tail (pass 12)
- **Code-split renderer per route** ⭐ NEW (pass 15)

---

## 🏁 Honest assessment after pass 15

Nine passes in. Pass 15's marginal yield: 1 small BG-side index + 1
UX-only renderer optimization. Both are real but small.

**Pattern continuation:** the "different angle" passes still find
candidates, but the magnitude is shrinking. Pass 14 found 250ms-2.4s
per fan-out; Pass 15 found 100-500ms per Deals tab open (which fires
infrequently) + 50-100ms per app launch.

**The diminishing-returns curve is now genuinely steep.** Each new
"different angle" requires going further from the buy hot path:

| Pass | Surface | Distance from buy hot path |
|---|---|---|
| 7 | buy code path itself | direct |
| 8 | cancel sweep (lifecycle within buy) | 1 step out |
| 9 | verify + fetch_tracking phases | 2 steps out |
| 11 | system-wide IPC + BG client | 3 steps out |
| 13 | failure paths + retry budgets | parallel to buy |
| 14 | BG Next.js endpoints | other-side, 1 hop network |
| 15 | BG worker + deals + deps | other-side, 2 hops away |

Each step further out, the candidates become smaller AND less
relevant to the user's "buy faster" goal. Pass 15's renderer
code-split affects app startup time, not buy speed at all.

### Truly unaudited surfaces

- **AmazonG's auto-update download path** — DMG is 350MB, no delta
  updates. UX concern only — affects how fast users get new versions.
- **BG's web dashboard** — competing for DB resources. Out of scope.
- **The `/api/public/deals/bestbuy` endpoint** — same shape as Amazon,
  AmazonG doesn't use it. Out of scope.
- **Network proxy configuration** — BG worker uses proxies for upstream
  buyinggroup.com calls. Cost shape on Railway's egress. Out of scope.
- **Long-running Electron memory growth** — needs runtime profiling,
  can't audit statically.

None of these would yield a top-5 candidate for buy throughput. They're
operational concerns for separate workstreams.

### Recommendation

After 9 passes, the master ranking is stable. **Ship Phase A** (the
top 10 candidates) before another research round. Real production
telemetry (unlocked by Pass 7 §1) will yield more useful information
than another pass of audit can.

If asked to keep going: I'll continue, but I'd rather draft actual
ship-ready code for one of the top candidates so you can see what
shipping it looks like. The marginal pass is now likely yielding
~100-500ms of savings per finding, far from the multi-second wins
of passes 7-13.
