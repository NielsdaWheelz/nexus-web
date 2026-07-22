/** Pure semantic projection for one followed-podcast row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import type {
  CollectionRowView,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import type { PodcastSyncStatus } from "@/lib/status/podcastSync";

export interface PodcastPresenterItem {
  id: string;
  title: string;
  contributors: ContributorCredit[];
  unplayedCount: Presence<PositiveCount>;
  syncStatus: Presence<PodcastSyncStatus>;
  publicationDate: Presence<PublicationDate>;
}

export type PodcastPresenterContext = Parameters<typeof podcastResourceOptions>[0] & {
  connectionSummary?: ConnectionSummaryOut;
};

function exceptionalStatus(
  syncStatus: Presence<PodcastSyncStatus>,
): Presence<ExceptionalStatus> {
  if (syncStatus.kind === "Absent" || syncStatus.value === "complete") {
    return absent();
  }
  return present({ kind: "PodcastSync", status: syncStatus.value });
}

export function presentPodcast(
  item: PodcastPresenterItem,
  ctx: PodcastPresenterContext,
): CollectionRowView {
  const { connectionSummary, ...actionCtx } = ctx;

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
      item.unplayedCount.kind === "Present"
        ? present({ kind: "Unplayed", count: item.unplayedCount.value })
        : absent(),
    exceptionalStatus: exceptionalStatus(item.syncStatus),
    connections: connectionsFromSummary(connectionSummary),
    relatedMediaId: absent(),
    actions: podcastResourceOptions(actionCtx),
    selected: false,
  };
}
