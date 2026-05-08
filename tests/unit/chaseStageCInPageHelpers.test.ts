import { describe, expect, it } from 'vitest';
import { STAGE_C_IN_PAGE_HELPERS_SRC } from '../../src/main/chaseStageCInPageHelpers.js';

/**
 * The helpers run inside `page.evaluate` in PR2, so we eval them in
 * Node here and exercise the resulting functions against fake Response
 * objects. This proves the source parses and the classifier returns
 * the right kind for each documented status / content-type combo.
 */

interface InPageFns {
  fetchWithTimeout: (
    url: string,
    options?: RequestInit,
    timeoutMs?: number,
  ) => Promise<unknown>;
  classifyResponse: (r: FakeResponse) => Promise<{ kind: string; [k: string]: unknown }>;
}

function loadHelpers(): InPageFns {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    `${STAGE_C_IN_PAGE_HELPERS_SRC}\nreturn { fetchWithTimeout, classifyResponse };`,
  ) as () => InPageFns;
  return make();
}

class FakeHeaders {
  private map = new Map<string, string>();
  constructor(init?: Record<string, string>) {
    if (init) for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), v);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}

class FakeResponse {
  status: number;
  headers: FakeHeaders;
  private body: string;
  constructor(status: number, body: string, headers: Record<string, string>) {
    this.status = status;
    this.body = body;
    this.headers = new FakeHeaders(headers);
  }
  async text(): Promise<string> {
    return this.body;
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }
}

describe('STAGE_C_IN_PAGE_HELPERS_SRC parses and exposes both helpers', () => {
  it('eval succeeds and exports the expected functions', () => {
    const fns = loadHelpers();
    expect(typeof fns.fetchWithTimeout).toBe('function');
    expect(typeof fns.classifyResponse).toBe('function');
  });
});

describe('classifyResponse', () => {
  const fns = loadHelpers();

  it('returns kind:ok for a 200 SUCCESS JSON response', async () => {
    const r = new FakeResponse(200, JSON.stringify({ code: 'SUCCESS', cache: [] }), {
      'content-type': 'application/json; charset=UTF-8',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('ok');
    expect((out as unknown as { json: { code: string } }).json.code).toBe('SUCCESS');
  });

  it('returns kind:akamai-403 for an HTML 403 (the bot-manager rejection shape)', async () => {
    const r = new FakeResponse(
      403,
      '<html><body>Reference #18.abcd1234</body></html>',
      { 'content-type': 'text/html; charset=UTF-8' },
    );
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('akamai-403');
    expect(out.status).toBe(403);
  });

  it('returns kind:auth for a 403 with ACCOUNTS:AuthorizationException', async () => {
    const r = new FakeResponse(
      403,
      JSON.stringify({ code: 'ACCOUNTS:AuthorizationException' }),
      { 'content-type': 'application/json' },
    );
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('auth');
    expect(out.status).toBe(403);
  });

  it('returns kind:auth for a 401 regardless of body code', async () => {
    const r = new FakeResponse(401, JSON.stringify({}), {
      'content-type': 'application/json',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('auth');
  });

  it('returns kind:rate-limit for 429', async () => {
    const r = new FakeResponse(429, JSON.stringify({ code: 'THROTTLED' }), {
      'content-type': 'application/json',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('rate-limit');
  });

  it('returns kind:transient-5xx for any 5xx', async () => {
    const r = new FakeResponse(503, JSON.stringify({ code: 'UNAVAILABLE' }), {
      'content-type': 'application/json',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('transient-5xx');
  });

  it('returns kind:non-json for a non-JSON 200 (Chase served HTML for some reason)', async () => {
    const r = new FakeResponse(200, '<!DOCTYPE html>', {
      'content-type': 'text/html',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('non-json');
  });

  it('returns kind:json-parse-error when content-type lies and json() throws', async () => {
    const r = new FakeResponse(200, 'not-json-at-all', {
      'content-type': 'application/json',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('json-parse-error');
  });

  it('returns kind:other for an unhandled status that has JSON body', async () => {
    const r = new FakeResponse(418, JSON.stringify({ code: 'TEAPOT' }), {
      'content-type': 'application/json',
    });
    const out = await fns.classifyResponse(r);
    expect(out.kind).toBe('other');
    expect(out.status).toBe(418);
  });
});

describe('fetchWithTimeout', () => {
  const fns = loadHelpers();
  // We can't easily test the success path against a real fetch in
  // this Node environment (no DOM Response) — the timeout / abort
  // path is the production-critical behavior; success is exercised
  // end-to-end in PR2 against a real Chase session.

  it('returns kind:timeout when the deadline elapses before fetch completes', async () => {
    const slowFetch = (_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        });
      });
    const restore = (globalThis as { fetch: unknown }).fetch;
    (globalThis as { fetch: unknown }).fetch = slowFetch;
    try {
      const out = (await fns.fetchWithTimeout('https://example.com', {}, 50)) as {
        ok: boolean;
        kind: string;
      };
      expect(out.ok).toBe(false);
      expect(out.kind).toBe('timeout');
    } finally {
      (globalThis as { fetch: unknown }).fetch = restore;
    }
  });

  it('returns kind:network-error when fetch rejects for a non-abort reason', async () => {
    const failingFetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const restore = (globalThis as { fetch: unknown }).fetch;
    (globalThis as { fetch: unknown }).fetch = failingFetch;
    try {
      const out = (await fns.fetchWithTimeout('https://example.com', {}, 1000)) as {
        ok: boolean;
        kind: string;
      };
      expect(out.ok).toBe(false);
      expect(out.kind).toBe('network-error');
    } finally {
      (globalThis as { fetch: unknown }).fetch = restore;
    }
  });
});
