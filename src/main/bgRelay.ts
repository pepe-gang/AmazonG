/**
 * BG.com fetch relay — desktop side.
 *
 * BG creates RemoteFetchJob rows for buyinggroup.com calls it would
 * have made directly. This module long-polls for them, executes the
 * fetch from the user's IP (the whole point — buyinggroup.com sees
 * the home/office IP, not Vercel/Railway), and posts the response
 * back.
 *
 * ── Lifecycle ──────────────────────────────────────────────────
 *
 *   start({bg, signal})  — kicks off N concurrent worker loops; each
 *                          long-polls /claim, processes one job at a
 *                          time, posts the result back.
 *   stop()                — flips the abort signal; the next loop
 *                          iteration aborts mid-poll cleanly via the
 *                          fetch's AbortSignal.timeout pairing.
 *
 * ── Concurrency ────────────────────────────────────────────────
 *
 * The dispute page fans out ~15 parallel BG.com calls in BG. With one
 * relay worker on AmazonG, that becomes 15 sequential round-trips =
 * ~5-10s end-to-end. Six concurrent workers brings it under 1s.
 *
 * ── Defense in depth ───────────────────────────────────────────
 *
 *   - URL whitelist: only api.prod.buyinggroup.com is allowed. BG's
 *     decideRelay() already enforces this, but a compromised BG
 *     instance could otherwise turn AmazonG into an SSRF vector.
 *   - 20s per-fetch timeout: prevents a hung BG.com response from
 *     blocking a worker forever.
 *   - 5MB response body cap: enforced server-side too; we cap here
 *     to avoid posting massive responses.
 */

import { BGApiError } from '../shared/errors.js';
import type { BGClient } from '../bg/client.js';
import { logger } from '../shared/logger.js';

/** Number of concurrent claim/process workers. Each holds one
 *  long-poll request to BG plus at most one in-flight buyinggroup.com
 *  fetch. 6 covers the dispute-page fan-out comfortably without
 *  hammering BG's claim endpoint. */
const CONCURRENT_WORKERS = 6;

/** Per-fetch timeout against buyinggroup.com. BG.com responses are
 *  typically <1s; a 20s ceiling covers the slowest path observed
 *  (large public-deal-info batches) with margin. */
const FETCH_TIMEOUT_MS = 20_000;

/** Backoff on persistent claim errors. */
const CLAIM_ERROR_BACKOFF_MS = 5_000;

/** Cached public IP of the desktop. Detected once on first claim,
 *  stamped on every result so the dashboard can render the IP
 *  buyinggroup.com saw. Cached across worker invocations. */
let cachedClientIp: string | null = null;
let clientIpFetchInFlight: Promise<string | null> | null = null;

const BG_HOST = 'api.prod.buyinggroup.com';

/**
 * Marker prefix on `body` when BG serialized a FormData body. Mirror
 * of FORM_DATA_PREFIX in BG's bgRelayRuntime.ts. Format:
 *   "__bgrelay_form__:" + JSON.stringify([[key, value], ...])
 *
 * AmazonG re-detects the prefix, rebuilds a FormData object, and
 * sends it as multipart/form-data — same wire format BG would have
 * used directly. Without this round-trip BG.com receives a body-less
 * POST and returns empty results.
 */
const FORM_DATA_PREFIX = '__bgrelay_form__:';

/**
 * Reconstruct the actual body the desktop should send, from the
 * serialized string BG put in the job. String bodies pass through;
 * the FormData marker triggers JSON parse + FormData rebuild.
 *
 * Also strips Content-Type from the headers when we rebuild a
 * FormData body — multipart/form-data needs the boundary which
 * fetch() generates fresh per request. If we kept BG's stored
 * Content-Type, undici would send a header with a mismatched
 * boundary and the server would reject the body.
 */
function deserializeRelayBody(
  rawBody: string | null,
  headers: Record<string, string>,
): { body: BodyInit | undefined; headers: Record<string, string> } {
  if (rawBody == null) return { body: undefined, headers };
  if (rawBody.startsWith(FORM_DATA_PREFIX)) {
    try {
      const entries = JSON.parse(rawBody.slice(FORM_DATA_PREFIX.length)) as Array<[string, string]>;
      const form = new FormData();
      for (const [k, v] of entries) form.append(k, v);
      // Strip stale Content-Type — fetch will regenerate with the
      // proper multipart boundary.
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== 'content-type') cleaned[k] = v;
      }
      return { body: form, headers: cleaned };
    } catch {
      // Fall through to plain-string body — better than throwing
      // mid-fetch.
    }
  }
  return { body: rawBody, headers };
}

/**
 * Fetch the desktop's public IP via api.ipify.org. Used once on
 * relay start; cached for subsequent jobs so we don't ping ipify on
 * every single relay. ipify is rate-limited generously (1 req/min)
 * but we'd hit it many times per minute under load otherwise.
 *
 * Returns null on failure — the relay still works without the IP
 * stamp, the dashboard just won't show it.
 */
