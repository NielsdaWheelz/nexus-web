/** One source row: metadata only; the containing section owns its scoped controls. */

import type { CollectionRowView } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/credits";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export interface FeedPresenterItem {
  readonly id: string;
  readonly kind: "podcast" | "article";
  readonly subtitle: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly contributors: readonly ContributorCredit[];
}

export function presentFeed(item: FeedPresenterItem): CollectionRowView {
  return {
    presentation: "Index",
    id: item.id,
    kind: item.kind === "podcast" ? "podcast" : "feed",
    primary: {
      kind: "link",
      href: `/${item.kind === "podcast" ? "podcasts" : "feeds"}/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    artwork: { imageUrl: item.imageUrl },
    contributors: item.contributors,
    publicationDate: null,
    context: item.subtitle === null ? null : { kind: "Text", text: item.subtitle },
    resourceRef: canonicalResourceRef({ scheme: item.kind === "podcast" ? "podcast" : "feed", id: item.id }),
    selected: false,
  };
}
