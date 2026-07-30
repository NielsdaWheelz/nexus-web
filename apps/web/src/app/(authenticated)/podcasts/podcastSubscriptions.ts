import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePresence, type Presence } from "@/lib/api/presence";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { decodePodcastUnplayedCount } from "@/lib/podcasts/activityFacts";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";
import { pluralize } from "@/lib/text/pluralize";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/status/podcastSync";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectNullableString,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

export type PodcastSubscriptionSyncStatus = PodcastSyncStatus;

export type PodcastBackfillState =
  "Pending" | "Running" | "Complete" | "SourceLimited" | "Failed";

export type PodcastBackfillRecord = {
  id: string;
  state: PodcastBackfillState;
  processed_count: number;
  added_count: number;
};

export type PodcastBackfill = {
  id: string;
  state: PodcastBackfillState;
  processedCount: number;
  addedCount: number;
};

export type PodcastSummary = {
  id: string;
  provider: string;
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type PodcastSubscriptionRecord = {
  podcast_id: string;
  default_playback_speed?: number | null;
  auto_queue?: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  backfill: PodcastBackfillRecord;
};

type PodcastSubscriptionDetail = PodcastSubscriptionRecord & {
  user_id: string;
};

export type PodcastDetailResponse = {
  podcast: PodcastSummary;
  subscription: PodcastSubscriptionDetail | null;
};

function decodePodcastBackfillState(
  raw: unknown,
  context: string,
): PodcastBackfillState {
  const state = expectString(raw, context);
  if (
    state !== "Pending" &&
    state !== "Running" &&
    state !== "Complete" &&
    state !== "SourceLimited" &&
    state !== "Failed"
  ) {
    throw new TypeError(`${context} is invalid`);
  }
  return state;
}

function decodePodcastBackfillRecord(
  raw: unknown,
  context: string,
): PodcastBackfillRecord {
  const value = expectExactRecord(
    raw,
    ["id", "state", "processed_count", "added_count"],
    context,
  );
  return {
    id: expectString(value.id, `${context}.id`),
    state: decodePodcastBackfillState(value.state, `${context}.state`),
    processed_count: expectNonnegativeInteger(
      value.processed_count,
      `${context}.processed_count`,
    ),
    added_count: expectNonnegativeInteger(
      value.added_count,
      `${context}.added_count`,
    ),
  };
}

export function decodePodcastDetailResponse(
  raw: unknown,
): PodcastDetailResponse {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastDetailResponse").data,
    ["podcast", "subscription"],
    "PodcastDetailResponse.data",
  );
  const podcast = expectExactRecord(
    data.podcast,
    [
      "id",
      "provider",
      "provider_podcast_id",
      "title",
      "contributors",
      "feed_url",
      "website_url",
      "image_url",
      "description",
      "created_at",
      "updated_at",
    ],
    "PodcastDetailResponse.podcast",
  );
  const subscription =
    data.subscription === null
      ? null
      : expectExactRecord(
          data.subscription,
          [
            "user_id",
            "podcast_id",
            "default_playback_speed",
            "auto_queue",
            "sync_status",
            "sync_error_code",
            "sync_error_message",
            "sync_attempts",
            "sync_started_at",
            "sync_completed_at",
            "last_synced_at",
            "updated_at",
            "backfill",
          ],
          "PodcastDetailResponse.subscription",
        );
  return {
    podcast: {
      id: expectString(podcast.id, "podcast.id"),
      provider: expectString(podcast.provider, "podcast.provider"),
      provider_podcast_id: expectString(
        podcast.provider_podcast_id,
        "podcast.provider_podcast_id",
      ),
      title: expectString(podcast.title, "podcast.title"),
      contributors: expectArray(
        podcast.contributors,
        (credit, index) =>
          decodeContributorCredit(credit, index, "Podcast detail contributors"),
        "podcast.contributors",
      ),
      feed_url: expectString(podcast.feed_url, "podcast.feed_url"),
      website_url: expectNullableString(
        podcast.website_url,
        "podcast.website_url",
      ),
      image_url: expectNullableString(podcast.image_url, "podcast.image_url"),
      description: expectNullableString(
        podcast.description,
        "podcast.description",
      ),
      created_at: expectString(podcast.created_at, "podcast.created_at"),
      updated_at: expectString(podcast.updated_at, "podcast.updated_at"),
    },
    subscription:
      subscription === null
        ? null
        : {
            user_id: expectString(subscription.user_id, "subscription.user_id"),
            podcast_id: expectString(
              subscription.podcast_id,
              "subscription.podcast_id",
            ),
            default_playback_speed:
              subscription.default_playback_speed === null
                ? null
                : expectFiniteNumber(
                    subscription.default_playback_speed,
                    "subscription.default_playback_speed",
                  ),
            auto_queue: expectBoolean(
              subscription.auto_queue,
              "subscription.auto_queue",
            ),
            sync_status: decodePodcastSyncStatus(
              subscription.sync_status,
              "subscription.sync_status",
            ),
            sync_error_code: expectNullableString(
              subscription.sync_error_code,
              "subscription.sync_error_code",
            ),
            sync_error_message: expectNullableString(
              subscription.sync_error_message,
              "subscription.sync_error_message",
            ),
            sync_attempts: expectNonnegativeInteger(
              subscription.sync_attempts,
              "subscription.sync_attempts",
            ),
            sync_started_at: expectNullableString(
              subscription.sync_started_at,
              "subscription.sync_started_at",
            ),
            sync_completed_at: expectNullableString(
              subscription.sync_completed_at,
              "subscription.sync_completed_at",
            ),
            last_synced_at: expectNullableString(
              subscription.last_synced_at,
              "subscription.last_synced_at",
            ),
            updated_at: expectString(
              subscription.updated_at,
              "subscription.updated_at",
            ),
            backfill: decodePodcastBackfillRecord(
              subscription.backfill,
              "subscription.backfill",
            ),
          },
  };
}

