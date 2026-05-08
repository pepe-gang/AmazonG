/**
 * In-page helpers for Stage C (PR2). These run inside the browser
 * context via `page.evaluate(...)`, NOT in the main process — so they
 * are exported as a JS source string for injection rather than as a
 * normal TypeScript module.
 *
 * Why string-based:
 *   - `page.evaluate(fn)` serializes `fn` to source. Closure variables
 *     and imported helpers are inaccessible inside the page. Defining
 *     them inline is the only way.
 *   - We want a single point of truth so both the runtime and the
 *     unit tests reference the same source.
 *
 * Used by Stage C's `runFetchStageC` (PR2). Tested in PR1 via Node-side
 * `eval` to confirm the source parses, the timeout helper aborts on
 * deadline, and the response classifier returns the correct kind for
 * each documented status / content-type combination.
 *
 * Two helpers are bundled:
 *   - `fetchWithTimeout(url, options, timeoutMs)` — `fetch` with an
 *     AbortSignal-based deadline. Fixes the production gap that
 *     `page.evaluate` itself has no timeout option (verified in
 *     Playwright `types.d.ts`); a stuck Chase 504 inside a parallel
 *     batch would otherwise hang the renderer indefinitely.
 *   - `classifyResponse(r)` — returns `{ kind, ... }` per documented
 *     failure-mode taxonomy from the round-4 deep audit:
 *     `'ok' | 'auth' | 'rate-limit' | 'transient-5xx' | 'akamai-403' |
 *      'non-json' | 'json-parse-error' | 'other'`.
 *     Reads `content-type` BEFORE `r.json()` so an Akamai HTML 403
 *     doesn't throw `SyntaxError: Unexpected token <` and nuke the
 *     entire `Promise.allSettled` batch.
 */

export const STAGE_C_IN_PAGE_HELPERS_SRC = String.raw`
async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 8000;
  try {
    const r = await fetch(url, {
      ...(options || {}),
      signal: AbortSignal.timeout(ms),
    });
    return { ok: true, response: r };
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, kind: 'timeout', timeoutMs: ms };
    }
    return { ok: false, kind: 'network-error', message: String(err && err.message || err) };
  }
}

async function classifyResponse(r) {
  const status = r.status;
  const contentType = (r.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    let text = '';
    try { text = await r.text(); } catch (_) {}
    if (status === 403 && /akamai|reference\s*#|<html/i.test(text)) {
      return { kind: 'akamai-403', status, bodyHead: text.slice(0, 512) };
    }
    return { kind: 'non-json', status, contentType, bodyHead: text.slice(0, 512) };
  }
  let json = null;
  try {
    json = await r.json();
  } catch (e) {
    return { kind: 'json-parse-error', status, error: String(e && e.message || e) };
  }
  if (status === 200 && json && json.code === 'SUCCESS') {
    return { kind: 'ok', status, json };
  }
  if (status === 401) {
    return { kind: 'auth', status, code: json && json.code };
  }
  if (status === 403 && json && typeof json.code === 'string' && /authoriz/i.test(json.code)) {
    return { kind: 'auth', status, code: json.code };
  }
  if (status === 429) {
    return { kind: 'rate-limit', status, code: json && json.code };
  }
  if (status >= 500) {
    return { kind: 'transient-5xx', status, code: json && json.code };
  }
  return { kind: 'other', status, code: json && json.code };
}
`;
