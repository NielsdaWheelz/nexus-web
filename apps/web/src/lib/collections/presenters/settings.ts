/** One settings row: a link to a section, or a static row with its own commands. */

import type { CollectionRowView } from "@/lib/collections/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

export interface SettingsPresenterItem {
  id?: string;
  title: string;
  description?: string;
  meta?: string;
  href?: string;
  actions?: readonly ActionDescriptor[];
}

export function presentSettingsRow(
  item: SettingsPresenterItem,
): CollectionRowView {
  const context = [item.description, item.meta].filter(Boolean).join(" · ");
  return {
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
    // not a resource: an explicit flat menu, no action snapshot
    resourceRef: null,
    flatActions: item.actions,
    selected: false,
  };
}
