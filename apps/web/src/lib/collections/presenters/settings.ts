/** One settings row: a link to a section or a static fact. */

import type { CollectionRowView } from "@/lib/collections/types";

export interface SettingsPresenterItem {
  presentation: "Index" | "Details";
  id?: string;
  title: string;
  description?: string;
  meta?: string;
  href?: string;
}

export function presentSettingsRow(
  item: SettingsPresenterItem,
): CollectionRowView {
  const context = [item.description, item.meta].filter(Boolean).join(" · ");
  return {
    presentation: item.presentation,
    id: item.id ?? item.href ?? item.title,
    kind: "settings_row",
    primary: item.href
      ? { kind: "link", href: item.href, paneLabelHint: item.title }
      : { kind: "static" },
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
