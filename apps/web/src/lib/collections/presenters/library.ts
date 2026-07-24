/** Pure semantic projection for one library row. */

import { absent, present } from "@/lib/api/presence";
import {
  libraryResourceOptions,
  type LibraryActionSubject,
} from "@/lib/actions/resourceActions";
import type { CollectionRowView } from "@/lib/collections/types";

export interface LibraryPresenterItem extends LibraryActionSubject {
  id: string;
  name: string;
}

export interface LibraryPresenterContext {
  onShare?: Parameters<typeof libraryResourceOptions>[0]["onShare"];
  onOpenSettings?: () => void;
  onDelete?: () => void;
}

export function presentLibrary(
  item: LibraryPresenterItem,
  ctx: LibraryPresenterContext,
): CollectionRowView {
  return {
    id: item.id,
    kind: "library",
    primary: {
      kind: "link",
      href: `/libraries/${item.id}`,
      paneLabelHint: item.name,
    },
    title: { text: item.name },
    contributors: [],
    publicationDate: absent(),
    context: present({
      kind: "Text",
      text: item.isDefault ? "Default library" : item.role,
    }),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: libraryResourceOptions({ library: item, ...ctx }),
    selected: false,
  };
}
