import type { ActionMenuOption } from "@/components/ui/ActionMenu";

interface BuildMediaHeaderOptionsInput {
  canonicalSourceUrl: string | null;
  defaultLibraryId: string | null;
  inDefaultLibrary: boolean;
  libraryBusy: boolean;
  isEpub: boolean;
  hasEpubToc: boolean;
  epubTocExpanded: boolean;
  onAddToLibrary: () => void;
  onRemoveFromLibrary: () => void;
  onToggleEpubToc: () => void;
}

export function buildMediaHeaderOptions({
  canonicalSourceUrl,
  defaultLibraryId,
  inDefaultLibrary,
  libraryBusy,
  isEpub,
  hasEpubToc,
  epubTocExpanded,
  onAddToLibrary,
  onRemoveFromLibrary,
  onToggleEpubToc,
}: BuildMediaHeaderOptionsInput): ActionMenuOption[] {
  const options: ActionMenuOption[] = [];

  if (defaultLibraryId) {
    options.push({
      id: inDefaultLibrary ? "remove-from-library" : "add-to-library",
      label: inDefaultLibrary ? "Remove from library" : "Add to library",
      disabled: libraryBusy,
      onSelect: inDefaultLibrary ? onRemoveFromLibrary : onAddToLibrary,
    });
  }

  if (canonicalSourceUrl) {
    options.push({
      id: "open-source",
      label: "Open source",
      href: canonicalSourceUrl,
    });
  }

  if (isEpub && hasEpubToc) {
    options.push({
      id: "toggle-toc",
      label: epubTocExpanded ? "Hide table of contents" : "Show table of contents",
      onSelect: onToggleEpubToc,
    });
  }

  return options;
}
