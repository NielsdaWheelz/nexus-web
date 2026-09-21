import { expectOneOf } from "@/lib/validation";

const PODCAST_SYNC_STATUSES = [
  "Pending",
  "Running",
  "Complete",
  "SourceLimited",
  "Failed",
] as const;

const PODCAST_BACKFILL_STATES = [
  "Pending",
  "Running",
  "Complete",
  "SourceLimited",
  "Failed",
] as const;

export type PodcastSyncStatus = (typeof PODCAST_SYNC_STATUSES)[number];

export type PodcastBackfillState = (typeof PODCAST_BACKFILL_STATES)[number];

export type PodcastRefreshScope =
  | { readonly kind: "Podcast"; readonly podcastId: string }
  | { readonly kind: "Podcasts" }
  | { readonly kind: "Library"; readonly libraryId: string };

export interface PodcastRefreshProgress {
  readonly finishedCount: number;
  readonly requestedCount: number;
}

export interface PodcastRefreshResult {
  readonly kind: "Complete" | "Failed";
  readonly announcement: string;
}

export function decodePodcastSyncStatus(
  raw: unknown,
  name: string,
): PodcastSyncStatus {
  return expectOneOf(raw, PODCAST_SYNC_STATUSES, name);
}

export function decodePodcastBackfillState(
  raw: unknown,
  name: string,
): PodcastBackfillState {
  return expectOneOf(raw, PODCAST_BACKFILL_STATES, name);
}
