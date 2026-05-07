# AmazonG perf improvements — ranked, 2026-05-06

Consolidated ranked view of every improvement surfaced across the
v0.13.24 release and the `feature/spc-perf` branch (v0.13.25 in
progress). Includes what's shipped, what's pending, and what's been
killed empirically.

For the broader research context (passes 1–18 across multiple research
arcs), see `MASTER-speed-improvements-ranking.md`. This doc is
specifically the post-v0.13.23 reset.

---

## ✅ Shipped on `main` (v0.13.24, released 2026-05-06)

| Commit | What | Saving / filler buy |
|---|---|---|
| `af188f9` | Telemetry — propagate jobId+profile through `step.buy.*` / `step.fillerBuy.*` | 0 ms (observability — but unblocks evidence-based work) |
| `48d5ff1` | Inline 3 /spc cashback parsers into `page.evaluate` (drops 3 page.content() + JSDOM round-trips) | ~1,000–1,300 ms |
| `cd71962` | Drop 4 blind waits in shared cancel-form helpers | ~25–55 s in cancel paths × 3 lifecycle phases |
| `16a21e5` | Extend CDP blocklist with 9 PDP XHR patterns (data.amazon.com, vap/ew, twisterDimension, paymentOptions, billOfMaterial, acp, paets, location_selector, patc-config) | ~2,000–2,300 ms / PDP nav |
| `90dfb7d` + `94a83a1` + `03cc941` | Surgical cashback recovery (flag-gated, off by default) — Phase A linear-remove + Phase B replacement + Phase R focused radio-click + Settings UI toggle | When fires: replaces a 3–4 min doomed retry loop with a deterministic <30 s recovery |

---

## ✅ Shipped on `feature/spc-perf` (v0.13.25 in progress)

Ranked by absolute saving, biggest first.

| Rank | Commit | What | Saving / filler buy | Risk | LOC |
|---|---|---|---|---|---|
| **1** | `8a7c88c` | **Replace 2 blind 1500ms waits in `cancelFillerOrder.ts` with event-driven selector waits** (verified SSR carries the data via raw HTTP fetch — 60 `data-component` attrs in static markup; cancel link is in SSR). Fires up to 3× per filler-buy lifecycle. | **up to ~9 s** | Low (SSR-rendered selector verified; falls through to current 1500 ms ceiling on edge cases) | ~24 |
| **2** | `028b889` | **Block `hz/rhf*`** (Recommendations Hub Frame widget — pure cross-sell carousel, fires on order-details / cancel-form / address-book navs). Structurally verified outside every AmazonG selector. | up to ~5,700 ms in cancel paths | Low | 1 line |
| **3** | `47f8dc4` | **Drop redundant 500ms wait between `pickBestCashbackDelivery` iterations.** Empirically: `:checked` updates synchronously in 7 ms; labels don't async-re-render in the post-click window; downstream `waitForDeliverySettle` already handles the real settle. | **~2–6 s** | Low (verified) | 1 line |
| **4** | `028b889` | **Block `rd/uedata*`** (RUM beacon — image-typed pixel, ~371 bytes, no DOM). Fires on every browser nav AmazonG makes. | ~2,800–4,000 ms | Low | 1 line |
| **5** | `028b889` | **Block `pgi7j6i5ab.execute-api.us-east-1.amazonaws.com/*`** (3rd-party AWS API Gateway monitoring; same shape as already-blocked `paa-reporting-advertising`). | ~1,000 ms (search-results × ~6 navs) | Low | 1 line |
| **6** | `a3fb183` | **Block `cart/add-to-cart/patc-config*`** (PATC = Pickup-At-The-Counter; AmazonG always ships home, never reads PATC config). | ~175 ms × every /spc load | Low | 1 line |

