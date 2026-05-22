import { describe, expect, it } from "vitest";
import { signalWake, waitForWake } from "../../src/main/redisWakeSignal.js";

describe("redisWakeSignal", () => {
  it("waitForWake resolves on signalWake", async () => {
    const promise = waitForWake();
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    signalWake();
    // Yield to the microtask queue so the .then handler runs.
    await new Promise<void>((r) => setImmediate(r));
    expect(resolved).toBe(true);
  });

  it("returns a fresh promise after each signal", async () => {
    const first = waitForWake();
    signalWake();
    await first;
    const second = waitForWake();
    // The promise returned after a signal must NOT be already-resolved
    // (otherwise the scheduler would spin-loop).
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(secondResolved).toBe(false);
    signalWake();
    await new Promise<void>((r) => setImmediate(r));
    expect(secondResolved).toBe(true);
  });

  it("signalWake without a waiter is a no-op (no throw)", () => {
    // The producer might call waitForWake, consume, and not be
    // waiting when the next message arrives. signalWake must be
    // safe to call regardless.
    expect(() => signalWake()).not.toThrow();
    expect(() => signalWake()).not.toThrow();
    expect(() => signalWake()).not.toThrow();
  });

  it("multiple concurrent waiters all resolve on the same signal", async () => {
    const w1 = waitForWake();
    const w2 = waitForWake();
    const w3 = waitForWake();
    // All three were grabbed before any signal — they should share
    // the same underlying promise instance.
    expect(w1).toBe(w2);
    expect(w2).toBe(w3);
    let resolvedCount = 0;
    void w1.then(() => resolvedCount++);
    void w2.then(() => resolvedCount++);
    void w3.then(() => resolvedCount++);
    signalWake();
    await new Promise<void>((r) => setImmediate(r));
    expect(resolvedCount).toBe(3);
  });
});
