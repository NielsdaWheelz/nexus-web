/** Pure semantic projection for one note page row. */

import type { CollectionRowView } from "@/lib/collections/types";
import type { NotePageSummary } from "@/lib/notes/pageContract";

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
    publicationDate: null,
    context: null,
    activity: null,
    exceptionalStatus: null,
    actionSubject: item.actionSubject,
    selected: false,
  };
}
