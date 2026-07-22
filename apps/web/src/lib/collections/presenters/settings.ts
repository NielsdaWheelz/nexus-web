/** Pure semantic projection for one settings row. */

import { absent, present } from "@/lib/api/presence";
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

export function presentSettingsRow(item: SettingsPresenterItem): CollectionRowView {
  const context = [item.description, item.meta].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

  return {
    id: item.id ?? item.href ?? item.title,
    kind: "settings_row",
    primary: item.href
      ? { kind: "link", href: item.href, paneLabelHint: item.title }
      : { kind: "static" },
    title: { text: item.title },
    contributors: [],
    publicationDate: absent(),
    context:
      context.length > 0
        ? present({ kind: "Text", text: context.join(" · ") })
        : absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: item.actions ?? [],
    selected: false,
  };
}
