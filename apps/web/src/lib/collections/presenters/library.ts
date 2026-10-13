/** Pure semantic projection for one library row. */

import { canonicalResourceRef } from "@/lib/sharing/targets";
import { libraryPresentation } from "@/lib/libraries/presentation";
import type { CollectionRowView } from "@/lib/collections/types";

export interface LibraryPresenterItem {
  id: string;
  name: string;
  is_default: boolean;
  role: string;
  can_rename: boolean;
  can_delete: boolean;
}

export function presentLibrary(
  item: LibraryPresenterItem,
): CollectionRowView {
  const href = `/libraries/${item.id}`;
  const presentation = libraryPresentation({
    is_default: item.is_default,
    name: item.name,
    role: item.role,
  });
  return {
    id: item.id,
    kind: "library",
    primary: {
      kind: "link",
      href,
      paneLabelHint: presentation.name,
    },
    title: { text: presentation.name },
    contributors: [],
    publicationDate: null,
    context: {
      kind: "Text",
      text: presentation.context,
    },
    activity: null,
    exceptionalStatus: null,
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "library", id: item.id }),
    },
    selected: false,
  };
}
