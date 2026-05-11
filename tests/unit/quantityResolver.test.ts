import { describe, it, expect } from "vitest";
import { resolvePlacedQuantity } from "../../src/shared/quantityResolver.js";

describe("resolvePlacedQuantity", () => {
  it("trusts /spc DOM when present and it agrees with cart-add target", () => {
    const r = resolvePlacedQuantity({ fromSpcDom: 2, fromCartAddTarget: 2 });
    expect(r.quantity).toBe(2);
    expect(r.warn).toBeNull();
  });

  it("emits spc_disagrees when /spc DOM differs from cart-add target", () => {
    const r = resolvePlacedQuantity({ fromSpcDom: 1, fromCartAddTarget: 2 });
    expect(r.quantity).toBe(1);
    expect(r.warn).toBe("spc_disagrees");
  });

  it("falls back to cart-add target when /spc DOM is null", () => {
    // The new Chewbacca /spc layout returns null from readTargetQuantity
    // because .lineitem-container selectors break. Cart-add target is the
    // authoritative buy-time qty in that case.
    const r = resolvePlacedQuantity({ fromSpcDom: null, fromCartAddTarget: 3 });
    expect(r.quantity).toBe(3);
    expect(r.warn).toBeNull();
  });

  it("uses cart-add target for qty=1 buys when /spc is null", () => {
    const r = resolvePlacedQuantity({ fromSpcDom: null, fromCartAddTarget: 1 });
    expect(r.quantity).toBe(1);
    expect(r.warn).toBeNull();
  });
});
