/** One followed-podcast row, shared by the podcasts and library panes. */

import type { Schema } from "@/lib/api/wire";
import type { CollectionRowView, PositiveCount } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/credits";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export interface PodcastPresenterItem {
  readonly id: string;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly contributors: readonly ContributorCredit[];
  readonly unplayedCount: PositiveCount | null;
  readonly syncStatus: Schema<"PodcastSyncStatus"> | null;
}

export function presentPodcast(item: PodcastPresenterItem): CollectionRowView {
  const sync = item.syncStatus;
  return {
    id: item.id,
    kind: "podcast",
    primary: {
      kind: "link",
      href: `/podcasts/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    artwork: { imageUrl: item.imageUrl },
    contributors: item.contributors,
    publicationDate: null,
    context: null,
    activity:
      sync === "Pending" || sync === "Running"
        ? { kind: "PodcastSync", status: sync }
        : item.unplayedCount !== null
          ? { kind: "Unplayed", count: item.unplayedCount }
          : null,
    exceptionalStatus:
      sync === "Failed"
        ? { kind: "PodcastSync", status: "Failed" }
        : null,
    resourceRef: canonicalResourceRef({ scheme: "podcast", id: item.id }),
    selected: false,
  };
}
