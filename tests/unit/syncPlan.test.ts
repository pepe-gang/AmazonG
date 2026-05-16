import { describe, it, expect } from "vitest";
import { planSync } from "../../src/main/syncPlan.js";
import type { AutoGSyncBlob, SyncCard } from "../../src/shared/types.js";

const card = (id: string): SyncCard => ({
  id,
  label: `Card ${id}`,
  cardholderName: `Holder ${id}`,
  last4: id.slice(-4).padStart(4, "0"),
  number: `4111111111${id.slice(-4).padStart(4, "0")}`,
  expiry: "12/27",
  cvv: "123",
});

/** A populated BG blob (exists=true) with sensible defaults; override per test. */
function blob(over: Partial<AutoGSyncBlob> = {}): AutoGSyncBlob {
  return {
    exists: true,
    cards: [],
    cardAssignments: null,
    buyWithFillers: false,
    fillerAttempts: ["eero"],
    updatedAt: "2026-05-16T00:00:00.000Z",
    ...over,
  };
}

const emptyBlob: AutoGSyncBlob = {
  exists: false,
  cards: [],
  cardAssignments: null,
  buyWithFillers: null,
  fillerAttempts: null,
  updatedAt: null,
};

describe("planSync", () => {
  describe("when BG has no row yet (exists=false)", () => {
    it("seeds from local: push up, change nothing, not applied", () => {
      const plan = planSync(emptyBlob, 3);
      expect(plan).toEqual({
        settingsPatch: {},
        cards: null,
        cardAssignments: null,
        pushLocal: true,
        applied: false,
      });
    });

    it("seeds even when this machine has no cards either", () => {
      const plan = planSync(emptyBlob, 0);
      expect(plan.pushLocal).toBe(true);
      expect(plan.applied).toBe(false);
    });
  });

  describe("settings patch", () => {
    it("applies buyWithFillers + fillerAttempts from BG", () => {
      const plan = planSync(
        blob({ buyWithFillers: true, fillerAttempts: ["eero", "amazon-basics"] }),
        0,
      );
      expect(plan.settingsPatch).toEqual({
        buyWithFillers: true,
        fillerAttempts: ["eero", "amazon-basics"],
      });
      expect(plan.applied).toBe(true);
    });

    it("omits fillerAttempts when BG carries an empty array or null", () => {
      expect(planSync(blob({ fillerAttempts: [] }), 0).settingsPatch.fillerAttempts).toBeUndefined();
      expect(planSync(blob({ fillerAttempts: null }), 0).settingsPatch.fillerAttempts).toBeUndefined();
    });

    it("omits buyWithFillers when BG carries null", () => {
      expect(planSync(blob({ buyWithFillers: null }), 0).settingsPatch.buyWithFillers).toBeUndefined();
    });

    it("applies buyWithFillers=false (a real value, not skipped)", () => {
      const plan = planSync(blob({ buyWithFillers: false, fillerAttempts: [] }), 0);
      expect(plan.settingsPatch).toEqual({ buyWithFillers: false });
      expect(plan.applied).toBe(true);
    });
  });

  describe("cards", () => {
    it("replaces the local vault when BG has cards", () => {
      const bgCards = [card("c1"), card("c2")];
      const plan = planSync(blob({ cards: bgCards }), 5);
      expect(plan.cards).toBe(bgCards);
      expect(plan.pushLocal).toBe(false);
      expect(plan.applied).toBe(true);
    });

    it("does NOT wipe a populated local vault when BG card list is empty — pushes local instead", () => {
      const plan = planSync(blob({ cards: [] }), 2);
      expect(plan.cards).toBeNull();
      expect(plan.pushLocal).toBe(true);
    });

    it("leaves the vault alone when both BG and local have no cards", () => {
      const plan = planSync(blob({ cards: [] }), 0);
      expect(plan.cards).toBeNull();
      expect(plan.pushLocal).toBe(false);
    });
  });

  describe("card assignments", () => {
    it("applies a non-empty assignment map from BG", () => {
      const assignments = { "a@x.com": "c1" };
      const plan = planSync(blob({ cards: [card("c1")], cardAssignments: assignments }), 0);
      expect(plan.cardAssignments).toBe(assignments);
      expect(plan.applied).toBe(true);
    });

    it("ignores an empty assignment map", () => {
      const plan = planSync(blob({ cards: [card("c1")], cardAssignments: {} }), 0);
      expect(plan.cardAssignments).toBeNull();
    });

    it("does NOT apply assignments when pushing local up (empty remote)", () => {
      const plan = planSync(blob({ cards: [], cardAssignments: { "a@x.com": "c1" } }), 2);
      expect(plan.pushLocal).toBe(true);
      expect(plan.cardAssignments).toBeNull();
    });
  });

  describe("applied flag", () => {
    it("is true when only cards changed", () => {
      const plan = planSync(
        blob({ cards: [card("c1")], buyWithFillers: null, fillerAttempts: null }),
        0,
      );
      expect(plan.applied).toBe(true);
    });

    it("is true when only assignments changed", () => {
      const plan = planSync(
        blob({ buyWithFillers: null, fillerAttempts: null, cardAssignments: { "a@x.com": "c1" } }),
        0,
      );
      expect(plan.applied).toBe(true);
    });

    it("is false when nothing changed (BG empty of cards + settings, local empty)", () => {
      const plan = planSync(
        blob({ cards: [], buyWithFillers: null, fillerAttempts: null }),
        0,
      );
      expect(plan.applied).toBe(false);
      expect(plan.pushLocal).toBe(false);
    });
  });
});
