/** Static settings details. */

import type { CollectionRowView } from "@/lib/collections/types";

export function presentSettingsRow(item: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
}): CollectionRowView {
  const context = [item.description, item.meta].filter(Boolean).join(" · ");
  return {
    presentation: "Details",
    id: item.id,
    kind: "settings_row",
    primary: { kind: "static" },
    title: { text: item.title },
    contributors: [],
    publicationDate: null,
    context: context ? { kind: "Text", text: context } : null,
    activity: null,
    exceptionalStatus: null,
    resourceRef: null,
    selected: false,
  };
}
