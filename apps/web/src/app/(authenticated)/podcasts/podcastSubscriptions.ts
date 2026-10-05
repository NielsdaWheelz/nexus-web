import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import {
  decodeCollectionCursor,
  decodeCollectionRevision,
  type CollectionPage,
} from "@/lib/api/collectionPage";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { decodePresence, type Presence } from "@/lib/api/presence";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { decodePodcastUnplayedCount } from "@/lib/podcasts/activityFacts";
import {
  publishPodcastSubscriptionUnsubscribed,
  runPodcastSubscriptionSettingsMutation,
} from "@/lib/podcasts/subscriptionSettings";
import type { PodcastSyncStatus } from "@/lib/podcasts/types";

export type PodcastBackfillRecord = Schema<"PodcastBackfillOut">;
export type PodcastDetailResponse = Schema<"PodcastDetailOut">;

export type PodcastSubscriptionListItem = Schema<"PodcastSubscriptionListItemOut"> & {
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
};

export function podcastSubscriptionPageFromWire(
  page: ApiJson<"/podcasts/subscriptions", "get">["data"],
): CollectionPage<PodcastSubscriptionListItem> {
  return decodeApiPayload(
    page,
    (body) => ({
      items: body.items.map<PodcastSubscriptionListItem>((item) => ({
        ...item,
        unplayedCount: decodePodcastUnplayedCount(item.unplayed_count),
        publicationDate:
          item.latest_episode_published_at.kind === "Present"
            ? decodeOptionalPublicationDate(
                item.latest_episode_published_at.value,
                "podcast latest_episode_published_at",
              )
            : { kind: "Absent" },
        syncStatus: { kind: "Present", value: item.sync_status },
      })),
      collectionRevision: decodeCollectionRevision(body.collectionRevision),
      nextCursor: decodePresence(body.nextCursor, decodeCollectionCursor),
    }),
    "Podcast subscriptions",
  );
}

export async function retryPodcastSubscriptionBackfill(
  podcastId: string,
): Promise<ApiJson<"/podcasts/subscriptions/{podcast_id}/backfill/retry", "post">["data"]> {
  const response = await apiFetch<
    ApiJson<"/podcasts/subscriptions/{podcast_id}/backfill/retry", "post">
  >(`/api/podcasts/subscriptions/${podcastId}/backfill/retry`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  return response.data;
}

export async function unsubscribeFromPodcast(podcastId: string): Promise<void> {
  return runPodcastSubscriptionSettingsMutation(async () => {
    await apiFetch<ApiJson<"/podcasts/subscriptions/{podcast_id}", "delete">>(
      `/api/podcasts/subscriptions/${podcastId}`,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    publishLibraryPlacementChange("Unknown");
    await publishPodcastSubscriptionUnsubscribed(podcastId);
  });
}
