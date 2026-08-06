/** Pure semantic projection for one podcast-episode row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type {
  CollectionActivity,
  CollectionRowView,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";

export interface EpisodePresenterItem {
  id: string;
  title: string;
  kind: string;
  processing_status: MediaProcessingStatus;
  episode_state: "unplayed" | "in_progress" | "played";
  canonical_source_url: string | null;
  offline_download_eligible: boolean;
  contributors: ContributorCredit[];
  capabilities?: unknown;
  publicationDate: Presence<PublicationDate>;
  activityFacts: {
    totalMinutes: Presence<PositiveMinutes>;
    fraction: Presence<ProgressFraction>;
    remainingMinutes: Presence<PositiveMinutes>;
  };
}

export interface EpisodePresenterContext {
  readonly connectionSummary?: ConnectionSummaryOut;
  readonly localAvailability: Presence<LocalAvailability>;
}

function episodeActivity(
  item: EpisodePresenterItem,
): Presence<CollectionActivity> {
  switch (item.episode_state) {
    case "unplayed":
      return present({
        kind: "Unread",
        modality: "Listen",
        totalMinutes: item.activityFacts.totalMinutes,
      });
    case "in_progress": {
      const facts = item.activityFacts;
      if (facts.fraction.kind === "Present") {
        return present({
          kind: "InProgress",
          modality: "Listen",
          fraction: facts.fraction,
          remainingMinutes: facts.remainingMinutes,
        });
      }
      if (facts.remainingMinutes.kind === "Absent") {
        return absent();
      }
      return present({
        kind: "InProgress",
        modality: "Listen",
        fraction: facts.fraction,
        remainingMinutes: facts.remainingMinutes,
      });
    }
    case "played":
      return present({ kind: "Finished", modality: "Listen" });
    default: {
      const exhaustive: never = item.episode_state;
      throw new Error(`Unsupported episode state: ${exhaustive}`);
    }
  }
}

function exceptionalStatus(
  status: MediaProcessingStatus,
): Presence<ExceptionalStatus> {
  return status === "ready_for_reading"
    ? absent()
    : present({ kind: "MediaProcessing", status });
}

export function presentEpisode(
  item: EpisodePresenterItem,
  ctx: EpisodePresenterContext,
): CollectionRowView {
  const { connectionSummary, localAvailability } = ctx;
  const href = `/media/${item.id}`;

  return {
    id: item.id,
    kind: "podcast_episode",
    primary: {
      kind: "link",
      href,
      paneLabelHint: item.title,
      viewTransition: "media-reader",
    },
    title: { text: item.title },
    contributors: item.contributors,
    publicationDate: item.publicationDate,
    context: absent(),
    activity: episodeActivity(item),
    exceptionalStatus: exceptionalStatus(item.processing_status),
    localAvailability,
    connections: connectionsFromSummary(connectionSummary),
    relatedMediaId: present(item.id),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: item.id }),
    },
    selected: false,
  };
}
