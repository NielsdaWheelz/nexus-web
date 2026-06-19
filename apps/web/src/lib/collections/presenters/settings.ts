/**
 * Settings presenter — maps one static settings-nav item to a `CollectionRowView`.
 * Pure data: no React, no fetch. The pane resolves the icon via `getPaneRouteIcon`
 * and passes it in; the presenter does not compute it.
 *
 * `CollectionRowView` has no description field, so the item's description line is
 * carried as a single dimmed signal.
 */

import type { LucideIcon } from "lucide-react";
import type { CollectionRowView } from "@/lib/collections/types";

export interface SettingsPresenterItem {
  id?: string;
  title: string;
  description?: string;
  meta?: string;
  href?: string;
  icon: LucideIcon;
}

export function presentSettingsRow(item: SettingsPresenterItem): CollectionRowView {
  const signals = [];
  if (item.description) signals.push({ value: item.description });
  if (item.meta) signals.push({ value: item.meta });

  return {
    id: item.id ?? item.href ?? item.title,
    kind: "settings_row",
    primary: item.href
      ? { kind: "link", href: item.href, paneTitleHint: item.title }
      : { kind: "static" },
    lead: { icon: item.icon },
    headline: { text: item.title },
    signals,
  };
}
