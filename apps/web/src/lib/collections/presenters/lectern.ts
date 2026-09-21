/** Pure semantic projection for one Lectern row. */

import { absent, present } from "@/lib/api/presence";
import { readActivity, type ReadStatus } from "@/lib/collections/readState";
import type {
  CollectionRowView,
  ConsumptionModality,
} from "@/lib/collections/types";
import type {
  ConsumptionInfo,
  ConsumptionState,
  LecternActivityFacts,
  LecternItem,
} from "@/lib/lectern/contract";

function modalityFor(item: LecternItem): ConsumptionModality {
  if (item.activation.kind === "FooterAudio") return "Listen";
  if (item.kind === "video") return "Watch";
  return "Read";
}

const LECTERN_READ_STATE: Record<ConsumptionState, ReadStatus> = {
  Unread: "unread",
  InProgress: "in_progress",
  Finished: "finished",
};

export function playbackVerb(consumption: ConsumptionInfo): "Play" | "Replay" | "Resume" {
  if (consumption.state === "InProgress") return "Resume";
  if (consumption.state === "Finished") return "Replay";
  return "Play";
}

export function presentLecternItem(
  item: LecternItem,
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
    activity: readActivity(
      {
        read_state: LECTERN_READ_STATE[item.consumption.state],
        progressFraction: activityFacts.fraction,
      },
      modalityFor(item),
      activityFacts,
    ),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject: item.actionSubject,
    selected: false,
  };
}
