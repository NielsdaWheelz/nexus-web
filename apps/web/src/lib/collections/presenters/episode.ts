/** Pure semantic projection for one podcast-episode row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type { CollectionRowView } from "@/lib/collections/types";
import { readActivity, type ReadStatus } from "@/lib/collections/readState";
import type {
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  exceptionalStatus,
  type MediaProcessingStatus,
} from "@/lib/status/mediaProcessing";

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
  readonly localAvailability: Presence<LocalAvailability>;
}

const EPISODE_READ_STATE: Record<
  EpisodePresenterItem["episode_state"],
  ReadStatus
> = { unplayed: "unread", in_progress: "in_progress", played: "finished" };

export function presentEpisode(
  item: EpisodePresenterItem,
  ctx: EpisodePresenterContext,
): CollectionRowView {
  const { localAvailability } = ctx;
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
    activity: readActivity(
      {
        read_state: EPISODE_READ_STATE[item.episode_state],
        progressFraction: item.activityFacts.fraction,
      },
      "Listen",
      item.activityFacts,
    ),
    exceptionalStatus: exceptionalStatus(item.processing_status),
    localAvailability,
    connections: absent(),
    relatedMediaId: present(item.id),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: item.id }),
    },
    selected: false,
  };
}
