import { describe, it, expect } from "vitest";
import { effectiveStatusGroup } from "../../src/renderer/lib/jobsColumns.js";
import type { JobAttempt } from "../../src/shared/types.js";

// Minimal JobAttempt factory — only the fields effectiveStatusGroup
// actually reads. Default orderId is a real-shape Amazon order id so
// the tracking gate applies; tests that exercise the no-orderId
// exemption pass `orderId: null` explicitly.
function attempt(overrides: Partial<JobAttempt>): JobAttempt {
  return {
    attemptId: "a1",
    jobId: "j1",
    amazonEmail: "test@example.com",
    phase: "buy",
    dealKey: null,
    dealId: null,
    dealTitle: null,
    productUrl: "https://amazon.com/dp/B000",
    upc: null,
    status: "completed",
    cost: null,
    cashbackPct: null,
    error: null,
    orderId: "111-1234567-1234567",
    amazonPurchaseId: null,
    fillerOrderIds: null,
    fillerCancelTasks: null,
    trackingIds: null,
    placedQuantity: null,
    correlationId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as JobAttempt;
}

describe("effectiveStatusGroup", () => {
  describe("tracking gate (the alignment with BG semantics)", () => {
    it("demotes `completed` to pending when trackingIds is null", () => {
      const a = attempt({ status: "completed", trackingIds: null });
      expect(effectiveStatusGroup(a)).toBe("pending");
    });

    it("demotes `completed` to pending when trackingIds is empty array", () => {
      const a = attempt({ status: "completed", trackingIds: [] });
      expect(effectiveStatusGroup(a)).toBe("pending");
    });

    it("demotes `verified` to pending when trackingIds is null", () => {
      const a = attempt({ status: "verified", trackingIds: null });
      expect(effectiveStatusGroup(a)).toBe("pending");
    });

    it("keeps `completed` as success once trackingIds arrive", () => {
      const a = attempt({ status: "completed", trackingIds: ["1Z999AA10123456784"] });
      expect(effectiveStatusGroup(a)).toBe("success");
    });

    it("keeps `verified` as success once trackingIds arrive", () => {
      const a = attempt({ status: "verified", trackingIds: ["1Z..."] });
      expect(effectiveStatusGroup(a)).toBe("success");
    });

    it("keeps multi-tracking-id rows as success", () => {
      const a = attempt({
        status: "completed",
        trackingIds: ["1Z111", "1Z222", "1Z333"],
      });
      expect(effectiveStatusGroup(a)).toBe("success");
    });
  });

  describe("no-orderId exemption (can't track, can't re-verify)", () => {
    it("keeps `verified` as success when orderId is null and tracking is null", () => {
      // Real-world case: the 6 cross-deal-contamination rows that
      // were NULLed by scripts/cleanup-shared-orderids.ts on
      // 2026-05-09. They have status=verified, no orderId, no
      // tracking. Demoting them to Pending would imply "waiting
      // for tracking" — nothing can arrive without an orderId.
      const a = attempt({ status: "verified", orderId: null, trackingIds: null });
      expect(effectiveStatusGroup(a)).toBe("success");
    });

    it("keeps `completed` as success when orderId is null", () => {
      const a = attempt({ status: "completed", orderId: null, trackingIds: [] });
      expect(effectiveStatusGroup(a)).toBe("success");
    });

    it("DEMOTES when orderId IS present and tracking is missing (the normal case)", () => {
      // Sanity: confirm the orderId guard doesn't accidentally
      // exempt rows that DO have an orderId. Those should still
      // demote — they're the legit "waiting for tracking" rows.
      const a = attempt({
        status: "verified",
        orderId: "111-1234567-1234567",
        trackingIds: null,
      });
      expect(effectiveStatusGroup(a)).toBe("pending");
    });
  });

  describe("dry_run_success exemption (no real order, no tracking expected)", () => {
    it("dry_run_success without tracking stays success", () => {
      const a = attempt({ status: "dry_run_success", trackingIds: null });
      expect(effectiveStatusGroup(a)).toBe("success");
    });

    it("dry_run_success with empty trackingIds stays success", () => {
      const a = attempt({ status: "dry_run_success", trackingIds: [] });
      expect(effectiveStatusGroup(a)).toBe("success");
    });
  });

  describe("non-success buckets pass through unchanged", () => {
    it("queued is pending regardless of tracking", () => {
      expect(effectiveStatusGroup(attempt({ status: "queued" }))).toBe("pending");
    });

    it("in_progress is pending", () => {
      expect(effectiveStatusGroup(attempt({ status: "in_progress" }))).toBe("pending");
    });

    it("awaiting_verification is pending", () => {
      expect(effectiveStatusGroup(attempt({ status: "awaiting_verification" }))).toBe(
        "pending",
      );
    });

    it("cancelled_by_amazon is cancelled (not affected by tracking)", () => {
      const a = attempt({ status: "cancelled_by_amazon", trackingIds: null });
      expect(effectiveStatusGroup(a)).toBe("cancelled");
    });

    it("failed is failed", () => {
      expect(effectiveStatusGroup(attempt({ status: "failed" }))).toBe("failed");
    });

    it("action_required is action_required", () => {
      expect(effectiveStatusGroup(attempt({ status: "action_required" }))).toBe(
        "action_required",
      );
    });
  });
});
