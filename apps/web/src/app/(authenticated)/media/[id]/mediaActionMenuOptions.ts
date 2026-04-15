import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ReaderTheme } from "@/lib/reader/types";

interface BuildMediaHeaderOptionsInput {
  canonicalSourceUrl: string | null;
  defaultLibraryId: string | null;
  inDefaultLibrary: boolean;
  libraryBusy: boolean;
  showThemeOptions: boolean;
  currentTheme: ReaderTheme;
  isEpub: boolean;
  hasEpubToc: boolean;
  epubTocExpanded: boolean;
  onAddToLibrary: () => void;
  onRemoveFromLibrary: () => void;
  onToggleEpubToc: () => void;
  onSelectTheme: (theme: ReaderTheme) => void;
}

export function buildMediaHeaderOptions({
  canonicalSourceUrl,
  defaultLibraryId,
  inDefaultLibrary,
  libraryBusy,
  showThemeOptions,
  currentTheme,
  isEpub,
  hasEpubToc,
  epubTocExpanded,
  onAddToLibrary,
  onRemoveFromLibrary,
  onToggleEpubToc,
  onSelectTheme,
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

  if (showThemeOptions) {
    const themeLabels: Record<ReaderTheme, string> = {
      light: "Light theme",
      dark: "Dark theme",
      sepia: "Sepia theme",
    };
    const themeOrder: ReaderTheme[] = ["light", "dark", "sepia"];

    for (const theme of themeOrder) {
      const isCurrent = theme === currentTheme;
      options.push({
        id: `theme-${theme}`,
        label: isCurrent
          ? `${themeLabels[theme]} (current)`
          : themeLabels[theme],
        disabled: isCurrent,
        onSelect: () => onSelectTheme(theme),
      });
    }
  }

  return options;
}
