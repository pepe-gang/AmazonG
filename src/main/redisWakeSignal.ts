/**
 * Cross-module wake signal connecting the Redis subscriber (which
 * runs in the main process) to the StreamingScheduler's producer
 * loop (which also runs in the main process).
 *
 * The producer loop's idle-wait used to be `await sleep(10_000)`.
 * It becomes `await Promise.race([waitForWake(), sleep(60_000)])`.
 * When a Redis pub/sub message arrives, `signalWake()` resolves the
 * pending wake promise and the producer fires its burst-claim
 * immediately.
 *
 * Properties:
 *   - waitForWake() ALWAYS returns a fresh promise. Awaiting twice
 *     gives you two independent wakeups (we want that — the
 *     producer's debounce flag handles overlapping wakes).
 *   - signalWake() is idempotent. Calling it 50 times rapidly when
 *     no one is waiting just resolves whatever promise is currently
 *     pending; the next waitForWake() gets a fresh unresolved one.
 *   - Module-level singleton. The subscriber and scheduler import
 *     this same module so they share state.
 */

let pending: Promise<void> = new Promise(() => {});
let resolver: (() => void) | null = null;

function refresh(): void {
  pending = new Promise<void>((resolve) => {
    resolver = resolve;
  });
}

// Initialize immediately so the first waitForWake() has a real
// promise behind it.
refresh();

/**
 * Resolves on the NEXT signalWake() call. Each invocation returns a
 * fresh promise — awaiting twice in a row yields two distinct
 * wakeups (the producer's debounce flag will collapse them if they
 * overlap in the same iteration).
 */
export function waitForWake(): Promise<void> {
  return pending;
}

/**
 * Signal that work may be ready. Resolves the current pending
 * wake-promise, then immediately allocates a fresh one so the next
 * waiter starts from an unresolved state. Safe to call from any
 * context (subscriber callback, IPC handler, test helper).
 */
export function signalWake(): void {
  const r = resolver;
  refresh();
  if (r) r();
}