**Total estimated saving: ~15–25 s per worst-case filler-mode buy** (in addition to v0.13.24's wins).

---

## 🟡 Unshipped — Medium risk

Worth doing in their own focused PRs after v0.13.25 confirms stable.

| Rank | Candidate | Saving / filler buy | Risk | LOC | Why I held off |
|---|---|---|---|---|---|
| 1 | **Event-driven `waitForConfirmationOrPending` rewrite** — replace 500 ms polling with `Promise.race(waitForURL, waitForFunction({polling:'mutation'}))` | ~250 ms mean / buy | Medium | ~80 | Touches post-Place-Order critical path. Bug here = silent buy failures. Worth a focused PR with tests against confirmation-flow fixtures. |
| 2 | **Event-driven `waitForCheckout` rewrite** (same shape as above, but for the /spc-load → Place-Order-button-ready window) | ~250–500 ms / buy | Medium | ~60 | Same risk class as #1 — touches the /spc state machine. |
| 3 | **`selectAllowedAddressRadio` 500 ms post-click wait** | ~500 ms when address swap fires | Medium | 1 line | The form's `action` URL update may genuinely require a beat (different from the picker's `:checked` which is sync). Needs an empirical probe like the picker one. |
| 4 | **`purchaseId` cache for /spc re-entry** — direct GET `/checkout/p/<id>/spc` instead of re-allocating via `/checkout/entry/cart` | ~1,800 ms / re-entry | Medium | ~30 | Speculative — has zero current call sites that benefit (every existing `SPC_ENTRY_URL` site is post-cart-mutation, which invalidates the cache). Wait until a non-mutating re-entry path lands. |
| 5 | **JSDOM → node-html-parser swap** for HTTP-only path parsers (clearCart, fetchTracking, verifyOrder) | ~500–800 ms / filler buy | Medium | ~150 | Larger refactor — 19 call sites, several with different parser semantics. Needs a one-stream-at-a-time migration. |
| 6 | **`listMergedAttempts` two-tier broadcast** — local-only fast path; BG-merge slow path on 30s timer + on-demand | ~500 ms–2.4 s per fan-out + ~95 % BG request rate reduction | Med | ~60 | Pass-11 finding. Shape change to UI freshness model — needs UX validation. |
| 7 | **AccountLock: switch verify / fetch_tracking to `acquireRead`** | 1–10 s / collision | Low-Med | ~20 | Pass-7 finding. Easy fix but lock-policy changes deserve careful regression testing. |
| 8 | **Idle-pool session lifecycle (60s TTL after success)** | 5–15 s per consecutive same-profile buy | Low-Med | ~80 | Pass-7 finding. Browser-context reuse — needs careful close-on-error invariants. |

---

## 🟠 Unshipped — Low risk but small

Worth lumping into a future "minor cleanups" commit if you ever touch nearby code.

| Candidate | Saving | Source |
|---|---|---|
| Parallelize `verifyTargetLineItemPrice` + `ensureAddress` reads | ~150 ms / buy | This session R2 |
| Parallelize `setMaxQuantity` + `detectBuyPath` | ~30–50 ms / buy | Pass-12 |
| Lazy `pickIdsToEvict` (move to persist path) | ~50–75 ms / fan-out | Pass-12 |
| `loadSettings` + `loadProfiles` mtime cache | ~150 ms / min idle | Pass-12 |
| Drop `polling: 1000` in `fetchOrderIdsForAsins` | ~500 ms / filler buy | Pass-9 |
| Skip duplicate `/order-details` fetch in `fetchTracking` | ~800 ms / active tracking | Pass-2 #13 / Pass-4 #3 |
| `listAmazonAccounts` 60 s caching | ~900 ms–1.8 s / N-job burst | Pass-11 |

---

## 🔴 Unshipped — High risk; don't ship without dedicated A/B harness

| Candidate | Saving | Why high-risk |
|---|---|---|
| Direct POST to `/checkout/p/<id>/spc/place-order` (skip the click) | ~100–300 ms | Pass-8 already killed the analogous "B3 HTTP buynow direct POST" approach (1.3–1.8 s slower in practice + suspected fraud-side flags). Click handler may set Chewbacca session state / refresh CSRF / fire fraud beacons before the POST. |
| Cancel-sweep tier 2 (parallelize across N pages + defer to scheduler tuple) | ~25–55 s removed from buy slot | Pass-8 §2. Bigger refactor — affects scheduler concurrency model. |

---

## 📦 Unshipped — Lives in BG repo (server side)

