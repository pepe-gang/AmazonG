import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
import {
  bodySample,
  clickRequestCancellation,
  isCancelConfirmed,
  isCancelRefused,
  openCancelPage,
  waitForCancelOutcome,
} from './cancelForm.js';

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

  const opened = await openCancelPage(page, orderId);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason, ...(opened.detail ? { detail: opened.detail } : {}) };
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

  const submitted = await clickRequestCancellation(page);
  if (!submitted.clicked) {
    return {
      ok: false,
      reason: 'Request Cancellation submit button not found',
      detail: `cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}`,
    };
  }

  // Poll for success/refusal banner rather than sleeping a fixed
  // interval — Amazon's confirmation widget often spins for 5-10s
  // after submit before rendering, and a bare sleep was too short.
  await waitForCancelOutcome(page);

  if (await isCancelRefused(page)) {
    return {
      ok: false,
      reason:
        'Amazon refused: unable to cancel requested items (already processing, shipped, or locked)',
      detail: `url=${page.url()}, cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}`,
    };
  }

  if (!(await isCancelConfirmed(page))) {
    const sample = await bodySample(page, 300);
    return {
      ok: false,
      reason: 'no cancellation confirmation detected after submit',
      detail: `url=${page.url()}, cancelled(prospective)=${counts.cancelled}, kept=${counts.kept}, bodySample="${sample}"`,
    };
  }

  logger.info(
    'step.cancelNonTargetItems.ok',
    { orderId, cancelled: counts.cancelled, kept: counts.kept },
    cid,
  );
  return { ok: true, cancelled: counts.cancelled, kept: counts.kept };
}
