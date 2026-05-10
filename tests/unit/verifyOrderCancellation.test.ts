import { describe, it, expect } from "vitest";

/**
 * Regression coverage for the cancellation-detection regex in
 * src/actions/verifyOrder.ts.
 *
 * Real-world bug context (2026-05-09): the original regex anchored on
 * `data-component="cancelled"` and required "This order has been
 * cancelled" within the same div's first 3000 chars. On the live
 * order-details page, the cancelled div is rendered EMPTY and the
 * cancellation banner lives in a SEPARATE `data-component=
 * "cancelledOrderBanner"` div. As a result, every cancelled order
 * verified as "active" and stayed in the Pending bucket on AmazonG.
 * Verified against `/Users/jack/Downloads/cancalled.html` (real
 * capture, orderId 111-1469172-3176235).
 *
 * The regex must:
 *   - DETECT both the new (`cancelledOrderBanner`) and legacy
 *     (`cancelled` with inline copy) layout variants.
 *   - NOT false-positive on active orders that mention the word
 *     "cancel" in unrelated places (e.g. "Cancel" buttons on
 *     in-flight orders, Returns/Cancellations help links).
 */
const CANCELLED_RE =
  /<div[^>]+data-component=["'](?:cancelledOrderBanner|cancelled)["'][^>]*>[\s\S]{0,3000}?This order has been cancell?ed/i;

describe("verifyOrder cancellation detection regex", () => {
  it("matches the modern cancelledOrderBanner layout", () => {
    // Mirrors the structure observed in cancalled.html: the
    // `cancelled` div is empty, the actual banner is in
    // `cancelledOrderBanner` with the alert h4 inside.
    const html = `
      <div class="" data-component="cancelled"></div>
      <div class="" data-component="cancelledOrderBanner">
        <div class="a-box a-alert a-alert-info">
          <div class="a-box-inner a-alert-container">
            <h4 class="a-alert-heading">This order has been cancelled.</h4>
          </div>
        </div>
      </div>
    `;
    expect(CANCELLED_RE.test(html)).toBe(true);
  });

  it("matches the legacy `cancelled` div layout (text inline)", () => {
    // Some older A/B variants put the copy inside the cancelled div.
    // Keep matching them for safety.
    const html = `
      <div class="" data-component="cancelled">
        <h4>This order has been cancelled.</h4>
      </div>
    `;
    expect(CANCELLED_RE.test(html)).toBe(true);
  });

  it("does NOT match an active order that mentions cancellation in unrelated places", () => {
    // Active order page might show: "Cancel items" link, returns
    // help text, etc. None of those should be inside a cancellation
    // data-component.
    const html = `
      <div data-component="purchasedItems">
        <a href="/progress-tracker/cancel-items">Cancel items</a>
        <p>Need to cancel? Visit our help center.</p>
      </div>
      <div data-component="orderTotal">$299.00</div>
    `;
    expect(CANCELLED_RE.test(html)).toBe(false);
  });

  it("does NOT match when only the data-component marker is present without the confirmation text", () => {
    // Defensive: empty `cancelled` div alone isn't enough. The text
    // is the safety check that the page actually carries the
    // cancellation announcement.
    const html = `<div data-component="cancelled"></div>`;
    expect(CANCELLED_RE.test(html)).toBe(false);
  });

  it("matches the British spelling (`cancelled`) and tolerates the single-l form (`canceled`)", () => {
    // The regex's `cancell?ed` pattern accepts both.
    const british = `<div data-component="cancelledOrderBanner"><h4>This order has been cancelled.</h4></div>`;
    const american = `<div data-component="cancelledOrderBanner"><h4>This order has been canceled.</h4></div>`;
    expect(CANCELLED_RE.test(british)).toBe(true);
    expect(CANCELLED_RE.test(american)).toBe(true);
  });
});
