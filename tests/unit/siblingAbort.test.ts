import { describe, test, expect } from 'vitest';

/**
 * Verifies the AbortController + pMap composition we'll use to kill
 * sibling profiles when one detects a PRODUCT-level failure (out-of-
 * stock or price-exceeds). The test uses a local copy of the exact pMap
 * helper from pollAndScrape.ts so we exercise the same concurrency
 * model production runs (8 profiles, concurrency 3, queued workers
 * pick up as in-flight slots free).
 */

// LOCAL COPY of pMap (from pollAndScrape.ts:2347). Kept here so the
// test stays self-contained without exporting the helper.
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

type ProfileResult = {
  profile: number;
  status: 'completed' | 'failed' | 'aborted';
  reason: string;
  reachedStage: string;
};

describe('sibling-abort pattern', () => {
  test('out_of_stock at profile 0 → kills in-flight + queued profiles', async () => {
    const controller = new AbortController();

    async function runForProfile(profileId: number): Promise<ProfileResult> {
      // Stage A: pre-flight check (e.g. session warm-up). Queued
      // profiles hit this first when they get picked up.
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'preflight',
        };
      }

      // Stage B: simulated scrapeProduct
      await sleep(40);
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_scrape',
        };
      }

      // Stage C: verifyProduct — profile 0 detects out_of_stock and
      // fires the kill signal for siblings.
      if (profileId === 0) {
        controller.abort('out_of_stock');
        return {
          profile: profileId,
          status: 'failed',
          reason: 'out_of_stock',
          reachedStage: 'verify',
        };
      }

      // Stage D: simulated Buy Now click + later steps
      await sleep(200);
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_buy_now',
        };
      }

      return {
        profile: profileId,
        status: 'completed',
        reason: 'happy_path',
        reachedStage: 'placed',
      };
    }

    // 7 profiles, concurrency 3 — exactly the user's scenario
    const results = await pMap([0, 1, 2, 3, 4, 5, 6], 3, runForProfile);

    expect(results.length).toBe(7);

    // Profile 0 fired the abort with the trigger reason
    expect(results[0]).toMatchObject({
      profile: 0,
      status: 'failed',
      reason: 'out_of_stock',
      reachedStage: 'verify',
    });

    // Profiles 1, 2 — running in parallel with 0 (initial concurrency 3) —
    // caught the abort signal at one of the post-await checks.
    for (const i of [1, 2]) {
      expect(results[i]!.status).toBe('aborted');
      expect(results[i]!.reason).toBe(
        'aborted_by_sibling:out_of_stock',
      );
    }

    // Profiles 3-6 — queued initially. By the time they're picked up,
    // the signal is already aborted, so they bail at preflight (no
    // wasted scrapeProduct or Buy Now work).
    for (const i of [3, 4, 5, 6]) {
      expect(results[i]!.status).toBe('aborted');
      expect(results[i]!.reachedStage).toBe('preflight');
      expect(results[i]!.reason).toBe(
        'aborted_by_sibling:out_of_stock',
      );
    }
  });

  test('price_exceeds also propagates with its own reason', async () => {
    const controller = new AbortController();

    async function runForProfile(profileId: number): Promise<ProfileResult> {
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'preflight',
        };
      }
      await sleep(40);
      if (profileId === 1) {
        // Profile 1 detects price-exceeds (PDP-level price check)
        controller.abort('price_exceeds');
        return {
          profile: profileId,
          status: 'failed',
          reason: 'price_exceeds',
          reachedStage: 'verify',
        };
      }
      await sleep(200);
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_buy_now',
        };
      }
      return {
        profile: profileId,
        status: 'completed',
        reason: 'happy_path',
        reachedStage: 'placed',
      };
    }

    const results = await pMap([0, 1, 2, 3, 4, 5, 6], 3, runForProfile);

    expect(results[1]).toMatchObject({
      status: 'failed',
      reason: 'price_exceeds',
    });
    // The abort reason flows to siblings via signal.reason
    for (const i of [0, 2, 3, 4, 5, 6]) {
      expect(results[i]!.status).toBe('aborted');
      expect(results[i]!.reason).toBe(
        'aborted_by_sibling:price_exceeds',
      );
    }
  });

  test('account-specific failure does NOT propagate (cashback_gate)', async () => {
    // Critical negative test: failures that AREN'T product-level must
    // NOT call abort. Other profiles continue independently because
    // they may have different cashback eligibility (different account
    // overrides, different addresses, etc.).
    const controller = new AbortController();

    async function runForProfile(profileId: number): Promise<ProfileResult> {
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: 'sibling',
          reachedStage: 'preflight',
        };
      }
      await sleep(40);
      if (profileId === 0) {
        // cashback_gate is account-specific — do NOT abort siblings.
        return {
          profile: profileId,
          status: 'failed',
          reason: 'cashback_gate',
          reachedStage: 'gate',
        };
      }
      await sleep(100);
      return {
        profile: profileId,
        status: 'completed',
        reason: 'happy_path',
        reachedStage: 'placed',
      };
    }

    const results = await pMap([0, 1, 2, 3, 4, 5, 6], 3, runForProfile);

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reason).toBe('cashback_gate');

    // All other profiles complete normally — the cashback_gate failure
    // on profile 0 did not propagate.
    for (const i of [1, 2, 3, 4, 5, 6]) {
      expect(results[i]!.status).toBe('completed');
      expect(results[i]!.reachedStage).toBe('placed');
    }
  });

  test('production-shape: 7 profiles, concurrency 3, queued bail at preflight without doing PDP work', async () => {
    // Simulates the real handleJob flow with the production logging keys
    // we added (job.profile.aborted_by_sibling, job.fanout.abort.fired).
    // Counts how much "PDP work" each profile did so we can prove the
    // savings match what we promised the user.
    const controller = new AbortController();
    const log: string[] = [];

    let pdpLoadsPerformed = 0;
    let buyFlowsStarted = 0;

    async function runForProfile(profileId: number): Promise<ProfileResult> {
      // Preflight checkpoint
      if (controller.signal.aborted) {
        log.push(`p${profileId}: bailed at preflight (no PDP load)`);
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'preflight',
        };
      }

      // Simulated session warmup (~50ms) — real cost ~1-3s in production
      await sleep(20);
      if (controller.signal.aborted) {
        log.push(`p${profileId}: bailed after_getSession`);
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_getSession',
        };
      }

      // Simulated PDP load (~30ms) — real cost ~3-5s in production
      pdpLoadsPerformed++;
      log.push(`p${profileId}: PDP load done`);
      await sleep(30);
      if (controller.signal.aborted) {
        log.push(`p${profileId}: bailed after_scrape`);
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_scrape',
        };
      }

      // Verify check — profile 0 detects out_of_stock here
      if (profileId === 0) {
        log.push(`p${profileId}: detected out_of_stock, firing abort`);
        controller.abort('out_of_stock');
        return {
          profile: profileId,
          status: 'failed',
          reason: 'out_of_stock',
          reachedStage: 'verify',
        };
      }

      if (controller.signal.aborted) {
        log.push(`p${profileId}: bailed after_verify`);
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'after_verify',
        };
      }

      // Simulated full buy flow — real cost ~30-90s in production
      buyFlowsStarted++;
      log.push(`p${profileId}: starting buy flow`);
      await sleep(200);
      return {
        profile: profileId,
        status: 'completed',
        reason: 'happy_path',
        reachedStage: 'placed',
      };
    }

    const results = await pMap([0, 1, 2, 3, 4, 5, 6], 3, runForProfile);

    // Profile 0 fires abort — the trigger
    expect(results[0]).toMatchObject({
      status: 'failed',
      reason: 'out_of_stock',
    });

    // Profiles 1-6 are aborted (none completed buy flow)
    for (const i of [1, 2, 3, 4, 5, 6]) {
      expect(results[i]!.status).toBe('aborted');
    }

    // Quantitative check: NOT every profile loaded the PDP. The queued
    // ones (3-6) should bail at preflight. Only 0/1/2 (initial concurrency)
    // do the PDP load.
    expect(pdpLoadsPerformed).toBeLessThanOrEqual(3);

    // No profile reached the buy flow (they all aborted before it)
    expect(buyFlowsStarted).toBe(0);

    // Sanity: all 7 reported a result
    expect(results.length).toBe(7);
  });

  test('every profile reports a result even when aborted (no orphans)', async () => {
    // Important for BG-side tracking: every profile must produce a
    // ProfileResult so we can report status to BG for every (job,
    // profile) row. None should silently disappear from the results
    // array.
    const controller = new AbortController();

    async function runForProfile(profileId: number): Promise<ProfileResult> {
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'preflight',
        };
      }
      await sleep(20);
      if (profileId === 0) {
        controller.abort('out_of_stock');
        return {
          profile: profileId,
          status: 'failed',
          reason: 'out_of_stock',
          reachedStage: 'verify',
        };
      }
      await sleep(50);
      if (controller.signal.aborted) {
        return {
          profile: profileId,
          status: 'aborted',
          reason: `aborted_by_sibling:${String(controller.signal.reason)}`,
          reachedStage: 'mid',
        };
      }
      return {
        profile: profileId,
        status: 'completed',
        reason: 'happy_path',
        reachedStage: 'placed',
      };
    }

    const results = await pMap([0, 1, 2, 3, 4, 5, 6], 3, runForProfile);

    // No undefined / missing entries
    expect(results.length).toBe(7);
    for (const r of results) {
      expect(r).toBeDefined();
      expect(typeof r.profile).toBe('number');
      expect(['completed', 'failed', 'aborted']).toContain(r.status);
      expect(r.reason).toBeTruthy();
    }
  });
});