export type PodcastSubscriptionListItemWire = {
  podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  unplayed_count: number;
  latest_episode_published_at: Presence<string>;
  default_playback_speed: Presence<number>;
  auto_queue: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
};

export type PodcastSubscriptionListItem = PodcastSubscriptionListItemWire & {
  defaultPlaybackSpeed: number | null;
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
};

export function decodePodcastSubscriptionListItem(
  raw: unknown,
): PodcastSubscriptionListItem {
  const item = expectExactRecord(
    raw,
    [
      "podcast_id",
      "title",
      "contributors",
      "unplayed_count",
      "latest_episode_published_at",
      "default_playback_speed",
      "auto_queue",
      "sync_status",
    ],
    "PodcastSubscriptionListItem",
  );
  const latestEpisodePublishedAt = decodePresence(
    item.latest_episode_published_at,
    (value) => expectString(value, "latest_episode_published_at.value"),
  );
  const defaultPlaybackSpeed = decodePresence(
    item.default_playback_speed,
    (value) => expectFiniteNumber(value, "default_playback_speed.value"),
  );
  const syncStatus = decodePodcastSyncStatus(
    item.sync_status,
    "podcast sync_status",
  );
  const wire: PodcastSubscriptionListItemWire = {
    podcast_id: expectString(item.podcast_id, "podcast_id"),
    title: expectString(item.title, "title"),
    contributors: expectArray(
      item.contributors,
      (credit, index) =>
        decodeContributorCredit(
          credit,
          index,
          "Podcast subscription contributors",
        ),
      "contributors",
    ),
    unplayed_count: expectNonnegativeInteger(
      item.unplayed_count,
      "unplayed_count",
    ),
    latest_episode_published_at: latestEpisodePublishedAt,
    default_playback_speed: defaultPlaybackSpeed,
    auto_queue: expectBoolean(item.auto_queue, "auto_queue"),
    sync_status: syncStatus,
  };
  return {
    ...wire,
    defaultPlaybackSpeed:
      defaultPlaybackSpeed.kind === "Present"
        ? defaultPlaybackSpeed.value
        : null,
    unplayedCount: decodePodcastUnplayedCount(wire.unplayed_count),
    publicationDate:
      latestEpisodePublishedAt.kind === "Present"
        ? decodeOptionalPublicationDate(
            latestEpisodePublishedAt.value,
            "podcast latest_episode_published_at",
          )
        : { kind: "Absent" },
    syncStatus: {
      kind: "Present",
      value: syncStatus,
    },
  };
}

type PodcastSubscriptionSettingsFields = Pick<
  PodcastSubscriptionRecord,
  "default_playback_speed" | "auto_queue"
>;

type PodcastSubscriptionSettingsDraft = {
  defaultSpeed: string;
  autoQueue: boolean;
};

export type PodcastSubscriptionSettingsResponse = {
  user_id: string;
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  backfill: PodcastBackfill;
  collectionRevision: CollectionRevision;
  libraryEntriesCollectionRevision: CollectionRevision;
};

export type PodcastBackfillRetryResult = {
  podcastId: string;
  outcome: "Retried" | "NotEligible";
  backfill: PodcastBackfill;
};

export type PodcastSubscriptionSyncRefreshResult = {
  podcast_id: string;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
  collectionRevision: CollectionRevision;
  libraryEntriesCollectionRevision: CollectionRevision;
};

