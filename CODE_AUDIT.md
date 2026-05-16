# AmazonG Code Audit — 2026-05-15

Method: 6 parallel deep-research passes over the whole codebase (~111 files,
~39k LOC) — checkout hot path, workflow/scheduler, parsers/shared, main
process, BG integration, renderer — followed by a verification pass against
the real source. Findings are deduped, prioritized, and each carries a
**regression risk** and a **verification status**.

Verification status legend:
- **VERIFIED** — re-read the actual code, the issue is real as described.
- **REPORTED** — agent-reported, plausible, not yet line-by-line re-verified.
- **DISPROVEN** — checked, the agent was wrong; kept here so we don't chase it.

> Nothing in this file has been changed in code. It is a notes-only audit.
> Before acting on any item, re-read the cited lines — Amazon-facing code
> shifts and several "obvious fixes" below are explicitly marked risky.

---

## Theme A — Silent error swallowing / data loss  (HIGHEST VALUE)

This is the same class as the ghost-order bug fixed in v0.13.58. The audit
confirms it is **systemic**, not a one-off. These are the highest-value,
mostly-low-risk fixes.

### A1. `reportSafe` drops BG status reports on error, no retry — VERIFIED
`pollAndScrape.ts:2034` — `reportSafe` catches any `reportStatus` failure and
only logs `job.report.error`. A network blip / BG 5xx / 401 means the job's
outcome never reaches BG. For a buy-success report this is severe: BG never
learns the purchase happened, re-queues the job, and a duplicate can be placed.
- **Fix:** retry 2–3× with backoff before giving up; on final failure persist
  the unreported payload to a small on-disk queue and replay on the next poll.
- **Regression risk: MEDIUM** — a retry can mask a sustained outage; the
  replay queue must be idempotent on BG's side (BG already dedups by jobId).

### A2. Fire-and-forget `jobAttempts.update(...).catch(() => undefined)` — VERIFIED
Multiple lifecycle writes swallow store-write failures entirely:
`pollAndScrape.ts:~2769` (buy success — persists fillerOrderIds/cartAsins that
verify needs), `~1131` (verify→verified), `~2417` (abort checkpoint),
`~2792` (buy catch). If the write fails, in-memory and on-disk state diverge
and verify can silently skip filler cleanup.
- **Fix:** at minimum, change `.catch(() => undefined)` → `.catch(err =>
  logger.warn('jobAttempts.update.failed', {attemptId, err}))` so the loss is
  visible. Optionally retry the write.
- **Regression risk: LOW** — logging only; no behavior change.

