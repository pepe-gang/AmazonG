/**
 * Verifies ensureAddress recovers from Amazon's transient HTTP 500
 * during address-picker form submission.
 *
 * Live failure observed 2026-05-10 on DL-05260034: bot picked the
 * matching saved-address radio + submitted the form, but Amazon's
 * checkout farm 500'd. Browser landed at
 *   amazon.com/errors/500?ref=chk_web_sry
 * instead of redirecting back to /spc. The bot's `waitForURL` timed
 * out and the buy was abandoned with reason
 *   "address submitted but did not redirect back to /spc"
 * — even though a fresh /spc recreate would have succeeded.
 *
 * Recovery (Option A):
 *   - On the timeout, if page.url() is anywhere under /errors/, navigate
 *     to SPC_ENTRY_URL (/checkout/entry/cart?proceedToCheckout=1) to
 *     allocate a fresh purchaseId.
 *   - Recurse ensureAddress once with allowAmazon500Recovery=false to
 *     prevent infinite loops if the farm is actually down.
 *   - The recursion's fast path (readCurrentAddress) usually succeeds,
 *     because Amazon's address-set commits server-side independently
 *     of the /spc render that 500'd.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { ensureAddress } from '../../src/actions/buyNow.js';

type Step = (msg: string, data?: unknown) => void;

/**
 * Builds a minimal scripted Page mock. `urlSequence` is consumed in
 * order on each `page.url()` call; subsequent reads stick on the last
 * value. `evaluateScript` is consumed in order on each `page.evaluate`.
 */
function makePage(opts: {
  urlSequence: string[];
  evaluateScript: Array<unknown | ((...args: unknown[]) => unknown)>;
  waitForURL: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
}): Page {
  let urlIdx = 0;
  let evalIdx = 0;
  const url = vi.fn(() => {
    const v = opts.urlSequence[Math.min(urlIdx, opts.urlSequence.length - 1)];
    if (urlIdx < opts.urlSequence.length - 1) urlIdx++;
    return v ?? '';
  });
  const evaluate = vi.fn(async (_fn: unknown, ...args: unknown[]) => {
    const next = opts.evaluateScript[evalIdx++];
    if (typeof next === 'function') return (next as (...a: unknown[]) => unknown)(...args);
    return next;
  });
  const locator = vi.fn(() => ({
    first: () => ({
      waitFor: vi.fn().mockResolvedValue(undefined),
    }),
  }));
  return {
    evaluate,
    url,
    waitForURL: opts.waitForURL,
    goto: opts.goto,
    locator,
  } as unknown as Page;
}

