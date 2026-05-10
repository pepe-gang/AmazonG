import { describe, it, expect } from "vitest";
import { resolvePlacedQuantity } from "../../src/shared/quantityResolver.js";

describe("resolvePlacedQuantity", () => {
  describe("badge present (the happy path post-v0.13.33)", () => {
    it("trusts the confirmation badge over /spc DOM", () => {
      // The original bug case: Amazon merged duplicate SKU lines, /spc DOM
      // reported 1 line, badge correctly shows 2 units.
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: 2,
        fromSpcDom: 1,
        fromCartAddTarget: 2,
      });
      expect(r.quantity).toBe(2);
      expect(r.warn).toBe("spc_disagrees");
    });

    it("trusts the badge with no warning when /spc agrees", () => {
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: 3,
        fromSpcDom: 3,
        fromCartAddTarget: 3,
      });
      expect(r.quantity).toBe(3);
      expect(r.warn).toBeNull();
    });

    it("trusts the badge with no warning when /spc is null (single-line layout)", () => {
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: 4,
        fromSpcDom: null,
        fromCartAddTarget: 4,
      });
      expect(r.quantity).toBe(4);
      expect(r.warn).toBeNull();
    });
  });

  describe("badge absent on qty>1 (the third defense — added v0.13.34+)", () => {
    it("falls back to cart-add target, NOT /spc, when badge is missing on qty>1", () => {
      // The defense: if the badge ever stops rendering on a qty>1 buy,
      // we must NOT trust /spc (known buggy under-count). The qty we
      // POSTed to cart-add is the next-best authority.
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: null,
        fromSpcDom: 1, // would re-introduce the bug if we trusted this
        fromCartAddTarget: 2,
      });
      expect(r.quantity).toBe(2);
      expect(r.warn).toBe("badge_missing_on_multi");
    });

    it("emits the warn even when /spc returns null on qty>1", () => {
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: null,
        fromSpcDom: null,
        fromCartAddTarget: 5,
      });
      expect(r.quantity).toBe(5);
      expect(r.warn).toBe("badge_missing_on_multi");
    });

    it("uses cart-add target even when /spc reports a higher value (still untrustworthy)", () => {
      // /spc reading higher than target is also possible if Amazon adds
      // a filler line — we still don't trust it as the source of truth.
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: null,
        fromSpcDom: 7,
        fromCartAddTarget: 3,
      });
      expect(r.quantity).toBe(3);
      expect(r.warn).toBe("badge_missing_on_multi");
    });
  });

  describe("badge absent on qty=1 (expected — Amazon hides badge at qty=1)", () => {
    it("uses /spc DOM when present and target=1", () => {
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: null,
        fromSpcDom: 1,
        fromCartAddTarget: 1,
      });
      expect(r.quantity).toBe(1);
      expect(r.warn).toBeNull();
    });

    it("falls back to target when /spc is null and target=1", () => {
      const r = resolvePlacedQuantity({
        fromConfirmationBadge: null,
        fromSpcDom: null,
        fromCartAddTarget: 1,
      });
      expect(r.quantity).toBe(1);
      expect(r.warn).toBeNull();
    });
  });
});
