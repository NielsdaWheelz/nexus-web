import { afterEach, describe, expect, it, vi } from "vitest";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";
import {
  confirmAndDeleteMedia,
} from "./mediaLibraries";

afterEach(() => vi.restoreAllMocks());

describe("confirmAndDeleteMedia", () => {
  it("owns the canonical confirmation copy and does not execute when cancelled", async () => {
    const confirmRemoval = vi.fn(() => false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      confirmAndDeleteMedia({
        mediaId: "media-1",
        mediaTitle: "A Work",
        confirmRemoval,
      }),
    ).resolves.toEqual({ kind: "Cancelled" });

    expect(confirmRemoval).toHaveBeenCalledWith(
      'Delete "A Work" from All and libraries you manage? This cannot be undone.',
    );
    expect(confirmRemoval).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("executes and strictly decodes the canonical delete command after confirmation", async () => {
    const confirmRemoval = vi.fn(() => true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          kind: "Hidden",
          removedFromLibraryIds: ["library-1"],
          remainingReferenceCount: 1,
          libraryEntriesCollectionRevision: 7,
        },
      }),
    );

    await expect(
      confirmAndDeleteMedia({
        mediaId: "media-1",
        mediaTitle: "A Work",
        confirmRemoval,
      }),
    ).resolves.toEqual({
      kind: "Completed",
      result: {
        kind: "Hidden",
        removedFromLibraryIds: ["library-1"],
        remainingReferenceCount: 1,
        libraryEntriesCollectionRevision: 7,
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/media/media-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(confirmRemoval).toHaveBeenCalledTimes(1);
  });

  it("publishes exactly one Unknown-scope placement revision per acknowledged delete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          kind: "Removed",
          removedFromLibraryIds: ["library-1", "library-2"],
          remainingReferenceCount: 0,
          libraryEntriesCollectionRevision: 8,
        },
      }),
    );
    const before = libraryPlacementSnapshot();

    await expect(
      confirmAndDeleteMedia({
        mediaId: "media-9",
        mediaTitle: "A Work",
        confirmRemoval: () => true,
      }),
    ).resolves.toMatchObject({ kind: "Completed" });

    const after = libraryPlacementSnapshot();
    expect(after.revision - before.revision).toBe(1);
    expect(after.affectedLibraryIds).toBe("Unknown");
  });

  it.each([
    {
      name: "unknown discriminator",
      body: { data: { kind: "removed" } },
      defect: "Invalid MediaDeleteResult.kind",
    },
    {
      name: "extra envelope key",
      body: { data: { kind: "Deleting" }, legacy: true },
      defect: "Invalid MediaDeleteResult envelope",
    },
    {
      name: "extra Deleting arm key",
      body: { data: { kind: "Deleting", legacy: true } },
      defect: "Invalid MediaDeleteResult.Deleting",
    },
    {
      name: "extra completed arm key",
      body: {
        data: {
          kind: "Removed",
          removedFromLibraryIds: [],
          remainingReferenceCount: 0,
          libraryEntriesCollectionRevision: 1,
          legacy: true,
        },
      },
      defect: "Invalid MediaDeleteResult.Removed",
    },
    {
      name: "negative remaining reference count",
      body: {
        data: {
          kind: "Hidden",
          removedFromLibraryIds: [],
          remainingReferenceCount: -1,
          libraryEntriesCollectionRevision: 1,
        },
      },
      defect: "Invalid MediaDeleteResult.Hidden",
    },
  ])("defects on $name", async ({ body, defect }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));

    await expect(
      confirmAndDeleteMedia({
        mediaId: "media-1",
        mediaTitle: "A Work",
        confirmRemoval: () => true,
      }),
    ).rejects.toThrow(defect);
  });
});
