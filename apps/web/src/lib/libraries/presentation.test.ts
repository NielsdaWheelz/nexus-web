import { describe, expect, it } from "vitest";
import {
  isReservedLibraryName,
  libraryPresentation,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "./presentation";

describe("libraryPresentation", () => {
  it("aliases the default library to All across your libraries", () => {
    expect(
      libraryPresentation({
        isDefault: true,
        name: "My Library",
        role: "admin",
      }),
    ).toEqual({ name: "All", context: "Across your libraries" });
  });

  it("presents an authored name with the viewer role as context", () => {
    expect(
      libraryPresentation({
        isDefault: false,
        name: "Reading",
        role: "admin",
      }),
    ).toEqual({ name: "Reading", context: "admin" });
  });
});

describe("isReservedLibraryName", () => {
  it("reserves All regardless of case or surrounding whitespace", () => {
    for (const name of ["all", "All", " ALL ", "aLl"]) {
      expect(isReservedLibraryName(name)).toBe(true);
    }
  });

  it("permits ordinary names", () => {
    for (const name of ["all things", "Reading"]) {
      expect(isReservedLibraryName(name)).toBe(false);
    }
  });
});

describe("RESERVED_LIBRARY_NAME_MESSAGE", () => {
  it("is the exact reserved-name copy", () => {
    expect(RESERVED_LIBRARY_NAME_MESSAGE).toBe(
      "All is reserved for the All view.",
    );
  });
});