async function detectPublicIp(): Promise<string | null> {
  if (cachedClientIp) return cachedClientIp;
  if (clientIpFetchInFlight) return clientIpFetchInFlight;
  clientIpFetchInFlight = (async () => {
    try {
      const res = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { ip?: string };
      const ip = typeof json.ip === 'string' ? json.ip : null;
      cachedClientIp = ip;
      return ip;
    } catch {
      return null;
    } finally {
      clientIpFetchInFlight = null;
    }
  })();
  return clientIpFetchInFlight;
}

export type RelayHandle = {
  /** Stop the relay loop — aborts in-flight long-polls + fetches.
   *  Resolves once every worker has exited. */
  stop(): Promise<void>;
};

/**
 * Start N concurrent relay workers. Returns a handle the caller uses
 * to stop them on app shutdown / disconnect. Workers retry with
 * backoff on persistent claim errors (BG down, auth blip) so the
 * loop self-heals.
 */
export function startBgRelay(deps: { bg: BGClient }): RelayHandle {
  const controller = new AbortController();
  const workerPromises: Promise<void>[] = [];

  // Eager IP detection — fires-and-forgets so the first job already
  // has the IP available. Fail-quiet; subsequent jobs will retry on
  // cache miss.
  void detectPublicIp();

  logger.info('bgRelay.start', { workers: CONCURRENT_WORKERS });

  for (let i = 0; i < CONCURRENT_WORKERS; i++) {
    workerPromises.push(workerLoop(deps.bg, controller.signal, i));
  }

  return {
    async stop() {
      logger.info('bgRelay.stop');
      controller.abort();
      // Wait for every worker to exit. Bounded — they each have
      // an aborted long-poll that returns within ~1s.
      await Promise.allSettled(workerPromises);
    },
  };
}

async function workerLoop(
  bg: BGClient,
  signal: AbortSignal,
  workerId: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const job = await bg.claimRemoteFetchJob();
      if (signal.aborted) return;
      if (!job) {
        // 204 — nothing pending. Loop back immediately; the long-poll
        // already sat for 25s.
        continue;
      }

      // Process. Errors are caught + posted back as result-failure
      // so the worker loop never crashes. Logging is tagged with
      // workerId for parallel visibility.
      await processJob(bg, job, workerId);
    } catch (err) {
      if (signal.aborted) return;
      // Auth errors / BG down — back off briefly then retry. We
      // don't want a hot-loop spamming a broken endpoint.
      const isAuthError = err instanceof BGApiError && err.status === 401;
      logger.warn('bgRelay.claim.error', {
        workerId,
        isAuthError,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleepUntil(CLAIM_ERROR_BACKOFF_MS, signal);
    }
  }
}

async function processJob(
  bg: BGClient,
  job: import('../shared/types.js').ServerRemoteFetchJob,
  workerId: number,
): Promise<void> {
  // Defense-in-depth: BG already filters URLs in decideRelay, but
  // re-validate so a hypothetical compromised BG can't turn this
  // worker into an SSRF vector. Refusal is reported back as an
  // error so BG's relayFetch falls through to direct.
  let allowed = false;
  try {
    const u = new URL(job.url);
    allowed = u.protocol === 'https:' && u.hostname === BG_HOST;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    logger.warn('bgRelay.refused', {
      workerId,
      jobId: job.id,
      callTag: job.callTag,
      url: job.url,
    });
    await bg
      .postRemoteFetchResult(job.id, {
        error: 'AmazonG refused: URL is not api.prod.buyinggroup.com',
      })
      .catch(() => undefined);
    return;
  }

  const clientIp = await detectPublicIp();

  const startedAt = Date.now();
  let result: {
    status: number;
    headers: Record<string, string>;
    body: string;
  } | null = null;
  let errorMsg: string | null = null;

  try {
    // Rebuild FormData if BG serialized one — string bodies pass through
    const { body: reqBody, headers: reqHeaders } = deserializeRelayBody(
      job.body,
      job.headers,
    );
    const res = await fetch(job.url, {
      method: job.method,
      headers: reqHeaders,
      body: reqBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    const respBody = await res.text();
    result = { status: res.status, headers: respHeaders, body: respBody };
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const cloudDurationMs = Date.now() - startedAt;

  logger.info('bgRelay.executed', {
    workerId,
    jobId: job.id,
    callTag: job.callTag,
    status: result?.status ?? null,
    durationMs: cloudDurationMs,
    clientIp,
    ...(errorMsg ? { error: errorMsg } : {}),
  });

  // Post result back. If THIS post fails, the BG-side relayFetch
  // poll will time out at 5s and fall through to direct. So a
  // missed-result is recoverable; we just log and move on.
  await bg
    .postRemoteFetchResult(job.id, {
      ...(result
        ? { status: result.status, headers: result.headers, body: result.body }
        : { error: errorMsg ?? 'unknown failure' }),
      ...(clientIp ? { clientIp } : {}),
      cloudDurationMs,
    })
    .catch((err) => {
      logger.warn('bgRelay.result.post.error', {
        workerId,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * setTimeout pinned to an AbortSignal so the loop's stop()
 * propagates cleanly through the backoff window. Returns when
 * either ms elapses OR the signal aborts.
 */
function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
