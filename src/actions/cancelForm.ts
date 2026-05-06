import type { Page } from 'playwright';

/**
 * Helpers shared by `cancelFillerOrder` and `cancelNonTargetItems`. The
 * two flows differ in WHICH checkboxes they tick and the logger event
 * names, but navigation, submit, and confirmation detection are
 * identical — kept here to avoid two copies drifting apart.
 */

export const CANCEL_URL = (orderId: string): string =>
  `https://www.amazon.com/progress-tracker/package/preship/cancel-items?orderID=${orderId}`;

export type OpenCancelPageResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: string };

/**
 * Navigate to the pre-ship cancel-items page, wait for it to hydrate,
 * and confirm we're still on the cancel URL (Amazon redirects when the
 * order is already cancelled / shipped / otherwise not cancellable).
 */
export async function openCancelPage(
  page: Page,
  orderId: string,
): Promise<OpenCancelPageResult> {
  try {
    // 'commit' returns at TCP commit (~50ms) instead of DCL (~500-2000ms).
    // The waitForFunction below is the actual readiness gate — it polls
    // for the cancel form's checkbox + submit button at RAF cadence
    // (~16ms) so we proceed as soon as the form is genuinely usable
    // instead of guessing. Saves ~750ms per cancel vs the old
    // DCL+1500ms-blind combo. Same pattern as scrapeProduct.ts:196.
    await page.goto(CANCEL_URL(orderId), {
      waitUntil: 'commit',
      timeout: 30_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'failed to load cancel page',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Wait for the cancel form to actually be interactable: a primary form
  // (action contains "cancel" OR has itemId/orderItem inputs) with at
  // least one visible checkbox AND a submit/cancel button. 10s ceiling
  // covers pathological hydration; typical cases resolve in 200-500ms.
  // If this URL was going to redirect away (already-cancelled / shipped),
  // the predicate never matches and we time out — the post-wait URL
  // check below catches it as "not on cancel-items page".
  await page
    .waitForFunction(
      () => {
        const forms = Array.from(document.querySelectorAll('form'));
        const primary = forms.find(
          (f) =>
            /cancel/i.test(f.getAttribute('action') || '') ||
            f.querySelector('input[name*="itemId" i], input[name*="orderItem" i]'),
        );
        if (!primary) return false;
        const cb = primary.querySelector(
          'input[type="checkbox"]:not([disabled])',
        );
        const submit = primary.querySelector(
          'input[name*="cancel" i][type="submit"], button[name*="cancel" i]',
        );
        return !!cb && !!submit;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const here = page.url();
  if (!/cancel-items/i.test(here)) {
    return {
      ok: false,
      reason:
        'not on cancel-items page after navigation — order likely already cancelled or shipped',
      detail: `url=${here}`,
    };
  }
  return { ok: true };
}

export type SubmittedResult =
  | { clicked: true; via: string }
  | { clicked: false };

/**
 * Click the "Request Cancellation" submit button. Amazon has used
 * several labels ("Cancel items", "Request cancellation", "Cancel
 * selected items") — try id/name selectors first, fall back to label
 * match. Returns `clicked: true` with the selector used, or
 * `clicked: false` if nothing matched.
 *
 * Tees up listeners for the form-POST response and the resulting
 * navigation BEFORE firing the click — Amazon's cancel form is a
 * classic synchronous form submit, so the click triggers a navigation
 * whose response carries the actual server-side cancel ack. The
 * caller (waitForCancelOutcome) consumes those promises to block
 * until the round-trip completes; without them, an in-page click
 * returns immediately and the page can be torn down before Amazon
 * has even received the POST.
 */
export async function clickRequestCancellation(
  page: Page,
): Promise<SubmittedResult> {
  // Arm the network listener before the click so we don't miss the
  // response. Matches the cancel POST regardless of which exact
  // endpoint Amazon's A/B variant uses today (cancel-items, cancel,
  // confirm-cancel, etc.). Stored on the page so waitForCancelOutcome
  // can await it after the click without us threading state through
  // the public return type.
  const responsePromise = page
    .waitForResponse(
      (resp) => /cancel/i.test(resp.url()) && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  // Also watch for the post-submit navigation — some Amazon variants
  // GET-redirect after the POST, others render the result inline.
  const navigationPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    .catch(() => undefined);
  // Stash on page so waitForCancelOutcome can drain them. Using a
  // private symbol-ish key avoids leaking to the Page typedef.
  (page as unknown as { __cancelInflight?: Array<Promise<unknown>> }).__cancelInflight = [
    responsePromise,
    navigationPromise,
  ];

  return page
    .evaluate(() => {
      const selectorCandidates = [
        'input[name="cancelAll"]',
        'input[name="cancelItems"]',
        'input[name*="cancel" i][type="submit"]',
        'button[name*="cancel" i]',
        'input[id*="cancel" i][type="submit"]',
        'button[id*="cancel" i]',
      ];
      for (const sel of selectorCandidates) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) {
          el.click();
          return { clicked: true as const, via: sel };
        }
      }
      const labelRe = /^(request cancellation|cancel items?|cancel selected items?|confirm cancellation)$/i;
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], input[type="button"], a[role="button"], .a-button-input',
        ),
      );
      for (const btn of buttons) {
        if (btn.offsetParent === null) continue;
        if ((btn as HTMLButtonElement).disabled) continue;
        const label = (
          (btn as HTMLInputElement).value ||
          btn.getAttribute('aria-label') ||
          btn.textContent ||
          ''
        ).trim();
        if (labelRe.test(label)) {
          btn.click();
          return { clicked: true as const, via: `text:${label}` };
        }
      }
      return { clicked: false as const };
    })
    .catch(() => ({ clicked: false as const }));
}

/**
 * After clicking submit, wait for Amazon's cancel POST round-trip to
 * complete AND for the resulting page to either confirm the
 * cancellation or surface its "Unable to cancel requested items"
 * refusal banner. Returns early as soon as the outcome is detectable.
 * Best-effort — silently continues if any individual signal times out.
 *
 * The order matters:
 *   1. Drain the network/navigation promises armed in
 *      clickRequestCancellation. This blocks until Amazon has actually
 *      received the POST and produced a response. Without this, the
 *      DOM-text poll can match against a stale page or race the
 *      navigation, and the caller can tear the page down before the
 *      POST hits the wire.
 *   2. Wait for domcontentloaded on whatever page we ended up on.
 *   3. Poll the body text for the success/refusal banner — covers
 *      inline re-renders and SPA confirmations that don't trigger a
 *      full navigation.
 */
export async function waitForCancelOutcome(page: Page): Promise<void> {
  // 1. Drain in-flight cancel POST + navigation promises armed by
  //    clickRequestCancellation. These are the most reliable signal
  //    that Amazon actually received and processed the cancel.
  const inflight =
    (page as unknown as { __cancelInflight?: Array<Promise<unknown>> })
      .__cancelInflight ?? [];
  if (inflight.length > 0) {
    await Promise.allSettled(inflight);
    // Clear so subsequent calls (e.g. retry attempts) re-arm fresh.
    (page as unknown as { __cancelInflight?: Array<Promise<unknown>> })
      .__cancelInflight = undefined;
  }

  // 2. Whatever page we landed on, give it a chance to parse.
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  // 3. Poll for the visible outcome banner — handles inline rerenders.
  //    Default polling is RAF (~16ms); banners typically appear ~50ms
  //    after the response settles, so an explicit `polling: 500` was
  //    making us wait up to 500ms before the first check. Removed.
  await page
    .waitForFunction(
      () => {
        const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
        const refused = /unable to cancel (?:the\s+)?(?:requested|selected|these)?\s*items?/i;
        const ok = /cancellation (?:has been )?(?:requested|submitted|received|successful)|your cancellation request|item(?:s)? (?:has|have) been cancelled|order (?:was|has been) cancelled/i;
        return refused.test(body) || ok.test(body);
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);

  // 4. Final settle — networkidle catches any straggler XHR (Amazon
  //    sometimes fires a tracking beacon AFTER the confirmation
  //    banner renders, and tearing the page down mid-beacon has been
  //    observed to invalidate the cancel server-side). Short timeout
  //    so we don't hang on long-poll connections.
  //
  // TODO(perf-pass-9): the 5s timeout almost always maxes out per pass-9
  // audit because Amazon's telemetry beacons keep firing — net 5s tax
  // per cancel. Pass 9 recommended dropping this entirely on the basis
  // that the response/nav promises drained at step 1 are the load-
  // bearing signal, but the comment above documents a real bug this
  // wait was added to prevent. Decision deferred until we have post-
  // telemetry-fix production data showing whether cancels regress
  // when this is removed/shortened. See pass-9 §1 + pass-18 §2.
  await page
    .waitForLoadState('networkidle', { timeout: 5_000 })
    .catch(() => undefined);
}

/** True when Amazon's "Unable to cancel requested items" refusal banner is visible. */
export async function isCancelRefused(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      return /unable to cancel (?:the\s+)?(?:requested|selected|these)?\s*items?/i.test(
        body,
      );
    })
    .catch(() => false);
}

/** True when Amazon's cancellation-confirmation banner has rendered. */
export async function isCancelConfirmed(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      const re =
        /cancellation (?:has been )?(?:requested|submitted|received|successful)|your cancellation request|item(?:s)? (?:has|have) been cancelled|order (?:was|has been) cancelled/i;
      return re.test(body);
    })
    .catch(() => false);
}

/** Small-sample of the page body — included in failure `detail` strings. */
export async function bodySample(page: Page, max = 500): Promise<string> {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 500);
    })
    .catch(() => '')
    .then((s) => s.slice(0, max));
}
