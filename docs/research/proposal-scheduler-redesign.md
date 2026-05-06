# Proposal: unified account-aware streaming scheduler

**Status:** unshipped, deferred research note
**Date:** 2026-05-05
**Branch where draft lives:** `feat/chase-headless-research` (research only)
**Estimated saving:** 1× pass-2 latency on every fan-out where N profiles > M parallel slots; in the canonical case (N=5, M=3) the saving is ~1/3 of total wall-clock per multi-job batch. Independent verify/tracking parallelism multiplies on top.
**Risk:** Med-High — the lock-chain controls race-safety on Amazon checkout. A wrong impl risks duplicate orders.
**Effort:** ~10–14 hours across 4 phases (see §13).

---

## 1. TL;DR

Replace today's two-tier concurrency (per-job `pMap` for buy fan-out + a separate `lifecycleInFlight` set for verify/tracking) with a single **streaming scheduler** keyed on `(jobId, amazonEmail)` *tuples*. The scheduler keeps M worker slots saturated by pulling the next runnable tuple whenever a slot frees, regardless of which job it belongs to. Tuples carry a *phase-aware* per-account lock: `buy` takes an exclusive lock on the account; `verify` and `fetch_tracking` are HTTP-only reads and can run unlimited parallel against the same account (and concurrently with a buy on a *different* account, possibly even the same one — see §3). The BG poll loop pre-fetches into a small ready queue so claim latency doesn't gate dispatch.

