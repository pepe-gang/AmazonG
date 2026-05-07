# Pass 14 — Deep research, 2026-05-06 (round 8) — DIFFERENT ANGLE

After 7 passes auditing AmazonG inside-out, this pass flips the perspective:
**audit the OTHER side** — the BG (Better-BuyingGroup) Next.js endpoints
AmazonG hits. Pass 11 found the broadcast loop wastes BG round-trips, but
hadn't audited what each round-trip actually costs **server-side**.

Source: `~/Projects/Better-BuyingGroup/`. Endpoints under
`src/app/api/autog/`. Database via Prisma + Postgres.

Headline: **AutoBuyJob is missing a critical compound index** that the
hottest BG endpoint (`/api/autog/purchases`) depends on. Adding it could
save 50-300ms per call — and that call fires 5-8× per fan-out per
pass-11.

---

## 🔴 Major finding: missing `(userId, phase, createdAt DESC)` index on AutoBuyJob

`src/app/api/autog/purchases/route.ts:91-100`:

```ts
const jobs = await db.autoBuyJob.findMany({
  where: {
    userId: auth.userId,
    phase: "buy",                         // <-- filter
    ...(jobIdFilter ? { id: jobIdFilter } : {}),
  },
  orderBy: { createdAt: "desc" },         // <-- sort
  include: { purchases: ... },
  take: limit,                            // typically 200, max 500
});
```

Existing AutoBuyJob indexes (`prisma/schema.prisma:493-497`):

```prisma
@@index([userId, status])
@@index([status, createdAt(sort: Desc)])
@@index([commitmentId])
@@index([dealId])
@@index([upc])
```

**There is no index that matches `(userId, phase, createdAt DESC)`.**
Postgres's planner has these options for the GET /api/autog/purchases
query:

1. Use `(userId, status)` to find user rows → table fetch each →
   filter by `phase` → sort by `createdAt` → take 200.
2. Use `(status, createdAt DESC)` and filter by `userId` and `phase`
   in memory.

Either way: **filter + sort cost** that scales with the user's total
job history. Power users with 10000+ historical jobs pay the most.

### Cost estimate

For a user with 5000 AutoBuyJob rows:
- With current indexes: ~50-300ms query time (depending on stat cache state)
- With `(userId, phase, createdAt DESC)` covering index: index-only scan,
  ~5-30ms

**Saving:** 50-300ms per `purchases` GET call.

### Frequency

Per AmazonG pass 11: `bg.listPurchases(500)` fires 5-8 times per
5-profile fan-out (one per coalesced broadcast). On a busy buy day:
- 50 fan-outs/day × 6 calls × 100ms saved (mid-range) = **30s saved per day per user** on this single index
- Plus reduced Postgres CPU + I/O

### Recommended fix

Add to `prisma/schema.prisma` after line 497:

```prisma
@@index([userId, phase, createdAt(sort: Desc)])
```

Generate migration, apply on Vercel. Zero AmazonG-side changes needed.

**Risk:** Low. Adding a compound index doesn't change query semantics;
old plans remain valid. Migration cost: ~seconds on a typical Postgres
table at user-scale (low millions of rows total).

**File:line:** `~/Projects/Better-BuyingGroup/prisma/schema.prisma:497`.

---

## 🟡 Status endpoint is 922 lines — heavy on every job report

`src/app/api/autog/jobs/[id]/status/route.ts` is **922 lines**.
Handles:
- Update AutoBuyJob row
- Upsert AutoBuyPurchase rows (1-N per call)
- Create notifications
- Trigger auto-submit-tracking
- Create rebuy jobs on cancellations
- Lots of cross-row reasoning

Cost: probably 200-800ms typical (warm Vercel) + lots of DB transactions.

This fires once per buy bundle (after all profiles report) AND once per
verify phase AND once per fetch_tracking phase. So on a typical filler
buy lifecycle:
- 1 buy bundle status report
- 1 verify status report
- 1 fetch_tracking status report
- = 3 × ~500ms = **1.5s of BG-side processing per buy lifecycle**

