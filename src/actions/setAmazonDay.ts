/**
 * Set the account-level "Amazon Day" delivery preference on
 * www.amazon.com/b?node=17928921011 (the Manage Your Amazon Day page).
 *
 * Strategy (researched live 2026-05-23 against the signed-in page):
 *   1. Navigate to the page using the existing authenticated session.
 *   2. Detect not-signed-in (Amazon redirected us to /ap/signin) and
 *      not-Prime (the "Manage Your Amazon Day" button is absent) cases
 *      early and bail with a structured reason.
 *   3. Scrape the four payload values that the Save button POSTs:
 *      `customerId`, `regionId`, `addressId`, `marketplaceId` —
 *      all visible in the page HTML in multiple places, so a simple
 *      regex over the rendered doc is reliable.
 *   4. Read the currently-displayed day from
 *      `.amazonDayProfileCustomerInfo span.a-size-large.a-text-bold`
 *      so the result includes "before"/"after" for the dashboard.
 *   5. POST the preference directly to
 *      `/amazondayprofile/preference` (returns 200 on success). The
 *      `page.evaluate` shell sends the request from the browser
 *      context so the existing session cookies attach automatically.
 *   6. If the HTTP path returns non-200, fall back to the DOM-click
 *      sequence (open modal → click target day → click Save).
 *   7. Verify the change persisted by reloading the page and reading
 *      the customer-info day text again.
 *
 * Never throws — every error is captured into a structured result so
 * the orchestrator can report per-account state to BG without
 * crashing the fan-out.
 */

import type { Page } from "playwright";
import { logger } from "../shared/logger.js";

export type DayOfWeek =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

const DAY_LONG: Record<DayOfWeek, string> = {
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};

export type SetAmazonDayResult =
  | {
      ok: true;
      via: "http" | "dom";
      before: string | null;
      after: string;
      noop: boolean;
    }
  | {
      ok: false;
      reason:
        | "not_prime"
        | "sign_in_required"
        | "no_payload"
        | "http_error"
        | "save_click_failed"
        | "verify_mismatch"
        | "unexpected_error";
      detail?: string;
      before?: string | null;
    };

const AMAZON_DAY_URL =
  "https://www.amazon.com/b?node=17928921011";

const AMAZON_DAY_API =
  "https://www.amazon.com/amazondayprofile/preference";

/** Selectors verified live against the rendered Amazon Day page. */
export const AMAZON_DAY_SELECTORS = {
  manageButton: "button.chooseAmazonDayButton",
  signInForm: "input#ap_email",
  currentDayLabel: ".amazonDayProfileCustomerInfo span.a-size-large.a-text-bold",
  // Modal day buttons. The clickable <button> uses name="<DAY>"; the
  // wrapping <span> uses id="<DAY>". Use the wrapper id to detect
  // selection state (it gets the `a-button-selected` class).
  dayButtonClickTarget: (day: DayOfWeek) => `button[name="${day}"]`,
  dayButtonWrapper: (day: DayOfWeek) => `#${day}`,
  saveClickTarget: 'input[aria-labelledby="saveAmazonDayProfile-announce"]',
} as const;

/**
 * Pure parser — pulled out so unit tests can hit it against the
 * saved tests/fixtures/amazon-day-page.json HTML without spinning
 * up Playwright.
 */
