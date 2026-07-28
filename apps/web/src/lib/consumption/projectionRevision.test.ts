import { describe, expect, it, vi } from "vitest";
import {
  consumptionProjectionSnapshot,
  publishConsumptionProjectionChange,
  subscribeConsumptionProjection,
} from "./projectionRevision";

// The store is module-global; assert revision deltas, never absolute values.

describe("publishConsumptionProjectionChange", () => {
  it("bumps the revision monotonically", () => {
    const before = consumptionProjectionSnapshot().revision;

    publishConsumptionProjectionChange();
    expect(consumptionProjectionSnapshot().revision).toBe(before + 1);

    publishConsumptionProjectionChange();
    expect(consumptionProjectionSnapshot().revision).toBe(before + 2);
  });
});

describe("subscribeConsumptionProjection", () => {
  it("notifies a subscriber on publish and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConsumptionProjection(listener);

    const before = consumptionProjectionSnapshot().revision;

    publishConsumptionProjectionChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(consumptionProjectionSnapshot().revision).toBe(before + 1);

    unsubscribe();
    publishConsumptionProjectionChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(consumptionProjectionSnapshot().revision).toBe(before + 2);
  });
});
