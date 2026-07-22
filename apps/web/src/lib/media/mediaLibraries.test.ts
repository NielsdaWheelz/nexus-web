import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeMediaLibraryMemberships,
  ensureMediaAbsentFromLibrary,
  ensureMediaInLibraries,
  patchLibraryMembership,
  type LibraryTargetPickerItem,
} from "./mediaLibraries";

afterEach(() => vi.restoreAllMocks());

describe("decodeMediaLibraryMemberships", () => {
  it("decodes the canonical non-default membership projection", () => {
    expect(
      decodeMediaLibraryMemberships({
        data: [
          {
            id: "library-1",
            name: "Research",
            color: null,
            is_in_library: true,
            can_add: false,
            can_remove: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "library-1",
        name: "Research",
        color: null,
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      },
    ]);
  });

  it("defects on malformed same-system membership data", () => {
    expect(() =>
      decodeMediaLibraryMemberships({
        data: [
          {
            id: "library-1",
            name: "Research",
            color: null,
            is_in_library: "yes",
            can_add: false,
            can_remove: true,
          },
        ],
      }),
    ).toThrow("invalid library entry");
  });
});

function makeLibrary(
  overrides: Partial<LibraryTargetPickerItem> = {},
): LibraryTargetPickerItem {
  return {
    id: "library-1",
    name: "Inbox",
    color: null,
    isInLibrary: false,
    canAdd: true,
    canRemove: false,
    ...overrides,
  };
}

describe("patchLibraryMembership", () => {
  it("flips the membership flags of the targeted library only", () => {
    const result = patchLibraryMembership(
      [
        makeLibrary(),
        makeLibrary({
          id: "library-2",
          isInLibrary: true,
          canAdd: false,
          canRemove: true,
        }),
      ],
      "library-1",
      true,
    );
    expect(result).toEqual([
      makeLibrary({ isInLibrary: true, canAdd: false, canRemove: true }),
      makeLibrary({
        id: "library-2",
        isInLibrary: true,
        canAdd: false,
        canRemove: true,
      }),
    ]);
  });

  it("clears membership flags when isInLibrary is false", () => {
    const result = patchLibraryMembership(
      [makeLibrary({ isInLibrary: true, canAdd: false, canRemove: true })],
      "library-1",
      false,
    );
    expect(result).toEqual([makeLibrary()]);
  });
});

describe("media-library command responses", () => {
  it.each([
    {
      name: "add",
      run: () =>
        ensureMediaInLibraries({
          mediaId: "media-1",
          libraryIds: ["library-1"],
        }),
    },
    {
      name: "remove",
      run: () =>
        ensureMediaAbsentFromLibrary({
          mediaId: "media-1",
          libraryId: "library-1",
        }),
    },
  ])("defects when $name returns a JSON success body", async ({ run }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: { legacy: true } }),
    );

    await expect(run()).rejects.toMatchObject({
      code: "E_INVALID_RESPONSE",
      status: 200,
    });
  });

  it.each([
    {
      name: "add",
      run: () =>
        ensureMediaInLibraries({
          mediaId: "media-1",
          libraryIds: ["library-1"],
        }),
    },
    {
      name: "remove",
      run: () =>
        ensureMediaAbsentFromLibrary({
          mediaId: "media-1",
          libraryId: "library-1",
        }),
    },
  ])("defects when $name returns bodyless 205", async ({ run }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 205 }),
    );

    await expect(run()).rejects.toMatchObject({
      code: "E_INVALID_RESPONSE",
      status: 205,
    });
  });

  it("accepts bodyless 204 for both canonical commands", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await ensureMediaInLibraries({
      mediaId: "media-1",
      libraryIds: ["library-1"],
    });
    await ensureMediaAbsentFromLibrary({
      mediaId: "media-1",
      libraryId: "library-1",
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "/api/media/media-1/libraries",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "/api/media/media-1/libraries/library-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
