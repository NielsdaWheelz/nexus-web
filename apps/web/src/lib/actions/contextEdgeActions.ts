import { createElement, type ComponentType } from "react";
import { ListMinus } from "lucide-react";
import type {
  ActionDescriptor,
  ActionSelectDetail,
} from "@/lib/ui/actionDescriptor";

type ContextEdgeIcon = ComponentType<{
  size?: number;
  "aria-hidden"?: boolean | "true" | "false";
}>;

interface ContextEdgeActionCatalogEntry {
  /** Stable dot-delimited PascalCase id in the context-edge namespace. */
  readonly id: string;
  /** The item label shown inside the separate control's menu. */
  readonly label: string;
  /** The label while the edge mutation is in flight. */
  readonly busyLabel: string;
  /** Default accessible label for the separate control's own trigger. */
  readonly triggerLabel: string;
  readonly icon: ContextEdgeIcon;
  readonly tone?: "default" | "danger";
}

/**
 * The one owner of context-edge command identity and presentation. These
 * commands act on a conversation-context / connection / synapse EDGE — not on
 * the canonical resource — so they are NOT resource actions under the canonical
 * taxonomy. They left
 * `RESOURCE_ACTION_CATALOG` for this separate, typed publication contract and
 * are rendered only through the dedicated {@link "@/components/resources/ContextEdgeMenu"}
 * control, never merged into `ResourceActionMenu`.
 */
export const CONTEXT_EDGE_ACTION_CATALOG = {
  Unlink: {
    id: "ContextEdgeAction.Connection.Unlink",
    label: "Unlink connection",
    busyLabel: "Unlinking...",
    triggerLabel: "Edit connection",
    icon: ListMinus,
  },
  Dismiss: {
    id: "ContextEdgeAction.Connection.Dismiss",
    label: "Dismiss connection",
    busyLabel: "Dismissing...",
    triggerLabel: "Edit connection",
    icon: ListMinus,
  },
  RemoveFromContext: {
    id: "ContextEdgeAction.Context.Remove",
    label: "Remove from conversation context",
    busyLabel: "Removing...",
    triggerLabel: "Remove from context",
    icon: ListMinus,
  },
} as const satisfies Record<string, ContextEdgeActionCatalogEntry>;

export type ContextEdgeActionKind = keyof typeof CONTEXT_EDGE_ACTION_CATALOG;

export function contextEdgeActionEntry(
  kind: ContextEdgeActionKind,
): ContextEdgeActionCatalogEntry {
  return CONTEXT_EDGE_ACTION_CATALOG[kind];
}

/**
 * Project one context-edge command into a menu descriptor. Presentation
 * (id/label/busy label/icon/tone) is catalog-owned here; the caller supplies
 * only the in-flight flag and the selection port for the edge mutation.
 */
export function projectContextEdgeAction({
  kind,
  busy,
  disabledReason,
  onSelect,
}: {
  readonly kind: ContextEdgeActionKind;
  readonly busy: boolean;
  readonly disabledReason?: string;
  readonly onSelect: (detail: ActionSelectDetail) => void;
}): ActionDescriptor {
  const entry = contextEdgeActionEntry(kind);
  return {
    kind: "command",
    id: entry.id,
    label: busy ? entry.busyLabel : entry.label,
    icon: createElement(entry.icon, { size: 14, "aria-hidden": true }),
    disabled: busy || undefined,
    disabledReason: busy ? (disabledReason ?? "Working…") : undefined,
    tone: entry.tone,
    onSelect,
    restoreFocusOnClose: false,
  };
}