### A3. `listAmazonAccounts` failure silently disables the cashback gate — REPORTED
`pollAndScrape.ts:~900` — on `listAmazonAccounts()` failure the catch returns
`{accounts: []}`, which makes `effectiveMinByEmail` empty → every profile's
min cashback defaults to 0 → the 6% gate is OFF for the duration of a BG
outage.
- **Fix:** on failure, default each eligible profile to `requireMinCashback:
  true` (mirrors `normalizeJob`'s default) rather than gate-off.
- **Regression risk: MEDIUM** — flips the failure-mode default; during a BG
  outage more buys would fail `cashback_gate` instead of slipping through.
  That is the safer direction but it IS a behavior change — confirm intent.

### A4. `cancel_fillers` reports `completed` when the task-list fetch fails — REPORTED
`pollAndScrape.ts:~2139` — when `listFillerCancelTasks` returns null on a
transient BG error, `tasks` defaults to `[]` and the job reports
`status: 'completed'` with no updates. BG marks the job done; the real pending
cancel tasks are orphaned and the fillers ship.
- **Fix:** distinguish "list returned empty" (ok, complete) from "list call
  failed" (report `failed`, let BG reschedule).
- **Regression risk: LOW** — the current silent-success is clearly wrong.

### A5. Logger sink swallows errors with no fallback — REPORTED
`logger.ts:~35` — a throwing sink (disk full, perms) is caught silently; log
events vanish with no signal.
- **Fix:** `console.error` fallback inside the catch.
- **Regression risk: LOW** — diagnostic only.

### A6. verify/fetch_tracking early-failure reports omit order context — REPORTED
`pollAndScrape.ts:~1057/1065/1652/1660` — early failures report
`{status:'failed', error}` with no `placedOrderId`/`placedEmail`, so BG can't
match the purchase row; it stays stuck in `awaiting_verification`.
- **Fix:** include `placedOrderId` + `placedEmail` in those error reports.
- **Regression risk: LOW** — additive fields; BG ignores unknown keys.

---

## Theme B — State persistence & concurrency

### B1. `settings.json` read-merge-write has no lock — REPORTED
`index.ts:~1325` + `settings.ts:~119` — `settingsSet` does load → merge →
write with an `await` in the middle; a concurrent writer (auto-redeem ticker)
can interleave and the later write clobbers the earlier.
- **Fix:** a module-level mutex around the read-merge-write triad.
- **Regression risk: HIGH** — introduces serialization infra that doesn't
  exist today; needs careful testing. **Do not do this casually.**

### B2. jobStore debounced save may not flush on app quit — REPORTED
`jobStore.ts:~83` — a 250ms debounce timer can fire after the quit handler's
flush, racing process exit; last mutations can be lost.
- **Fix:** export `flushAll()` that clears the timer + persists synchronously;
  call it first in `before-quit`.
- **Regression risk: MEDIUM** — quit-ordering is fiddly; must not schedule a
  new save while exiting.

### B3. Chase session map leak on navigation error — REPORTED
`index.ts:~1851` — `chaseRewardsActionSessions.set(id, session)` happens
*before* the `goto` that can throw; on failure the stale session stays mapped.
- **Fix:** register the map entry only after navigation succeeds; close the
  context in the catch.
- **Regression risk: LOW–MEDIUM** — verify a partially-opened context is
  always closeable.

---

## Theme C — Parser robustness

### C1. Price regex accepts `$0.00` and 3+ decimals — REPORTED
A `$0.00` promo price or `$19.995` would parse as a valid number and could
slip past price-cap gates.
- **Fix:** require exactly 2 decimals; reject `n <= 0`.
- **Regression risk: LOW** — real Amazon prices are always 2-decimal, > 0.

### C2. Cashback regex caps at 99% (`\d{1,2}`) — REPORTED
A "100% back" promo would fail to parse → gate fails incorrectly.
- **Fix:** `\d{1,3}`, clamp to 100.
- **Regression risk: LOW**.

### C3. `classifyError` misses uppercase "EXCEEDS RETAIL CAP $" — VERIFIED
`snapshotGroups.ts:26` — first regex is case-sensitive on the original
string; the lowercase fallback only covers "exceeds max", not "retail cap".
An all-caps "retail cap" error wouldn't classify → no snapshot.
- **Fix:** single case-insensitive test: `/exceeds (max|retail cap) \$/i.test(e)`.
- **Regression risk: LOW** — strictly widens matching.

### C4. ASIN regex is case-insensitive — REPORTED
`sanitize.ts:~17` — `/[A-Z0-9]{10}/i` accepts lowercase ASINs; if any matcher
elsewhere is case-sensitive, dedup/lookup can miss.
- **Fix:** normalize captured ASIN to uppercase (`.toUpperCase()`).
- **Regression risk: LOW** — normalizing is safer than removing the flag.

---

## Theme D — Renderer (lower value, mostly hygiene)

### D1. IPC-in-effect missing post-await cancellation checks — REPORTED
`Accounts.tsx:~334`, `Logs.tsx:~120`, `Settings.tsx:~339` — `setState` after
unmount on slow IPC. Pattern is already done correctly nearby; just complete it.
- **Regression risk: LOW**.

### D2. A few IPC calls in handlers lack try/catch — REPORTED
`Settings.tsx:~339/~346` (`snapshotsDiskUsage`, `snapshotsClearAll`).
- **Fix:** wrap with graceful fallback.
- **Regression risk: LOW**.

---

## DISPROVEN / DO-NOT-TOUCH  (verification caught these)

### X1. `Bank.tsx:888 setErrMsg` "undefined" — DISPROVEN
Agent claimed `setErrMsg` is undeclared (a build error). `errMsg` is a prop
threaded into a child component; the project typechecks clean at baseline.
The agent misread scope. **No action.**

### X2. `cancelNonTargetItems:144` `&&` → `||` — DO NOT CHANGE
Agent proposed flipping `cb.offsetParent === null && cb.getClientRects()
.length === 0` to `||`. **That would introduce a bug**: `offsetParent` is also
null for `position:fixed` elements, which are visible and clickable. `||`
would skip valid fixed-position checkboxes. The current `&&` is defensible —
leave it.

### X3. `buyCtx` staleness between expand and dispatch — INTENTIONAL
Agent flagged that `surgicalCashbackRecovery`/parallelism are read at
expand-time and could be stale at dispatch. This is the documented
"settings re-read every claim" model; mid-flight changes intentionally don't
apply. Not a bug.

---

## Recommended sequencing

**Tier 1 — do first (low risk, high value, all in Theme A):**
A2 (logging on update failure), A5 (logger fallback), A6 (order context in
error reports), C3 (classifyError), A4 (cancel_fillers empty-vs-failed).

**Tier 2 — needs care but high value:**
A1 (reportSafe retry + replay queue), A3 (cashback-gate failure default),
C1/C2 (parser bounds), B3 (chase session leak).

**Tier 3 — only with a dedicated testing pass:**
B1 (settings mutex — HIGH risk), B2 (quit-flush ordering).

**Never:** X2.

Each Tier-1 item is a self-contained change; they do not interact and can
ship one per PR with its own verification.
