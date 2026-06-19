/**
 * Note presenter — pure data, mirrors the media template. It owns what earns
 * weight for a note-page row and returns a `CollectionRowView`. No React, no fetch.
 */

import type { CollectionRowView } from "@/lib/collections/types";
import type { NotePageSummary } from "@/lib/notes/api";
import { resourceIconForScheme } from "@/lib/resources/resourceKind";

export function presentNote(item: NotePageSummary): CollectionRowView {
  return {
    id: item.id,
    kind: "note",
    primary: { kind: "link", href: `/pages/${item.id}`, paneTitleHint: item.title },
    lead: { icon: resourceIconForScheme("page") },
    headline: { text: item.title },
    signals: [],
    recency: item.updatedAt ? { at: item.updatedAt, reason: "added" } : undefined,
  };
}
