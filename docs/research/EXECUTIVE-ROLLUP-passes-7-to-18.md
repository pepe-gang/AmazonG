# Executive rollup — research passes 7–18 (2026-05-06)

12 deep-research passes done in one day, building on the prior 6-pass
master doc. **No code shipped yet.** This is the consolidated "ship
this, in this order" summary.

---

## TL;DR

- **Total identified savings: ~3-5s per buy hot-path + ~55-70s per
  filler-buy on cancel work + ~1-2s per fan-out on system overhead
  + 80-160s rescued from doomed cashback retries.**
- **One blocking observability gap:** `step.buy.*` events never reach
  disk because the emitter doesn't propagate `jobId+profile`. Until
  this is fixed, every future perf claim is inferred not measured.
  **Fix this first** — 5-line change.
- **Two repos to touch:** AmazonG (most fixes) and Better-BuyingGroup
  (4 server-side fixes that complement the AmazonG client-side ones).
- **Single highest-impact unshipped item:** pass 17's `page.content()
  +JSDOM → page.evaluate inline` for the 3 /spc cashback readers. Saves
  ~1.0-1.3s on every buy. Drop-in low-risk.

---

## 🚨 Ship-first item: telemetry fix (Pass 7 §1)

**5-line change. 0ms direct savings. But it unblocks every subsequent
research pass and every A/B comparison.**

`buyNow.ts:110-111`:

```ts
const step: StepEmitter = (message, data) => logger.info(message, data, cid);
const warn: StepEmitter = (message, data) => logger.warn(message, data, cid);
```

The disk-log filter (`main/index.ts:802-805`) requires `data.attemptId`
OR `data.jobId+data.profile`. The step emitter passes neither — every
`step.buy.*` event is silently dropped at the disk-log boundary. Across
50+ recent production logs in
`~/Library/Application Support/AmazonG/job-logs/`, **zero `step.buy.*`
events appear.** The 52-second gap between `scrape.ok` and
`profile.placed` in production has no internal detail because of this.

Fix: capture `jobId, profile` at the start of `buyNow` and merge them
into every emit. Same for `buyWithFillers`.

```ts
// At the top of buyNow():
const ctx = { jobId: opts.jobId, profile: opts.profileEmail };
const step: StepEmitter = (message, data) =>
  logger.info(message, { ...ctx, ...(data ?? {}) }, cid);
