/** Pure semantic projection for one note page row. */

import { absent } from "@/lib/api/presence";
import { emptyResourceMenuGroups } from "@/lib/actions/resourceActions";
import type { CollectionRowView } from "@/lib/collections/types";
import type { NotePageSummary } from "@/lib/notes/normalize";

export function presentNote(item: NotePageSummary): CollectionRowView {
  return {
    id: item.id,
    kind: "note",
    primary: {
      kind: "link",
      href: `/pages/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: {
      kind: "ResourceMenu",
      target: item.actionTarget,
      groups: emptyResourceMenuGroups(),
    },
    selected: false,
  };
}