Concretely: when job 1's buy finishes on account A while job 2's buy is still running on accounts B, C, D, the freed M-th worker immediately starts job 2's buy on account A — instead of sitting idle while job 1's tail rounds (today's behavior).

## 2. Current architecture

### 2.1 Files of record

| Concern | File | Key lines |
|---|---|---|
| Poll loop, claim, dispatch | `src/workflows/pollAndScrape.ts` | 644–818 (`startWorker`) |
| Buy fan-out (per-job pMap) | `src/workflows/pollAndScrape.ts` | 1014–1028 (`pMap(eligible, concurrency, runForProfile)`) |
| Verify (browser-context HTTP) | `src/actions/verifyOrder.ts` | 70–152 (entire fn) |
| Tracking (browser-context HTTP) | `src/actions/fetchTracking.ts` | 34–100 (entire fn) |
| Buy single-mode (browser pages) | `src/actions/buyNow.ts` | 108+, navs at 227, 609, 2145 |
| Buy filler-mode (mixed) | `src/actions/buyWithFillers.ts` | navs at 514, 618, 647, 1348; HTTP at 1993, 2161, 2321 |
| Session per-profile | `src/browser/driver.ts` | 22–308 (`openSession`, `close`) |
| Concurrency knob | `src/main/settings.ts` | 41 (`maxConcurrentBuys`, default 3) |
| BG claim semantics | `Better-BuyingGroup/src/app/api/autog/jobs/claim/route.ts` | 17–91 (FOR UPDATE SKIP LOCKED) |
| BG status reporting | `Better-BuyingGroup/src/app/api/autog/jobs/[id]/status/route.ts` | 240+ |

### 2.2 Walkthrough of the four phases

The worker runs a single async loop in `startWorker`. Each iteration:

1. Eligibility gate (`pollAndScrape.ts:675-685`) — bail if no signed-in profiles.
2. Read parallelism setting (`pollAndScrape.ts:691-697`).
3. **At-cap guard (lifecycle):** if `lifecycleInFlight.size >= cap`, race the in-flight set and `continue` (`pollAndScrape.ts:704-707`).
4. `bg.claimJob()` (`pollAndScrape.ts:709`) — single HTTP POST that returns one job or 204.
5. Dispatch by `job.phase`:

   - **`verify` / `fetch_tracking`** (`pollAndScrape.ts:726-757`): wrap `handleJob(...)` in a self-removing promise, push into `lifecycleInFlight`, **continue without awaiting**. The handler opens a per-profile session, opens one page, then runs `verifyOrder` (`actions/verifyOrder.ts:70`) or `fetchTracking` (`actions/fetchTracking.ts:34`). Both are pure `ctx.request.get(...)` HTTP calls that share the BrowserContext's cookie jar; no `page.goto`. The page exists only to expose `page.context().request`. Sessions are closed with `closeAndForgetSession` in `finally` (`pollAndScrape.ts:1529, 1831`).

   - **`buy`** (`pollAndScrape.ts:759-766`): drain any in-flight lifecycle work first (`Promise.allSettled([...lifecycleInFlight])`), **then** await `handleJob` synchronously. Inside `handleJob` (specifically lines 820–1163):
     1. Filter `eligible` to `enabled` accounts (`pollAndScrape.ts:866-886`); rebuy path scopes to single email (`846-864`).
     2. Read per-account overrides + min-cashback gates from BG (`898-919`).
     3. Read `parallelism` again (`938-941`).
     4. Create one queued attempt row per (job, profile) (`959-986`).
     5. Construct `AbortController` for sibling-abort (`1003-1012`).
     6. Fan out: `pMap(eligible, concurrency, runForProfile)` (`1014-1028`) — concurrency-limited Promise.all preserving input order.
     7. Aggregate + report-to-BG once at the end (`1031-1162`).

`runForProfile` (`pollAndScrape.ts:1912-2322`) is the per-(job, profile) function. It calls `getSession` (`2422-2452`) which lazily creates a persistent BrowserContext via `openSession`, opens a single page, runs `scrapeProduct` → `verifyProductDetailed` → either `buyNow` or `runFillerBuyWithRetries`, updates the local attempt row, then `closeAndForgetSession` so the next pass-through always cold-starts.

### 2.3 The two-tier concurrency mechanism (today)

```
         ┌─────────────────────────────── claim loop ─────────────────────────────────┐
         │                                                                             │
poll ───► claim ──► phase=buy?  ──► YES ──► drain lifecycleInFlight ──► await handleJob (BLOCKS the loop) ──► next poll
         │                                                                             │
         │                          NO ──► spawn handleJob in background ──► add to ──┐│
         │                                                                lifecycleInFlight
         └─ at-cap (lifecycleInFlight.size >= cap)? race for one slot ◄────────────────┘
```

Two distinct caps in play:

- **Buy fan-out cap:** inside `handleJob` for a buy phase, `fanoutConcurrency(parallelism)` (`pollAndScrape.ts:583`) clamps `pMap`'s concurrency. Bounds: `MIN=1`, `MAX=5`, default `3` (`112-117`).
- **Lifecycle cap:** at the loop level, `lifecycleInFlight.size >= cap` gates further claiming. *Same `cap`* as above (`691-697`), so verifying 5 orders uses the same knob as parallel buys.

**Critically: a buy run blocks the loop.** While a `pMap` of 5 fan-out tuples is running, the loop is parked on `await handleJob(...)` at line 765. No other job — buy or lifecycle — is claimed during that window. The waste is exactly the user's complaint: when `eligible.length > concurrency`, the second wave only fills `eligible.length - concurrency` slots; the other slots sit idle.

### 2.4 Where the wasted parallelism actually shows up

The buy fan-out is capped at M (let's say 3). With N=5 eligible accounts:

- t=0: pMap launches workers for accounts A, B, C.
- t≈30s: all three finish (cold-start ≈ session boot ≈ 56–327ms; total wall-clock dominated by Buy Now → /spc → Place Order). pMap's two remaining items dequeue: D and E start.
- t≈30–60s: only 2 of 3 worker slots are running. **One slot sits idle.** This is the user's exact diagnosis.

Today the idle slot isn't reused because:

1. The loop is blocked on the outer `await handleJob` — the parent fan-out hasn't returned yet, no new claim happens.
2. Even if the loop weren't blocked, the next claim wouldn't share the `pMap` worker pool — `pMap` only sees one fixed input list.
3. `lifecycleInFlight` exists but is intentionally drained before a buy starts (`762-764`) so verify/tracking can't fill the gap during a buy fan-out tail.

## 3. The actual per-account lock granularity

The lock granularity question is the linchpin of the redesign. The user assumed "1 amazon account = 1 buy at a time, ever." That's an over-statement; the *actual* race conditions are narrower.

### 3.1 Inventory of state shared per-account

A single `BrowserContext` (per `openSession` in `driver.ts:22`) holds:

1. **Cookie jar** (mutated by every Amazon HTTP/page response that sets a cookie; particularly `session-id`, `session-token`, `at-main`, `ubid-main`, and anti-csrftoken-a2z values rotated on cart-add).
2. **HTTP/2 connection pool / keepalive** to amazon.com (transparent; not user-visible state).
3. **`localStorage`/IndexedDB** (Amazon stores some session state there, but the buy flow doesn't read it).
4. **One persistent userDataDir on disk** (Chromium's SingletonLock prevents two processes from sharing, *not* two contexts in the same process — but our worker only opens one persistent context per profile via `getSession` which dedupes via `sessions` map at `pollAndScrape.ts:2428`).

Server-side state at Amazon that's per-account:

5. **Cart contents** (mutated by cart-add, cart-clear, Buy Now, /spc place-order).
6. **Active checkout session** (`/checkout/p/p-{purchaseId}/spc`) — there can be multiple in flight, but only one is "the active one" the cookie jar resolves to.
7. **Order history** (read-only for verify/tracking).
8. **PMTS payment-revision flags** etc. — read-only for our purposes.

### 3.2 Per-phase lock requirements

| Phase | Browser session needed? | Mutates cart / checkout? | Mutates cookies? | Lock requirement |
|---|---|---|---|---|
| `buy` (single-mode) | yes (page.goto PDP, /spc, click Place Order) | yes | yes (csrf rotation, session refreshes) | **Exclusive on the account.** Two parallel buys would race the cart, race the checkout session, race the place-order csrf. |
| `buy` (filler-mode) | yes (page.goto /spc, Place Order) + heavy HTTP | yes | yes | **Exclusive on the account.** Same as single. |
| `verify` | yes (only for `page.context().request`) — pure HTTP GET | no | minimal — Amazon may set tracking cookies, but the response is idempotent and the verify result doesn't depend on cookie freshness | **Shared read.** Multiple parallel verifies on the same account are safe. Code path: `verifyOrder.ts:80` is a single `ctx.request.get(...)`. No place where it depends on having a fresh session-token. |
| `fetch_tracking` | same as verify (HTTP only) | no | minimal | **Shared read.** `fetchTracking.ts` does verify + `Promise.allSettled(urls.map(readTrackingIdViaHttp))` — already doing parallel HTTP on the same context. |

### 3.3 Cross-phase: can buy + verify run on the same account?

This is the empirical question the user flagged and it deserves a careful answer.

**Mechanically possible:** verify is `page.context().request.get(...)` — Playwright's `APIRequestContext`. It runs in Node, shares cookies with the BrowserContext, but doesn't compete for `page` resources. While `buyNow` is mid-`page.goto('/spc')` on `pages()[0]`, a second consumer can fire `context().request.get('/gp/your-account/order-details?orderID=…')` in parallel. Playwright does serialize requests on the same APIRequestContext via an internal queue, but the queue isn't blocked by `page.goto`.

**Cookie contention concern:** the buy flow does mutate cookies (Amazon rotates anti-csrftoken-a2z on cart-add per `amazonHttp.ts:29-44`). If a verify GET happens to land *during* the cart-add → /spc transition, the verify reads cookies that include the in-flight rotation. Amazon's order-details endpoint authenticates via `at-main` (long-lived) and `session-id`/`session-token` (long-lived). It does not consult anti-csrftoken-a2z. So the rotation is irrelevant to verify correctness.

**Risk needs verification:** there's a residual concern that Amazon's bot-detection may flag a "user reading order history while clicking Place Order" pattern. We have no evidence either way.

**Recommendation:**
- **Phase 1 (conservative):** lock buy as exclusive vs. *all* other phases on the same account (today's effective behavior — a buy drains lifecycle before running, so they're never concurrent).
- **Phase 2 (aggressive, after empirical confirmation):** allow verify/tracking to run concurrently with a buy on the same account. Saves nothing on a fresh fan-out but unlocks "verify the cancelled order on account A while account A's rebuy is queueing."

The code below uses a **read/write lock** abstraction so we can flip the policy without rewriting the scheduler.

### 3.4 Sibling: same account, different jobs, all buys

Two buy jobs both want account A. Today, BG's `claimJob()` returns them in `createdAt` order; the worker fans each out separately, so they're naturally serialized. With a streaming scheduler, both would land in the ready queue and the per-account write-lock holds the second back until the first finishes. Same effective behavior, but now the rest of A's fan-out can saturate other accounts.

## 4. Today's two concurrency mechanisms — diagrammed

### 4.1 During a buy fan-out

```
loop ─── claim(buy) ─── handleJob (BLOCKS) ────────── handleJob returns ─── claim
                              │
                              ▼
                         pMap(M slots)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          slot 0          slot 1          slot 2
          profile A       profile B       profile C
              │               │               │
              └─ done ─────► slot 0 picks D
                              └─ done ──────► slot 0 picks E
                                              ▼
                              all 5 done, pMap returns

Independent verify/tracking jobs that BG queued during this window
sit untouched — the loop is blocked on handleJob.
```

### 4.2 During a lifecycle drain (no buy in flight)

```
loop ─── claim(verify1) ─── spawn-and-track ─── continue (no await)
loop ─── claim(verify2) ─── spawn-and-track ─── continue
loop ─── claim(verify3) ─── spawn-and-track ─── continue
loop ─── lifecycleInFlight.size >= cap? ─── race for one to finish
loop ─── claim(verify4) ...

If a buy claim arrives:
    drain lifecycleInFlight (await all)
    THEN start buy fan-out
```

### 4.3 The combined cap

Both gates use `cap = max(1, parallelism.maxConcurrentBuys)` (lines 691–697 and 942 reach the same setting). So a user's "Parallel buys = 3" means *also* "Parallel verifies/tracking = 3" — but the buy fan-out itself is also separately capped at 3, and the lifecycle queue drains before a buy starts. There's no global "3 across everything" gate; it's "3 per phase, one phase at a time."

## 5. Proposed unified scheduler

### 5.1 Core data model

```ts
type AccountKey = string; // amazonEmail.toLowerCase()

type Tuple = {
  jobId: string;
  job: AutoGJob;          // captured at claim time
  account: AccountKey;
  profile: AmazonProfile; // resolved from listEligibleProfiles
  phase: 'buy' | 'verify' | 'fetch_tracking';
  // scheduling metadata
  enqueuedAt: number;
  // shared signals (from the original fan-out)
  abortSignal?: AbortSignal;
  // per-job context the existing handlers need
  fillerByEmail?: Map<AccountKey, boolean>;
  effectiveMinByEmail?: Map<AccountKey, number>;
  requireMinByEmail?: Map<AccountKey, boolean>;
};

type JobBundle = {
  jobId: string;
  total: number;          // total tuples for this job
  results: ProfileResult[]; // collected as they complete
  abortController: AbortController;
  // resolves once `results.length === total`
  done: Promise<ProfileResult[]>;
  resolve: (r: ProfileResult[]) => void;
};
```

### 5.2 Per-account read/write lock

```ts
class AccountLock {
  private writers = new Map<AccountKey, Promise<void>>();
  private readers = new Map<AccountKey, Set<Promise<void>>>();

  /** Exclusive: held by buy. Waits for any in-flight readers OR writer. */
  async acquireWrite(k: AccountKey): Promise<() => void> {
    while (this.writers.has(k) || (this.readers.get(k)?.size ?? 0) > 0) {
      const wait: Promise<unknown>[] = [];
      const w = this.writers.get(k); if (w) wait.push(w);
      const rs = this.readers.get(k); if (rs) wait.push(...rs);
      await Promise.race(wait).catch(() => undefined);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    this.writers.set(k, p);
    return () => { this.writers.delete(k); release(); };
  }

  /** Shared: held by verify / fetch_tracking. Waits only for a writer. */
  async acquireRead(k: AccountKey): Promise<() => void> {
    while (this.writers.has(k)) {
      await this.writers.get(k)!.catch(() => undefined);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    let bag = this.readers.get(k);
    if (!bag) { bag = new Set(); this.readers.set(k, bag); }
    bag.add(p);
    return () => {
      bag!.delete(p);
      if (bag!.size === 0) this.readers.delete(k);
      release();
    };
  }
}
```

(Phase 1 conservative variant: `acquireRead` also waits for writers AND treats verify as a writer. Phase 2 aggressive: the version above. Same call sites either way.)

### 5.3 The scheduler loop (sketch, ~80 lines)

```ts
function startStreamingWorker(deps: Deps): WorkerHandle {
  let running = true;
  const sessions = new Map<string, DriverSession>();
  const lock = new AccountLock();
  const readyQueue: Tuple[] = [];                        // FIFO of runnable tuples
  const bundles = new Map<string, JobBundle>();          // jobId → bundle
  const inFlight = new Set<Promise<void>>();             // current worker tasks

  // Producer: claim from BG, expand to tuples, push to readyQueue.
  const producer = (async () => {
    while (running) {
      const cap = await loadCap();
      // Don't pre-buffer more than 2× cap of tuples; we want fresh signals.
      if (readyQueue.length >= cap * 2) {
        await sleep(200, () => running);
        continue;
      }
      const eligible = await deps.listEligibleProfiles();
      if (eligible.length === 0) { await sleep(5_000, () => running); continue; }

      const job = await deps.bg.claimJob();
      if (!job) {
        if (inFlight.size > 0) await Promise.race(inFlight).catch(() => {});
        else await sleep(5_000, () => running);
        continue;
      }

      const tuples = await expandToTuples(job, eligible, deps);
      if (tuples.length === 0) { /* report + skip */ continue; }

      const bundle = makeBundle(job.id, tuples.length);
      bundles.set(job.id, bundle);
      // Persist queued attempt rows immediately (matches today's UX).
      await Promise.all(tuples.map((t) => createAttemptRow(deps, t)));
      readyQueue.push(...tuples);
    }
  })();

  // Consumer: pull from readyQueue when slots free.
  const consumers = (async () => {
    while (running) {
      const cap = await loadCap();
      if (inFlight.size >= cap || readyQueue.length === 0) {
        if (inFlight.size === 0) await sleep(50, () => running);
        else await Promise.race(inFlight).catch(() => {});
        continue;
      }
      const t = readyQueue.shift()!;
      const task = (async () => {
        // Lock first — different phases want different lock kinds.
        const release =
          t.phase === 'buy'
            ? await lock.acquireWrite(t.account)
            : await lock.acquireRead(t.account);
        try {
          const result = await runTuple(deps, sessions, t);
          collectResult(bundles, t.jobId, result);
        } finally {
          release();
        }
      })().catch((err) => {
        logger.error('scheduler.tuple.error', { jobId: t.jobId, account: t.account, error: String(err) });
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
  })();

  // Aggregator: when a bundle completes, fire the BG status report.
  // (Implemented inside collectResult — see §6.)

  return { stop, openProfileTab };
}
```

`runTuple` dispatches on phase:

```ts
async function runTuple(deps, sessions, t: Tuple): Promise<ProfileResult> {
  if (t.phase === 'buy') {
    return runForProfile(deps, sessions, t.job, t.profile, ..., t.abortSignal!, t.abortSiblings!);
    // existing function, untouched
  }
  if (t.phase === 'verify') {
    return runVerifyTuple(deps, sessions, t.job, t.profile);
    // wraps today's handleVerifyJob body but produces a ProfileResult-shaped value
  }
  if (t.phase === 'fetch_tracking') {
    return runFetchTrackingTuple(deps, sessions, t.job, t.profile);
  }
}
```

### 5.4 How each phase maps onto this

| Phase | Tuple expansion | Lock | Returns |
|---|---|---|---|
| `buy` (fan-out) | One tuple per `enabled` profile in `eligible`. Carries the shared `AbortController.signal` so sibling-abort still works. | write | `ProfileResult` |
| `buy` (rebuy with `placedEmail`) | Single tuple for that one profile. `total = 1`. | write | `ProfileResult` |
| `verify` | Single tuple for `placedEmail`. | read (or write if Phase 1) | adapter type that maps to ProfileResult or a verify-specific result |
| `fetch_tracking` | Single tuple for `placedEmail`. | read | adapter type |

Today's `handleVerifyJob` and `handleFetchTrackingJob` produce side effects (BG status report inline, jobAttempts updates, session close). In the streaming model, these become `runVerifyTuple` / `runFetchTrackingTuple` — same body, same side effects, but the *job-completion* side effect (BG status) fires from the bundle aggregator instead of inline. Verify/tracking bundles have `total=1` so the aggregator fires the moment the tuple completes — semantically identical to today.

### 5.5 What didn't change

- `runForProfile` (`pollAndScrape.ts:1912-2322`) is untouched. Same signature.
- `verifyOrder` / `fetchTracking` (`actions/verifyOrder.ts`, `actions/fetchTracking.ts`) are untouched.
- `getSession` / `closeAndForgetSession` (`pollAndScrape.ts:2422-2470`) are untouched. Sessions are still per-profile, lazily created, and torn down after each tuple. (See §5.6 for the "should we reuse sessions across tuples?" question.)
- BG client (`src/bg/client.ts`) is untouched.
- The existing `lifecycleInFlight`, `pMap`, and the buy-vs-lifecycle branch in the loop body all go away.

### 5.6 Session reuse across consecutive tuples (open question, not in v1)

Pass-2 #4 (session reuse) was rejected as marginal because cold-start is 56–327ms. With streaming, the same account may run two tuples back-to-back: e.g. job1's buy on A → job2's buy on A (queued behind the write-lock). Today each gets a fresh session.

**Pro reuse:** save ~200ms per back-to-back tuple. **Con reuse:** cookie cruft accumulates (cart contents from previous buy if cart-clear missed something), and the existing `closeAndForgetSession` + new BrowserContext is the cleanest "reset to known state" we have.

**Recommendation:** out of scope for v1. Re-evaluate after the streaming scheduler is shipped and we have empirical data on how often back-to-back tuples actually happen.

## 6. Per-job aggregation + reporting

### 6.1 The bundle abstraction

A `JobBundle` is created when a buy job's tuples are expanded. It tracks `total` (number of tuples) and a growing `results` array. When `results.length === total`, fire the BG `reportStatus` aggregation (today's lines 1031–1162) and remove the bundle from the map.

```ts
function collectResult(bundles, jobId, result) {
  const b = bundles.get(jobId);
  if (!b) return; // job already finalized (e.g. abort); discard
  b.results.push(result);
  if (b.results.length === b.total) {
    bundles.delete(jobId);
    void finalizeBundle(b); // BG status report happens here, async
  }
}
```

`finalizeBundle` runs the existing aggregation logic verbatim:
- Compute successes/failures/dryRunPasses/actionRequireds.
- Pick winner by cashback %.
- Build `purchases: PurchaseReport[]`.
- Call `bg.reportStatus(jobId, ...)`.

### 6.2 Verify / fetch_tracking finalization

For `total=1` bundles, the aggregator simply runs the BG status branch immediately on tuple completion. This preserves today's exact semantics (verify and tracking are inherently per-account, not fan-outs).

### 6.3 Partial failures

Existing semantics handle this already (`pollAndScrape.ts:1080-1105`):

- If any success: `awaiting_verification` (full) or `partial` (some failed).
- All dry-run: `failed` with a `[DRY RUN OK]` marker.
- Only action_required: `action_required`.
- Else: `failed`.

Streaming changes nothing here — the bundle aggregator runs the same code with the same `results` array shape.

### 6.4 Abort propagation (fan-out level)

Today's `AbortController` (`pollAndScrape.ts:1003-1012`) lives inside `handleJob`. In the streaming model, it lives on the `JobBundle`:

```ts
abortSiblings(reason) {
  // 1. Set the bundle's signal (in-flight tuples notice at next checkpoint).
  bundle.abortController.abort(reason);
  // 2. Drain queued tuples for this job from readyQueue WITHOUT running them.
  for (let i = readyQueue.length - 1; i >= 0; i--) {
    if (readyQueue[i].jobId === jobId) {
      const t = readyQueue.splice(i, 1)[0];
      collectResult(bundles, jobId, abortedResult(t.account, reason));
    }
  }
}
```

This is strictly better than today: today, queued profiles inside `pMap` already running `runForProfile` notice abort at the preflight checkpoint; streaming additionally avoids ever even *starting* `runTuple` for them. Saves a `getSession` for queued accounts that hadn't been picked up yet.

### 6.5 Job cancellation by user (e.g. "Stop" button)

Today's stop sets `running = false` and calls `closeAllSessions`. In the streaming model:

```ts
async function stop() {
  running = false;
  // Drain readyQueue, marking each tuple's bundle as failed.
  for (const t of readyQueue) collectResult(bundles, t.jobId, failed(t.account, 'worker stopping'));
  readyQueue.length = 0;
  // Close all sessions; in-flight Playwright ops will throw and the tuple
  // task's catch block converts them into a failed ProfileResult. The
  // aggregator then finalizes each affected bundle.
  await closeAllSessions(sessions);
  // Optional: requeue in_progress jobs back to BG via bg.requeueJob(jobId)
  // for any bundle that hasn't started Place Order yet (preserves today's
  // recovery sweep behavior).
}
```

## 7. Edge case walkthroughs

### 7.1 Two jobs both fanned to account A only (single-account jobs)

State at t=0: cap=3, both jobs in `readyQueue` as `(J1, A, buy)` and `(J2, A, buy)`.

- Consumer pulls `(J1, A, buy)`, acquires write-lock on A, starts `runForProfile`.
- Consumer pulls `(J2, A, buy)`, tries to acquire write-lock on A, blocks.
- Two other consumer slots (slot 1, slot 2) are idle — `readyQueue` is empty, they wait.
- t=30s: J1's buy on A finishes. write-lock released. J2's buy on A starts.
- t=60s: J2 finishes.

**Vs today:** identical wall-clock (the lock chains them serially). Streaming doesn't help when there's only one account and two jobs — that's an inherent serial constraint. Streaming *also doesn't make it worse*. ✓

### 7.2 3 jobs over {A,B,C}, {A,B,D}, {C,D,E}; M=4

Cap=4. Tuples expanded: 9 total. Initial readyQueue (FIFO):
`(J1,A) (J1,B) (J1,C) (J2,A) (J2,B) (J2,D) (J3,C) (J3,D) (J3,E)`.

t=0: 4 consumer slots try to pull.
- slot 0: `(J1,A)` → acquires A.write → starts.
- slot 1: `(J1,B)` → acquires B.write → starts.
- slot 2: `(J1,C)` → acquires C.write → starts.
- slot 3: `(J2,A)` → tries A.write, blocked. **What happens?**

This is the critical design choice. Two options:

**Option α (head-of-line, FIFO scheduler):** slot 3 holds `(J2,A)` and waits on A.write. The remaining 5 tuples in the queue stay queued. Slot 3 is effectively wasted until J1's A finishes.

**Option β (skip-blocked, work-stealing scheduler):** slot 3 sees `(J2,A)` is blocked (try-acquire fails), pushes it to the *back* of the queue, pulls the next tuple `(J2,B)` instead. Slot 3 sees `(J2,B)` is also blocked (B.write held by slot 1), tries `(J2,D)` — D.write is free → starts.

t=0 with β:
- slot 0: A held by J1
- slot 1: B held by J1
- slot 2: C held by J1
- slot 3: D held by J2 (J2,A and J2,B requeued)

t=30s: J1's A, B, C all finish (assume same wall-clock). 3 slots free. J2,A unblocks, J2,B unblocks. J3,C unblocks. Etc.
- slot 0: pulls `(J2,A)` → starts
- slot 1: pulls `(J2,B)` → starts
- slot 2: pulls `(J3,C)` → starts (was `(J3,C)` after rewinds; J2's A and B were ahead in fifo)
- slot 3: still running J2,D until ~t=30s...

**Recommendation: Option β.** It's the entire point of the redesign. The implementation: when a consumer pulls a tuple whose lock can't be acquired without waiting, append it to the back of `readyQueue` and try the next one. To avoid livelock when all queued tuples are blocked on the same account (e.g. 3 jobs all targeting only account A), break with a small sleep + race-on-inFlight.

Pseudocode:

```ts
async function pullNextRunnable(): Promise<Tuple | null> {
  let scanned = 0;
  while (scanned < readyQueue.length) {
    const t = readyQueue.shift()!;
    if (canAcquireImmediately(lock, t)) return t;
    readyQueue.push(t); // back of queue
    scanned++;
  }
  return null; // all blocked
}
```

`canAcquireImmediately` is a read-only check on `AccountLock` state. If `null` returns, the consumer awaits `Promise.race(inFlight)` and retries.

### 7.3 J1's buy fails on A → BG enqueues filler rebuy → J1's B,C,D,E still running

Sequence:
- t=0: J1's tuples for A,B,C,D,E enter the queue, M=4. Slots 0-3 take A,B,C,D. E queued.
- t=10s: J1's A returns `failed{cashback_gate}`. BG enqueues `J1' = rebuy(J1, A, viaFiller=true)` server-side via the status report. (Actually: rebuy is created later, when the verify phase runs and detects cancellation — see `Better-BuyingGroup/src/lib/autoBuy.ts:153`. But for cashback_gate failures the user has `autoRebuyOnCancel` patterns. Let's trace both.)

For cashback_gate: per `Better-BuyingGroup/src/app/api/autog/jobs/[id]/status/route.ts` body, BG can enqueue an auto-rebuy when the parent finalizes. So the rebuy `J1'` doesn't appear in the queue until *after* `J1`'s bundle finalizes.

- t=30s: J1's bundle finalizes (B,C,D,E returned), BG creates `J1'`.
- t=35s: producer claims `J1'`, expands to one tuple `(J1', A, buy, viaFiller=true)`, pushes to queue.
- t=35s: consumer pulls `(J1', A)`, acquires A.write (free since J1's A finished), starts.

Vs today: same. The rebuy is queued via BG, not a worker-internal mechanism. ✓

Edge variant: if BG enqueues `J1'` *before* J1's bundle finishes (race), the producer can claim `J1'` before J1's tuples for B,C,D,E complete. The streaming scheduler handles this naturally: `(J1', A, buy)` joins the queue; A.write is free (J1's A already finished); `J1'` starts immediately while J1's tail is still running. **This is strictly better than today** (today the loop is blocked on J1's pMap).

### 7.4 Verify for A in flight; new buy for A arrives

State: bundle for `verifyJob1` has one in-flight tuple holding A.read. Producer claims `buyJob2`, expands to tuples including `(buyJob2, A, buy)`.

- Phase 1 (conservative): `(buyJob2, A, buy)` tries A.write, blocks behind A.read AND any pending writers. Once verify finishes (~1–2s for HTTP-only verify), buy starts.
- Phase 2 (aggressive): `(buyJob2, A, buy)` acquires A.write — but `acquireWrite` waits for readers. So under either phase the verify's read-lock blocks the buy's write. **The aggressive phase only helps when verify lands while a buy is *already running*** — where it skips the write-lock acquire entirely.

Concrete saving: if a verify takes 1s and buys take 30s, Phase 2 saves at most 1s. Probably not worth the empirical-confirmation cost. **Recommendation: ship Phase 1.**

### 7.5 AmazonG crashes mid-stream

State at crash: 3 buys in flight for J1 (A,B,C), J1 bundle has results for B (success). J2's tuples queued.

After crash:
- BG sees J1 in `in_progress`, J2 in `queued`. After `CLAIM_STALE_MS = 10 min` (`claim/route.ts:9`), J1 becomes reclaimable.
- AmazonG restarts: `abortPendingAttempts` (`src/main/index.ts:834`) marks all queued/in_progress local attempt rows as failed. Worker starts.
- Producer claims J2 (queued, oldest). Then on next iteration, claims J1 (still `in_progress` until 10 min stale, but our same instance recovers it).

**Gap vs today:** today the same 10-min stale recovery applies. No change. The streaming scheduler doesn't make recovery worse.

**One improvement to consider (separate proposal):** when stop is initiated *gracefully* (Stop button), the worker could call `bg.requeueJob(jobId)` for tuples that are still queued in `readyQueue` (haven't started Place Order). This already exists for in-flight buys — see `BGClient.requeueJob`. Just generalize.

### 7.6 User disables account A while buy is in flight

Today: disabling an account in the Accounts tab updates `loadProfiles()`. Next call to `listEligibleProfiles` filters it out. The currently running fan-out for A continues — there's no abort signal hooked to "account disabled."

In streaming: same. The disable affects future tuples (the producer's `expandToTuples` uses the up-to-the-moment eligible list). In-flight tuples for A continue. Queued tuples for A still in readyQueue continue to run because they were already enqueued.

**Improvement (out of scope for v1):** when account A is disabled, scan readyQueue and drop queued buy-phase tuples for A. Verify/tracking for in-flight orders should NOT be dropped (per the comment at `pollAndScrape.ts:743-749`). This is an improvement over today.

## 8. Migration plan

### 8.1 Phased rollout

**Phase 0 — instrumentation (1h, ship first, separate release).**
Add `worker.lifecycle.in_flight.size`, `worker.fanout.duration_ms`, `worker.idle_ms_during_buy_tail` log lines so we have baseline metrics. Confirms the diagnosis (idle slots during fan-out tail) before changing behavior.

**Phase 1 — extract helpers, no behavior change (2h).**
- Pull `runForProfile` invocation site into a `runBuyTuple` wrapper that returns a `ProfileResult`.
- Pull `handleVerifyJob` body into `runVerifyTuple` that returns a verify-shaped result (and call the BG status report from the wrapper).
- Pull `handleFetchTrackingJob` body the same way.
- All three return a `TupleResult` discriminated union.
- Existing `handleJob` still drives `pMap` and inline-reports — just using the new wrappers.
- **Test:** existing test suite passes. Behavior identical.

**Phase 2 — introduce streaming scheduler behind a feature flag (4h).**
- Add `AccountLock` class.
- Add `JobBundle` map + `collectResult` aggregator.
- Add `streamingScheduler: boolean` option to `Settings` (default false).
- When false, use today's `startWorker`. When true, use `startStreamingWorker`.
- Producer + consumer loops as in §5.3.
- Verify/tracking bundles use `total=1` (semantically equivalent to today).
- **Test:** unit tests on the lock and aggregator; manual smoke test with the flag on.

**Phase 3 — flip default + telemetry (2h).**
- Default `streamingScheduler` to true.
- Keep the legacy code path one release as a kill switch.
- Add an explicit log when scheduler chooses streaming so support can confirm.

**Phase 4 — remove legacy path (1h, after one full release with default-on).**
- Delete `pMap`, `lifecycleInFlight`, the buy-vs-lifecycle branch in the old loop.
- Delete the setting flag.
- Update CLAUDE.md / AGENTS.md to reflect the new architecture.

### 8.2 Rollback

- **Phase 1:** trivial, just helper extraction.
- **Phase 2:** flag defaults to false. Rollback = no action.
- **Phase 3:** flip `DEFAULTS.streamingScheduler = false` in `src/main/settings.ts:6`. Affected installs revert on next launch.
- **Phase 4:** rollback requires a code revert. Hold for one release (i.e. v0.13.X+1 has both, v0.13.X+2 removes legacy). Same cadence as the v0.13.19 maxConcurrentBuys unification.

## 9. Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| **Duplicate orders from a wrong lock impl** | Critical | (a) Lock acquire is *before* any Amazon HTTP/page work in the tuple. (b) Phase 1 ships the conservative lock (read still blocks write). (c) Unit tests cover lock semantics directly. (d) Behind a feature flag for one release. (e) The existing `runForProfile` body is unchanged — same Place Order critical-section markers via `onStage('placing')` / `onStage(null)` (`pollAndScrape.ts:2158`). |
| Lock starvation (long buys keep verify waiting) | Low | Verify is HTTP-only and sub-2s; buy is 30–60s. Even today, lifecycle is drained before buy starts (lines 762–764), so today's behavior is *worse* — streaming is strictly better here. |
| Livelock when every queued tuple is blocked on a tied-up account | Low | The skip-blocked consumer (§7.2) bails after one full readyQueue scan and races `inFlight`. Cannot livelock — eventually a write-lock is released. Unit test covers this. |
| Bundle leaks (job's tuples never all return) | Med | Add a watchdog timer per bundle: if no tuple completes for >10 min and `inFlight` doesn't include any of its tuples, finalize as failed. (Today's behavior is the same: a hung `pMap` would block the loop forever.) |
| BG out-of-order status reports cause UI jitter | Low | Today, `reportStatus` for J1 fires once at end of fan-out. With streaming, J1 still fires once at bundle-completion. Multiple jobs' reports interleave (e.g. J2 may finish before J1) but each is atomic per-job — same as today when verifies interleave. |
| Per-attempt log routing breaks | Low | Logs are routed by `attemptId` or `jobId+profile` (`src/main/index.ts:798-815`) — both still exist on tuples. No change. |
| `findExistingSession` race with streaming | Low | The borrowed-session code (`pollAndScrape.ts:2422-2452`) is unchanged. The map-deduped `getSession` already handles concurrent `getSession` calls for the same profile (the map check is synchronous). |
| Sibling-abort regresses | Med | The abort moves from inline `AbortController` to `bundle.abortController`. Behavior identical. Plus we get the bonus of pruning queued tuples (§6.4). Test: unit test checking that an abort prunes queued tuples and propagates to in-flight. |
| Buy + verify on same account concurrent (Phase 2) introduces weird Amazon behavior | Med | Don't ship Phase 2 in v1. Phase 1 lock-policy is read-blocks-write, write-blocks-read — equivalent to today's drain. |
| Crash mid-Place-Order leaves orphan order in Amazon | Med | Existing `stage='placing'` flag + startup `abortPendingAttempts` sweep route those rows to manual review (`main/index.ts:527-625`). Streaming preserves this exactly — see §15 for full design (graceful-shutdown handler, recovery sweep, orphan reconciliation). |

## 10. Testing strategy

### 10.1 Unit tests

```ts
describe('AccountLock', () => {
  it('write blocks subsequent write on same key', async () => { ... });
  it('write blocks read on same key', async () => { ... });
  it('reads on same key are concurrent', async () => { ... });
  it('different keys never block each other', async () => { ... });
  it('release unblocks waiters in FIFO order', async () => { ... });
});

describe('JobBundle aggregation', () => {
  it('finalizes after total tuples returned', async () => { ... });
  it('aborts pending tuples on abortSiblings()', async () => { ... });
  it('handles partial-failure aggregation matching today\'s logic', async () => { ... });
});

describe('Scheduler', () => {
  it('skip-blocked consumer reorders queue when head is locked', async () => { ... });
  it('does not livelock when all queue items target one account', async () => { ... });
  it('saturates M slots when N buys span M+ distinct accounts', async () => { ... });
});
```

### 10.2 Stress tests

A `MockTuple` runner that takes random sleep (uniform 100–500ms) and returns random outcomes. Simulate:

- **Stress A:** 10 jobs × 5 accounts, M=3. Verify total wall-clock ≤ ceil(50/3) × mean_sleep. Compare with today (which would be ≥ sum of per-job ceil(5/3) tail rounds).
- **Stress B:** 5 jobs × 1 account each (all different accounts), M=3. Should run in ~ceil(5/3) × mean.
- **Stress C:** 5 jobs × 1 account, all the same. Should run serially.
- **Stress D:** Mix: 3 buy jobs + 5 verify jobs. Verify should not block buy progress beyond per-account contention.
- **Stress E:** Inject random "abort" mid-flight, confirm queued tuples drop and in-flight tuples report aborted.

### 10.3 Integration tests against real BG

- Spin up BG locally (it's Next.js + Postgres; doable per `~/Projects/Better-BuyingGroup` repo). Enqueue 3 buy jobs against 5 accounts. Observe the streaming scheduler claims them in succession and saturates.
- Test the 10-min stale-claim recovery: kill the worker mid-flight, wait for the BG side to release.

### 10.4 Live test (gated)

Before flipping the default:

1. Internal-only run with `streamingScheduler=true`, dry-run mode (`buyDryRun=true`), 2 jobs × 5 accounts × 3 workers. Observe logs match the predicted dispatch sequence.
2. Live (real Place Order) run with 1 job × 3 accounts × 2 workers. Confirm placed orders, no duplicates, no cookie-jar weirdness.
3. Live run with 2 jobs × 5 accounts × 3 workers — the canonical "saturate the third slot during fan-out tail" scenario. Compare wall-clock to today's baseline.

## 11. Settings + UX implications

### 11.1 The cap setting

Today: one `maxConcurrentBuys` (1–5, default 3) governs both buy fan-out and lifecycle. Documented as "Parallel buys."

Recommendation: keep the single global cap. Streaming makes the meaning clearer ("at most M *anything* in flight") but the user-facing label and bounds stay the same.

If we want a separate verify/tracking cap (debatable — they're cheap), introduce `maxConcurrentLifecycle` later. Skip in v1.

### 11.2 Visibility

Today's status panel (renderer side) shows `worker.start` / `worker.stop`. With streaming, the user benefits from seeing *what's currently running across jobs*:

```
Worker: running
Slots: 3 in use, 0 idle
  • J1.amazon-account-A.buy (12s elapsed)
  • J1.amazon-account-B.buy (12s elapsed)
  • J2.amazon-account-A.buy (queued, blocked on A.write)
Queue depth: 4
```

Adding this is a renderer-side change in `src/main/index.ts` and the renderer Jobs panel. Not strictly required for v1; a useful follow-up.

### 11.3 Existing telemetry

Log lines that exist today and continue to make sense:
- `worker.start` / `worker.stop`
- `job.claim`
- `job.fanout.start` (rename → `job.tuple.expanded`?)
- `job.fanout.done` (rename → `job.bundle.finalized`)
- `job.fanout.abort.fired`
- `job.profile.start` / `job.profile.placed` / `job.profile.fail`

New log lines:
- `scheduler.tuple.enqueued` (job, account, phase, queueDepth)
- `scheduler.tuple.start` (held lock, slotIdx)
- `scheduler.tuple.skipped_blocked` (account, reason="A.write held")
- `scheduler.bundle.created` (jobId, total)
- `scheduler.bundle.finalized` (jobId, totalDurationMs, perTupleDurationMsP50/P95)

These give the user-visible "saturation %" the diagnosis section asks for: `idle_slot_seconds / total_seconds` across a window.

## 12. BG-side coordination

### 12.1 Claim endpoint

Already correct: atomic `FOR UPDATE SKIP LOCKED` on `AutoBuyJob`, single job per call, race-safe across multiple AmazonG instances. (`Better-BuyingGroup/src/app/api/autog/jobs/claim/route.ts:28-47`).

The streaming scheduler will call `claimJob()` *more often* than today (whenever a slot frees, gated by the `readyQueue.length < cap*2` heuristic). With cap=5 and 5 jobs each fanning to 5 accounts = 25 tuples, this is at most a handful of additional claim calls. Negligible BG load.

**No BG changes required.**

### 12.2 Status reporting

Already correct: per-job aggregated report at the end of a buy fan-out, single report per verify, single report per fetch_tracking. The streaming scheduler fires reports per-bundle, same shape.

**No BG changes required.**

### 12.3 Future BG enhancement (not needed for v1)

If at some point we want the producer to claim a *batch* of jobs (e.g. claim up to N at once), BG would need a `POST /api/autog/jobs/claim/batch` route. Current `FOR UPDATE SKIP LOCKED LIMIT 1` would just become `LIMIT N`. Single SQL change. Not required for the streaming-scheduler design — single-job claiming saturates fine because the producer runs concurrently with the consumer.

## 13. Effort estimate

| Phase | Description | Estimate |
|---|---|---|
| 0 | Instrumentation (idle-slot telemetry, baseline metrics) | 1h |
| 1 | Extract `runBuyTuple` / `runVerifyTuple` / `runFetchTrackingTuple` helpers | 2h |
| 2 | Streaming scheduler + AccountLock + bundle aggregator behind flag | 4h |
| 2-test | Unit tests on lock + bundle + scheduler | 2h |
| 2-stress | Stress tests with mock runners | 1h |
| 3 | Live integration tests against real BG | 1h |
| 3 | Flip default + ship | 1h |
| 4 | Remove legacy code path (one release later) | 1h |
| **Total** | | **13h spread across 2 release cycles** |

## 14. Open questions / decisions needed

1. **Empirical: can verify run concurrently with a buy on the same account without Amazon flagging us?** Needs a one-shot live test: place a verify GET request mid-`runForProfile` and confirm the buy still completes successfully and the verify returns the expected outcome. **Decision needed before considering Phase 2 of the lock.** (Phase 1 doesn't need this.)

2. **Should the consumer use Option α (FIFO, head-of-line block) or Option β (skip-blocked)?** Recommended β — see §7.2. Caller confirms?

3. **Watchdog timer on bundles** (mitigation in §9 risk table): is the 10-min budget right? Today there's no equivalent — a hung pMap blocks the loop but doesn't trigger a bundle leak (because there's no aggregator state). Suggest 10 min to match BG's `CLAIM_STALE_MS` so the bundle expires around when BG would reclaim the job anyway.

4. **Settings name for the feature flag** — `streamingScheduler`, `unifiedScheduler`, `accountAwareScheduler`? Naming-only.

5. **Should we add a separate `maxConcurrentLifecycle` knob now, or wait for user complaints?** Today the same cap covers both. Streaming preserves that; a separate knob is a UX addition we can ship later if needed.

6. **Per-account "in flight" UI panel** (§11.2): worth shipping in v1, or follow-up? My read: ship in v1 — once the streaming scheduler is on, the user *will* be confused about why account A's buy started before account B's verify. A panel makes the dispatch visible and answers the question without log-spelunking.

7. **Tracking phase: `Promise.allSettled` over ship-track URLs** (`fetchTracking.ts:79-81`) is already inner-parallel. Should the scheduler treat each ship-track-URL as a separate tuple (e.g. for ultra-fine-grained fan-out)? Recommend no — the inner parallelism is already there, and the orchestration overhead of one tuple per ship-track URL would dwarf the saving.

8. **Session reuse across consecutive same-account tuples** (§5.6): out of scope for v1, revisit after streaming ships and we have data on back-to-back rates.

---

## Appendix A — code-only summary table

| Question | Answer | Source |
|---|---|---|
| Does claimJob return one job or many? | One job per call. | `Better-BuyingGroup/src/app/api/autog/jobs/claim/route.ts:44` (`LIMIT 1`) |
| Is claim race-safe across multiple workers? | Yes — `FOR UPDATE SKIP LOCKED`. | same, line 43 |
| Stale-claim timeout? | 10 minutes. | same, line 9 (`CLAIM_STALE_MS`) |
| Buy fan-out concurrency cap? | `fanoutConcurrency(parallelism)` = `maxConcurrentBuys`, clamped 1–5, default 3. | `pollAndScrape.ts:583`, `settings.ts:41` |
| Lifecycle (verify/tracking) concurrency cap? | Same `maxConcurrentBuys` setting; gated separately. | `pollAndScrape.ts:691-707` |
| Can buys and lifecycle run concurrently today? | No — buy drains lifecycle first. | `pollAndScrape.ts:762-764` |
| Is verify a browser session or HTTP only? | HTTP only via `page.context().request.get`. Page exists only as a handle. | `actions/verifyOrder.ts:80` |
| Is fetch_tracking HTTP only? | Yes — same pattern, plus `Promise.allSettled` over ship-track URLs. | `actions/fetchTracking.ts:57, 79-81` |
| Is buy browser-page driven? | Yes — `page.goto` for PDP, /spc, optionally /cart; `page.locator.click` for Buy Now / Place Order. | `actions/buyNow.ts:227, 609, 2145`; `actions/buyWithFillers.ts:514, 618, 647, 1348` |
| Is each (job, profile) given a fresh BrowserContext? | Yes — `getSession` lazily opens; `closeAndForgetSession` runs in finally. | `pollAndScrape.ts:2422-2470` |
| Where does the loop block on buy? | `pollAndScrape.ts:765` (`await handleJob` for buy phase). |
| Where is sibling-abort wired? | `pollAndScrape.ts:1003-1012` (controller); `pollAndScrape.ts:1959-1972` (per-profile checkpoint). |

---

## 15. Crash + shutdown recovery design

This section addresses the question "what happens if AmazonG dies mid-stream?" — both for today's worker and for the streaming scheduler proposed above. The core finding: **AmazonG already has a credible recovery story for today's worker** (the `stage='placing'` + `abortPendingAttempts` mechanism at `main/index.ts:527-625`), and the streaming scheduler doesn't change the worst-case orphan-order risk surface. The work needed for v1 is mostly mapping today's mechanism onto the new data structures (`readyQueue`, `bundles`), not new risk mitigations.

### 15.1 Today's recovery mechanism

| Shutdown mode | What today's code does | What's left in BG | What's left locally |
|---|---|---|---|
| **Cmd-Q** (menu Quit) | Fires Electron's `before-quit` (`main/index.ts:934-954`). Code calls `e.preventDefault()` so the quit stalls until cleanup runs: `closeAllChromiumSessions()` (`:902-928`) calls `worker.stop()` (`pollAndScrape.ts:786-801`) which flips `running=false` and calls `closeAllSessions(sessions)` — closes every per-profile BrowserContext. Closing the context makes any in-flight `page.goto` / `click` / `waitForSelector` throw `Target closed`, which `runForProfile`'s catch (`pollAndScrape.ts:2302-2311`) maps to `status='failed'` on the local attempt row. Then `abortPendingAttempts('AmazonG closed mid-run')` runs (`:913`) — see §15.2 for what that does. Finally drains buffered logs (`flushIpcLogs` + `flushDiskLogs` at `:945-947`) and calls `app.quit()` once `quittingCleanly=true`. | Jobs still `in_progress` on BG side. Reclaimable after `CLAIM_STALE_MS = 10 min` (`Better-BuyingGroup/.../claim/route.ts:9`). The `before-quit` path also fires `bg.requeueJob(jobId)` for every safe-to-retry job (`main/index.ts:606-616`), bypassing the 10-min stale window. | Local attempt rows: `placing` ones marked `failed` with "manual review required" message; `in_progress` non-`placing` ones reset to `queued` (so the next BG claim creates a clean re-attempt). Persisted via debounced 250ms write (`jobStore.ts:84-92`) — but `flushDiskLogs` only flushes the log buffer, NOT the attempt store. **Risk: if `before-quit` finishes faster than the 250ms debounce, the attempt-store write may not land.** Needs verification. |
| **App-window close** (red dot) | Fires `app.on('window-all-closed')` at `main/index.ts:883-894`. This calls `closeAllChromiumSessions()` (same as Cmd-Q's pathway) — which already includes `worker.stop()` and `abortPendingAttempts`. On macOS the app stays alive (no `app.quit()` at `:893`); on other platforms it quits. **macOS gotcha:** the user can close the window then click the dock icon to bring it back — at that point the worker is stopped but the local attempt store has been swept. They have to click Start manually. | Same as Cmd-Q on macOS (worker stopped, jobs requeued / marked failed). On non-macOS, also fires `before-quit` shortly after — runs the same cleanup again, idempotent. | Same as Cmd-Q. |
| **Hard kill** (`kill -9`, Force Quit, OS reboot, panic) | Nothing — the process dies before any handler runs. Log buffers in `ipcLogBuffer` / `diskLogBuffers` (`main/index.ts:144-148`) are dropped (last ~200ms of events lost). The Playwright Chromium child processes become zombies and the OS reaps them on its own schedule. The persistent userDataDir's SingletonLock is released by Chromium's normal shutdown, but on `kill -9` it may stick — the next launch will see "Chromium failed to start" on the affected profile until the lock file is manually cleared. **Needs verification: does `userData/amazon-profiles/<email>/SingletonLock` cleanly clear after kill -9?** | Jobs in `in_progress` stay there. Reclaimable only after `CLAIM_STALE_MS = 10 min` (no requeue call fired). | Local attempt rows in whatever state the last debounced write captured (within 250ms of the most recent mutation). On next startup, `abortPendingAttempts('AmazonG exited mid-run (recovered at startup)')` runs as part of `whenReady` (`main/index.ts:834-836`) — same sweep semantics. |
| **Mid-Place-Order specifically** | All three modes above route mid-`placing` rows through `abortPendingAttempts` (immediately for graceful, on next startup for hard kill). The `unsafe` (`stage='placing'`) bucket gets `status='failed'` + a "manual review required" error message + a BG `reportStatus` with `status='partial'` or `'failed'` per `main/index.ts:577-600`. Non-`placing` rows reset to `queued` and get `bg.requeueJob` called per-job (`:606-616`). | For mid-`placing` rows: BG receives `status='failed'` (or `'partial'` if any sibling profile is still queued) with the manual-review error. The dashboard shows the row as failed, NOT in_progress — so it's user-visible. | The mid-`placing` row stays as `failed` with a distinguishable error string. The user can see "manual review required" and check their Amazon account themselves. **No automated reconciliation against Amazon's order history.** |

**Key file:line citations for the recovery flow:**
- `main/index.ts:527` — `abortPendingAttempts(reason)` entry
- `main/index.ts:529-533` — partition `running` attempts into `unsafe` (`stage='placing'`) vs `safe` (anything else `in_progress`)
- `main/index.ts:543-548` — unsafe → `status='failed'` with manual-review message
- `main/index.ts:549-561` — safe → reset to `queued` (clears `cost`, `cashbackPct`, `orderId`, `stage`, `error`)
- `main/index.ts:577-600` — for unsafe rows, BG `reportStatus` with `failed` or `partial` (per-profile failure)
- `main/index.ts:606-616` — for safe rows, BG `requeueJob` per unique jobId (bypasses 10-min stale-claim window)
- `main/index.ts:933` — `quittingCleanly` flag prevents `before-quit` re-entry
- `main/index.ts:934-954` — the `before-quit` handler (`e.preventDefault()` → cleanup → `app.quit()`)
- `main/index.ts:902-928` — `closeAllChromiumSessions` (worker stop + Order-Click sessions)
- `main/index.ts:834-836` — startup recovery (runs `abortPendingAttempts` before worker autostart)

**Conclusion:** today's recovery story is more complete than I initially expected. The graceful path is solid; hard-kill loses ~200ms of in-memory log buffer + relies on the 250ms debounce on the attempt store; the mid-Place-Order risk is bounded but not closed (orphan-order detection requires manual review).

### 15.2 The mid-Place-Order risk window

The "dangerous" stretch where the click has been dispatched but the outcome isn't yet observable.

**Single-mode buy** (`actions/buyNow.ts`):
- Set: `await opts.onStage?.('placing')` at `:422` — immediately before `placeLocator.click({ timeout: 10_000 })` at `:424`.
- Cleared: `await opts.onStage?.(null)` at `:456` — immediately after `waitForConfirmationOrPending` returns success.
- Elapsed: between the click (`:424`) and confirm-page parse (`:445`). The confirmation helper's deadline is `60_000ms` (`buyNow.ts:1729`), so the worst-case window is ~60s. Typical case: 2–5s for Amazon's CPE redirect chain to land on `/thankyou` or `/orderconfirm`.

**Filler-mode buy** (`actions/buyWithFillers.ts`):
- Set: `await opts.onStage?.('placing')` at `:1109`.
- Cleared: `await opts.onStage?.(null)` at `:1151`.
- Elapsed: same shape. ~2–5s typical, 60s worst-case.

**`onStage` itself** (`pollAndScrape.ts:2158-2159`):
```ts
const onStage = (stage: 'placing' | null): Promise<void> =>
  deps.jobAttempts.update(attemptId, { stage }).then(() => undefined);
```
Calls `updateAttempt` in `jobStore.ts:119-134`, which mutates `cache` in memory + schedules a 250ms debounced disk write (`scheduleSave` at `jobStore.ts:84-92`). **The 250ms debounce is a recovery hazard:** if the process dies between `onStage('placing')` and the next disk flush, the on-disk row may still show `stage=null`. Then `abortPendingAttempts` would mis-classify it as `safe` and `bg.requeueJob` it — risking a duplicate order if Amazon also accepted the original click.

**Mitigation needed (small fix, applies to both today's and streaming scheduler):**
Make `stage='placing'` writes synchronous (skip the debounce, fsync immediately). Cost: one extra disk fsync per buy, ~5ms. Trivially worth it. Suggest adding a `forceFlush?: boolean` option to `updateAttempt`.

**Recovery decision per `abortPendingAttempts`:**

| State at startup | Action | Source |
|---|---|---|
| `status='in_progress'`, `stage='placing'` | Mark `failed` with "manual review required". Report `failed` (or `partial`) to BG. **Do NOT auto-retry.** | `main/index.ts:543-548, 577-600` |
| `status='in_progress'`, `stage=null` | Reset to `queued`. Call BG `requeueJob`. Worker re-claims and retries fresh. | `main/index.ts:549-561, 606-616` |
| `status='queued'` | Untouched — natural BG claim cycle re-issues. | implicit at `main/index.ts:529` (`running` filter excludes `queued`) |
| `status='awaiting_verification'` | Untouched — buy succeeded; verify-phase job will run normally. | implicit |

This is correct behavior. **The streaming scheduler MUST preserve the same `onStage('placing')` → `onStage(null)` semantics.** Since `runForProfile` is unchanged in the streaming design (per §5.5), this is automatic.

### 15.3 Orphan order reconciliation today

**Q: If AmazonG died mid-Place-Order and Amazon DID finalize the order, is there any mechanism today to detect/reconcile?**

There IS a user-triggered mechanism, but no automatic one:

1. **`jobsReconcileStuck` IPC** (`main/index.ts:1996-2085`) — bound to a UI button. Walks local pending rows; for each one without a matching BG `AutoBuyPurchase`, marks it `failed` with the reason "Orphan pending — no matching BG purchase. Worker likely crashed or the app was closed before the outcome was reported." For rows where BG agrees but `orderId` is null AND age > 30 min, marks both sides `failed`. **This does NOT scrape Amazon's order history.** It only reconciles local attempt rows against BG.

2. **`abortPendingAttempts` startup sweep** (`main/index.ts:834`) — runs unconditionally on startup. Marks unsafe (`placing`) rows as `failed` with manual-review message. Tells BG via `reportStatus`. **Does NOT scrape Amazon.**

3. **No periodic / automatic order-history scrape exists.** Code search confirms: `your-orders` and `order-history` URLs appear in `buyWithFillers.ts:1349`, `buyNow.ts:492`, `buyNow.ts:2146` (multi-ASIN order-id lookups during a successful buy), and `main/index.ts:2431` (user-triggered "Your Orders" window). None of these run as a reconciliation sweep.

**The gap:** if the recovery sweep marks a row as "manual review required" because it was mid-`placing`, the user sees "Failed: AmazonG exited mid-run; Amazon may or may not have accepted the order" in the Jobs table. They have to:
1. Open Amazon's order history themselves
2. Cross-check against the failed row's deal
3. If an order DID land, manually contact BG to update the AutoBuyPurchase record (or use the `jobsVerifyOrder` IPC at `main/index.ts:2087+` if they have an orderId — but they don't, because the click never returned one).

**Frequency / impact:**
- Crashes are rare. Cmd-Q and window-close routes are graceful. Hard kills happen on OS panic / Force Quit / `kill -9` / power loss.
- Within the rare crash, the `placing` window is ~2–5s typical (per §15.2). The probability of dying *during* that window is roughly `(5s / 30s buy duration) × P(crash during a buy)` — single-digit %.
- Per buy, the impact is one mis-attributed order: BG dashboard shows `failed`, Amazon shows `placed`. User loses cashback tracking on that buy unless they reconcile manually.

**This gap exists today and is unrelated to the streaming scheduler.** §15.8 outlines a follow-up enhancement to close it.

### 15.4 Why streaming doesn't worsen the risk

The streaming scheduler increases concurrency surface area in some dimensions but not the dimension that matters for orphan orders:

| Dimension | Today | Streaming |
|---|---|---|
| Max simultaneous mid-`placing` tuples | M (cap) | M (cap) — unchanged |
| Max in-flight job IDs | 1 buy + cap-many lifecycle | up to cap, mixed phases |
| Max queued tuples held in worker memory | 0 (pMap input is the per-job eligible list) | up to `cap*2` (per `readyQueue` size guard at §5.3) |
| Per-bundle in-memory state | 0 (pMap returns synchronously) | `bundle.results: ProfileResult[]` (up to N entries) |

The worst-case orphan-order count is bounded by **simultaneously mid-`placing` tuples**, which equals M in both models. Streaming doesn't increase M — that's the user's `maxConcurrentBuys` setting (default 3, max 5).

What streaming DOES change:
- **More job IDs in `in_progress` simultaneously on BG.** Today: at most 1 buy + several lifecycle. Streaming: up to cap, any mix. The recovery sweep (`abortPendingAttempts`) handles this fine — it iterates per-jobId and per-attempt independently.
- **Per-bundle progress is in memory.** If J1 has 5 tuples and 3 finished before crash, the `bundle.results` array (in §5.1) is lost. On next startup, the local `JobAttempt` rows for those 3 finished tuples still show `awaiting_verification` (set at `pollAndScrape.ts:2271-2287`), so they're already in BG too — but the *aggregate* report (winner pick, partial-vs-full status) was never sent. **This means BG shows individual `awaiting_verification` purchases but the parent `AutoBuyJob` never transitions out of `in_progress`.** The 10-min stale-claim window will reclaim it; AmazonG will re-fan out with the same eligible list, but those 3 already-`awaiting_verification` rows would be touched by BG's "skipped on retry — profile no longer eligible" sweep at `Better-BuyingGroup/.../status/route.ts:347-362` IF the eligible list changed.

This is mostly fine — but it's a new behavior to test. See §15.6 for the recommendation.

### 15.5 Proposed graceful-shutdown handler

Today's `before-quit` handler does the right thing: flips `running=false`, closes all sessions (which causes in-flight Playwright ops to throw immediately), then runs `abortPendingAttempts`. For the streaming scheduler we extend this with three changes:

```ts
// In streamingScheduler stop():
async function stop(): Promise<void> {
  running = false;

  // 1. Drain readyQueue WITHOUT running its tuples. Mark each as failed
  //    locally; the bundle aggregator finalizes affected jobs as
  //    'partial' (some siblings may have completed before the stop).
  for (const t of readyQueue) {
    collectResult(bundles, t.jobId, failed(t.account, 'worker stopping'));
  }
  readyQueue.length = 0;

  // 2. Close all sessions. In-flight tuple tasks throw 'Target closed';
  //    their catch in the consumer (§5.3) converts to a failed
  //    ProfileResult; the aggregator finalizes their bundles. This step
  //    is the same as today's worker.stop() at pollAndScrape.ts:786-801.
  await closeAllSessions(sessions);

  // 3. Wait for all consumer tasks to settle so abortPendingAttempts
  //    sees stable JobAttempt rows. Bounded by Electron's before-quit
  //    grace (~5s, see below) — race against a deadline.
  await Promise.race([
    Promise.allSettled(Array.from(inFlight)),
    new Promise((r) => setTimeout(r, 4_000)), // 4s soft cap
  ]);

  // 4. abortPendingAttempts runs as today (called from app.on('before-quit')
  //    in main/index.ts:913, AFTER closeAllChromiumSessions). It sweeps
  //    JobAttempt rows on disk; nothing about streaming changes its semantics.
}
```

**Electron `before-quit` semantics (verified via the existing handler at `main/index.ts:934-954`):**
- Fires once when the user requests a quit (Cmd-Q, app.quit(), force-quit DOES NOT fire it — it's `kill` on the process).
- `e.preventDefault()` *does* stall the quit. The handler can run async work; Electron will wait until `app.quit()` is called again (with `quittingCleanly=true` to bypass the re-entry guard).
- **No documented hard timeout** — Electron will wait forever. But macOS will eventually force-kill if the user mashes Cmd-Q repeatedly or the OS is shutting down. **Soft target: 5s total cleanup.**
- **Non-graceful paths (Force Quit, kill -9, OS panic) skip `before-quit` entirely.** No code can run; only the next-launch startup sweep recovers. This is true today and unchanged.

**"Wait up to 5s for tuples to settle"** — the right bound:
- Closing the BrowserContext makes `page.click` / `page.goto` throw `Target closed` within ~50ms.
- A tuple in mid-CPE-redirect (post Place Order click, pre confirm-page parse) has the `placing` flag set. When the context closes, the `waitForConfirmationOrPending` polling loop (`buyNow.ts:1735`) breaks at its next `page.evaluate`, throws, runForProfile's catch maps it to `failed`. Total time: <200ms.
- `closeAndForgetSession` in `runForProfile`'s finally (`pollAndScrape.ts:2200, 2310, 2255`) takes ~100ms.
- So 4s is generous. 1s would probably suffice for the in-flight settle, leaving 4s of the 5s Electron budget for `abortPendingAttempts` (which does 5–25 disk writes + 5–25 BG HTTP requests).

**Critical: the `placing` window is NOT specially treated by graceful stop.** Today, when `before-quit` fires, in-flight `placing` tuples are interrupted by session close — the click already went out, the response is in flight, and the tuple's catch converts the thrown `Target closed` error into a `failed` row. **At no point does the graceful stop wait for an in-flight Place Order to complete.** This is a deliberate trade: we'd rather have the `placing` row marked unsafe + manual-review on next startup than block shutdown for 60s waiting for Amazon's redirect chain.

If we wanted to add "best-effort wait for `placing` tuples to finish", the implementation would be:

```ts
// In stop(), AFTER setting running=false but BEFORE closeAllSessions:
const placingTasks = Array.from(inFlight).filter((task) =>
  // need to track which inFlight task corresponds to a placing tuple;
  // requires plumbing the tuple's onStage state out to the scheduler
);
// Wait up to 3s for placing tuples to finish; the rest are aborted via
// closeAllSessions immediately.
await Promise.race([
  Promise.allSettled(placingTasks),
  new Promise((r) => setTimeout(r, 3_000)),
]);
await closeAllSessions(sessions); // aborts the rest
```

**Recommendation: don't bother in v1.** The current "interrupt everything immediately, mark `placing` as manual-review" is simpler and the user-experience cost (one row marked failed when it might have succeeded) is the same risk we already accept on `kill -9`.

### 15.6 Persistent vs ephemeral state

**Recommendation: Design X — don't persist `readyQueue` / `bundles`. Rely on BG + local JobAttempt rows.**

Rationale:

1. **BG already persists the source of truth.** Each tuple corresponds to an `AutoBuyPurchase` row (created at `pollAndScrape.ts:959-986`, persisted via `bg.reportStatus` in subsequent updates). The queue is reconstructable: re-claim the in_progress jobs, re-expand to tuples, skip any whose `AutoBuyPurchase.status` is already `awaiting_verification`/`completed`/`cancelled`.

2. **Local JobAttempt rows are persisted** (`jobStore.ts:78-92`, with the 250ms debounce and the `flushDiskLogs` hook in `before-quit`). On startup, `abortPendingAttempts` already reads them.

3. **The "lost work" cost is small.** If we crash with 5 tuples in flight on a streaming scheduler:
   - 3 finished → already updated their JobAttempt rows + BG `AutoBuyPurchase` rows. Lost: only the *aggregate* `reportStatus` (the parent `AutoBuyJob` stays `in_progress`).
   - 2 in-flight → `placing` rows go to manual-review or `queued` rows reset cleanly. Same as today.
   - The aggregate report can be reconstructed on next startup by reading the per-purchase rows from BG (`bg.listPurchases`) and rolling them up. **Or** simpler: on `requeueJob`, BG resets the parent to `queued` and AmazonG re-claims; the existing `viaFiller` / `placedEmail` snapshot fields on the job mean the rebuy logic still works, and the per-profile rows that already have `awaiting_verification` are skipped by the upsert (because `runForProfile` would only be called for queued attempts — but wait, `abortPendingAttempts` resets ALL `in_progress` non-`placing` rows to `queued`, including the 3 finished ones).

   That last point is a real gap: today's recovery sweep over-resets. Rows that completed successfully but never got their aggregate report sent would be re-attempted as a duplicate buy. **Needs verification: do successful tuples (status='awaiting_verification') get protected from the sweep?**

   Looking at `main/index.ts:529`: `const running = all.filter((a) => a.status === 'in_progress')`. So `awaiting_verification` rows are NOT touched by the sweep. ✓ Successful tuples are safe. The only sweep targets are still-running ones.

4. **Persistence (Design Y) adds complexity without proportional benefit.** Re-hydrating `bundles` from disk requires a write per tuple-completion (or a snapshot every N seconds), plus version/concurrent-edit checks if multiple AmazonG instances ever run. The 10-min stale-claim window is the right granularity for recovery — instant recovery of in-memory queue state isn't worth the complexity.

**Implementation note for §6 (the bundle aggregator):** add a startup hook that, for each `AutoBuyJob` reclaimed by `claimJob` after a crash, calls `bg.listPurchases(jobId)` and pre-populates `bundle.results` from the existing rows. This avoids re-running tuples that already succeeded on the previous instance. Estimated additional effort: ~1h, can be deferred to a follow-up release.

### 15.7 Recovery sweep on startup

**The current sweep** (`main/index.ts:527-625`, called from `whenReady` at `:834`) handles all the cases we need. The streaming scheduler doesn't add new states to JobAttempt; it just runs more of them in parallel. The decision tree is unchanged:

```
For each JobAttempt at startup:
  status='queued'                        → skip (BG will re-issue via natural claim cycle)
  status='in_progress', stage='placing'  → DANGEROUS
                                            • mark failed + "manual review required"
                                            • bg.reportStatus('failed' or 'partial')
                                            • surface to user via failed-row in Jobs table
                                          (existing: main/index.ts:543-548, 577-600)
  status='in_progress', stage=null       → safe-to-retry
                                            • reset to queued (clear cost/cashback/orderId)
                                            • bg.requeueJob (bypasses 10-min stale-claim)
                                          (existing: main/index.ts:549-561, 606-616)
  status='awaiting_verification'         → preserved (verify-phase job will pick it up)
  status='verified' / 'completed' / 'failed' / 'cancelled_by_amazon' / 'action_required' / 'dry_run_success' → terminal, untouched
```

**User-facing UX for the dangerous case (today):** failed-row in the Jobs table with the error message "AmazonG exited mid-run (recovered at startup) — stopped mid-Place-Order; Amazon may or may not have accepted the order, manual review required." (`main/index.ts:541, 546`).

**Improvement opportunity (out of scope for v1, but cheap):** add a renderer-side dashboard banner when `abortPendingAttempts` finds any unsafe rows on startup. Currently the user only notices if they happen to look at the Jobs table. Banner text: "AmazonG recovered N attempts that may have placed orders on Amazon. Check your Amazon order history and verify the Jobs table." Clicks through to a filtered view of the failed rows.

**Streaming-specific addition needed:** when `claimJob` returns a job that's been reclaimed after a stale window (or via `requeueJob`), the producer should call `bg.listPurchases(jobId)` and check for any `awaiting_verification` siblings. If found, *exclude* those Amazon emails from the tuple expansion — they already succeeded on the previous instance. Without this, streaming can issue duplicate Place Order clicks for accounts that already finished. (This is also a latent risk today, but less so because today's worker only runs one buy at a time and the sweep resets the row before the next claim — so the per-profile attempt row is in `queued` not `awaiting_verification`. With streaming, the sweep might run faster than the previous instance's `reportStatus` to BG, leaving the divergence.)

**Implementation for §5.3's `expandToTuples`:**

```ts
async function expandToTuples(job, eligible, deps): Promise<Tuple[]> {
  let alreadySucceeded = new Set<string>();
  if (job.attempts > 1) {
    // Reclaimed (stale or requeued). Filter out profiles that already
    // succeeded on a previous instance.
    const existing = await deps.bg.listPurchasesForJob(job.id);
    alreadySucceeded = new Set(
      existing
        .filter((p) => p.status === 'awaiting_verification' || p.status === 'completed')
        .map((p) => p.amazonEmail.toLowerCase()),
    );
  }
  return eligible
    .filter((p) => !alreadySucceeded.has(p.email.toLowerCase()))
    .map((p) => ({ jobId: job.id, profile: p, /* ... */ }));
}
```

Cost: one extra HTTP GET per reclaimed job. Worst case: cap-many of these on startup. Bounded.

### 15.8 Orphan order reconciliation (follow-up, NOT in v1)

To actually CLOSE the orphan-order risk (instead of just bounding it via manual-review), AmazonG would need a periodic scrape of each account's `/your-orders` page and a reconciler. Sketch:

```
Daily (or on-startup) sweep, per Amazon account:
  1. Open session for the account (HTTP-only — no UI tab).
  2. GET /gp/css/order-history → parse order list (dates, orderIds, item titles, prices).
     Limit to last 7 days to bound the page count.
  3. For each Amazon order:
     a. Look up matching AutoBuyPurchase by orderId. If found, skip (already tracked).
     b. If not found: candidate orphan. Try to map back to a likely AutoBuyJob:
        - Same amazonEmail
        - Same item title (fuzzy match against deal titles)
        - Same approximate price
        - Placed within the same 60s window as a `failed` JobAttempt with stage='placing'
        - Optional: check the `purchaseId` from /thankyou URL if we captured it pre-crash
     c. If a unique match is found: update AutoBuyPurchase with the orderId via a new
        BG endpoint /api/autog/purchases/[id]/reconcile. Flag user via notification.
     d. If multiple candidates or no match: leave as a "potential orphan" — surface in
        a UI panel for the user to manually associate.
```

**Risks (all reasons this is NOT in v1):**

1. **False positives.** User placed orders manually on the same account. We'd mis-attribute them to AmazonG-driven deals. Mitigation: only auto-reconcile when there's a unique match WITHIN the recovery window of a `placing`-state crash. Otherwise, surface as a candidate, don't auto-update.

2. **ASIN reuse across deals.** Two different BG deals can target the same ASIN at different times. Title-matching is imperfect.

3. **Time-window correctness.** The `placing` row's `updatedAt` is the last write before crash. Amazon's order timestamp is when they finalized. These can be 5–60s apart depending on the CPE redirect chain duration.

4. **Cost.** A full order-history scrape per account is a few hundred KB of HTML and a parse. Even hourly per-account is fine — but that's M HTTP requests per hour + M parses, which adds up across many accounts.

**Effort estimate: 8–14 hours** (writing a robust HTML parser for /your-orders, deduping logic, BG endpoint, UI panel for candidate review). Defer to a separate proposal once the streaming scheduler is shipped and we have data on actual orphan rates.

**Cheap interim mitigation (1h):** in the recovery sweep, when we find a `placing` row, log the deal+account+last-known timestamps to a `recovery-orphans.jsonl` file in userData. Lets the user (and us) audit historical occurrences without building the full reconciliation pipeline.

### 15.9 Effort estimate

| Item | Effort | In-scope for v1? |
|---|---|---|
| Make `stage='placing'` writes synchronous (skip 250ms debounce) | 0.5h | **Yes** — risk fix, applies to today's code too. Ship in same release as Phase 0 instrumentation. |
| Streaming scheduler `stop()` drains `readyQueue` + races inFlight (§15.5) | 1h | **Yes** — part of Phase 2 scheduler implementation. |
| `expandToTuples` filters out `awaiting_verification` siblings on reclaim (§15.7) | 1h | **Yes** — required for streaming correctness on stale-claim recovery. |
| BG endpoint `bg.listPurchasesForJob(jobId)` (if not already exposed) | 0.5h | **Yes** — needed for the above. May already exist via `bg.listPurchases` filtering; verify. |
| Renderer dashboard banner on startup-recovery-with-unsafe-rows (§15.7) | 1h | Optional — defer to follow-up. |
| `recovery-orphans.jsonl` audit log (§15.8) | 1h | Optional — cheap to add now. |
| Full orphan-order reconciliation against `/your-orders` (§15.8) | 8–14h | **No** — separate proposal. |

**v1 streaming-scheduler additions for crash safety: ~3h** (synchronous `placing` writes + scheduler `stop()` + reclaim de-dup + endpoint verification). On top of the 13h estimate in §13. Total: ~16h.

### 15.10 Open questions

These I cannot answer from the code alone:

1. **Does the 250ms debounce on the JobAttempt store ever drop a `stage='placing'` write on hard kill?** Mechanically yes if the kill happens within 250ms of the `onStage('placing')` call. In practice the click takes longer than that; the `placing` flag is usually flushed by the time the click resolves. **Test:** instrument with `fsync` after every `stage` write; measure how many writes land before vs after the click. (Almost certainly 100% before — but worth confirming.)

2. **Does Chromium's `SingletonLock` on `userData/amazon-profiles/<email>/` clear cleanly after `kill -9`?** If not, the next launch sees "Chromium failed to start: profile in use" until the user manually removes the lock file. **Test:** SIGKILL the AmazonG process while a worker is running; verify the next launch can re-open all profiles. If it fails, we need a startup pass that removes stale `SingletonLock` files (already a known Chromium recovery pattern).

3. **What happens on macOS sleep / wake during a buy?** macOS may suspend the Electron process (and its Chromium children) for hours. On wake, the Playwright BrowserContext may have stale TCP connections; the in-flight `page.goto` may time out and throw. The tuple's catch handles this — but the user-experience question is whether sleep is treated as "crash mid-run" or "pause then resume." **Test:** start a buy, put the Mac to sleep for 5 min, wake; observe whether the buy completes, fails, or hangs. Recommend sleep treatment is "hard crash" — Amazon's session may have expired anyway, retry-from-scratch is safer than resume.

4. **If `before-quit` cleanup exceeds Electron's grace period (which is OS-dependent), does AmazonG exit cleanly?** Electron docs are vague. Setting `app.exit()` (not `app.quit()`) bypasses cleanup and exits immediately — useful as a final "5s elapsed, force exit" timeout. **Test:** synthetically slow `closeAllChromiumSessions` to 30s; observe whether macOS Force-Quits AmazonG, whether logs are lost.

5. **How often does the orphan-order case actually happen in production?** I have no empirical data. The user's tolerance for adding the §15.8 reconciliation work depends on this. **Action:** add the `recovery-orphans.jsonl` audit log (1h) and revisit in 4–6 weeks with real numbers.

6. **Does `bg.listPurchases` accept a `jobId` filter, or do we need a new endpoint?** `Better-BuyingGroup/src/app/api/autog/purchases/route.ts` and the BGClient need to be cross-checked. If not, adding the filter is trivial (one WHERE clause). Counts as part of the §15.9 0.5h estimate.

7. **In the streaming-scheduler stop path, does `closeAllSessions` correctly tear down sessions that are mid-`placing`?** Today's `pollAndScrape.ts:786-801` design says yes — closing the context throws `Target closed` and the catch handles it. **Test:** unit-level test on `runForProfile` with a mocked Page that raises during `placeLocator.click`, verify `onStage('placing')` was called and the catch path fires (the row stays at `stage='placing'` until the next mutation).

