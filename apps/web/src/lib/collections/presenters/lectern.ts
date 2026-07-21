/**
 * Lectern collection presenters. These pure mappings own the queue/recent row
 * hierarchy and actions; the pane owns resource state and renders playable
 * controls because those controls bind to the global player capability.
 */

import { Trash2 } from "lucide-react";
import type { CollectionRowView, ReadStatus } from "@/lib/collections/types";
import type {
  ConsumptionInfo,
  LecternItem,
  MediaId,
  RecentConsumptionItem,
} from "@/lib/lectern/contract";
import { mediaKindIcon } from "@/lib/resources/resourceKind";

function presentConsumption(
  consumption: ConsumptionInfo,
): CollectionRowView["consumption"] {
  const fraction =
    consumption.progress.kind === "Present" ? consumption.progress.value : undefined;
  if (consumption.state === "Unread" && fraction === undefined) return undefined;
  const status: ReadStatus =
    consumption.state === "Finished"
      ? "finished"
      : consumption.state === "InProgress"
        ? "in_progress"
        : "unread";
  return fraction === undefined ? { status } : { status, fraction };
}

export function playbackVerb(consumption: ConsumptionInfo): "Play" | "Replay" | "Resume" {
  if (consumption.state === "InProgress") return "Resume";
  if (consumption.state === "Finished") return "Replay";
  return "Play";
}

export function presentLecternItem(
  item: LecternItem,
  onRemove: (triggerEl: HTMLButtonElement | null) => void,
): CollectionRowView {
  return {
    id: item.itemId,
    kind: item.kind === "podcast_episode" ? "podcast_episode" : "media",
    primary: { kind: "link", href: item.href, paneLabelHint: item.title },
    lead: { icon: mediaKindIcon(item.kind) },
    headline: { text: item.title },
    signals: item.subtitle.kind === "Present" ? [{ value: item.subtitle.value }] : [],
    consumption: presentConsumption(item.consumption),
    relatedMediaId: null,
    actions: [
      {
        kind: "command",
        id: "remove-from-lectern",
        label: "Remove from Lectern",
        tone: "danger",
        restoreFocusOnClose: false,
        onSelect: ({ triggerEl }) => onRemove(triggerEl),
      },
    ],
    swipeActions: [
      {
        id: "remove-from-lectern",
        label: "Remove",
        icon: Trash2,
        tone: "danger",
        onActivate: () => onRemove(null),
      },
    ],
  };
}

export function presentRecentConsumptionItem(
  item: RecentConsumptionItem,
  input: { canAdd: boolean; onAdd: (mediaId: MediaId) => void },
): CollectionRowView {
  const subtitle =
    item.playerDescriptor.kind === "Present" &&
    item.playerDescriptor.value.subtitle.kind === "Present"
      ? item.playerDescriptor.value.subtitle.value
      : undefined;
  return {
    id: item.mediaId,
    kind: item.kind === "podcast_episode" ? "podcast_episode" : "media",
    primary: { kind: "link", href: item.href, paneLabelHint: item.title },
    lead: { icon: mediaKindIcon(item.kind) },
    headline: { text: item.title },
    signals: subtitle ? [{ value: subtitle }] : [],
    consumption: presentConsumption(item.consumption),
    recency: { at: item.lastEngagedAt },
    relatedMediaId: null,
    actions: [
      {
        kind: "command",
        id: "add-to-lectern",
        label: "Add to Lectern",
        disabled: !input.canAdd,
        onSelect: () => input.onAdd(item.mediaId),
      },
    ],
  };
}
