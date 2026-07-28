import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  libraryPlacementAffectedSince,
  libraryPlacementSnapshot,
  publishLibraryPlacementChange,
  resetLibraryPlacementRevisionForTest,
  subscribeLibraryPlacement,
} from "./placementRevision";

beforeEach(() => {
  resetLibraryPlacementRevisionForTest();
});

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

describe("libraryPlacementAffectedSince", () => {
  it("is false when no change has advanced past the captured revision", () => {
    const since = libraryPlacementSnapshot().revision;
    expect(libraryPlacementAffectedSince(since, "lib-1")).toBe(false);
  });

  it("sees a library affected by an INTERMEDIATE change, not only the latest", () => {
    const since = libraryPlacementSnapshot().revision;
    // Add-Content publishes per unit: B first, then C. Judging staleness by the
    // latest scope alone (C) would mask B; the log must still report B affected.
    publishLibraryPlacementChange(["lib-b"]);
    publishLibraryPlacementChange(["lib-c"]);
    expect(libraryPlacementAffectedSince(since, "lib-b")).toBe(true);
    expect(libraryPlacementAffectedSince(since, "lib-c")).toBe(true);
  });

  it("is unaffected by a later change scoped to a different library", () => {
    const since = libraryPlacementSnapshot().revision;
    publishLibraryPlacementChange(["lib-b"]);
    const afterB = libraryPlacementSnapshot().revision;
    publishLibraryPlacementChange(["lib-c"]);
    // Nothing after `afterB` touched lib-b.
    expect(libraryPlacementAffectedSince(afterB, "lib-b")).toBe(false);
    // But lib-b IS affected relative to the earlier capture.
    expect(libraryPlacementAffectedSince(since, "lib-b")).toBe(true);
  });

  it("treats an Unknown-scoped change as affecting any library", () => {
    const since = libraryPlacementSnapshot().revision;
    publishLibraryPlacementChange(["lib-x"]);
    publishLibraryPlacementChange("Unknown");
    expect(libraryPlacementAffectedSince(since, "lib-anything")).toBe(true);
  });

  it("is order-independent: an early affecting change survives many later ones", () => {
    const since = libraryPlacementSnapshot().revision;
    publishLibraryPlacementChange(["lib-target"]);
    for (let i = 0; i < 10; i += 1) {
      publishLibraryPlacementChange([`lib-other-${i}`]);
    }
    expect(libraryPlacementAffectedSince(since, "lib-target")).toBe(true);
  });

  it("is conservative (true) once the bounded log evicts the captured revision", () => {
    const since = libraryPlacementSnapshot().revision;
    // Overrun the 64-entry log so the change immediately after `since` is gone.
    for (let i = 0; i < 100; i += 1) {
      publishLibraryPlacementChange([`lib-fill-${i}`]);
    }
    expect(libraryPlacementAffectedSince(since, "lib-never-listed")).toBe(true);
  });
});
