import { decodeApiPayload } from "@/lib/api/client";
import {
  decodeCollectionCursor,
  decodeCollectionRevision,
  type CollectionPage,
} from "@/lib/api/collectionPage";
import { decodePresence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { mediaSummaryFromWire, type MediaSummary } from "@/lib/media/mediaSummary";
import {
  canRequestTranscript,
  shouldPollTranscriptProvisioning,
} from "@/lib/media/transcriptView";
import type { EpisodeStateFilter } from "@/lib/podcasts/episodeView";

export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;

export type TranscriptRequestReason = "search" | "highlight" | "quote";

export const EPISODE_WIDE_COMMAND_LABELS = {
  all: {
    transcript: "Transcribe all episodes",
    markPlayed: "Mark all episodes as played",
  },
  unplayed: {
    transcript: "Transcribe all unplayed episodes",
    markPlayed: "Mark all unplayed episodes as played",
  },
  in_progress: {
    transcript: "Transcribe all in-progress episodes",
    markPlayed: "Mark all in-progress episodes as played",
  },
  played: {
    transcript: "Transcribe all played episodes",
    markPlayed: "All played episodes are already played",
  },
} as const satisfies Record<
  EpisodeStateFilter,
  { readonly transcript: string; readonly markPlayed: string }
>;

export type PodcastEpisodeMedia = Omit<
  Schema<"PodcastEpisodeListItemOut">,
  "mediaSummary"
> & {
  mediaSummary: MediaSummary;
  /** Lazy detail enrichment; absent from the compact list wire. */
  description_text: string | null;
};

export function podcastEpisodePageFromWire(
  page: ApiJson<"/podcasts/{podcast_id}/episodes", "get">["data"],
): CollectionPage<PodcastEpisodeMedia> {
  return decodeApiPayload(
    page,
    (body) => ({
      items: body.items.map((item) => ({
        ...item,
        mediaSummary: mediaSummaryFromWire(item.mediaSummary),
        description_text: null,
      })),
      collectionRevision: decodeCollectionRevision(body.collectionRevision),
      nextCursor: decodePresence(body.nextCursor, decodeCollectionCursor),
    }),
    "Podcast episodes",
  );
}

export function canRequestTranscriptForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  return canRequestTranscript(episode.transcript_state);
}

export function shouldPollTranscriptProvisioningForEpisode(
  episode: PodcastEpisodeMedia,
): boolean {
  return shouldPollTranscriptProvisioning(episode.transcript_state);
}