export type PodcastUnsubscribeResult =
  | {
      readonly outcome: "Unsubscribed";
      readonly podcast_id: string;
      readonly removed_placement_count: number;
      readonly retained_shared_count: number;
      readonly collectionRevision: CollectionRevision;
      readonly libraryEntriesCollectionRevision: CollectionRevision;
    }
  | {
      readonly outcome: "AlreadyUnsubscribed";
      readonly podcast_id: string;
      readonly collectionRevision: CollectionRevision;
      readonly libraryEntriesCollectionRevision: CollectionRevision;
    };

export function getPodcastSubscriptionSettingsDraft(
  subscription: PodcastSubscriptionSettingsFields | null | undefined,
): PodcastSubscriptionSettingsDraft {
  return {
    defaultSpeed:
      subscription?.default_playback_speed == null
        ? "default"
        : String(subscription.default_playback_speed),
    autoQueue: Boolean(subscription?.auto_queue),
  };
}

export function parsePodcastSubscriptionDefaultPlaybackSpeed(
  value: string,
): number | null {
  return value === "default" ? null : Number.parseFloat(value);
}

export function getPodcastSubscriptionSyncPatch(
  result: PodcastSubscriptionSyncRefreshResult,
) {
  return {
    sync_status: result.sync_status,
    sync_error_code: result.sync_error_code,
    sync_error_message: result.sync_error_message,
    sync_attempts: result.sync_attempts,
  };
}

export function getPodcastSubscriptionSettingsPatch({
  response,
  updatedAt,
}: {
  response: PodcastSubscriptionSettingsResponse;
  updatedAt: string;
}) {
  return {
    default_playback_speed: response.default_playback_speed,
    auto_queue: response.auto_queue,
    updated_at: response.updated_at ?? updatedAt,
  };
}

