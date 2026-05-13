import type { Page } from 'playwright';
import { logger } from '../shared/logger.js';
import type { BGAddress } from '../shared/types.js';

const ADD_ADDRESS_URL = 'https://www.amazon.com/a/addresses/add';

/** Amazon's add-address form lives at /a/addresses/add. All fields are
 *  in a single <form id="address-ui-address-form"> that POSTs to itself.
 *  Selectors captured live 2026-05-13 — Amazon uses the same
 *  `address-ui-widgets-*` namespace across both the standalone
 *  account-management page and the in-/spc add-address modal, so this
 *  action is reusable for the in-checkout auto-recovery path too. */
const FIELDS = {
  country: 'select[name="address-ui-widgets-countryCode"]',
  fullName: 'input[name="address-ui-widgets-enterAddressFullName"]',
  phone: 'input[name="address-ui-widgets-enterAddressPhoneNumber"]',
  street1: 'input[name="address-ui-widgets-enterAddressLine1"]',
  street2: 'input[name="address-ui-widgets-enterAddressLine2"]',
  city: 'input[name="address-ui-widgets-enterAddressCity"]',
  state: 'select[name="address-ui-widgets-enterAddressStateOrRegion"]',
  zip: 'input[name="address-ui-widgets-enterAddressPostalCode"]',
} as const;

const FORM_ID = 'address-ui-address-form';

export type AddAddressResult =
  | { ok: true; landedUrl: string }
  | { ok: false; reason: string; detail?: string };

/**
 * Drive Amazon's /a/addresses/add form: fill the BG address fields and
 * submit. Returns `ok: true` when the post-submit URL leaves the /add
 * page (Amazon redirects back to /a/addresses on success) or `ok: false`
 * with a recognizable reason otherwise.
 *
 * Caller is responsible for opening the page; this function assumes a
 * Playwright `Page` with an active Amazon session. Does NOT navigate
 * back away after success — caller can close the tab or reuse.
 */
export async function addAmazonAddress(
  page: Page,
  addr: BGAddress,
  opts: { correlationId?: string } = {},
): Promise<AddAddressResult> {
  const cid = opts.correlationId;
  logger.info('step.addAddress.start', { fullName: addr.fullName }, cid);

  // 1. Navigate to /a/addresses/add. Same redirect-tolerance pattern as
  //    elsewhere — Amazon occasionally races past 'commit'. We catch the
  //    error and decide via the landed URL.
  await page
    .goto(ADD_ADDRESS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => undefined);
  const landed = page.url();
  if (!/\/a\/addresses\/add\b/i.test(landed)) {
    logger.warn('step.addAddress.nav.fail', { landed }, cid);
    return { ok: false, reason: 'add_page_did_not_load', detail: `landed=${landed}` };
  }

  // 2. Confirm the form rendered (some account states show a different
  //    page — e.g. challenge prompts — and we should bail rather than
  //    fight an empty form).
  const formReady = await page
    .locator(FIELDS.fullName)
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!formReady) {
    return { ok: false, reason: 'form_not_rendered' };
  }

  // 3. Fill every field. Country defaults to US server-side; we still
  //    select it explicitly so a profile that defaults to a different
  //    region gets normalized. State is a <select>, not a free text —
  //    use selectOption with the two-letter code (`OR`, `CA`, ...).
  try {
    await page.selectOption(FIELDS.country, 'US');
    await page.fill(FIELDS.fullName, addr.fullName);
    await page.fill(FIELDS.phone, addr.phone);
    await page.fill(FIELDS.street1, addr.street1);
    if (addr.street2) await page.fill(FIELDS.street2, addr.street2);
    await page.fill(FIELDS.city, addr.city);
    await page.selectOption(FIELDS.state, addr.state);
    await page.fill(FIELDS.zip, addr.zip);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('step.addAddress.fill.fail', { detail }, cid);
    return { ok: false, reason: 'fill_failed', detail };
  }

  // 4. Submit. The form has multiple <input type="submit"> rows (one is
  //    a hidden error-recovery button); we drive the real submit by
  //    calling form.requestSubmit() rather than guessing which is the
  //    "Use this address" button. requestSubmit fires native validation
  //    + lets Amazon's JS-attached submit handlers run.
  const submitted = await page
    .evaluate((formId) => {
      const f = document.getElementById(formId) as HTMLFormElement | null;
      if (!f) return false;
      f.requestSubmit();
      return true;
    }, FORM_ID)
    .catch(() => false);
  if (!submitted) {
    return { ok: false, reason: 'submit_failed' };
  }

  // 5. Wait for the post-submit URL change. Success: Amazon redirects
  //    to /a/addresses (the list) or to a chooser. Failure: stays on
  //    /a/addresses/add with a validation error inline.
  await page
    .waitForURL((url) => !/\/a\/addresses\/add\b/i.test(url.toString()), { timeout: 15_000 })
    .catch(() => undefined);

  const post = page.url();
  if (/\/a\/addresses\/add\b/i.test(post)) {
    // Still on the form — likely a validation error rendered inline.
    // Try to surface the first visible error message so the caller has
    // something better than a generic "submit didn't take".
    const errText = await page
      .evaluate(() => {
        const errs = document.querySelectorAll(
          '.a-alert-error, [class*="error-message"], .a-form-error',
        );
        for (const el of Array.from(errs)) {
          const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t) return t.slice(0, 160);
        }
        return null;
      })
      .catch(() => null);
    logger.warn('step.addAddress.submit.stayed', { errText }, cid);
    return {
      ok: false,
      reason: 'validation_error',
      detail: errText ?? 'form did not navigate after submit',
    };
  }

  logger.info('step.addAddress.ok', { landedUrl: post }, cid);
  return { ok: true, landedUrl: post };
}
