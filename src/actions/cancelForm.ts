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
    await page.goto(CANCEL_URL(orderId), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'failed to load cancel page',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Give the cancel form's React/a-declarative bits time to hydrate.
  await page.waitForTimeout(1_500);

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
 */
export async function clickRequestCancellation(
  page: Page,
): Promise<SubmittedResult> {
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
 * After clicking submit, wait up to 15s for Amazon to either confirm
 * the cancellation OR surface its "Unable to cancel requested items"
 * refusal banner. Returns early as soon as either outcome is
 * detectable. Best-effort — silently continues if the poll times out.
 */
export async function waitForCancelOutcome(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page
    .waitForFunction(
      () => {
        const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
        const refused = /unable to cancel (?:the\s+)?(?:requested|selected|these)?\s*items?/i;
        const ok = /cancellation (?:has been )?(?:requested|submitted|received|successful)|your cancellation request|item(?:s)? (?:has|have) been cancelled|order (?:was|has been) cancelled/i;
        return refused.test(body) || ok.test(body);
      },
      undefined,
      { timeout: 15_000, polling: 500 },
    )
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
