import { absent, present } from "@/lib/api/presence";
import type {
  CollectionActivity,
  CollectionRowView,
  ConsumptionModality,
} from "@/lib/collections/types";
import type { SlateItem, SlateReason, SlateTarget } from "@/lib/resonance/contract";

function assertNever(value: never): never {
  throw new Error(`Unhandled Slate reason: ${JSON.stringify(value)}`);
}

export function presentSlateReason(reason: SlateReason): string {
  switch (reason.kind) {
    case "Continue":
      return "Continue where you left off";
    case "AddedToNexus":
      return "Added to Nexus";
    case "Published":
      return "Published";
    case "NewEpisode":
      return "New episode";
    case "Connected":
      return reason.edgeOrigin === "synapse"
        ? `Synapse · connected with ${reason.anchor.label}`
        : `Connected with ${reason.anchor.label}`;
    case "SharedAuthor":
      return `Shared author · ${reason.authorName} · with ${reason.anchor.label}`;
    case "Similar":
      return `Similar to ${reason.anchor.label}`;
    default:
      return assertNever(reason);
  }
}

function modalityFor(target: SlateTarget): ConsumptionModality {
  if (
    target.kind === "Podcast" ||
    (target.kind === "Media" && target.mediaKind === "podcast_episode")
  ) {
    return "Listen";
  }
  if (target.kind === "Media" && target.mediaKind === "video") {
    return "Watch";
  }
  return "Read";
}

export function presentSlateItem(item: SlateItem): CollectionRowView {
  const { target } = item;
  const reasonText = presentSlateReason(item.reason);
  const contextText =
    target.subtitle.kind === "Present"
      ? `${target.subtitle.value} · ${reasonText}`
      : reasonText;
  const activity =
    item.reason.kind === "Continue" && item.reason.progress.kind === "Present"
      ? present<CollectionActivity>({
          kind: "InProgress",
          modality: modalityFor(target),
          fraction: item.reason.progress,
          remainingMinutes: absent(),
        })
      : absent<CollectionActivity>();
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
    publicationDate:
      item.reason.kind === "Published"
        ? present(item.reason.publishedOn)
        : item.reason.kind === "NewEpisode"
          ? present(item.reason.publishedAt)
          : absent(),
    context: present({ kind: "Text", text: contextText }),
    activity,
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: [],
    selected: false,
  };
}