function decodePodcastSubscriptionSyncRefreshResult(
  raw: unknown,
): PodcastSubscriptionSyncRefreshResult {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastSubscriptionSyncRefreshResult")
      .data,
    [
      "podcast_id",
      "sync_status",
      "sync_error_code",
      "sync_error_message",
      "sync_attempts",
      "sync_enqueued",
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastSubscriptionSyncRefreshResult.data",
  );
  return {
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    sync_status: decodePodcastSyncStatus(data.sync_status, "sync_status"),
    sync_error_code: expectNullableString(
      data.sync_error_code,
      "sync_error_code",
    ),
    sync_error_message: expectNullableString(
      data.sync_error_message,
      "sync_error_message",
    ),
    sync_attempts: expectNonnegativeInteger(
      data.sync_attempts,
      "sync_attempts",
    ),
    sync_enqueued: expectBoolean(data.sync_enqueued, "sync_enqueued"),
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
}

function decodePodcastSubscriptionSettingsResponse(
  raw: unknown,
): PodcastSubscriptionSettingsResponse {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastSubscriptionSettingsResponse")
      .data,
    [
      "user_id",
      "podcast_id",
      "default_playback_speed",
      "auto_queue",
      "sync_status",
      "sync_error_code",
      "sync_error_message",
      "sync_attempts",
      "sync_started_at",
      "sync_completed_at",
      "last_synced_at",
      "updated_at",
      "backfill",
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastSubscriptionSettingsResponse.data",
  );
  return {
    user_id: expectString(data.user_id, "user_id"),
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    default_playback_speed:
      data.default_playback_speed === null
        ? null
        : expectFiniteNumber(
            data.default_playback_speed,
            "default_playback_speed",
          ),
    auto_queue: expectBoolean(data.auto_queue, "auto_queue"),
    sync_status: decodePodcastSyncStatus(data.sync_status, "sync_status"),
    sync_error_code: expectNullableString(
      data.sync_error_code,
      "sync_error_code",
    ),
    sync_error_message: expectNullableString(
      data.sync_error_message,
      "sync_error_message",
    ),
    sync_attempts: expectNonnegativeInteger(
      data.sync_attempts,
      "sync_attempts",
    ),
    sync_started_at: expectNullableString(
      data.sync_started_at,
      "sync_started_at",
    ),
    sync_completed_at: expectNullableString(
      data.sync_completed_at,
      "sync_completed_at",
    ),
    last_synced_at: expectNullableString(data.last_synced_at, "last_synced_at"),
    updated_at: expectString(data.updated_at, "updated_at"),
    backfill: decodePodcastBackfill(data.backfill, "backfill"),
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
}

function decodePodcastBackfill(raw: unknown, context: string): PodcastBackfill {
  const value = expectExactRecord(
    raw,
    ["id", "state", "processedCount", "addedCount"],
    context,
  );
  return {
    id: expectString(value.id, `${context}.id`),
    state: decodePodcastBackfillState(value.state, `${context}.state`),
    processedCount: expectNonnegativeInteger(
      value.processedCount,
      `${context}.processedCount`,
    ),
    addedCount: expectNonnegativeInteger(
      value.addedCount,
      `${context}.addedCount`,
    ),
  };
}

function decodePodcastBackfillRetryResult(
  raw: unknown,
): PodcastBackfillRetryResult {
  const data = expectExactRecord(
    expectExactRecord(raw, ["data"], "PodcastBackfillRetryResult").data,
    ["podcastId", "outcome", "backfill"],
    "PodcastBackfillRetryResult.data",
  );
  const outcome = expectString(data.outcome, "outcome");
  if (outcome !== "Retried" && outcome !== "NotEligible") {
    throw new TypeError("Podcast backfill Retry outcome is invalid");
  }
  return {
    podcastId: expectString(data.podcastId, "podcastId"),
    outcome,
    backfill: decodePodcastBackfill(data.backfill, "backfill"),
  };
}

export async function refreshPodcastSubscriptionSync(
  podcastId: string,
): Promise<PodcastSubscriptionSyncRefreshResult> {
  return decodePodcastSubscriptionSyncRefreshResult(
    await apiFetch<unknown>(`/api/podcasts/subscriptions/${podcastId}/sync`, {
      method: "POST",
    }),
  );
}

export async function savePodcastSubscriptionSettings(
  podcastId: string,
  {
    defaultPlaybackSpeed,
    autoQueue,
  }: {
    defaultPlaybackSpeed: number | null;
    autoQueue: boolean;
  },
): Promise<PodcastSubscriptionSettingsResponse> {
  return decodePodcastSubscriptionSettingsResponse(
    await apiFetch<unknown>(
      `/api/podcasts/subscriptions/${podcastId}/settings`,
      {
        method: "PATCH",
        body: JSON.stringify({
          default_playback_speed: defaultPlaybackSpeed,
          auto_queue: autoQueue,
        }),
      },
    ),
  );
}

export async function retryPodcastSubscriptionBackfill(
  podcastId: string,
): Promise<PodcastBackfillRetryResult> {
  return decodePodcastBackfillRetryResult(
    await apiFetch<unknown>(
      `/api/podcasts/subscriptions/${podcastId}/backfill/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    ),
  );
}

export async function unsubscribeFromPodcast(
  podcastId: string,
): Promise<PodcastUnsubscribeResult> {
  const response = await apiFetch<unknown>(
    `/api/podcasts/subscriptions/${podcastId}`,
    {
      method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
  const envelope = expectExactRecord(
    response,
    ["data"],
    "PodcastUnsubscribeResult",
  );
  const data = expectExactRecord(
    envelope.data,
    Object.prototype.hasOwnProperty.call(
      envelope.data,
      "removed_placement_count",
    )
      ? [
          "outcome",
          "podcast_id",
          "removed_placement_count",
          "retained_shared_count",
          "collectionRevision",
          "libraryEntriesCollectionRevision",
        ]
      : [
          "outcome",
          "podcast_id",
          "collectionRevision",
          "libraryEntriesCollectionRevision",
        ],
    "PodcastUnsubscribeResult.data",
  );
  const outcome = expectString(data.outcome, "outcome");
  const common = {
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
  const result: PodcastUnsubscribeResult =
    outcome === "Unsubscribed"
      ? {
          outcome,
          ...common,
          removed_placement_count: expectNonnegativeInteger(
            data.removed_placement_count,
            "removed_placement_count",
          ),
          retained_shared_count: expectNonnegativeInteger(
            data.retained_shared_count,
            "retained_shared_count",
          ),
        }
      : outcome === "AlreadyUnsubscribed"
        ? { outcome, ...common }
        : (() => {
            throw new TypeError("Podcast unsubscribe outcome is invalid");
          })();
  publishLibraryPlacementChange("Unknown");
  return result;
}

export function buildPodcastUnsubscribeConfirmation(
  title: string,
  libraries: readonly LibraryPlacementOption[],
): string {
  const removableLibraries = libraries.filter(
    (library) => library.isInLibrary && library.canRemove,
  );
  const retainedLibraries = libraries.filter(
    (library) => library.isInLibrary && !library.canRemove,
  );
  const confirmationLines = [
    `Unsubscribe from "${title}"?`,
    removableLibraries.length === 0
      ? "This podcast is not in any libraries you can change."
      : `This will remove the podcast from ${pluralize(removableLibraries.length, "library", "libraries")}.`,
  ];
  if (retainedLibraries.length > 0) {
    confirmationLines.push(
      `It will remain in ${pluralize(retainedLibraries.length, "shared library", "shared libraries")} you cannot administer.`,
    );
  }
  return confirmationLines.join("\n\n");
}
