import { describe, it, expect } from "vitest";
import {
  normalizeExpiry,
  splitExpiry,
  normalizeBilling,
} from "../../src/shared/cardFields.js";
import type { BillingAddress } from "../../src/shared/types.js";

describe("normalizeExpiry", () => {
  it("returns null for a blank value", () => {
    expect(normalizeExpiry("")).toBeNull();
    expect(normalizeExpiry("   ")).toBeNull();
  });

  it("normalizes MM/YY and pads the month", () => {
    expect(normalizeExpiry("12/28")).toBe("12/28");
    expect(normalizeExpiry("1/28")).toBe("01/28");
    expect(normalizeExpiry(" 3 / 27 ")).toBe("03/27");
  });

  it("accepts MM/YYYY and 4-digit year, keeping the last 2", () => {
    expect(normalizeExpiry("12/2028")).toBe("12/28");
    expect(normalizeExpiry("0628")).toBe("06/28");
  });

  it("throws on an unparseable non-blank value", () => {
    expect(() => normalizeExpiry("nope")).toThrow();
    expect(() => normalizeExpiry("13/28")).toThrow(); // month out of range
    expect(() => normalizeExpiry("00/28")).toThrow();
  });
});

describe("splitExpiry", () => {
  it("splits into unpadded month + 4-digit year", () => {
    expect(splitExpiry("12/28")).toEqual({ month: "12", year: "2028" });
    expect(splitExpiry("01/27")).toEqual({ month: "1", year: "2027" });
    expect(splitExpiry("3/2030")).toEqual({ month: "3", year: "2030" });
  });

  it("returns null for blank, null, or unparseable input", () => {
    expect(splitExpiry(null)).toBeNull();
    expect(splitExpiry(undefined)).toBeNull();
    expect(splitExpiry("")).toBeNull();
    expect(splitExpiry("abc")).toBeNull();
    expect(splitExpiry("13/28")).toBeNull(); // month out of range
  });
});

describe("normalizeBilling", () => {
  const full: BillingAddress = {
    fullName: "  Cuong Ngo ",
    line1: " 1 Main St ",
    line2: "",
    city: "Portland",
    state: "OR",
    zip: "97230",
    country: "",
    phone: "5035550100",
  };

  it("trims fields and defaults country to US", () => {
    expect(normalizeBilling(full)).toEqual({
      fullName: "Cuong Ngo",
      line1: "1 Main St",
      line2: "",
      city: "Portland",
      state: "OR",
      zip: "97230",
      country: "US",
      phone: "5035550100",
    });
  });

  it("returns null for null/undefined", () => {
    expect(normalizeBilling(null)).toBeNull();
    expect(normalizeBilling(undefined)).toBeNull();
  });

  it("collapses an all-blank address to null", () => {
    expect(
      normalizeBilling({
        fullName: "  ",
        line1: "",
        line2: "",
        city: "",
        state: "",
        zip: "",
        country: "  ",
        phone: "",
      }),
    ).toBeNull();
  });

  it("keeps an address that has any of name / line1 / city / zip", () => {
    const onlyZip = normalizeBilling({
      fullName: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      zip: "97230",
      country: "",
      phone: "",
    });
    expect(onlyZip).not.toBeNull();
    expect(onlyZip?.zip).toBe("97230");
  });
});
