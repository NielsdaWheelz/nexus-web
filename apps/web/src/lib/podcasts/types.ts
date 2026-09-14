import type { Presence } from "@/lib/api/presence";
import { expectOneOf, expectString } from "@/lib/validation";

const PODCAST_SYNC_STATUSES = [
  "Pending",
  "Running",
  "Complete",
  "SourceLimited",
  "Failed",
] as const;

const PODCAST_REFRESH_RUN_STATUSES = [
  "Running",
  "Complete",
  "Partial",
  "Failed",
] as const;

declare const PODCAST_REFRESH_RUN_HANDLE: unique symbol;
const PODCAST_REFRESH_RUN_HANDLE_RE =
  /^prr1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/u;

export type PodcastSyncStatus = (typeof PODCAST_SYNC_STATUSES)[number];

export type PodcastRefreshRunStatus =
  (typeof PODCAST_REFRESH_RUN_STATUSES)[number];

export type PodcastRefreshRunHandle = string & {
  readonly [PODCAST_REFRESH_RUN_HANDLE]: true;
};

export type PodcastRefreshScope =
  | { readonly kind: "Podcast"; readonly podcastId: string }
  | { readonly kind: "Podcasts" }
  | { readonly kind: "Library"; readonly libraryId: string };

export interface PodcastRefreshProgress {
  readonly finishedCount: number;
  readonly requestedCount: number;
}

export interface PodcastRefreshCounts extends PodcastRefreshProgress {
  readonly succeededCount: number;
  readonly sourceLimitedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly newEpisodeCount: number;
}

export interface PodcastRefreshRunSnapshot extends PodcastRefreshCounts {
  readonly refreshRunHandle: PodcastRefreshRunHandle;
  readonly status: PodcastRefreshRunStatus;
  readonly startedAt: string;
  readonly completedAt: Presence<string>;
}

export type PodcastRefreshResult = PodcastRefreshCounts & {
  readonly kind:
    | Exclude<PodcastRefreshRunStatus, "Running">
    | "ObservationLost";
  readonly announcement: string;
};

export function decodePodcastSyncStatus(
  raw: unknown,
  name: string,
): PodcastSyncStatus {
  return expectOneOf(raw, PODCAST_SYNC_STATUSES, name);
}

export function decodePodcastRefreshRunStatus(
  raw: unknown,
  name: string,
): PodcastRefreshRunStatus {
  return expectOneOf(raw, PODCAST_REFRESH_RUN_STATUSES, name);
}

export function decodePodcastRefreshRunHandle(
  raw: unknown,
  name: string,
): PodcastRefreshRunHandle {
  const value = expectString(raw, name);
  if (!PODCAST_REFRESH_RUN_HANDLE_RE.test(value)) {
    throw new TypeError(`${name} has invalid sealed-handle grammar`);
  }
  return value as PodcastRefreshRunHandle;
}
