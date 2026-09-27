import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import type { ConsumptionInfo, LecternItem } from "@/lib/lectern/contract";

export function playbackVerb(consumption: ConsumptionInfo): "Play" | "Replay" | "Resume" {
  if (consumption.state === "InProgress") return "Resume";
  if (consumption.state === "Finished") return "Replay";
  return "Play";
}

export function presentLecternItem(item: LecternItem): CollectionRowView {
  return presentMedia(item.mediaSummary, {
    id: item.itemId,
    primary: { kind: "link", href: item.href, viewTransition: "media-reader" },
    actionSubject: item.actionSubject,
    selected: false,
  });
}
