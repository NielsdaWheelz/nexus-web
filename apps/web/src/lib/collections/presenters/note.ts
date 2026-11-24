/** Pure semantic projection for one note page row. */

import type { CollectionRowView } from "@/lib/collections/types";
import { formatDay } from "@/lib/localDate";
import type { NotePageSummary } from "@/lib/notes/api";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export function presentNote(item: NotePageSummary, day: string | null, mark: string | null): CollectionRowView {
  return {
    presentation: "Title",
    id: item.id,
    kind: "note",
    workDateMark: day !== null && mark !== null ? { date: day, label: mark } : undefined,
    primary: {
      kind: "link",
      href: `/pages/${item.id}`,
      paneLabelHint: item.title,
      description: day === null ? undefined : `last worked on ${formatDay(day, null)}`,
    },
    title: { text: item.title },
    contributors: [],
    publicationDate: null,
    context: null,
    resourceRef: canonicalResourceRef({ scheme: "page", id: item.id }),
    selected: false,
  };
}