| Candidate | Saving | Source |
|---|---|---|
| **AutoBuyJob compound index** `@@index([userId, phase, createdAt(sort: Desc)])` | ~50–300 ms per `/api/autog/purchases` call × 5–8 calls/fan-out = ~250 ms–2.4 s | Pass-14 §1 |
| **`autoSubmitTracking` → `waitUntil`** in BG status endpoint | ~500 ms–2 s per fetch_tracking status report | Pass-16 §1 |
| **SharedDeal `storeSlugs` index** | ~100–500 ms / Deals tab open | Pass-15 |

---

## 🪦 Confirmed dead — don't revisit

| Candidate | Why | Source |
|---|---|---|
| **B3 HTTP `/checkout/entry/buynow` bypass** | Empirically 1.3–1.8 s SLOWER than click on live test session. POST returns full /spc HTML inline (~340 KB), `ctx.request.{get,post}` doesn't stream like `page.goto({ waitUntil: 'commit' })`. | Pass-8 §1 |
| **`tt/i` Trust Token endpoint blocking** | Already failing with `ERR_TRUST_TOKEN_OPERATION_FAILED`. Blocking explicitly might raise the session's bot-likeness vs the current "browser doesn't support TT" signal. Leave alone. | Blocklist coverage 2026-05-06 |
| **HLS video chunks `*.ts*`** | Only ~1 ms / PDP nav in live measurements. Risk of conflicting with TypeScript files (Amazon doesn't serve those, but the glob is fragile). Not worth its own commit. | Blocklist coverage 2026-05-06 |
| **`hz/payment-options`, `ax/preauth`, `ax/claim/webauthn/*`** | Auth/payment touchpoints — risk of cascade sign-out or payment validation breakage. | Blocklist coverage 2026-05-06 |
| **`waitForDeliverySettle` 200 ms tail** | Empirically calibrated correctly. Live MutationObserver: 191 mutations in 0–50 ms, 59 in 50–200 ms, 1 in 200–500 ms post-eligibleshipoption response. The 200 ms catches almost the entire settle. | This session R5 |
| **`buyWithFillers.ts:1422` 3000 ms post-cancel-sweep** | Documented race fix for "browser closed before cancel registered" user reports. | Code comment |
| **`buyNow.ts:924` 1500 ms `deliver_pending` settle** | Documented intentional — primary-submit XHR is in flight, intentionally slower poll cadence. | Code comment |

---

## How to use this doc

- **Before shipping a candidate:** verify it's still listed here as unshipped and matches the saving estimate. Move to "Shipped" once landed.
- **Before adding new research:** check "Confirmed dead" first — many obvious-looking candidates have been killed.
- **When prioritizing a session's work:** start at the top of the unshipped tables. The med-risk pile is ranked, the low-risk pile is unranked (small wins, take whichever is closest to code you're touching).
- **When the absolute saving feels off:** capture a live timing probe (Playwright MCP PerformanceObserver) and update the saving column in this doc. The live-empirical → update-doc loop is what kept this list accurate during pass 7–18.

## Empirical-probe playbook

For waits and blocks, the standard verification pattern is:

1. **Static suspicion** — find a `waitForTimeout` / unblocked URL in the code or via PerformanceObserver capture
2. **Read the comment justifying it** — if any
3. **Live probe** — instrument the actual situation:
   - For waits: capture timing + DOM state at multiple intervals after the action (e.g., t+0/+50/+100/+500/+1000/+3500 ms)
   - For URL blocks: structural overlap test — confirm AmazonG's parser selectors don't intersect with the candidate's DOM subtree
4. **Compare to comment claim** — if the comment says "Amazon needs N ms for X", verify X actually takes that long
5. **Ship with citation** — link the empirical evidence in the commit message + this doc

Examples from this session:
- `pickBestCashbackDelivery`'s 500 ms — comment said "settle for re-render"; empirical: 0 mutations to labels in 3.5 s; the wait was pure padding
- `cancelFillerOrder`'s 1500 ms × 2 — comment said "give it a beat to hydrate"; empirical: target attributes are SSR'd (verified via `fetch()` with no JS)
- `hz/rhf` widget — would-be safe assumption; empirical: structurally outside every AmazonG selector (`findingsAtRisk: []`)
