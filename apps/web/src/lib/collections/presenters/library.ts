/** Pure semantic projection for one library row. */

import { absent, present } from "@/lib/api/presence";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { publishResourceRowActions } from "@/lib/collections/resourceActionPublication";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { CollectionRowView } from "@/lib/collections/types";

export interface LibraryPresenterItem {
  id: string;
  name: string;
  isDefault: boolean;
  role: string;
  canRename: boolean;
  canDelete: boolean;
}

export type LibraryPresenterContext = Parameters<
  typeof libraryResourceOptions
>[0];

export function presentLibrary(
  item: LibraryPresenterItem,
  ctx: LibraryPresenterContext,
): CollectionRowView {
  const href = `/libraries/${item.id}`;
  return {
    id: item.id,
    kind: "library",
    primary: {
      kind: "link",
      href,
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
    actionPublication: publishResourceRowActions({
      target: routeResourceActionSubject({
        scheme: "library",
        id: item.id,
        href,
      }),
      rich: libraryResourceOptions(ctx),
      view: [],
    }),
    selected: false,
  };
}
