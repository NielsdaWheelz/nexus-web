import { describe, expect, it } from "vitest";
import type { LibraryTargetPickerItem } from "@/components/LibraryTargetPicker";
import { patchLibraryMembership } from "./mediaLibraries";

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
