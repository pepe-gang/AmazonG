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
import { captureDebugSnapshot, isUnpackagedRun, probePageDiag } from "./buyNow.js";

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
        | "bot_challenge"
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
  // Amazon's real default-address IDs are 13-digit timestamps (e.g.
  // "1731738134303"). Earlier code matched `\d{1,4}` and silently
  // fell back to "0" for every account, which only worked by
  // coincidence on accounts whose actual addressId WAS "0" (the
  // Huyen test account). For real accounts the truncated default
  // caused the API to reject the save with no actionable error.
  const addressId =
    /["']?address(?:Id|ID)["']?\s*[:=]\s*["'](\d{1,20})["']/i.exec(html)?.[1] ?? "0";
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
  opts: { profile?: string; correlationId?: string; debugDir?: string } = {},
): Promise<SetAmazonDayResult> {
  const cid = opts.correlationId ?? "setAmazonDay";
  const profile = opts.profile ?? "(unknown)";
  // Gate every diag-only emission on this — captureDebugSnapshot
  // already self-gates, but we want the JSON probes silent on
  // packaged builds too.
  const devOnly = await isUnpackagedRun().catch(() => false);
  try {
    await page.goto(AMAZON_DAY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // ── 1. WAF auto-solve wait ─────────────────────────────────────
    // AWS WAF serves a JS challenge page with empty title + gokuProps
    // global. The page's own challenge.js solves it and reloads —
    // we just need to wait for that. Without this wait we check the
    // DOM mid-challenge and see no manage button.
    const wafState = await waitForWafChallenge(page, cid, profile, devOnly);
    if (wafState === "stuck") {
      // Challenge never resolved within budget — caller will retry
      // next tick; cookie persists in the context so the next try
      // skips the challenge entirely.
      return { ok: false, reason: "bot_challenge" };
    }

    if (devOnly) {
      const landed = page.url();
      const title = await page.title().catch(() => "");
      logger.info(
        "step.setAmazonDay.diag.navigated",
        { profile, landedUrl: landed, title, wafState },
        cid,
      );
    }

    // ── 2. Sign-in redirect ───────────────────────────────────────
    if (/\/ap\/signin/i.test(page.url())) {
      if (devOnly) {
        logger.warn(
          "step.setAmazonDay.diag.sign_in_redirect",
          { profile, url: page.url() },
          cid,
        );
      }
      return { ok: false, reason: "sign_in_required" };
    }

    // ── 3. Auth-state check (CRUCIAL — must precede manage-button
    //      check). A stale Amazon session lets the page render but
    //      with "Hello, sign in" in the nav and NO manage button.
    //      Without this gate, every signed-out profile falsely
    //      reports `not_prime`. The auth cookie (`at-main`/`x-main`)
    //      has shorter TTL than the WAF cookie, so this is the
    //      single most common failure for accounts that haven't
    //      been used recently.
    const navText = await page
      .$eval(
        "#nav-link-accountList-nav-line-1",
        (el) => el.textContent?.trim() ?? "",
      )
      .catch(() => "");
    const signedIn = navText !== "" && !/sign\s*in/i.test(navText);
    if (!signedIn) {
      if (devOnly) {
        logger.warn(
          "step.setAmazonDay.diag.signed_out",
          { profile, navText, url: page.url() },
          cid,
        );
      }
      return { ok: false, reason: "sign_in_required" };
    }

    const manageBtn = await page.$(AMAZON_DAY_SELECTORS.manageButton);
    if (!manageBtn) {
      // Sign-in form on page? Treat as sign-in required.
      if (await page.$(AMAZON_DAY_SELECTORS.signInForm)) {
        if (devOnly) {
          logger.warn(
            "step.setAmazonDay.diag.signin_form_visible",
            { profile, url: page.url() },
            cid,
          );
        }
        return { ok: false, reason: "sign_in_required" };
      }
      // Manage button absent — could be not_prime, could be a wholly
      // different page (Amazon A/B test, layout change, geo redirect).
      // Snapshot the page so we can tell which.
      if (devOnly) {
        const probe = await probePageDiag(page, {
          manageButtonByClass: AMAZON_DAY_SELECTORS.manageButton,
          // Alternate selectors / common Amazon-day signals to spot
          // a layout change vs a genuine not-Prime state.
          anyAmazonDayClassMention: '[class*="amazonDay" i]',
          customerInfoPanel: ".amazonDayProfileCustomerInfo",
          dayPickerContainer: ".dayPickerDesktop",
          mondayId: "#MONDAY",
          // Prime markers — present on a Prime-eligible page even if
          // the manage button selector changed.
          primeBadge: ".a-prime-logo, [class*='prime-logo' i]",
          // Authentication state — last line of evidence the session
          // is alive even if the page is unexpected.
          navAccount: "#nav-link-accountList-nav-line-1",
          navAccountText: "#nav-link-accountList-nav-line-1",
          // If we landed somewhere weird (errors, captcha, robot
          // check) the snapshot will tell us via these headings.
          captchaForm: 'form[action*="validateCaptcha"]',
          robotCheck: ":has-text('robot')",
        }).catch(() => null);
        const navGreet = await page
          .$eval(
            "#nav-link-accountList-nav-line-1",
            (el) => el.textContent?.trim() ?? null,
          )
          .catch(() => null);
        logger.warn(
          "step.setAmazonDay.diag.no_manage_button",
          {
            profile,
            url: page.url(),
            title: await page.title().catch(() => ""),
            navGreet,
            probe,
          },
          cid,
        );
        const snap = await captureDebugSnapshot(
          page,
          opts.debugDir,
          "amazon_day_no_manage_button",
        );
        if (snap) {
          logger.info(
            "step.setAmazonDay.diag.no_manage_button.snapshot",
            { profile, png: snap.pngPath, html: snap.htmlPath },
            cid,
          );
        }
      }
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
    //
    // CRITICAL: Amazon's /amazondayprofile/preference endpoint ALWAYS
    // returns HTTP 200, even for auth/permission failures. The real
    // outcome is in the response body:
    //   - Success → empty body
    //   - Failure → JSON like { statusCode: 401, metadata: "<signin_url>" }
    // Treating `res.status === 200` as success was wrong; we now parse
    // the body and check the inner statusCode field.
    const httpProbe = await page
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
            const text = await res.text();
            return { httpStatus: res.status, text };
          } catch (e) {
            return { httpStatus: -1, text: e instanceof Error ? e.message : String(e) };
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
      .catch(() => ({ httpStatus: -1, text: "evaluate threw" }));

    // Parse the body. Successful save → empty body OR JSON with no
    // statusCode (or statusCode === 200). Failure → JSON with
    // statusCode !== 200 (most commonly 401 = auth required for THIS
    // specific operation, even when the nav says "Hello, <Name>").
    let httpOk = false;
    let httpInnerStatus: number | null = null;
    let httpDetail = "";
    if (httpProbe.httpStatus === 200) {
      const text = (httpProbe.text ?? "").trim();
      if (text === "") {
        httpOk = true;
      } else {
        try {
          const parsed = JSON.parse(text) as { statusCode?: number; metadata?: string };
          httpInnerStatus = typeof parsed.statusCode === "number" ? parsed.statusCode : null;
          httpDetail = parsed.metadata ?? "";
          if (httpInnerStatus === null || httpInnerStatus === 200) {
            httpOk = true;
          }
        } catch {
          // Non-JSON body on 200 — assume success (rare but possible
          // on a gzip-encoding hiccup we saw in curl probing).
          httpOk = true;
        }
      }
    }

    if (httpOk) {
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
      logger.warn(
        "step.setAmazonDay.http.verify_mismatch",
        { profile, after: verified.after, target: targetDay },
        cid,
      );
    } else {
      logger.warn(
        "step.setAmazonDay.http.failed",
        {
          profile,
          httpStatus: httpProbe.httpStatus,
          innerStatus: httpInnerStatus,
          // Slice the detail to avoid leaking a multi-KB redirect URL
          // into every log line.
          detail: httpDetail.slice(0, 200),
        },
        cid,
      );
      // statusCode:401 = Amazon wants the user to re-authenticate
      // for this specific operation (the global session is "fine"
      // but the Amazon-Day-specific token expired). The DOM-click
      // fallback will fail the same way — short-circuit and report
      // a clear reason instead of timing out.
      if (httpInnerStatus === 401) {
        return {
          ok: false,
          reason: "sign_in_required",
          detail: `Amazon returned statusCode 401 on /amazondayprofile/preference (re-sign-in required for this account)`,
          before,
        };
      }
      // Other non-OK statuses (403, 500, etc.) — still try the DOM
      // fallback in case the API endpoint has a different gate than
      // the modal UI.
    }

    // ── DOM-click fallback ───────────────────────────────────────
    const clicked = await runDomClickFallback(page, targetDay, cid, profile);
    if (!clicked.ok) {
      // Capture page state at the moment of failure so we can see
      // what Amazon was showing when Save timed out — the JSON-body
      // parsing above narrows most causes, but DOM-click can still
      // fail with no inner status to inspect (e.g., the modal never
      // opened because the manage button onclick threw, or the
      // popover transitioned to a different state).
      if (devOnly) {
        const snap = await captureDebugSnapshot(
          page,
          opts.debugDir,
          "amazon_day_save_click_failed",
        );
        if (snap) {
          logger.warn(
            "step.setAmazonDay.diag.save_click_failed.snapshot",
            { profile, png: snap.pngPath, html: snap.htmlPath, detail: clicked.detail },
            cid,
          );
        }
      }
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
      .click({ timeout: 10_000 });

    // Wait for the modal to fully attach + render. The Save button
    // exists in the DOM well before it's clickable (the popover does
    // its show animation, then enables the input). Waiting on the
    // popover container's visibility avoids the 5s save_click_failed
    // race we saw on cpnduy / cpnhuy in the 10:02 dispatch.
    await page
      .locator(".a-popover.a-popover-modal")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });

    await page
      .locator(AMAZON_DAY_SELECTORS.dayButtonClickTarget(targetDay))
      .click({ timeout: 10_000 });

    // Now click Save. Generous 15s timeout — the picker also fires a
    // pre-save XHR that briefly disables the button. Without the
    // wait above the click race usually lands during that window.
    await page
      .locator(AMAZON_DAY_SELECTORS.saveClickTarget)
      .click({ timeout: 15_000 });

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

/**
 * Detect + wait for the AWS WAF bot-check challenge page to
 * auto-solve. The challenge page is served by Amazon's edge when
 * the request looks bot-y; it carries a tiny HTML shell with:
 *   <title></title>                        // empty
 *   <div id="challenge-container">
 *   <script>window.gokuProps = { ... }</script>
 *   <script src=".../challenge.js">        // the solver
 *
 * The solver runs `AwsWafIntegration.getToken().then(reload)` and
 * reloads the page with an `aws-waf-token` cookie attached. We just
 * need to wait for that reload to happen, then re-evaluate the
 * landed page.
 *
 * Returns:
 *   "absent"  — no challenge was seen; landed page is the real page
 *   "passed"  — challenge was seen and auto-solved within budget
 *   "stuck"   — challenge was seen but didn't resolve within budget;
 *               caller should bail (cookie now persists in context
 *               so the NEXT navigation in this profile will skip the
 *               challenge entirely — bail + retry is the right move)
 */
async function waitForWafChallenge(
  page: import("playwright").Page,
  cid: string,
  profile: string,
  devOnly: boolean,
): Promise<"absent" | "passed" | "stuck"> {
  const detect = async () => {
    return page
      .evaluate(() => {
        return {
          gokuProps: typeof (window as { gokuProps?: unknown }).gokuProps !== "undefined",
          challengeContainer: !!document.getElementById("challenge-container"),
          // Real Amazon Day page has a non-empty title; WAF shell has "".
          title: document.title,
          // The amazonDayProfileDesktopContainer hydrates AFTER the
          // real page loads — its presence is the strongest "we're
          // through" signal.
          desktopContainer: !!document.querySelector(
            ".amazonDayProfileDesktopContainer",
          ),
        };
      })
      .catch(() => ({
        gokuProps: false,
        challengeContainer: false,
        title: "",
        desktopContainer: false,
      }));
  };

  const initial = await detect();
  const challengeActive =
    initial.gokuProps || initial.challengeContainer || (initial.title === "" && !initial.desktopContainer);

  if (!challengeActive) return "absent";

  if (devOnly) {
    logger.warn(
      "step.setAmazonDay.waf.challenge_seen",
      { profile, initial },
      cid,
    );
  }

  // Poll for up to 15s — the challenge typically solves in 2-5s on a
  // warm context, longer (8-12s) on a cold one.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const state = await detect();
    // We're through when the real page is loaded (desktopContainer
    // present or non-empty title without gokuProps).
    if (state.desktopContainer) {
      if (devOnly) {
        logger.info(
          "step.setAmazonDay.waf.passed",
          { profile, elapsedMs: 15_000 - (deadline - Date.now()) },
          cid,
        );
      }
      return "passed";
    }
    if (!state.gokuProps && state.title !== "") {
      // Non-empty title without challenge markers — likely a sign-in
      // redirect or other page state. Return passed; the caller's
      // subsequent checks (sign-in, manage-button) will sort it out.
      return "passed";
    }
  }

  if (devOnly) {
    logger.warn(
      "step.setAmazonDay.waf.stuck",
      { profile, finalState: await detect() },
      cid,
    );
  }
  return "stuck";
}
