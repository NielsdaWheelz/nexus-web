import { describe, it, expect } from "vitest";
import { resolveLinkedItemsLayoutMode } from "./linkedItemsLayoutMode";

describe("resolveLinkedItemsLayoutMode", () => {
  const defaults = {
    isPdf: false,
    pdfHighlightScope: "page" as const,
    isEpub: false,
    epubHighlightScope: "chapter" as const,
    isMobile: false,
  };

  // ---------------------------------------------------------------------------
  // Mobile viewport — always list mode (aligned requires side-by-side panes)
  // ---------------------------------------------------------------------------

  it("returns list mode on mobile for a web article", () => {
    expect(
      resolveLinkedItemsLayoutMode({ ...defaults, isMobile: true }),
      "Mobile web article should use list mode — aligned positioning is meaningless when panes are tabbed"
    ).toBe("list");
  });

  it("returns list mode on mobile for page-scoped PDF", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isPdf: true,
        pdfHighlightScope: "page",
        isMobile: true,
      }),
      "Mobile page-scoped PDF should use list mode — aligned mode breaks scroll"
    ).toBe("list");
  });

  it("returns list mode on mobile for document-scoped PDF", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isPdf: true,
        pdfHighlightScope: "document",
        isMobile: true,
      }),
      "Mobile document-scoped PDF should use list mode"
    ).toBe("list");
  });

  it("returns list mode on mobile for chapter-scoped EPUB", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isEpub: true,
        epubHighlightScope: "chapter",
        isMobile: true,
      }),
      "Mobile chapter-scoped EPUB should use list mode — aligned mode is a desktop-only pattern"
    ).toBe("list");
  });

  it("returns list mode on mobile for book-scoped EPUB", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isEpub: true,
        epubHighlightScope: "book",
        isMobile: true,
      }),
      "Mobile book-scoped EPUB should use list mode"
    ).toBe("list");
  });

  // ---------------------------------------------------------------------------
  // Desktop viewport — preserves existing content-type-aware logic
  // ---------------------------------------------------------------------------

  it("returns aligned mode on desktop for web article (default)", () => {
    expect(
      resolveLinkedItemsLayoutMode({ ...defaults, isMobile: false }),
      "Desktop web article should use aligned mode for side-by-side pane alignment"
    ).toBe("aligned");
  });

  it("returns aligned mode on desktop for page-scoped PDF", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isPdf: true,
        pdfHighlightScope: "page",
        isMobile: false,
      }),
      "Desktop page-scoped PDF should use aligned mode for scroll-synchronized positioning"
    ).toBe("aligned");
  });

  it("returns list mode on desktop for document-scoped PDF", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isPdf: true,
        pdfHighlightScope: "document",
        isMobile: false,
      }),
      "Desktop document-scoped PDF uses list mode — too many highlights to align"
    ).toBe("list");
  });

  it("returns aligned mode on desktop for chapter-scoped EPUB", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isEpub: true,
        epubHighlightScope: "chapter",
        isMobile: false,
      }),
      "Desktop chapter-scoped EPUB should use aligned mode"
    ).toBe("aligned");
  });

  it("returns list mode on desktop for book-scoped EPUB", () => {
    expect(
      resolveLinkedItemsLayoutMode({
        ...defaults,
        isEpub: true,
        epubHighlightScope: "book",
        isMobile: false,
      }),
      "Desktop book-scoped EPUB uses list mode — whole-book index doesn't align to anchors"
    ).toBe("list");
  });
});