```

After this lands: one production buy yields more empirical data than
6 passes of audit could surface.

---

## Top 10 unshipped candidates (ranked by `saving / risk`)

| # | Candidate | File:line | Saving | Risk | Pass |
|---|---|---|---|---|---|
| 1 | Cancel-form Tier 1 fixes (5 small) | `cancelForm.ts:28,40,189,199` + `cancelFillerOrder.ts:141` | **~55-70s/filler-buy** across all 3 lifecycle phases | Low | 8/9 |
| 2 | listMergedAttempts two-tier broadcast (local-only fast path; BG-merge slow path on 30s timer) | `main/index.ts:294-302,368-471` | ~500ms-2.4s/fan-out + 95% BG load reduction | Low–Med | 11 §1 |
| 3 | Cancel-sweep Tier 2 (parallelize across N pages + defer to scheduler tuple) | `buyWithFillers.ts:1234` | 25-55s removed from buy slot per filler buy | Med | 8 §2 |
| 4 | **Telemetry fix** (jobId+profile in step.* emitters) | `buyNow.ts:110-111` + `buyWithFillers.ts` | 0ms but unblocks future research | Low | 7 §1 |
| 5 | Doomed-cashback-retry short-circuit (skip retry when attempt-1 cashback was 0/null) | `pollAndScrape.ts:551` + `BuyWithFillersResult` shape | ~80-160s/failed cashback buy (10-30% frequency) | Low | 13 §1 |
| 6 | BG-side AutoBuyJob `(userId, phase, createdAt DESC)` index | `~/Projects/Better-BuyingGroup/prisma/schema.prisma:497` | ~250ms-2.4s/fan-out per user | Low | 14 §1 |
| 7 | **Inline /spc parsers into `page.evaluate`** (drop page.content+JSDOM at 3 sites) | `buyNow.ts:1461,2069` + `buyWithFillers.ts:1721` | **~1.0-1.3s per buy** | Low | 17 §1-3 |
| 8 | BG-side `autoSubmitTracking` → `waitUntil` | `~/Projects/Better-BuyingGroup/...status/route.ts:394` | ~500ms-2s per fetch_tracking status report | Low | 16 §1 |
| 9 | CDP blocklist extension (9 new patterns: data.amazon.com, /vap/ew/*, twisterDimension, etc.) | `driver.ts:140-186` | ~2.0-2.3s/PDP nav | Low | 7 §3 |
| 10 | Idle-pool session lifecycle (60s TTL after success) | `pollAndScrape.ts:1911` (replace closeAndForgetSession with markIdle + new sessionPool helper) | 5-15s per consecutive same-profile buy | Low–Med | 7 §5 |

---

## Phased ship plan

### Phase A.0 (BG repo — 1 deploy via `vercel --prod`)

**4 changes in one Prisma migration + small status-route edits.**

1. AutoBuyJob `(userId, phase, createdAt DESC)` index (Pass 14 §1)
2. SharedDeal `storeSlugs` GIN index (Pass 15 §3)
3. `autoSubmitTracking` → `waitUntil` (Pass 16 §1)
4. `createRebuyJob` loop → `waitUntil` (Pass 16 §1)

**Deploy:** push to BG `main` → `cd ~/Projects/Better-BuyingGroup &&
vercel --prod --yes`.

**Cumulative:** 250ms-4s saved per fan-out + per-tracking report on the
BG side.

### Phase A (AmazonG repo — 1 CL bundle)

**8 changes that all touch independent files. Low coupling.** Any of
these 8 can be staged individually if desired.

1. **Telemetry fix** (Pass 7 §1) — ship FIRST so subsequent items have
   measurable impact
2. Cancel-form Tier 1 fixes (Pass 8/9) — biggest filler-mode saving
3. **Inline /spc parsers into evaluate** (Pass 17) — biggest hot-path saving
4. Doomed-cashback-retry short-circuit (Pass 13 §1)
5. listMergedAttempts two-tier broadcast (Pass 11 §1) — biggest system-wide saving
6. CDP blocklist extension (Pass 7 §3)
7. Skip duplicate /order-details fetch in fetchTracking (A4)
8. JSDOM → node-html-parser swap (A1) — for HTTP-fetched HTML sites only
   (NOT the 3 /spc sites which Pass 17 fixes differently)

**Realistic combined Phase A impact on filler-mode workload:**
- ~55-70s saved per filler buy (cancel-form Tier 1)
- ~80-160s saved per doomed-cashback failure (when fires)
- ~1.0-1.3s saved per buy (/spc parser inlining)
- ~500ms-2.4s saved per fan-out (BG broadcast fix)
- ~2.3s saved per PDP nav (blocklist)
- ~800ms per active tracking
- ~500-800ms per buy (parser swap A1)
- 95% reduction in BG request rate

### Phase A.1 (AmazonG follow-up — small hygiene CL)

Bundle of small wins (each 1-50 lines):

- loadSettings/loadProfiles mtime cache (Pass 12 §5)
- Lazy `pickIdsToEvict` (Pass 12 §4)
- Parallelize `setMaxQuantity` + `detectBuyPath` (Pass 12)
- listAmazonAccounts 60s cache (Pass 11 §3)
- toggleBGNameAndRetry event-driven waits (Pass 13 §2)
- selectAllowedAddressRadio 500ms blind → waitForFunction (Pass 13 §3)
- debug-screenshots auto-prune (Pass 13 §4)
- Drop `polling: 1000` in `fetchOrderIdsForAsins` (Pass 9 §4)
- Move `scrollTargetIntoView` to one upfront call (Pass 18 §1)
- Drop pre-place `waitFor({state:'visible'})` (Pass 18 §2)

**Cumulative:** ~600ms-1.5s additional savings per buy + various
system-hygiene wins.

### Phase B (separate CLs — touch behaviour, not just data)

- W rewrite (event-driven `waitForCheckout` + `waitForConfirmationOrPending`)
  (Pass 7 §4 + Pass 13 misc) — 0.5-3.5s/buy on happy path; up to 7.5s
  on pending-order path
- Cancel-sweep Tier 2 (parallelize cancel + defer to scheduler tuple)
  (Pass 8 §2) — 25-55s buy-slot
- AccountLock acquireRead for verify/track (Pass 7 §6) — 1-10s/collision
- HTTP timeouts on BG client (Pass 11 §2) — liveness

### Phase C (architectural)

- Defer cancel sweep to its own scheduler tuple — combines with Phase B
  AccountLock fix
- IPC delta broadcasts (Pass 11 §"renderer")
- Trace-only-the-tail (Pass 12 §3, snapshotOnFailure=true users)

### Phase D (major-version)

- B7 multi-context refactor (Pass 6 + Pass 7 recalibration) — 3.4×
  RSS reduction, 4.4× faster context cold-start

---

## 🪦 Confirmed dead — don't research these again

(Selected from the comprehensive list across passes 1-16)

| Hypothesis | Dead because | Source |
|---|---|---|
| **HTTP buynow bypass (B3) alone** | Empirically 1.3-1.8s SLOWER than click on real cpnduy session. Amazon now serves /spc HTML inline in the POST response (~340-380KB body, ~2s edge work). `ctx.request.{get,post}` doesn't stream like `page.goto({waitUntil:'commit'})` does. | **Pass 8** |
| Multi-item buynow / batch buynow | Amazon's `/checkout/entry/buynow` is single-item by design; only `items[0.base]` makes it into session | Pass 4 |
| HTTP-only `eligibleshipoption` | 200 OK but body is "Something Went Wrong" — Amazon's click-state token check blocks non-browser POSTs | Pass 4 |
| `data.amazon.com` from Node.js | Auth-gated, NOT CORS-gated. Returns 503/415. Theory wrong. | Pass 6 |
| Mobile / app JSON APIs (mapi, mshop) | TLS refused / CORS-blocked / require app-attestation tokens | Pass 3 |
| GraphQL on www.amazon.com | All HTML 404; service worker references are framework-internal | Pass 3 |
| Direct `/spc/place-order` POST without browser | CPE redirect requires browser JS execution | Pass 1 |
| Hidden URL params (`?one-click=1`, `?direct_buy=1`, `?bypass=payments`) | All no-ops | Pass 3 |
| Hot-context pool / pre-warm contexts | Cold-start is 56-327ms (config-dependent); pre-warming saves at most ~80-250ms | Pass 5 |
| Streaming PDP fetch + early `body.cancel()` | Native `fetch` doesn't propagate Set-Cookie back to BrowserContext → broke filler flow Place Order | Pass 5 (revert `1859e57`) |
| Parallel per-item cart-add POSTs | Silent-drop bug — Amazon's edge sometimes lost items in concurrent posts | Pass 8 (revert `bfae5f0`) |
| Two-tab parallel filler search/add | Single batch POST is the correct shape; per-item parallel was reverted | Pass 7 |
| Pre-build Place Order POST during dwell | Body is 3 fields, 142 bytes — already trivial | Pass 5 |
| `fetchOrderIdsForAsins` polling helps with order propagation | Static server-rendered page; polling can't surface what wasn't in initial HTML | Pass 9 |
| Auto-enqueue tick perf | Disabled stub at `index.ts:1241-1250`; no scheduler exists | Pass 12 |
| Chase code path perf candidates | Regex parsers, no blind waits on hot path, already has anti-bot driver flags | Pass 11 |

---

## Pass-by-pass map (1-line each)

- **Pass 7** — Buy hot path + system audit. 5 new top-10 candidates: telemetry fix, blocklist extension, idle-pool sessions, AccountLock policy, W rewrite.
- **Pass 8** — Cancel-sweep audit (lifecycle within buy). Cancel-form Tier 1 = ~25-30s/filler-buy. **Killed B3 HTTP buynow bypass empirically.**
- **Pass 9** — Verify + fetch_tracking audit. Cancel work fires 3× per filler buy lifecycle → savings revised UP from 25-30s to **55-70s**.
- **Pass 10** — Live A/B place-and-cancel attempts blocked by Amazon's account flagging. No new top-10. Three smaller findings on /pay interstitial + Place Order POST shape.
- **Pass 11** — System-wide IPC + BG client. **Major bug: `listMergedAttempts` triggers full BG round-trip per coalesced broadcast.** Fix: two-tier broadcast.
- **Pass 12** — Hygiene + dead-stub findings. 3 minor wins (mtime cache, lazy eviction, parallelize 2 reads).
- **Pass 13** — Failure-path audit. **Major: `FILLER_MAX_ATTEMPTS=3` retries blindly for 4min when cashback target is 0%.** Short-circuit fix.
- **Pass 14** — BG endpoint audit (different angle). **Missing AutoBuyJob compound index** for the hottest endpoint.
- **Pass 15** — BG worker + deals + deps. Small SharedDeal index gap. Confirmed renderer/Chase/deps clean.
- **Pass 16** — BG `lib/` audit. **`autoSubmitTracking` awaited inline** — easy `waitUntil` fix.
- **Pass 17** — **Checkout page focus (user-prompted).** Major: 3 /spc readers use page.content+JSDOM; inline-into-evaluate saves **~1.0-1.3s/buy**.
- **Pass 18** — Checkout follow-up. Two minor wins (scroll redundancy, redundant pre-place visible-wait).

---

## Pattern observations

1. **"Different angle" passes outperform "deeper into same code" passes
   by ~5×.** Passes 8, 11, 13, 14, 16, 17 — each found a new top-10
   candidate. Passes 9, 10, 12, 15, 18 — each only refined existing
   findings.

2. **Constraints surface findings.** Pass 17 was user-prompted ("checkout
   page specifically") and yielded the biggest concentrated chunk of
   per-buy savings in the entire arc.

3. **Amazon-side optimizations are at the floor** (per pass 6's prior
   conclusion, holding through pass 18). The remaining wins live in:
   a) AmazonG's INTERNAL surfaces (broadcast loop, retry budgets,
      parser placement)
   b) BG server-side (indexes, awaited-inline calls)
   c) Lifecycle-wide work (cancel sweep across 3 phases)

4. **The single highest-leverage shipping move is the telemetry fix.**
   Without it, every future perf claim remains inferred. With it, one
   production filler buy yields more empirical data than another full
   research pass would.

---

## Empirical artifacts produced (12 passes)

Under `.research/`:
- `probe_buy_to_spc.mjs` — authenticated PDP→/spc timing probe
- `probe_buy_to_spc_*.json` — captured event logs
- `probe_http_buynow_bypass.mjs` — B3 token harvest
- `probe_buynow_e2e.mjs` — B3 A/B comparison (3 runs each, killed B3)
- `probe_buynow_setcontent.mjs` — page.setContent shortcut test
- `probe_live_buy_cancel.mjs` — first place+cancel attempt (pending interstitial)
- `probe_live_buy_cancel_v2.mjs` — second attempt with pending-click loop
- `probe_cancel_form_timing.mjs` — cancel-page goto timing
- `bench_page_content_evaluate.mjs` — /spc operation cost benchmarks
- `bench_spc_parse.mjs` — JSDOM vs regex parse benchmark
- `check_signin*.mjs` — profile sign-in checkers
- `check_recent_order*.mjs` — order-history scrapes
- `check_thankyou.mjs` — stale purchaseId revisit (404 finding)
- `buynow_post_response_*.html` — captured /spc inline POST responses
- `order_history_dump.html` — dumped order history HTML
- `thankyou_dump.html` — dumped thank-you 500 page

---

## What to actually do next (priority order)

1. **Read this rollup + Pass 17's writeup**, in that order
2. Ship Phase A.0 (BG repo, 1 deploy) — 4 small changes, biggest ROI
   per LOC of any change
3. Ship Phase A.1 step-by-step on AmazonG, in this order:
   - Telemetry fix (verify with one production buy that step.buy.*
     events now appear in `~/Library/Application Support/AmazonG/job-logs/`)
   - /spc parser inlining (Pass 17) — biggest hot-path saving
   - Cancel-form Tier 1 fixes (Pass 8/9) — biggest filler-mode saving
   - Doomed-cashback-retry short-circuit (Pass 13)
   - Two-tier broadcast (Pass 11)
   - Remaining items in Phase A
4. Run a real BG fan-out post-deploy. Capture step.buy.* events.
   Compare to the predicted savings.
5. **If predicted savings hold** — ship Phase B (W rewrite, idle-pool,
   AccountLock).
6. **If they don't** — re-research with the now-available production data.

After 12 passes, this is the highest-confidence path to ~5-10s of
shipped per-buy savings + ~55-70s per filler buy on lifecycle work +
~1-2s per fan-out on system overhead. Real measured impact will only
materialize after step 1.

---

## How to reach me / re-engage

The MASTER ranking doc (`MASTER-speed-improvements-ranking.md`) is the
single source of truth for ongoing perf work. Per its maintenance rules:
- When a candidate ships → REMOVE from tier tables, add to "✅ Already
  shipped" with commit SHA
- When new research adds a candidate → ADD to a tier table, RE-RANK
  the Top 10
- When research falsifies a candidate → MOVE to "🪦 Confirmed dead"
- The "Recommended ship order" section reflects current best advice

This rollup is a snapshot of the state at the end of pass 18. Future
research should update the MASTER, not this file (which becomes
historical once a few items ship).