### Optimization candidate (BG-side, not AmazonG)

If the BG team wants to reduce this:
- Move the cross-row reasoning (rebuy creation, auto-submit) to a
  background job (e.g., Vercel cron + queue) instead of inline.
- The status POST returns immediately after the row writes; downstream
  side-effects fire async.

**Caveat:** out of scope for AmazonG fixes. Listed for completeness.

---

## 🟢 amazon-accounts endpoint is well-indexed already

`src/app/api/autog/amazon-accounts/route.ts:29-44` runs **two queries
in parallel via `Promise.all`**:

```ts
const [rows, bgAccounts] = await Promise.all([
  db.amazonAccount.findMany({ where: { userId } }),
  db.bGAccount.findMany({ where: { userId }, orderBy: { label: "asc" } }),
]);
```

Both indexed on `userId` (AmazonAccount has `@@unique([userId, email])`,
BGAccount has `@@index([userId])`). Cost: ~30-100ms warm.

Pass 11 §3 already proposed AmazonG-side caching (60s TTL) for this —
that fix saves the round-trip entirely. No additional BG-side work needed.

---

## 🟢 claim endpoint is well-designed

`src/app/api/autog/jobs/claim/route.ts:28-47` uses **`FOR UPDATE SKIP
LOCKED`** for atomic concurrent claim. Correct.

Three queries on success path:
1. UPDATE...SELECT (atomic claim) — fast
2. findUnique by id — sub-ms
3. findUnique on SharedDeal by dealKey — sub-ms (`dealKey @unique`)

Cost: ~30-100ms warm. Cold start adds 100-500ms (Vercel Lambda).

When idle: AmazonG polls 30/min × ~50ms warm = **1500ms/min idle BG
load**. Plus occasional cold starts ×500ms each.

### Possible BG-side micro-fix

The third query (SharedDeal lookup for dealId+price enrichment) could
be folded into the first via a Postgres CTE or done client-side via
the snapshot columns AmazonG just shipped (`AutoBuyJob.dealId`,
`AutoBuyJob.upc`). Saves one round-trip, ~10-20ms.

**Saving:** ~10-20ms per claim call. Marginal.

---

## 🟡 No HTTP-side caching headers on any AutoG endpoint

Every endpoint sets `export const dynamic = "force-dynamic"`. This
disables Next.js's edge cache and Vercel's CDN. For endpoints whose
data changes only on user action (e.g., `amazon-accounts`,
`/api/autog/version`, `/api/autog/me`), short-TTL HTTP caching could:

- Reduce Vercel function invocations
- Cache responses at the CDN edge for cross-region speedup

### Where caching would help

| Endpoint | Cacheable? | TTL |
|---|---|---|
| `/api/autog/me` | yes (per-user) | 5min |
| `/api/autog/amazon-accounts` | yes (per-user) | 30s |
| `/api/autog/version` | yes (global) | 5min |
| `/api/autog/purchases` | NO — mutates frequently | n/a |
| `/api/autog/jobs/claim` | NO — atomic mutation | n/a |
| `/api/autog/jobs/{id}/status` | NO — write-only | n/a |

### Recommended fix (BG-side)

Add response headers on `/api/autog/version` (low-risk first):

```ts
return NextResponse.json(payload, {
  headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' },
});
```

AmazonG's BGClient uses native `fetch`, which honors HTTP cache
semantics by default in Node. Subsequent calls within TTL hit the
local cache. Saves ~50-100ms × however many version checks.

**Saving:** Per-user/global, varies. Not buy-throughput-affecting.

---

## 🟢 Pattern: failed perf experiments (git log review)

Walked the git log for reverted perf commits. Five reverts:

