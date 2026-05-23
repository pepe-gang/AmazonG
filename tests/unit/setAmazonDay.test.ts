/**
 * Unit tests for the new Amazon Day setter (researched live 2026-05-23
 * against the signed-in Manage Your Amazon Day page). The bulk of the
 * logic in setAmazonDayForProfile requires a Playwright page; these
 * tests cover the pure parsers that derive the payload + verify
 * current state from rendered HTML.
 *
 * Fixture: tests/fixtures/amazon-day-page.json — captured live
 * via Playwright MCP (only the .amazonDayProfileDesktopContainer
 * region, ~2.6KB).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractAmazonDayPayload,
  readCurrentDayFromHtml,
  AMAZON_DAY_SELECTORS,
} from "../../src/actions/setAmazonDay.js";
import { mapResult } from "../../src/workflows/accountConfigOrchestrator.js";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/amazon-day-page.json"), "utf8"),
) as { wrapperHtml: string };

describe("extractAmazonDayPayload", () => {
  it("pulls customerId / regionId / addressId / marketplaceId from page HTML", () => {
    // Mimic the actual page's JSON-embed style (single-quote vars +
    // mixed casing — Amazon's templates do both).
    const html = `
      <html><body>
        <script>var config = { marketplaceId: 'ATVPDKIKX0DER', customerID: "A1J7ZTF6RVFRBQ", regionId: "97230", addressId: "0" };</script>
      </body></html>`;
    expect(extractAmazonDayPayload(html)).toEqual({
      customerId: "A1J7ZTF6RVFRBQ",
      regionId: "97230",
      addressId: "0",
      marketplaceId: "ATVPDKIKX0DER",
    });
  });

  it("returns nulls for missing required fields; defaults for marketplaceId / addressId", () => {
    const html = `<div>nothing useful here</div>`;
    expect(extractAmazonDayPayload(html)).toEqual({
      customerId: null,
      regionId: null,
      addressId: "0",
      marketplaceId: "ATVPDKIKX0DER",
    });
  });

  it("tolerates the mixed double/single-quote style of the live page", () => {
    // Two of the four hits the live page produced, verbatim.
    const html = `
      "marketplaceID":"ATVPDKIKX0DER"
      customerId: 'A1J7ZTF6RVFRBQ'
      "regionId": "97230"
      "addressId": "0"
    `;
    expect(extractAmazonDayPayload(html)).toEqual({
      customerId: "A1J7ZTF6RVFRBQ",
      regionId: "97230",
      addressId: "0",
      marketplaceId: "ATVPDKIKX0DER",
    });
  });
});

describe("readCurrentDayFromHtml (saved fixture)", () => {
  it("reads the displayed day from the customer-info panel", () => {
    // The captured fixture was taken with Thursday set (we restored
    // to Wed after capture). The fixture still shows Thursday.
    expect(readCurrentDayFromHtml(FIXTURE.wrapperHtml)).toBe("Thursday");
  });

  it("returns null when the customer-info panel is absent", () => {
    expect(readCurrentDayFromHtml("<html><body></body></html>")).toBeNull();
  });

  it("doesn't false-match a day name outside the customer-info container", () => {
    const html = `
      <div>This week's review covered Wednesday's results.</div>
      <p>Saturday delivery slots are full.</p>
    `;
    expect(readCurrentDayFromHtml(html)).toBeNull();
  });
});

describe("mapResult (orchestrator → BG)", () => {
  it("maps a successful change → 'ok' with before/after", () => {
    expect(
      mapResult({
        ok: true,
        via: "http",
        before: "Friday",
        after: "Wednesday",
        noop: false,
      }),
    ).toEqual({ status: "ok", before: "Friday", after: "Wednesday" });
  });

  it("maps an already-correct day → 'noop_already_set'", () => {
    expect(
      mapResult({
        ok: true,
        via: "http",
        before: "Wednesday",
        after: "Wednesday",
        noop: true,
      }),
    ).toEqual({ status: "noop_already_set", before: "Wednesday", after: "Wednesday" });
  });

  it("maps not-Prime → 'skipped' (per-account state, not a retry condition)", () => {
    expect(
      mapResult({ ok: false, reason: "not_prime" }),
    ).toMatchObject({ status: "skipped", reason: "not_prime" });
  });

  it("maps sign-in-required → 'skipped'", () => {
    expect(
      mapResult({ ok: false, reason: "sign_in_required" }),
    ).toMatchObject({ status: "skipped", reason: "sign_in_required" });
  });

  it("maps HTTP / DOM failures → 'failed' with reason + detail", () => {
    expect(
      mapResult({
        ok: false,
        reason: "http_error",
        detail: "status=502",
      }),
    ).toEqual({
      status: "failed",
      reason: "http_error",
      detail: "status=502",
      before: null,
    });
  });

  it("maps verify_mismatch → 'failed' (the save call succeeded but page disagreed)", () => {
    expect(
      mapResult({
        ok: false,
        reason: "verify_mismatch",
        detail: "expected Wednesday, page shows Tuesday",
      }),
    ).toMatchObject({ status: "failed", reason: "verify_mismatch" });
  });
});

describe("AMAZON_DAY_SELECTORS", () => {
  it("matches the live DOM identifiers captured 2026-05-23", () => {
    // Snapshot test — these strings drive the action's
    // page.locator() calls. If any of them change because Amazon
    // ships a new template, this test changes too so the diff is
    // a single obvious surface.
    expect(AMAZON_DAY_SELECTORS.manageButton).toBe("button.chooseAmazonDayButton");
    expect(AMAZON_DAY_SELECTORS.saveClickTarget).toBe(
      'input[aria-labelledby="saveAmazonDayProfile-announce"]',
    );
    expect(AMAZON_DAY_SELECTORS.dayButtonClickTarget("WEDNESDAY")).toBe(
      'button[name="WEDNESDAY"]',
    );
    expect(AMAZON_DAY_SELECTORS.dayButtonWrapper("MONDAY")).toBe("#MONDAY");
    expect(AMAZON_DAY_SELECTORS.currentDayLabel).toBe(
      ".amazonDayProfileCustomerInfo span.a-size-large.a-text-bold",
    );
  });
});
