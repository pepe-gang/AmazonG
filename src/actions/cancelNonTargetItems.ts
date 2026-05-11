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

  // Select-all-then-uncheck-target. The legacy "walk up from each
  // checkbox to find its row" approach over-reaches on the Chewbacca
  // cancel-items layout: the walker grabs an ancestor that contains the
  // target ASIN's /dp/ link anywhere inside, which causes sibling items'
  // checkboxes to be wrongly classified as target → skipped → Amazon
  // rejects the partial cancel (bundle constraint: all bundle items
  // must cancel together). Live-tested 2026-05-11 on order
  // 112-3920218-6945066: the new approach succeeds where the legacy one
  // failed with `Unable to cancel requested items: All discounted
  // bundle items must be canceled together`.
  const counts = await page
    .evaluate(
      ({ asin, title }) => {
        const isSelectAllCb = (cb: HTMLInputElement): boolean => {
          const lbl = cb.id ? document.querySelector(`label[for="${cb.id}"]`) : null;
          return /select all/i.test((lbl?.textContent ?? '').trim());
        };

        // Walk up from a starting element looking for the smallest
        // ancestor scope containing exactly one per-item checkbox.
        // That's the target's row.
        const findUniqueCbInAncestors = (start: Element | null): HTMLInputElement | null => {
          for (let cur = start, d = 0; d < 8 && cur; cur = cur.parentElement, d++) {
            const cbs = Array.from(
              cur.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
            ).filter((cb) => !isSelectAllCb(cb));
            if (cbs.length === 1) return cbs[0] ?? null;
          }
          return null;
        };

        // Identify the SINGLE target checkbox. Refuse to proceed if we
        // can't, to avoid cancelling the target by mistake.
        const findTargetCheckbox = (): HTMLInputElement | null => {
          // Strategy A: /dp/<asin> or /gp/product/<asin> link.
          if (asin) {
            const link =
              document.querySelector<HTMLAnchorElement>(`a[href*="/dp/${asin}"]`) ??
              document.querySelector<HTMLAnchorElement>(`a[href*="/gp/product/${asin}"]`);
            const cb = findUniqueCbInAncestors(link);
            if (cb) return cb;
          }
          // Strategy B: title-prefix text-node match.
          if (title && title.length > 5) {
            const needle = title.toLowerCase();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const txt = ((n as Text).textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
              if (txt.length > 5 && txt.startsWith(needle)) {
                const cb = findUniqueCbInAncestors(n.parentElement);
                if (cb) return cb;
              }
            }
          }
          return null;
        };

        const targetCb = findTargetCheckbox();

        // Collect every per-item checkbox (exclude select-all).
        const forms = Array.from(document.querySelectorAll('form'));
        const primary = forms.find((f) =>
          /cancel/i.test(f.getAttribute('action') || '') ||
          /cancel/i.test(f.getAttribute('name') || '') ||
          f.querySelector('input[name*="itemId" i], input[name*="orderItem" i]'),
        );
        const scope: ParentNode = primary ?? document;
        const allBoxes = Array.from(
          scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        ).filter((cb) => !isSelectAllCb(cb));

        let cancelled = 0;
        let kept = 0;
        for (const cb of allBoxes) {
          if (cb.disabled) continue;
          if (cb.offsetParent === null && cb.getClientRects().length === 0) continue;
          if (cb === targetCb) {
            if (cb.checked) cb.click();
            kept += 1;
            continue;
          }
          if (!cb.checked) cb.click();
          cancelled += 1;
        }
        return { cancelled, kept, targetFound: targetCb !== null };
      },
      { asin: target.asin, title: titlePrefix },
    )
    .catch(() => ({ cancelled: 0, kept: 0, targetFound: false }));

  if (!counts.targetFound) {
    return {
      ok: false,
      reason: 'could not identify target item on cancel page — aborting to avoid cancelling target',
      detail: `asin=${target.asin}, title=${titlePrefix ?? '(null)'}`,
    };
  }

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
  // Wait until the submit button actually enables instead of guessing
  // 500ms. Same fix as cancelFillerOrder.ts post-reason-pick.
  await page
    .waitForFunction(
      () => {
        const submit = document.querySelector(
          'input[name*="cancel" i][type="submit"]:not([disabled]), button[name*="cancel" i]:not([disabled])',
        );
        return !!submit;
      },
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => undefined);

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
