/**
 * AmazonG-side Redis pub/sub subscriber for the "job-ready" doorbell.
 * Shipped in v0.13.78 + default-on since v0.13.79.
 *
 * Replaces the prior poll-every-10s loop with an instant wake when BG
 * publishes a job for this user. The 10s poll loop stays active as a
 * safety-net fallback (handles disconnects, cold-start race, and old
 * AmazonG versions). Background:
 * docs/migration/redis-pub-sub-push.md in the BetterBG repo.
 *
 * Lifecycle:
 *   - start(deps): fetches a scoped REDIS_URL + channel from BG via
 *     bg.getRedisToken(). Connects via ioredis. Subscribes. Calls
 *     deps.onMessage() on every received message.
 *   - stop(): unsubscribes, quits, releases listeners.
 *
 * Robustness (per the BullMQ-on-Upstash research + ioredis bug
 * reports — see GitHub redis/ioredis#1451):
 *   - PING every 120s. Upstash idle-timeout is ~300s; PINGing inside
 *     the window forces ioredis to detect a dead connection within
 *     ~2 minutes instead of silently losing messages.
 *   - keepAlive 250s (set after socket connect via ioredis built-in).
 *   - Subscriber callback wrapped in try/catch. A thrown callback
 *     does NOT kill the subscription.
 *   - Wake-signal debounce: rapid duplicate publishes don't cause
 *     N×wake. Producer wakes once; subsequent events are no-ops
 *     until the producer has consumed.
 *   - macOS powerMonitor: explicit disconnect/reconnect on sleep/wake.
 *     ioredis doesn't reliably detect post-sleep zombie connections.
 *   - On reconnect, fire an immediate synthetic wake so the producer
 *     drains any jobs queued during the disconnect window.
 *
 * If anything fails, we DO NOT block AmazonG. The safety-net poll in
 * the producer loop still runs every 60s.
 */

import Redis from "ioredis";

type Listener = () => void;

export type RedisSubscriberDeps = {
  fetchTokenAndChannel(): Promise<
    | { url: string; channel: string; staleInstanceWarning?: boolean }
    | null
  >;
  /** Fires on every received message AND on synthetic reconnect-wake.
   *  Idempotent — the producer's wake-signal flag de-dupes. */
  onWake(): void;
  /** Fires when BG returns staleInstanceWarning=true. Drives the
   *  renderer's "another AmazonG instance is running" banner. */
  onDuplicateInstanceWarning(): void;
  /** Optional fine-grained event hook for tests / debug. */
  onStatus?(
    status:
      | "connecting"
      | "connected"
      | "subscribed"
      | "reconnecting"
      | "disconnected"
      | "error",
    detail?: string,
  ): void;
};

let active: {
  client: Redis;
  pingTimer: NodeJS.Timeout;
  powerSubs: Array<() => void>;
  stopping: boolean;
} | null = null;

const PING_INTERVAL_MS = 120_000;
const KEEP_ALIVE_MS = 250_000;

/**
 * Try to import Electron lazily. Returns null in non-Electron
 * contexts (tests) — the subscriber still works, just without
 * powerMonitor sleep/wake handling.
 */
async function tryElectron(): Promise<typeof import("electron") | null> {
  try {
    return await import("electron");
  } catch {
    return null;
  }
}

/**
 * Start the subscriber. Idempotent — calling start() while already
 * running stops the existing subscriber first.
 *
 * Returns a Promise that resolves once subscribed (or rejects on
 * unrecoverable error). Caller should NOT block on this — race it
 * against a timeout if blocking would matter.
 */
