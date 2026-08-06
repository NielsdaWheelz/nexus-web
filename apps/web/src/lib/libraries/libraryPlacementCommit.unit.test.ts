import { describe, expect, it, vi } from "vitest";

import {
  decideUnconfirmedLibraryPlacement,
  reconcileCommittedLibraryPlacement,
} from "@/lib/libraries/libraryPlacementCommit";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION = {
  kind: "Library" as const,
  library: { id: LIBRARY_ID, name: "Research", color: null },
};

function placement(
  relation: LibraryPlacementOption["relation"],
): LibraryPlacementOption {
  return {
    destination: DESTINATION,
    relation,
    availability:
      relation.kind === "Inherited"
        ? { kind: "Blocked", reason: "Inherited" }
        : { kind: "Available" },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("reconcileCommittedLibraryPlacement", () => {
  it("awaits typed subject reconciliation before reading placement truth and becoming Ready", async () => {
    const barrier = deferred();
    const events: string[] = [];
    const onCommitted = vi.fn(async () => {
      events.push("action-started");
      await barrier.promise;
      events.push("action-finished");
    });
    const readPlacements = vi.fn(async () => {
      events.push("placement-read");
      return [];
    });

    const result = reconcileCommittedLibraryPlacement({
      target: { kind: "Media", id: MEDIA_ID },
      onCommitted,
      readPlacements,
    });
    await Promise.resolve();

    expect(events).toEqual(["action-started"]);
    expect(readPlacements).not.toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledWith({
      kind: "Subjects",
      refs: [`media:${MEDIA_ID}`],
    });

    barrier.resolve();
    await expect(result).resolves.toEqual({ kind: "Ready", placements: [] });
    expect(events).toEqual([
      "action-started",
      "action-finished",
      "placement-read",
    ]);
  });

  it("does not claim Ready or read placements when action reconciliation fails", async () => {
    const defect = new Error("snapshot contract drift");
    const readPlacements = vi.fn(async () => []);

    await expect(
      reconcileCommittedLibraryPlacement({
        target: { kind: "Media", id: MEDIA_ID },
        onCommitted: async () => {
          throw defect;
        },
        readPlacements,
      }),
    ).resolves.toEqual({ kind: "ActionSnapshotFailed", error: defect });
    expect(readPlacements).not.toHaveBeenCalled();
  });
});

describe("decideUnconfirmedLibraryPlacement", () => {
  const destinationKey = `Library:${LIBRARY_ID}` as const;

  it.each([
    ["Add", { kind: "Direct" }, "Committed"],
    [
      "Add",
      { kind: "Inherited", provenance: [DESTINATION.library] },
      "Committed",
    ],
    ["Add", { kind: "Absent" }, "RetryCommand"],
    ["Remove", { kind: "Absent" }, "Committed"],
    [
      "Remove",
      { kind: "Inherited", provenance: [DESTINATION.library] },
      "Committed",
    ],
    ["Remove", { kind: "Direct" }, "RetryCommand"],
  ] as const)("%s observes %s as %s", (op, relation, expected) => {
    expect(
      decideUnconfirmedLibraryPlacement({
        placements: [placement(relation)],
        destinationKey,
        op,
      }),
    ).toEqual({ kind: expected });
  });

  it("settles explicitly when the destination disappeared concurrently", () => {
    expect(
      decideUnconfirmedLibraryPlacement({
        placements: [],
        destinationKey,
        op: "Add",
      }),
    ).toEqual({ kind: "DestinationGone" });
  });
});