describe('ensureAddress — Amazon HTTP 500 recovery', () => {
  it('recovers when waitForURL times out and page lands on /errors/500', async () => {
    const allowed = ['13132', '13130', '1146'];
    const matchingAddr = 'BG Warehouse 13132 Some St City State 12345';

    // Sequence of evaluates ensureAddress will run:
    //   1. readCurrentAddress (initial)        → '' (no match → slow path)
    //   2. open address-picker (location.href) → some absolute URL
    //   3. picker form.submit                  → {ok:true, ...}
    //   --- waitForURL fires + times out ---
    //   --- recovery: page.goto(SPC_ENTRY_URL) ---
    //   --- recurse ensureAddress ---
    //   4. readCurrentAddress (post-recreate)  → matchingAddr (fast path ✓)
    const evaluateScript = [
      '', // readCurrentAddress 1
      'https://www.amazon.com/checkout/p/p-XXX/address?...', // picker open
      { ok: true, text: matchingAddr, prefix: '13132', checked: true }, // picker submit
      matchingAddr, // readCurrentAddress 2 (after recreate, fast path)
    ];

    const waitForURL = vi
      .fn()
      .mockImplementationOnce(async () => undefined) // first call: address picker page
      .mockImplementationOnce(async () => {
        throw new Error('Timeout 20000ms exceeded');
      }); // second call: /spc redirect — TIMES OUT

    const goto = vi.fn().mockResolvedValue(undefined);

    const page = makePage({
      // url() reads happen at: ensureAddress-fast-path-readCurrentAddress (no
      // url() call there), at the timeout (stuck=/errors/500), then in the
      // SPC_URL_MATCH check after goto (lands on /spc).
      urlSequence: [
        'https://www.amazon.com/errors/500?ref=chk_web_sry',
        'https://www.amazon.com/checkout/p/p-NEW/spc?referrer=spc',
      ],
      evaluateScript,
      waitForURL,
      goto,
    });

    const stepMsgs: string[] = [];
    const warnMsgs: string[] = [];
    const emit = {
      step: ((m: string) => stepMsgs.push(m)) as Step,
      warn: ((m: string) => warnMsgs.push(m)) as Step,
    };

    const result = await ensureAddress(page, allowed, emit);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefix).toBe('13132');
      expect(result.current).toBe(matchingAddr);
    }
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[0]).toBe(
      'https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1',
    );
    expect(warnMsgs).toContain('step.checkout.address.amazon500');
  });

  it('does NOT loop: if Amazon 500s twice, returns a clear error', async () => {
    const allowed = ['13132'];
    const evaluateScript = [
      '', // readCurrentAddress 1 (no match → slow path)
      'https://www.amazon.com/checkout/p/p-XXX/address?...', // picker open
      { ok: true, text: 'addr', prefix: '13132', checked: true }, // picker submit
      // Recurse with allowAmazon500Recovery=false:
      '', // readCurrentAddress 2 (no match → slow path again)
      'https://www.amazon.com/checkout/p/p-NEW/address?...', // picker open
      { ok: true, text: 'addr', prefix: '13132', checked: true }, // picker submit
      // Second timeout — recovery disabled — should fail with the
      // generic "did not redirect" reason (no further recreate).
    ];

    const waitForURL = vi
      .fn()
      .mockImplementationOnce(async () => undefined) // address picker 1
      .mockImplementationOnce(async () => {
        throw new Error('Timeout 1');
      }) // /spc 1 → TIMES OUT
      .mockImplementationOnce(async () => undefined) // address picker 2 (in recursion)
      .mockImplementationOnce(async () => {
        throw new Error('Timeout 2');
      }); // /spc 2 → TIMES OUT AGAIN

    const goto = vi.fn().mockResolvedValue(undefined);
    const page = makePage({
      urlSequence: [
        'https://www.amazon.com/errors/500?ref=chk_web_sry', // first stuck
        'https://www.amazon.com/checkout/p/p-NEW/spc', // after recreate (lands on /spc)
        'https://www.amazon.com/errors/500?ref=chk_web_sry', // second stuck (recursion)
      ],
      evaluateScript,
      waitForURL,
      goto,
    });

    const result = await ensureAddress(page, allowed, {
      step: (() => {}) as Step,
      warn: (() => {}) as Step,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Recursion ran with allowAmazon500Recovery=false, so the second
      // timeout falls through to the original "did not redirect" path
      // — no second goto attempt, no infinite loop.
      expect(result.reason).toMatch(/did not redirect/i);
    }
    // Exactly one recovery navigation (no second one in the recursion).
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('does not trigger recovery when stuck URL is non-/errors/ (e.g. genuinely stuck mid-redirect)', async () => {
    const allowed = ['13132'];
    const evaluateScript = [
      '', // readCurrentAddress 1
      'https://www.amazon.com/checkout/p/p-XXX/address?...', // picker open
      { ok: true, text: 'addr', prefix: '13132', checked: true }, // picker submit
    ];
    const waitForURL = vi
      .fn()
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error('Timeout');
      });
    const goto = vi.fn();
    const page = makePage({
      // Stuck at the address picker URL (not /errors/) — recovery should NOT fire.
      urlSequence: ['https://www.amazon.com/checkout/p/p-XXX/address?stillHere'],
      evaluateScript,
      waitForURL,
      goto,
    });
    const result = await ensureAddress(page, allowed, {
      step: (() => {}) as Step,
      warn: (() => {}) as Step,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/did not redirect/i);
    expect(goto).not.toHaveBeenCalled();
  });
});
