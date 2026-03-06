/**
 * Determines the layout mode for the LinkedItemsPane.
 *
 * On mobile viewports, always returns "list" because aligned mode uses
 * absolute positioning that requires side-by-side panes — impossible
 * when panes are tabbed on mobile.
 *
 * On desktop, chooses based on content type and scope:
 * - PDF page-scoped → aligned (rows align with page highlights)
 * - PDF document-scoped → list (too many highlights to align)
 * - EPUB chapter-scoped → aligned (rows align with chapter anchors)
 * - EPUB book-scoped → list (whole-book index, no per-anchor alignment)
 * - Web article → aligned (default side-by-side alignment)
 */
export function resolveLinkedItemsLayoutMode(opts: {
  isPdf: boolean;
  pdfHighlightScope: "page" | "document";
  isEpub: boolean;
  epubHighlightScope: "chapter" | "book";
  isMobile: boolean;
}): "aligned" | "list" {
  // Mobile: always list — aligned mode requires side-by-side panes
  // which are impossible when panes are tabbed on mobile.
  if (opts.isMobile) {
    return "list";
  }

  // Desktop: content-type-aware layout
  if (opts.isPdf) {
    return opts.pdfHighlightScope === "document" ? "list" : "aligned";
  }
  if (opts.isEpub && opts.epubHighlightScope === "book") {
    return "list";
  }
  return "aligned";
}
