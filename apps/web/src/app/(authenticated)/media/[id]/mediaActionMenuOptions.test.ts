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
      showThemeOptions: false,
      currentTheme: "light",
      isEpub: true,
      hasEpubToc: true,
      epubTocExpanded: false,
      onAddToLibrary: addSpy,
      onRemoveFromLibrary: removeSpy,
      onToggleEpubToc: tocSpy,
      onSelectTheme: vi.fn(),
    });

    expect(options.map((option) => option.label)).toEqual([
      "Add to library",
      "Open source",
      "Show table of contents",
    ]);
    expect(options.some((option) => option.label === "Delete")).toBe(false);
    expect(options.some((option) => option.label === "Retry")).toBe(false);
  });

  it("builds reader theme quick-switch options for epub readers", () => {
    const updateTheme = vi.fn();

    const options = buildMediaHeaderOptions({
      canonicalSourceUrl: null,
      defaultLibraryId: null,
      inDefaultLibrary: false,
      libraryBusy: false,
      showThemeOptions: true,
      currentTheme: "dark",
      isEpub: true,
      hasEpubToc: false,
      epubTocExpanded: false,
      onAddToLibrary: vi.fn(),
      onRemoveFromLibrary: vi.fn(),
      onToggleEpubToc: vi.fn(),
      onSelectTheme: updateTheme,
    });

    const themeOptions = options.filter((option) =>
      /light|dark|sepia/i.test(option.label)
    );

    expect(themeOptions.map((option) => option.label)).toEqual([
      "Light theme",
      "Dark theme (current)",
      "Sepia theme",
    ]);
    expect(themeOptions).toHaveLength(3);

    const currentThemeOption = themeOptions.find((option) => /dark/i.test(option.label));
    expect(currentThemeOption?.disabled).toBe(true);

    themeOptions.find((option) => /light/i.test(option.label))?.onSelect?.();
    themeOptions.find((option) => /sepia/i.test(option.label))?.onSelect?.();

    expect(updateTheme).toHaveBeenNthCalledWith(1, "light");
    expect(updateTheme).toHaveBeenNthCalledWith(2, "sepia");
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
      showThemeOptions: false,
      currentTheme: "light",
      isEpub: false,
      hasEpubToc: false,
      epubTocExpanded: false,
      onAddToLibrary: addSpy,
      onRemoveFromLibrary: removeSpy,
      onToggleEpubToc: tocSpy,
      onSelectTheme: vi.fn(),
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
      showThemeOptions: false,
      currentTheme: "light",
      isEpub: false,
      hasEpubToc: false,
      epubTocExpanded: false,
      onAddToLibrary: () => {},
      onRemoveFromLibrary: () => {},
      onToggleEpubToc: () => {},
      onSelectTheme: () => {},
    });

    expect(options).toEqual([]);
  });
});
