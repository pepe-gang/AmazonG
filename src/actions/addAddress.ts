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

const ADDRESS_BOOK_URL = 'https://www.amazon.com/a/addresses';

export type FetchAddressResult =
  | { ok: true; address: BGAddress }
  | { ok: false; reason: string; detail?: string };

/**
 * Parse one Amazon address-book tile's `<li>` lines into a BGAddress.
 * The tile lines look like (recon 2026-05-17):
 *   ["Huyen Nguyen (BG1)", "13132 N.E., AIRP0RT WAY",
 *    "Portland, OR 97230", "United States",
 *    "Phone number: ‪6822405526‬"]
 * Anchors on the "City, ST 12345" line: line 0 is the name, the lines
 * between it and the city line are street1/street2, and the phone is
 * the line carrying a "Phone number:" label. The country line is
 * ignored (BGAddress has no country field). Returns null when the
 * lines carry no recognizable city/state/zip line. Pure — exported
 * for unit testing.
 */
export function parseAddressTileLines(lines: string[]): BGAddress | null {
  // Drop a stray "Default:" marker line if the tile included one.
  const clean = lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^default:?$/i.test(l));
  const cityRe = /^(.+),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/;
  const cityIdx = clean.findIndex((l) => cityRe.test(l));
  // Need a name line before the city line and at least one street line.
  if (cityIdx < 2) return null;
  const cm = clean[cityIdx]!.match(cityRe)!;
  const streetLines = clean.slice(1, cityIdx);
  const phoneLine = clean.find((l) => /phone/i.test(l));
  return {
    fullName: clean[0]!,
    phone: phoneLine ? phoneLine.replace(/\D/g, '') : '',
    street1: streetLines[0]!,
    street2: streetLines[1] ?? null,
    city: cm[1]!.trim(),
    state: cm[2]!.toUpperCase(),
    zip: cm[3]!,
  };
}

/**
 * Scrape the account's Amazon address book (/a/addresses) and return
 * the first SAVED address whose street starts with one of
 * `allowedPrefixes` (the BG house-number prefixes used at checkout).
 *
 * The address-book tile carries the COMPLETE address — including the
 * phone number — unlike order history, which is why this reads the
 * address book. Caller opens the page's session; this navigates it.
 */
export async function fetchAmazonAddress(
  page: Page,
  allowedPrefixes: string[],
  opts: { correlationId?: string } = {},
): Promise<FetchAddressResult> {
  const cid = opts.correlationId;
  if (allowedPrefixes.length === 0) {
    return { ok: false, reason: 'no_allowed_prefixes' };
  }
  await page
    .goto(ADDRESS_BOOK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => undefined);
  const landed = page.url();
  if (!/\/a\/addresses\b/i.test(landed)) {
    return {
      ok: false,
      reason: 'address_book_did_not_load',
      detail: `landed=${landed}`,
    };
  }
  const tilesReady = await page
    .locator('.normal-desktop-address-tile')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!tilesReady) {
    return { ok: false, reason: 'no_saved_addresses' };
  }
  // Pull each tile's <li> lines out as raw text — parsing happens in
  // Node (parseAddressTileLines) so it stays unit-testable.
  const tiles: string[][] = await page
    .evaluate(() => {
      const out: string[][] = [];
      document
        .querySelectorAll('.normal-desktop-address-tile')
        .forEach((tile) => {
          const lines: string[] = [];
          tile.querySelectorAll('li').forEach((li) => {
            const t = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t) lines.push(t);
          });
          if (lines.length > 0) out.push(lines);
        });
      return out;
    })
    .catch(() => [] as string[][]);

  const prefixRe = new RegExp('\\b(' + allowedPrefixes.join('|') + ')\\b');
  for (const lines of tiles) {
    const addr = parseAddressTileLines(lines);
    if (addr && prefixRe.test(addr.street1)) {
      logger.info(
        'step.fetchAddress.matched',
        { street1: addr.street1, hasPhone: addr.phone.length > 0 },
        cid,
      );
      return { ok: true, address: addr };
    }
  }
  logger.info(
    'step.fetchAddress.noMatch',
    { tilesScanned: tiles.length, allowedPrefixes },
    cid,
  );
  return { ok: false, reason: 'no_matching_address' };
}
