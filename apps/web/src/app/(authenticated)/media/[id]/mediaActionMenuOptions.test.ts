import { describe, expect, it, vi } from "vitest";
import { buildMediaHeaderOptions } from "./mediaActionMenuOptions";

describe("media header action menu options", () => {
  it("builds add-to-library, source, and epub toc options when available", () => {
    const addSpy = vi.fn();
    const removeSpy = vi.fn();
    const tocSpy = vi.fn();

    const options = buildMediaHeaderOptions({
      canonicalSourceUrl: "https://example.com/source",
      defaultLibraryId: "library-1",
      inDefaultLibrary: false,
      libraryBusy: false,
      isEpub: true,
      hasEpubToc: true,
      epubTocExpanded: false,
      onAddToLibrary: addSpy,
      onRemoveFromLibrary: removeSpy,
      onToggleEpubToc: tocSpy,
    });

    expect(options.map((option) => option.label)).toEqual([
      "Add to library",
      "Open source",
      "Show table of contents",
    ]);
    expect(options.some((option) => option.label === "Delete")).toBe(false);
    expect(options.some((option) => option.label === "Retry")).toBe(false);
  });

  it("builds remove-to-library option when media is already in default library", () => {
    const addSpy = vi.fn();
    const removeSpy = vi.fn();
    const tocSpy = vi.fn();

    const options = buildMediaHeaderOptions({
      canonicalSourceUrl: null,
      defaultLibraryId: "library-1",
      inDefaultLibrary: true,
      libraryBusy: true,
      isEpub: false,
      hasEpubToc: false,
      epubTocExpanded: false,
      onAddToLibrary: addSpy,
      onRemoveFromLibrary: removeSpy,
      onToggleEpubToc: tocSpy,
    });

    expect(options.map((option) => option.label)).toEqual(["Remove from library"]);
    expect(options[0]?.disabled).toBe(true);
  });

  it("returns an empty option list when no action is meaningful", () => {
    const options = buildMediaHeaderOptions({
      canonicalSourceUrl: null,
      defaultLibraryId: null,
      inDefaultLibrary: false,
      libraryBusy: false,
      isEpub: false,
      hasEpubToc: false,
      epubTocExpanded: false,
      onAddToLibrary: () => {},
      onRemoveFromLibrary: () => {},
      onToggleEpubToc: () => {},
    });

    expect(options).toEqual([]);
  });
});
