/** One source row: metadata only; the containing section owns its scoped controls. */

import type { Schema } from "@/lib/api/wire";
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
  readonly recurring: Schema<"FeedRecurringOut"> | null;
}

export function presentFeed(item: FeedPresenterItem): CollectionRowView {
  const sync = item.recurring;
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
    activity: sync?.state === "pending" || sync?.state === "running"
      ? { kind: "FeedSync", feedKind: item.kind, status: sync.state } : null,
    exceptionalStatus: sync?.error_code !== null && sync?.error_code !== undefined
      ? { kind: "FeedSync", feedKind: item.kind, status: "failed" } : null,
    resourceRef: canonicalResourceRef({ scheme: item.kind === "podcast" ? "podcast" : "feed", id: item.id }),
    selected: false,
  };
}
