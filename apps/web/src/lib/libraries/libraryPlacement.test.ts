import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLibraryPlacement,
  addMediaToLibraries,
  decodeLibraryPlacements,
  listLibraryPlacements,
  patchLibraryPlacement,
  removeLibraryPlacement,
} from "./libraryPlacement";
import { libraryPlacementSnapshot } from "./placementRevision";

afterEach(() => vi.restoreAllMocks());

const LIBRARY_1 = "00000000-0000-4000-8000-000000000001";

const placementResponse = {
  data: [
    {
      id: LIBRARY_1,
      name: "Research",
      color: null,
      is_in_library: false,
      can_add: true,
      can_remove: false,
    },
  ],
};

describe("library placement contract", () => {
  it("strictly decodes the owned list response", () => {
    expect(decodeLibraryPlacements(placementResponse)).toEqual([
      {
        id: LIBRARY_1,
        name: "Research",
        color: null,
        isInLibrary: false,
        canAdd: true,
        canRemove: false,
      },
    ]);
  });

  it.each([
    { ...placementResponse, legacy: true },
    {
      data: [{ ...placementResponse.data[0], legacy: true }],
    },
    {
      data: [{ ...placementResponse.data[0], can_add: "yes" }],
    },
    {
      data: [{ ...placementResponse.data[0], id: "not-a-uuid" }],
    },
    {
      data: [placementResponse.data[0], placementResponse.data[0]],
    },
    {
      data: [
        {
          ...placementResponse.data[0],
          is_in_library: true,
          can_add: true,
        },
      ],
    },
  ])("defects on malformed or expanded same-system data", (body) => {
    expect(() => decodeLibraryPlacements(body)).toThrow(
      "Invalid library placement",
    );
  });

  it.each([
    {
      target: { kind: "Media" as const, id: "media-1" },
      path: "/api/media/media-1/libraries",
    },
    {
      target: { kind: "Podcast" as const, id: "podcast-1" },
      path: "/api/podcasts/podcast-1/libraries",
    },
  ])("lists $target.kind placements through its canonical route", async ({
    target,
    path,
  }) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(placementResponse));
    const signal = new AbortController().signal;

    await expect(
      listLibraryPlacements(target, { signal }),
    ).resolves.toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ method: "GET", signal }),
    );
  });
});

describe("library placement commands", () => {
  it.each([
    {
      name: "add media",
      run: () =>
        addLibraryPlacement(
          { kind: "Media", id: "media-1" },
          "library-1",
        ),
      path: "/api/media/media-1/libraries",
      method: "POST",
      body: { library_ids: ["library-1"] },
    },
    {
      name: "remove media",
      run: () =>
        removeLibraryPlacement(
          { kind: "Media", id: "media-1" },
          "library-1",
        ),
      path: "/api/media/media-1/libraries/library-1",
      method: "DELETE",
      body: undefined,
    },
    {
      name: "add podcast",
      run: () =>
        addLibraryPlacement(
          { kind: "Podcast", id: "podcast-1" },
          "library-1",
        ),
      path: "/api/libraries/library-1/podcasts",
      method: "POST",
      body: { podcast_id: "podcast-1" },
    },
    {
      name: "remove podcast",
      run: () =>
        removeLibraryPlacement(
          { kind: "Podcast", id: "podcast-1" },
          "library-1",
        ),
      path: "/api/libraries/library-1/podcasts/podcast-1",
      method: "DELETE",
      body: undefined,
    },
  ])("executes $name against its canonical response contract", async ({
    run,
    path,
    method,
    body,
  }) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        method === "DELETE"
          ? Response.json({
              data: { libraryEntriesCollectionRevision: 4 },
            })
          : new Response(null, { status: 204 }),
      );

    await run();

    expect(fetchSpy).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  });

  it("preserves the Add Content media batch command", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const signal = new AbortController().signal;

    await addMediaToLibraries(
      "media-1",
      ["library-1", "library-2"],
      { signal },
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/media/media-1/libraries",
      expect.objectContaining({
        method: "POST",
        signal,
        body: JSON.stringify({
          library_ids: ["library-1", "library-2"],
        }),
      }),
    );
  });

  it.each([200, 205])("defects when a command returns %s", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      status === 200
        ? Response.json({ data: {} })
        : new Response(null, { status }),
    );

    await expect(
      addLibraryPlacement(
        { kind: "Podcast", id: "podcast-1" },
        "library-1",
      ),
    ).rejects.toMatchObject({ code: "E_INVALID_RESPONSE", status });
  });

  it.each([
    {
      name: "addMediaToLibraries",
      run: () => addMediaToLibraries("media-1", ["library-1", "library-2"]),
      affected: ["library-1", "library-2"] as string[] | "Unknown",
    },
    {
      name: "addLibraryPlacement(Podcast)",
      run: () =>
        addLibraryPlacement({ kind: "Podcast", id: "podcast-1" }, "library-1"),
      affected: ["library-1"] as string[] | "Unknown",
    },
    {
      name: "addLibraryPlacement(Media) via addMediaToLibraries delegate",
      run: () =>
        addLibraryPlacement({ kind: "Media", id: "media-1" }, "library-1"),
      affected: ["library-1"] as string[] | "Unknown",
    },
    {
      name: "removeLibraryPlacement(Media)",
      run: () =>
        removeLibraryPlacement({ kind: "Media", id: "media-1" }, "library-1"),
      affected: ["library-1"] as string[] | "Unknown",
    },
    {
      name: "removeLibraryPlacement(Podcast)",
      run: () =>
        removeLibraryPlacement(
          { kind: "Podcast", id: "podcast-1" },
          "library-1",
        ),
      affected: ["library-1"] as string[] | "Unknown",
    },
  ])(
    "$name publishes exactly one placement revision with its scope",
    async ({ name, run, affected }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        name.startsWith("remove")
          ? Response.json({
              data: { libraryEntriesCollectionRevision: 5 },
            })
          : new Response(null, { status: 204 }),
      );
      const before = libraryPlacementSnapshot().revision;

      await run();

      const after = libraryPlacementSnapshot();
      expect(after.revision).toBe(before + 1);
      expect(after.affectedLibraryIds).toEqual(affected);
    },
  );

  it("patches only Add Content's selected local projection", () => {
    expect(
      patchLibraryPlacement(
        [
          {
            id: "library-1",
            name: "Research",
            color: null,
            isInLibrary: false,
            canAdd: true,
            canRemove: false,
          },
          {
            id: "library-2",
            name: "Shared",
            color: null,
            isInLibrary: true,
            canAdd: false,
            canRemove: false,
          },
        ],
        "library-1",
        true,
      ),
    ).toEqual([
      {
        id: "library-1",
        name: "Research",
        color: null,
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      },
      {
        id: "library-2",
        name: "Shared",
        color: null,
        isInLibrary: true,
        canAdd: false,
        canRemove: false,
      },
    ]);
  });
});
