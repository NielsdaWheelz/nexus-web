import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteMemberLibrary,
  renameMemberLibrary,
} from "@/lib/libraries/client";
import { libraryPlacementSnapshot } from "@/lib/libraries/placementRevision";

describe("Library mutation completion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes one broad placement change after the committed response decodes", async () => {
    const before = libraryPlacementSnapshot().revision;
    const libraryId = "01988be7-59f5-7c27-a1d3-9ef98f73a8e4";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`/api/libraries/${libraryId}`);
        expect(init?.method).toBe("DELETE");
        return Response.json({
          data: { libraryId, collectionRevision: 41 },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteMemberLibrary(libraryId)).resolves.toBe(41);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(libraryPlacementSnapshot()).toEqual({
      revision: before + 1,
      affectedLibraryIds: "Unknown",
    });
  });

  it("publishes one broad placement change after a rename commits", async () => {
    const before = libraryPlacementSnapshot().revision;
    const libraryId = "01988be7-59f5-7c27-a1d3-9ef98f73a8e4";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            library: {
              id: libraryId,
              name: "Canonical shelf",
              color: null,
              ownerUserHandle: `nus1.${"A".repeat(22)}.${"B".repeat(22)}`,
              isDefault: false,
              role: "admin",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
              createdAt: "2026-08-05T12:00:00Z",
              updatedAt: "2026-08-05T12:01:00Z",
            },
            collectionRevision: 42,
          },
        }),
      ),
    );

    await expect(
      renameMemberLibrary(libraryId, "Canonical shelf"),
    ).resolves.toMatchObject({
      library: { id: libraryId, name: "Canonical shelf" },
      collectionRevision: 42,
    });
    expect(libraryPlacementSnapshot()).toEqual({
      revision: before + 1,
      affectedLibraryIds: "Unknown",
    });
  });
});
