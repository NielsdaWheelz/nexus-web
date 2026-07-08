/**
 * Library presenter — mirrors the media template. Pure data: it owns the decision
 * of what earns weight for a library row. No React, no fetch.
 *
 * `ctx` carries the callbacks `libraryResourceOptions` needs (edit / delete);
 * the capability flags travel on the subject itself.
 */

import { Trash2 } from "lucide-react";
import { libraryResourceOptions, type LibraryActionSubject } from "@/lib/actions/resourceActions";
import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import { resourceIconForScheme } from "@/lib/resources/resourceKind";

export interface LibraryPresenterItem extends LibraryActionSubject {
  id: string;
  name: string;
}

export interface LibraryPresenterContext {
  onEdit?: () => void;
  onDelete?: () => void;
}

export function presentLibrary(
  item: LibraryPresenterItem,
  ctx: LibraryPresenterContext,
): CollectionRowView {
  const actions = libraryResourceOptions({ library: item, ...ctx });
  const deleteAction = actions.find(
    (action) => action.id === "delete-library" && !action.disabled && action.onSelect,
  );
  const signals: SignalFact[] = [
    { value: item.is_default ? "Default media library" : "Mixed library" },
  ];
  if (item.role) signals.push({ label: "role", value: item.role });

  return {
    id: item.id,
    kind: "library",
    primary: { kind: "link", href: `/libraries/${item.id}`, paneTitleHint: item.name },
    lead: { icon: resourceIconForScheme("library") },
    headline: { text: item.name },
    signals,
    status: item.is_default ? { tone: "info", label: "Default" } : undefined,
    actions,
    swipeActions: deleteAction
      ? [
          {
            id: deleteAction.id,
            label: deleteAction.label,
            icon: Trash2,
            tone: "danger",
            onActivate: () => deleteAction.onSelect?.({ triggerEl: null }),
          },
        ]
      : undefined,
  };
}
