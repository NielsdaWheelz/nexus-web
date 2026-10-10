/** One followed-podcast row, shared by the podcasts and library panes. */

import { absent, present, type Presence } from "@/lib/api/presence";
import type { Schema } from "@/lib/api/wire";
import type { CollectionRowView } from "@/lib/collections/types";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { ContributorCredit } from "@/lib/contributors/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export interface PodcastPresenterItem {
  readonly id: string;
  readonly title: string;
  readonly contributors: readonly ContributorCredit[];
  readonly unplayedCount: Presence<PositiveCount>;
  readonly syncStatus: Presence<Schema<"PodcastSyncStatus">>;
  readonly publicationDate: Presence<string>;
}

export function presentPodcast(item: PodcastPresenterItem): CollectionRowView {
  const sync =
    item.syncStatus.kind === "Present" ? item.syncStatus.value : null;
  return {
    id: item.id,
    kind: "podcast",
    primary: {
      kind: "link",
      href: `/podcasts/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    contributors: item.contributors,
    publicationDate: item.publicationDate,
    context: absent(),
    activity:
      sync === "Pending" || sync === "Running"
        ? present({ kind: "PodcastSync", status: sync })
        : item.unplayedCount.kind === "Present"
          ? present({ kind: "Unplayed", count: item.unplayedCount.value })
          : absent(),
    exceptionalStatus:
      sync === "Failed"
        ? present({ kind: "PodcastSync", status: "Failed" })
        : absent(),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "podcast", id: item.id }),
    },
    selected: false,
  };
}