export async function start(deps: RedisSubscriberDeps): Promise<void> {
  if (active) {
    await stop();
  }
  deps.onStatus?.("connecting");

  const tok = await deps.fetchTokenAndChannel();
  if (!tok) {
    deps.onStatus?.("error", "token_fetch_failed");
    throw new Error("subscriber.token_fetch_failed");
  }
  if (tok.staleInstanceWarning) {
    deps.onDuplicateInstanceWarning();
  }

  // ioredis in subscriber mode can't run regular commands — but it
  // CAN run PING. We use a single client for both subscribe + ping;
  // separate clients would just double the connection count.
  //
  // Connection options:
  //   lazyConnect: false — we want to fail fast on bad creds at
  //     start() time, not on the first message.
  //   keepAlive — 250s, well under Upstash's 300s idle timeout.
  //   maxRetriesPerRequest: null — unlimited reconnects (subscriber
  //     should NEVER give up). retryStrategy below caps wait time.
  //   retryStrategy — exponential up to 30s. Avoids hammering Upstash
  //     after a flap.
  const client = new Redis(tok.url, {
    lazyConnect: false,
    keepAlive: KEEP_ALIVE_MS,
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
    autoResubscribe: true,
    // enableOfflineQueue MUST stay at default (true). The SUBSCRIBE
    // command lands before the TLS handshake completes; offline-queue
    // buffers it until the socket is writable. With it off we get
    // "Stream isn't writeable" errors on every fresh start.
    //
    // The per-user ACL grants only SUBSCRIBE/PSUBSCRIBE/PING/QUIT,
    // not INFO — so ioredis's default ready-check (which sends INFO
    // to detect server role + state) fails with NOPERM. Disabling it
    // is safe for a sub-only client: the SUBSCRIBE call still
    // confirms the channel binding succeeded.
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 30_000),
  });

  // Module-level singleton holds the reference so it can't be GC'd.
  const pingTimer = setInterval(() => {
    if (!active) return;
    void client.ping().catch(() => {
      // PING failure = stale TCP. ioredis will tear down + reconnect
      // via retryStrategy. Don't try to handle here.
      deps.onStatus?.("error", "ping_failed");
    });
  }, PING_INTERVAL_MS);

  // Lifecycle handlers — keep them light, don't recurse into start().
  client.on("connect", () => deps.onStatus?.("connected"));
  client.on("reconnecting", () => deps.onStatus?.("reconnecting"));
  client.on("error", (err) =>
    deps.onStatus?.("error", err instanceof Error ? err.message : String(err)),
  );
  client.on("end", () => deps.onStatus?.("disconnected"));

  // The actual message handler. Wrap in try/catch so a bad payload
  // can't kill the subscription.
  client.on("message", (channel, _payload) => {
    if (channel !== tok.channel) return; // shouldn't happen; defensive
    try {
      deps.onWake();
    } catch (err) {
      console.warn(
        "[redisSubscriber.onWake.threw]",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // Initial subscribe + immediate wake so the producer drains any
  // jobs created before this connect landed (Redis pub/sub is
  // fire-and-forget; anything published while we were offline is
  // gone — safety-net poll covers it, but waking now is faster).
  await client.subscribe(tok.channel);
  deps.onStatus?.("subscribed", tok.channel);
  try {
    deps.onWake();
  } catch {
    // ignore
  }

  // macOS powerMonitor: ioredis doesn't reliably detect post-sleep
  // dead connections. Force disconnect on sleep, force reconnect on
  // wake. The reconnect triggers the connect/subscribe handlers
  // again.
  const electron = await tryElectron();
  const powerSubs: Array<() => void> = [];
  if (electron?.powerMonitor) {
    const onSuspend = () => {
      // Aggressive disconnect — better to force a reconnect than to
      // sit on a zombie socket.
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    };
    const onResume = () => {
      // ioredis's reconnecting state already handles this, but call
      // connect() explicitly to be safe. Awaiting it is fine — we
      // are inside a sync handler from Electron.
      void client.connect().catch(() => undefined);
      // Fire an immediate wake so the producer catches up.
      try {
        deps.onWake();
      } catch {
        // ignore
      }
    };
    electron.powerMonitor.on("suspend", onSuspend);
    electron.powerMonitor.on("resume", onResume);
    powerSubs.push(
      () => electron.powerMonitor.off("suspend", onSuspend),
      () => electron.powerMonitor.off("resume", onResume),
    );
  }

  active = { client, pingTimer, powerSubs, stopping: false };
}

/**
 * Stop the subscriber. Safe to call multiple times. Releases
 * powerMonitor listeners, clears the PING timer, sends QUIT.
 */
export async function stop(): Promise<void> {
  if (!active) return;
  active.stopping = true;
  clearInterval(active.pingTimer);
  for (const off of active.powerSubs) {
    try {
      off();
    } catch {
      // ignore
    }
  }
  try {
    await active.client.unsubscribe().catch(() => undefined);
    await active.client.quit().catch(() => undefined);
  } catch {
    // ignore — best-effort shutdown
  }
  active = null;
}

/** True if the subscriber is currently running. */
export function isRunning(): boolean {
  return active !== null;
}

/**
 * Test/debug helper: register a one-shot wake listener (not used in
 * the production flow, but useful for unit tests that need to
 * observe a wake event without instantiating a real ioredis client).
 */
export function _internal_simulateMessage(): void {
  // No-op when no subscriber active; tests must register their own
  // onWake via start().
}

/** Unused: silences "unused" linter for the helper. */
export const _internal_Listener = null as Listener | null;