| Commit | What | Why reverted |
|---|---|---|
| `83fe7c4` | Streaming PDP fetch + early `body.cancel()` | Native fetch doesn't propagate Set-Cookie to BrowserContext → broke filler flow Place Order |
| `bfae5f0` | Parallel per-item cart-add POSTs | "Silent-drop bug" — Amazon's edge sometimes lost items in concurrent posts |
| `7a2eab0` | First CDP `setBlockedURLs` attempt | Bisected to specific block — re-shipped after isolating the broken pattern |
| `087ab7c` | Path-block Rufus + dram + cr-media-carousel | Same bisect, re-shipped after narrowing |
| `2ea591b` | Extend blocklist (6 hosts + 3 cart widgets) | Same bisect |

### Lessons captured (already in MASTER dead list)

1. **`ctx.request.{get,post}` is the only safe HTTP path** — APIRequestContext
   shares cookies bidirectionally with BrowserContext. Native `fetch` doesn't.
2. **Amazon's batch endpoints expect serial** — parallel POSTs of "the
   same conceptual action" sometimes silently fail.
3. **CDP blocking needs empirical bisection** — some block patterns
   break Amazon JS in non-obvious ways; the safe set was found by
   one-by-one elimination.

These lessons constrain what future perf work can attempt:
- No `Promise.all` over Amazon-side mutations on the same session
- No `ctx.request` replacement with `fetch` for cookie-bearing calls
- New CDP block patterns need bisect testing, not bulk-add

### Pattern not yet captured but visible in history

**Reverts cluster around "trying to do less work in parallel".**
Future perf work should be biased toward:
- Removing wait-time (blind waits → event-driven)
- Reducing payload (parser swap, caching)
- Eliminating redundant work (BG broadcast fix, fetchTracking dedup)

NOT toward:
- Concurrency increases on the buy hot path
- Streaming/early-cancel of session-cookie-bearing requests

This pattern is implicit in MASTER's dead list but worth noting
explicitly for future researchers.

---

## 🟡 Other BG-side observations

### `force-dynamic` on every endpoint

All AutoG endpoints declare `export const dynamic = "force-dynamic"`.
Necessary for the auth-gated mutating ones; over-broad for read-only
ones (version, me).

### No request body size limits visible

The status endpoint body can be large (filler buys with 10+ purchase
rows). Vercel default is ~4.5MB. AmazonG's writes are ~2-10KB —
nowhere near, so not a concern.

### No rate limiting visible at the route layer

Vercel's default DDOS protection helps, but a misbehaving AmazonG
client could spam `claimJob` at much higher rates than the documented
2s cadence. **Risk vector** — not perf, but reliability.

---

## 📦 Updated MASTER ranking after pass 14

Pass 14 introduces **one new top-tier candidate** (BG-side index
addition). Lives in a different repo from AmazonG but is shipped via
the same release pipeline.

| Rank | Candidate | Saving | Risk | Source |
|---|---|---|---|---|
| 1 | Cancel-form tier 1 fixes | ~55–70s/filler-buy | Low | Pass 8/9 |
| 2 | listMergedAttempts two-tier broadcast | ~500ms-2.4s/fan-out + 95% BG load | Low–Med | Pass 11 §1 |
| 3 | Cancel-sweep tier 2 (parallelize + defer) | 25–55s buy-slot | Med | Pass 8 §2 |
| 4 | Telemetry fix | 0ms (unblocks future) | Low | Pass 7 §1 |
| 5 | Doomed-cashback-retry short-circuit | ~80-160s/failed cashback buy | Low | Pass 13 §1 |
| 6 | **BG-side `(userId, phase, createdAt DESC)` index on AutoBuyJob** ⭐ NEW | ~50-300ms/purchases call × 5-8 calls/fan-out = ~250ms-2.4s/fan-out per user | Low | **Pass 14 §1** |
| 7 | CDP blocklist extension | 2.0–2.3s/PDP | Low | Pass 7 §3 |
| 8 | Idle-pool session lifecycle | 5–15s/consecutive | Low–Med | Pass 7 §5 |
| 9 | fetchTracking dedup | ~800ms/track | Low | A4 |
| 10 | JSDOM → node-html-parser swap | 500–800ms/buy | Low | Pass 4 #1 |

Plus pass 14's smaller candidates:

