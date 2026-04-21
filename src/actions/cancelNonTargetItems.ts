import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';

const CANCEL_URL = (orderId: string) =>
  `https://www.amazon.com/progress-tracker/package/preship/cancel-items?orderID=${orderId}`;

export type CancelNonTargetResult =
  | { ok: true; cancelled: number; kept: number }
  | { ok: false; reason: string; detail?: string };

/**
 * Cancel every item in a pre-ship order EXCEPT the target (which we
 * want to keep). Used on the TARGET's order in the verify phase of a
 * filler buy — the fillers bundled into the same order as the target
 * get cancelled, leaving just the target item to ship.
 *
 * Identification order for the "keep" item:
 *   1. ASIN link in the row (`a[href*="/dp/${asin}"]`) — cancel page
 *      typically exposes /dp/ product links even though /spc doesn't.
 *   2. Row text startsWith target title prefix — fallback for layouts
 *      that don't put ASIN links next to checkboxes.
 *
 * Returns `ok: true` with the cancel/keep counts on success, or
 * `ok: false` with a reason. Safe to call multiple times — if the
 * non-target items already cancelled, Amazon renders empty cancel page
 * and we return a recognizable "nothing to cancel" error.
 */
export async function cancelNonTargetItems(
  page: Page,
  orderId: string,
  target: { asin: string | null; title: string | null },
  opts: { correlationId?: string } = {},
): Promise<CancelNonTargetResult> {
  const cid = opts.correlationId;
  logger.info(
    'step.cancelNonTargetItems.start',
    { orderId, targetAsin: target.asin, hasTitle: target.title !== null },
    cid,
  );

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

  await page.waitForTimeout(1_500);

  const here = page.url();
  if (!/cancel-items/i.test(here)) {
    return {
      ok: false,
      reason: 'not on cancel-items page after navigation — order likely already cancelled or shipped',
      detail: `url=${here}`,
    };
  }

  // Build a safe title prefix for the in-browser matcher. First ~40
  // characters is usually unique to the product; stripping quotes
  // keeps it safe to embed as a literal.
  const titlePrefix =
    target.title !== null
      ? target.title.replace(/\s+/g, ' ').trim().slice(0, 40).replace(/["'\\]/g, '')
      : null;

  // Check every item checkbox EXCEPT the one whose row represents the
  // target. Done in a single evaluate so we can see the DOM atomically.
  const counts = await page
    .evaluate(
      ({ asin, title }) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const primary = forms.find((f) =>
          /cancel/i.test(f.getAttribute('action') || '') ||
          /cancel/i.test(f.getAttribute('name') || '') ||
          f.querySelector('input[name*="itemId" i], input[name*="orderItem" i]'),
        );
        const scope: ParentNode = primary ?? document;
        const boxes = Array.from(
          scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        );
        let cancelled = 0;
        let kept = 0;

        const rowFor = (cb: HTMLInputElement): Element | null => {
          // Walk up from the checkbox until we hit an ancestor whose
          // innerText is bounded (the item row). 2000 chars ≈ one
          // Amazon cart row with ship date + title + price.
          let el: Element | null = cb.parentElement;
          let depth = 0;
          while (el && depth < 10) {
            const text =
              (el as HTMLElement).innerText ?? el.textContent ?? '';
            if (text.length > 30 && text.length < 2000) return el;
            el = el.parentElement;
            depth++;
          }
          return cb.parentElement;
        };

        const rowIsTarget = (row: Element | null): boolean => {
          if (!row) return false;
          // Try ASIN link match first.
          if (asin) {
            if (row.querySelector(`a[href*="/dp/${asin}"]`)) return true;
            if (row.querySelector(`a[href*="/gp/product/${asin}"]`)) return true;
          }
          // Fallback: visible text startsWith title prefix.
          if (title) {
            const text = (row as HTMLElement).innerText ?? row.textContent ?? '';
            const haystack = text.replace(/\s+/g, ' ').toLowerCase();
            const needle = title.toLowerCase();
            if (needle.length > 5 && haystack.includes(needle)) return true;
          }
          return false;
        };

        for (const cb of boxes) {
          if (cb.disabled) continue;
          if (cb.offsetParent === null && cb.getClientRects().length === 0) continue;
          const row = rowFor(cb);
          if (rowIsTarget(row)) {
            // Keep target — ensure unchecked.
            if (cb.checked) cb.click();
            kept += 1;
            continue;
          }
          // Non-target — ensure checked.
          if (!cb.checked) cb.click();
          cancelled += 1;
        }
        return { cancelled, kept };
      },
      { asin: target.asin, title: titlePrefix },
    )
    .catch(() => ({ cancelled: 0, kept: 0 }));

  if (counts.cancelled === 0) {
    return {
      ok: false,
      reason:
        counts.kept === 0
          ? 'no item checkboxes found on cancel page'
          : 'only target item is cancellable — nothing to cancel',
      detail: `kept=${counts.kept}`,
    };
  }

  if (counts.kept === 0) {
    // We wanted to keep the target but didn't identify it — abort
    // instead of cancelling the target by accident.
    return {
      ok: false,
      reason: 'could not identify target item on cancel page — aborting to avoid cancelling target',
      detail: `cancelled(prospective)=${counts.cancelled}, kept=0, asin=${target.asin}, title=${titlePrefix ?? '(null)'}`,
    };
  }

  // Select a cancellation reason if Amazon requires one (same pattern
  // as cancelFillerOrder).
  await page
    .evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>(
        'select[name*="reason" i], select[id*="reason" i], select[name*="cancelReason" i]',
      );
      if (sel && sel.options.length > 1) {
        let pickIdx = -1;
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i];
          if (!opt) continue;
          const t = (opt.textContent ?? '').trim();
          if (!opt.value || /^(select|choose|--|please)/i.test(t)) continue;
          pickIdx = i;
          break;
        }
        if (pickIdx >= 0) {
          sel.selectedIndex = pickIdx;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const radios = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"][name*="reason" i]',
        ),
      );
      const firstRadio = radios.find(
        (r) => !r.disabled && r.offsetParent !== null,
      );
      if (firstRadio && !firstRadio.checked) firstRadio.click();
    })
    .catch(() => undefined);
  await page.waitForTimeout(500);

  // Click Request Cancellation (same strategy as cancelFillerOrder).
  const submitted = await page
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
          return { clicked: true, via: sel };
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
          return { clicked: true, via: `text:${label}` };
        }
      }
      return { clicked: false };
    })
    .catch(() => ({ clicked: false as const }));

  if (!submitted.clicked) {
    return {
      ok: false,
      reason: 'Request Cancellation submit button not found',
      detail: `cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}`,
    };
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(2_500);

  // Same terminal-error detection as cancelFillerOrder.
  const notCancellable = await page
    .evaluate(() => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      return /unable to cancel (?:the\s+)?(?:requested|selected|these)?\s*items?/i.test(body);
    })
    .catch(() => false);
  if (notCancellable) {
    return {
      ok: false,
      reason: 'Amazon refused: unable to cancel requested items (already processing, shipped, or locked)',
      detail: `url=${page.url()}, cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}`,
    };
  }

  const confirmed = await page
    .evaluate(() => {
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
      const re =
        /cancellation (?:has been )?(?:requested|submitted|received|successful)|your cancellation request|item(?:s)? (?:has|have) been cancelled|order (?:was|has been) cancelled/i;
      return re.test(body);
    })
    .catch(() => false);

  if (!confirmed) {
    const bodySample = await page
      .evaluate(() => {
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        return text.slice(0, 300);
      })
      .catch(() => '');
    return {
      ok: false,
      reason: 'no cancellation confirmation detected after submit',
      detail: `url=${page.url()}, cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}, bodySample="${bodySample}"`,
    };
  }

  logger.info(
    'step.cancelNonTargetItems.ok',
    { orderId, cancelled: counts.cancelled, kept: counts.kept },
    cid,
  );
  return { ok: true, cancelled: counts.cancelled, kept: counts.kept };
}
