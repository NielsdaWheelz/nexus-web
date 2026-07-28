/** Pure semantic projection for one library row. */

import { absent, present } from "@/lib/api/presence";
import { libraryResourceOptions } from "@/lib/actions/resourceActions";
import { publishResourceRowActions } from "@/lib/collections/resourceActionPublication";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { libraryPresentation } from "@/lib/libraries/presentation";
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
  const presentation = libraryPresentation({
    isDefault: item.isDefault,
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
    publicationDate: absent(),
    context: present({
      kind: "Text",
      text: presentation.context,
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
