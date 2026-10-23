/** Rows for the libraries index and a library's entries. */

import type { CollectionRowView } from "@/lib/collections/types";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { Library, LibraryEntry } from "@/lib/libraries/api";
import { canonicalResourceRef } from "@/lib/sharing/targets";

/** The one alias: the viewer's default library is shown as All. */
export function libraryDisplayName(library: {
  readonly is_default: boolean;
  readonly name: string;
}): string {
  return library.is_default ? "All" : library.name;
}

export function presentLibrary(library: Library): CollectionRowView {
  const name = libraryDisplayName(library);
  return {
    id: library.id,
    kind: "library",
    primary: { kind: "link", href: `/libraries/${library.id}`, paneLabelHint: name },
    title: { text: name },
    contributors: [],
    publicationDate: null,
    context: {
      kind: "Text",
      text: library.is_default ? "Across your libraries" : library.role,
    },
    activity: null,
    exceptionalStatus: null,
    resourceRef: canonicalResourceRef({ scheme: "library", id: library.id }),
    selected: false,
  };
}

/** A row's identity is the item it files (unique within one library). */
export const libraryEntryId = (entry: LibraryEntry) => entry.media_summary.media_id;

export function presentLibraryEntry(entry: LibraryEntry): CollectionRowView {
  const id = entry.media_summary.media_id;
  return presentMedia(entry.media_summary, {
    id, primary: { kind: "link", href: `/media/${id}` },
    resourceRef: canonicalResourceRef({ scheme: "media", id }), selected: false,
  });
}
