// Single owner of the Default -> "All" display alias. No component derives the
// Default display name independently.

export interface LibraryPresentation {
  name: string;
  context: string;
}

export function libraryPresentation(library: {
  isDefault: boolean;
  name: string;
  role: string;
}): LibraryPresentation {
  return library.isDefault
    ? { name: "All", context: "Across your libraries" }
    : { name: library.name, context: library.role };
}

export const RESERVED_LIBRARY_NAME_MESSAGE = "all is reserved for the all view.";

export function isReservedLibraryName(name: string): boolean {
  return name.trim().toLowerCase() === "all";
}

/** One stable order for matching choices and their collapsed summary. */
export function compareLibraryNames(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