- BG-side caching headers on `/api/autog/version` (~50-100ms × occasional)
- BG-side claim endpoint micro-fix: fold SharedDeal into claim CTE (~10-20ms/claim)

---

## 🛣️ Recommended ship order — UPDATED after Pass 14

Pass 14's BG index fix is **independent of all AmazonG-side fixes** —
it ships in a separate repo (`~/Projects/Better-BuyingGroup`). Two
recommendations:

### Order:

1. Pass 11 §1 BG-broadcast two-tier (AmazonG-side). 95% BG load reduction
   regardless of what BG does.
2. **Pass 14 §1 BG index** (BG-side). Saves the remaining 5% of calls
   AND helps the dashboard's web UI loading.

Order matters: shipping #1 first reduces the index's marginal value
(fewer queries to optimize). But both are independent — safe to ship
in either order.

### Updated Phase A bundle

Phase A (AmazonG repo):

1. Cancel-form Tier 1 fixes
2. Doomed-cashback-retry short-circuit (Pass 13 §1)
3. listMergedAttempts two-tier broadcast (Pass 11 §1)
4. Telemetry fix (Pass 7 §1)
5. CDP blocklist extension (Pass 7 §3)
6. fetchTracking dedup (A4)
7. JSDOM → node-html-parser swap (A1)

Phase A.0 (BG repo, parallel):

8. **AutoBuyJob `(userId, phase, createdAt DESC)` index** (Pass 14 §1)

These can ship to BG via the existing release pipeline (per CLAUDE.md:
push → `vercel --prod`).

### Phase A.1 — AmazonG follow-up hygiene

9. loadSettings/loadProfiles mtime cache
10. Lazy pickIdsToEvict
11. Parallelize setMaxQuantity + detectBuyPath
12. listAmazonAccounts 60s cache
13. toggleBGNameAndRetry event-driven waits
14. selectAllowedAddressRadio 500ms blind → waitForFunction
15. debug-screenshots auto-prune
16. Drop polling: 1000 in fetchOrderIdsForAsins

### Phase B / C unchanged from prior pass

---

## 🏁 Honest assessment after pass 14

**Different angle paid off.** Auditing the BG side surfaced a finding
the inside-AmazonG passes couldn't have caught — the missing index
is purely server-side. AmazonG's caller code is fine; the cost lives
in BG's Postgres query plan.

The **interaction with pass 11** is interesting:
- Pass 11 says: stop calling `bg.listPurchases(500)` so often (95%
  reduction).
- Pass 14 says: when you DO call it, make it 5-10× faster server-side.

Combined: AmazonG calls BG less often, AND each call is faster. Total
fan-out latency reduction: probably 1-3 seconds in mid-range scenarios.

Eight-pass trajectory:

| Pass | Marginal saving | New top-5? |
|---|---|---|
| 7 | 8-15s | 5 |
| 8 | +25-55s (cancel sweep) | 1 |
| 9 | +30-40s revised | 0 |
| 10 | unchanged | 0 |
| 11 | +500ms-2.4s/fan-out | 1 |
| 12 | +200-300ms hygiene | 0 |
| 13 | +80-160s on failures | 1 |
| 14 | +50-300ms BG-side, ×5-8/fan-out | 1 |

Four of the eight passes found a new top-5 candidate. Pattern: about
half the passes (the "different angle" ones — 8, 11, 13, 14) yielded
substantial new candidates; the other half (the "deeper into the same
code" passes — 9, 10, 12) yielded refinements but no new top-5s.

The remaining "different angle" surfaces I haven't audited:
- BG worker (`~/Projects/Better-BuyingGroup/worker/`) — is there a
  scheduling cost on BG itself when AutoG reports status?
- AmazonG's electron-builder + auto-update download — DMG is 350MB
- BG's web dashboard — does it competes with AutoG for DB resources?

These are progressively further from the user's "buy faster" intent.
At this point, **shipping is the highest-leverage move** by a wide
margin.

After 8 passes, I genuinely think we're past the point where another
pass yields a new top-5 finding more often than not. The ship-then-
re-research pattern is the right next step.
