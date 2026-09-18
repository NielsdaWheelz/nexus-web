/** Pure semantic projection for one followed-podcast row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type {
  CollectionActivity,
  CollectionRowView,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { PodcastSyncStatus } from "@/lib/podcasts/types";

export interface PodcastPresenterItem {
  id: string;
  title: string;
  contributors: ContributorCredit[];
  unplayedCount: Presence<PositiveCount>;
  syncStatus: Presence<PodcastSyncStatus>;
  publicationDate: Presence<PublicationDate>;
}

function exceptionalStatus(
  syncStatus: Presence<PodcastSyncStatus>,
): Presence<ExceptionalStatus> {
  if (syncStatus.kind === "Absent") {
    return absent();
  }
  switch (syncStatus.value) {
    case "Failed":
      return present({ kind: "PodcastSync", status: "Failed" });
    case "Pending":
    case "Running":
    case "Complete":
    case "SourceLimited":
      return absent();
  }
}

function activity(
  syncStatus: Presence<PodcastSyncStatus>,
  unplayedCount: Presence<PositiveCount>,
): Presence<CollectionActivity> {
  if (syncStatus.kind === "Present") {
    switch (syncStatus.value) {
      case "Pending":
      case "Running":
        return present({
          kind: "PodcastSync",
          status: syncStatus.value,
        });
      case "Complete":
      case "SourceLimited":
      case "Failed":
        break;
    }
  }
  return unplayedCount.kind === "Present"
    ? present({ kind: "Unplayed", count: unplayedCount.value })
    : absent();
}

export function presentPodcast(item: PodcastPresenterItem): CollectionRowView {
  const href = `/podcasts/${item.id}`;

  return {
    id: item.id,
    kind: "podcast",
    primary: {
      kind: "link",
      href,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    contributors: item.contributors,
    publicationDate: item.publicationDate,
    context: absent(),
    activity: activity(item.syncStatus, item.unplayedCount),
    exceptionalStatus: exceptionalStatus(item.syncStatus),
    localAvailability: absent(),
    relatedMediaId: absent(),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "podcast", id: item.id }),
    },
    selected: false,
  };
}
