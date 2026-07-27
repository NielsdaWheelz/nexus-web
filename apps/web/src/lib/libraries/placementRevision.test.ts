import { describe, expect, it, vi } from "vitest";
import {
  libraryPlacementSnapshot,
  publishLibraryPlacementChange,
  subscribeLibraryPlacement,
} from "./placementRevision";

// The store is module-global; assert revision deltas, never absolute values.

describe("publishLibraryPlacementChange", () => {
  it("bumps the revision monotonically and records the affected ids", () => {
    const before = libraryPlacementSnapshot().revision;

    publishLibraryPlacementChange(["lib-1", "lib-2"]);
    const first = libraryPlacementSnapshot();
    expect(first.revision).toBe(before + 1);
    expect(first.affectedLibraryIds).toEqual(["lib-1", "lib-2"]);

    publishLibraryPlacementChange(["lib-3"]);
    const second = libraryPlacementSnapshot();
    expect(second.revision).toBe(before + 2);
    expect(second.affectedLibraryIds).toEqual(["lib-3"]);
  });

  it("round-trips the Unknown scope", () => {
    publishLibraryPlacementChange("Unknown");
    expect(libraryPlacementSnapshot().affectedLibraryIds).toBe("Unknown");
  });
});

describe("subscribeLibraryPlacement", () => {
  it("notifies a subscriber on publish and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLibraryPlacement(listener);

    publishLibraryPlacementChange(["lib-1"]);
    expect(listener).toHaveBeenCalledTimes(1);

    publishLibraryPlacementChange("Unknown");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    publishLibraryPlacementChange(["lib-9"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
