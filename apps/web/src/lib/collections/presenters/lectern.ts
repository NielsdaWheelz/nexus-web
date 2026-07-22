/** Pure semantic projection for one Lectern row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import type {
  CollectionActivity,
  CollectionRowView,
  ConsumptionModality,
} from "@/lib/collections/types";
import type {
  ConsumptionInfo,
  LecternActivityFacts,
  LecternItem,
} from "@/lib/lectern/contract";

function modalityFor(item: LecternItem): ConsumptionModality {
  if (item.activation.kind === "FooterAudio") return "Listen";
  if (item.kind === "video") return "Watch";
  return "Read";
}

function presentActivity(
  item: LecternItem,
  facts: LecternActivityFacts,
): Presence<CollectionActivity> {
  const modality = modalityFor(item);
  switch (item.consumption.state) {
    case "Unread":
      return present({ kind: "Unread", modality, totalMinutes: facts.totalMinutes });
    case "InProgress": {
      const fraction = facts.fraction;
      if (fraction.kind === "Present") {
        return present({
          kind: "InProgress",
          modality,
          fraction,
          remainingMinutes: facts.remainingMinutes,
        });
      }
      if (facts.remainingMinutes.kind === "Absent") {
        return absent();
      }
      return present({
        kind: "InProgress",
        modality,
        fraction,
        remainingMinutes: facts.remainingMinutes,
      });
    }
    case "Finished":
      return present({ kind: "Finished", modality });
    default: {
      const exhaustive: never = item.consumption.state;
      throw new Error(`Unsupported Lectern consumption state: ${exhaustive}`);
    }
  }
}

export function playbackVerb(consumption: ConsumptionInfo): "Play" | "Replay" | "Resume" {
  if (consumption.state === "InProgress") return "Resume";
  if (consumption.state === "Finished") return "Replay";
  return "Play";
}

export function presentLecternItem(
  item: LecternItem,
  onRemove: (triggerEl: HTMLButtonElement | null) => void,
  activityFacts: LecternActivityFacts,
): CollectionRowView {
  return {
    id: item.itemId,
    kind: item.kind === "podcast_episode" ? "podcast_episode" : "media",
    primary: { kind: "link", href: item.href, paneLabelHint: item.title },
    title: { text: item.title },
    contributors: [],
    publicationDate: absent(),
    context:
      item.subtitle.kind === "Present"
        ? present({ kind: "Text", text: item.subtitle.value })
        : absent(),
    activity: presentActivity(item, activityFacts),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
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
    selected: false,
  };
}
