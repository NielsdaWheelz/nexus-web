import type { Schema } from "@/lib/api/wire";

export type PodcastSyncStatus = Schema<"PodcastSubscriptionStatusOut">["sync_status"];

export type PodcastBackfillState = Schema<"PodcastBackfillOut">["state"];

export type PodcastRefreshScope =
  | Schema<"PodcastRefreshPodcastScope">
  | Schema<"PodcastRefreshPodcastsScope">
  | Schema<"PodcastRefreshLibraryScope">;
