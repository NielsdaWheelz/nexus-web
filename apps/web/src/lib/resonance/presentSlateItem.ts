import { absent, present } from "@/lib/api/presence";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import type { SlateItem } from "@/lib/resonance/contract";

export function presentSlateItem(item: SlateItem): CollectionRowView {
  const target = item.target;
  if (target.kind === "Media") {
    return presentMedia(target.mediaSummary, {
      id: target.ref,
      primary: { kind: "link", href: target.href, viewTransition: "media-reader" },
      actionSubject: target.actionSubject,
      selected: false,
    });
  }
  return {
    id: target.ref,
    kind: "podcast",
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
    title: { text: target.title },
    contributors: [],
    publicationDate: absent(),
    context: target.subtitle.kind === "Present"
      ? present({ kind: "Text", text: target.subtitle.value })
      : absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    actionSubject: target.actionSubject,
    selected: false,
  };
}
