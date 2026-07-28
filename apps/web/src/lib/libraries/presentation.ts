// Single owner of the Default -> "All" display alias. No component derives the
// Default display name independently. See
// docs/cutovers/library-all-and-smart-views-hard-cutover.md ("Presentation").

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

export const RESERVED_LIBRARY_NAME_MESSAGE = "All is reserved for the All view.";

export function isReservedLibraryName(name: string): boolean {
  return name.trim().toLowerCase() === "all";
}