export function extractAmazonDayPayload(html: string): {
  customerId: string | null;
  regionId: string | null;
  addressId: string;
  marketplaceId: string;
} {
  // The page emits these in 4+ places per the live capture, with both
  //   JSON style: "customerId":"A1J..."
  //   JS object: customerId: "A1J..."
  //   and mixed casing (customerId / customerID).
  // The regexes make the surrounding quotes optional and the case
  // suffix tolerant. The VALUE quotes stay required so we don't
  // catch a number-only context match.
  const customerId =
    /["']?customer(?:Id|ID)["']?\s*[:=]\s*["']([A-Z0-9]{12,16})["']/i.exec(html)?.[1] ??
    null;
  const regionId =
    /["']?region(?:Id|ID)["']?\s*[:=]\s*["'](\d{4,6})["']/i.exec(html)?.[1] ?? null;
  const addressId =
    /["']?address(?:Id|ID)["']?\s*[:=]\s*["'](\d{1,4})["']/i.exec(html)?.[1] ?? "0";
  const marketplaceId =
    /["']?marketplace(?:Id|ID)["']?\s*[:=]\s*["'](ATVPDKIKX0DER)["']/i.exec(html)?.[1] ??
    "ATVPDKIKX0DER";
  return { customerId, regionId, addressId, marketplaceId };
}

/**
 * Pure parser — current Amazon Day from the customer-info panel.
 * Returns the long day name ("Wednesday") or null when absent.
 */
export function readCurrentDayFromHtml(html: string): string | null {
  // Anchored at the customer-info container class so we don't pick up
  // unrelated "Wednesday" mentions elsewhere on the page.
  const m =
    /class=["'][^"']*amazonDayProfileCustomerInfo[^"']*["'][\s\S]*?<span[^>]+a-size-large[^"']*a-text-bold[^"']*["'][^>]*>\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*<\/span>/i.exec(
      html,
    );
  return m?.[1] ?? null;
}

/**
 * Run the dispatch for a single signed-in Amazon profile.
 *
 * Caller is expected to:
 *  - have already navigated `page` away from any modal or interstitial
 *    that would block /b?node=...
 *  - own page lifecycle (close it after we return).
 */
export async function setAmazonDayForProfile(
  page: Page,
  targetDay: DayOfWeek,
  opts: { profile?: string; correlationId?: string } = {},
): Promise<SetAmazonDayResult> {
  const cid = opts.correlationId ?? "setAmazonDay";
  const profile = opts.profile ?? "(unknown)";
  try {
    await page.goto(AMAZON_DAY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Detect sign-in redirect (Amazon will land us at /ap/signin if the
    // session expired between the worker's session-restore and now).
    if (/\/ap\/signin/i.test(page.url())) {
      return { ok: false, reason: "sign_in_required" };
    }

    const manageBtn = await page.$(AMAZON_DAY_SELECTORS.manageButton);
    if (!manageBtn) {
      // Sign-in form on page? Treat as sign-in required.
      if (await page.$(AMAZON_DAY_SELECTORS.signInForm)) {
        return { ok: false, reason: "sign_in_required" };
      }
      // Manage button absent on a fully-rendered page = not Prime.
      return { ok: false, reason: "not_prime" };
    }

    const html = await page.content();
    const payload = extractAmazonDayPayload(html);
    if (!payload.customerId || !payload.regionId) {
      return {
        ok: false,
        reason: "no_payload",
        detail: `missing customerId=${!!payload.customerId} regionId=${!!payload.regionId}`,
      };
    }
    const before = readCurrentDayFromHtml(html);

    logger.info(
      "step.setAmazonDay.start",
      { profile, targetDay, before, payload: { customerId: payload.customerId.slice(0, 4) + "…", regionId: payload.regionId } },
      cid,
    );

    // ── HTTP-first ───────────────────────────────────────────────
    const httpStatus = await page
      .evaluate(
        async ({ url, body }) => {
          try {
            const res = await fetch(url, {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "x-requested-with": "XMLHttpRequest",
              },
              body: JSON.stringify(body),
            });
            return res.status;
          } catch (e) {
            return -1;
          }
        },
        {
          url: AMAZON_DAY_API,
          body: {
            customerId: payload.customerId,
            addressId: payload.addressId,
            marketplaceId: payload.marketplaceId,
            regionId: payload.regionId,
            countryCode: "US",
            preferences: [targetDay],
            isPreferenceUpdated: true,
            isShipOptionDefaultingUpdated: true,
          },
        },
      )
      .catch(() => -1);

    if (httpStatus === 200) {
      const verified = await verifyAfterReload(page, targetDay, cid, profile);
      if (verified.ok) {
        return {
          ok: true,
          via: "http",
          before,
          after: verified.after,
          noop: before === DAY_LONG[targetDay],
        };
      }
      // HTTP returned 200 but page still shows wrong day → retry via
      // DOM-click (rare; covers eventual-consistency in Amazon's
      // backend or a partial cache hit).
      logger.warn(
        "step.setAmazonDay.http.verify_mismatch",
        { profile, after: verified.after, target: targetDay },
        cid,
      );
    } else {
      logger.warn(
        "step.setAmazonDay.http.non_200",
        { profile, httpStatus },
        cid,
      );
    }

    // ── DOM-click fallback ───────────────────────────────────────
    const clicked = await runDomClickFallback(page, targetDay, cid, profile);
    if (!clicked.ok) {
      return {
        ok: false,
        reason: "save_click_failed",
        detail: clicked.detail,
        before,
      };
    }
    const verifiedAfterClick = await verifyAfterReload(page, targetDay, cid, profile);
    if (!verifiedAfterClick.ok) {
      return {
        ok: false,
        reason: "verify_mismatch",
        detail: `target=${DAY_LONG[targetDay]} actual=${verifiedAfterClick.after}`,
        before,
      };
    }
    return {
      ok: true,
      via: "dom",
      before,
      after: verifiedAfterClick.after,
      noop: before === DAY_LONG[targetDay],
    };
  } catch (err) {
    return {
      ok: false,
      reason: "unexpected_error",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function runDomClickFallback(
  page: Page,
  targetDay: DayOfWeek,
  cid: string,
  profile: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await page
      .locator(AMAZON_DAY_SELECTORS.manageButton)
      .click({ timeout: 5_000 });
    await page
      .locator(AMAZON_DAY_SELECTORS.dayButtonClickTarget(targetDay))
      .click({ timeout: 5_000 });
    await page
      .locator(AMAZON_DAY_SELECTORS.saveClickTarget)
      .click({ timeout: 5_000 });
    // Amazon's modal closes async after Save; give it ~1s so the next
    // verify-reload sees the persisted state.
    await page.waitForTimeout(1_000);
    return { ok: true };
  } catch (err) {
    logger.warn(
      "step.setAmazonDay.dom.click_failed",
      { profile, err: err instanceof Error ? err.message : String(err) },
      cid,
    );
    return {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function verifyAfterReload(
  page: Page,
  targetDay: DayOfWeek,
  cid: string,
  profile: string,
): Promise<{ ok: true; after: string } | { ok: false; after: string }> {
  await page
    .goto(AMAZON_DAY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => undefined);
  const after = await page
    .locator(AMAZON_DAY_SELECTORS.currentDayLabel)
    .first()
    .textContent({ timeout: 5_000 })
    .then((t) => t?.trim() ?? "")
    .catch(() => "");
  const expected = DAY_LONG[targetDay];
  if (after === expected) return { ok: true, after };
  logger.warn(
    "step.setAmazonDay.verify_mismatch",
    { profile, expected, actual: after },
    cid,
  );
  return { ok: false, after };
}
