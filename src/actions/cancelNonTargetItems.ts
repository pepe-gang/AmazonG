import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
import {
  bodySample,
  clickRequestCancellation,
  isCancelConfirmed,
  isCancelPending,
  isCancelRefused,
  openCancelPage,
  waitForCancelOutcome,
} from './cancelForm.js';

export type CancelNonTargetResult =
  | { ok: true; cancelled: number; kept: number }
  | {
      ok: false;
      reason: string;
      detail?: string;
      /**
       * Machine-readable classification for the failure. Currently only
       * `'target_absent_from_cancel_page'` is set — fires when the
       * cancel page doesn't surface the target's checkbox at all,
       * which is the canonical signal that the target item has been
       * cancelled (by Amazon or by the user) while sibling fillers in
       * the same order are still active. Unset on other failures.
       */
      code?: 'target_absent_from_cancel_page';
    };

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

  // Locate the target's checkbox first via /dp/<asin> link (or title
  // text-node fallback), then check every other visible checkbox.
  // Refuse to proceed if the target can't be uniquely identified — a
  // wider "is this row the target?" walk over-reaches on Chewbacca's
  // cancel-items page and triggers Amazon's bundle-cancel rejection
  // (`All discounted bundle items must be canceled together`).
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
      code: 'target_absent_from_cancel_page',
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
      code: 'target_absent_from_cancel_page',
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

  // Amazon's "Attempting to cancel requested items / We'll email you
  // when there's an update" banner — the request was accepted into
  // their async pipeline but hasn't actually cancelled yet. We treat
  // this as TERMINAL (don't retry the click — Amazon will keep
  // showing the same banner until the async decision lands) but NOT
  // as cleaned: the "Uncancelled filler orders" warning stays visible
  // until a later verify pass re-reads the order and confirms the
  // filler is actually gone. Specific reason string so
  // isTerminalCancelReason in pollAndScrape.ts recognizes it.
  if (await isCancelPending(page)) {
    return {
      ok: false,
      reason:
        'pending_amazon_decision: Amazon accepted the cancel request but is still processing — will reverify later',
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
