import type { CollectionRowView } from "@/lib/collections/types";
import type { SlateItem, SlateReason } from "@/lib/resonance/contract";
import { mediaKindIcon, resourceIconForScheme } from "@/lib/resources/resourceKind";

function assertNever(value: never): never {
  throw new Error(`Unhandled Slate reason: ${JSON.stringify(value)}`);
}

export function presentSlateReason(reason: SlateReason): string {
  switch (reason.kind) {
    case "Continue":
      return reason.progress.kind === "Present"
        ? `Continue · ${Math.round(reason.progress.value * 100)}%`
        : "Continue where you left off";
    case "AddedToNexus":
      return `Added to Nexus · ${reason.addedAt.slice(0, 10)}`;
    case "Published":
      return `Published · ${reason.publishedOn}`;
    case "NewEpisode":
      return `New episode · ${reason.publishedAt.slice(0, 10)}`;
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

export function presentSlateItem(item: SlateItem): CollectionRowView {
  const { target } = item;
  return {
    id: target.ref,
    kind:
      target.kind === "Podcast"
        ? "podcast"
        : target.mediaKind === "podcast_episode"
          ? "podcast_episode"
          : "media",
    primary: { kind: "link", href: target.href, paneLabelHint: target.title },
    lead: {
      icon:
        target.kind === "Podcast"
          ? resourceIconForScheme("podcast")
          : mediaKindIcon(target.mediaKind),
      remoteUrl: target.imageUrl.kind === "Present" ? target.imageUrl.value : undefined,
    },
    headline: { text: target.title },
    description:
      target.subtitle.kind === "Present" ? target.subtitle.value : undefined,
    signals: [{ value: presentSlateReason(item.reason) }],
    relatedMediaId: null,
  };
}
