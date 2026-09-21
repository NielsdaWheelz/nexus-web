import { absent, present } from "@/lib/api/presence";
import { readActivity, type ReadStatus } from "@/lib/collections/readState";
import type {
  CollectionRowView,
  ConsumptionModality,
} from "@/lib/collections/types";
import type { ConsumptionState } from "@/lib/lectern/contract";
import type { SlateItem, SlateTarget } from "@/lib/resonance/contract";

const SLATE_READ_STATE: Record<ConsumptionState, ReadStatus> = {
  Unread: "unread",
  InProgress: "in_progress",
  Finished: "finished",
};

function modalityFor(target: SlateTarget): ConsumptionModality {
  if (target.kind === "Podcast" || target.mediaKind === "podcast_episode") {
    return "Listen";
  }
  return target.mediaKind === "video" ? "Watch" : "Read";
}

export function presentSlateItem(item: SlateItem): CollectionRowView {
  const { target, consumption, readingTimeEstimate } = item;
  return {
    id: target.ref,
    kind:
      target.kind === "Podcast"
        ? "podcast"
        : target.mediaKind === "podcast_episode"
          ? "podcast_episode"
          : "media",
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
    title: { text: target.title },
    contributors: [],
    publicationDate: item.publicationDate,
    context:
      target.subtitle.kind === "Present"
        ? present({ kind: "Text", text: target.subtitle.value })
        : absent(),
    activity:
      consumption.kind === "Present"
        ? readActivity(
            {
              read_state: SLATE_READ_STATE[consumption.value.state],
              progressFraction:
                consumption.value.progress.kind === "Present"
                  ? present({ value: consumption.value.progress.value })
                  : absent(),
            },
            modalityFor(target),
            readingTimeEstimate.kind === "Present"
              ? {
                  totalMinutes: present(readingTimeEstimate.value.totalMinutes),
                  remainingMinutes: readingTimeEstimate.value.remainingMinutes,
                }
              : { totalMinutes: absent(), remainingMinutes: absent() },
          )
        : absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject: target.actionSubject,
    selected: false,
  };
}
