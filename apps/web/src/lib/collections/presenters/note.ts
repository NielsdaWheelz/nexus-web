/** Pure semantic projection for one note page row. */

import type { CollectionRowView } from "@/lib/collections/types";
import type { NotePageSummary } from "@/lib/notes/api";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export function presentNote(item: NotePageSummary): CollectionRowView {
  return {
    presentation: "Index",
    id: item.id,
    kind: "note",
    primary: {
      kind: "link",
      href: `/pages/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    contributors: [],
    publicationDate: null,
    context: null,
    activity: null,
    exceptionalStatus: null,
    resourceRef: canonicalResourceRef({ scheme: "page", id: item.id }),
    selected: false,
  };
}
