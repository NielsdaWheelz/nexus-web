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
  status: "active" | "unsubscribed";
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
};

type PodcastSubscriptionDetail = PodcastSubscriptionRecord & {
  user_id: string;
};

export type PodcastDetailResponse = {
  podcast: PodcastSummary;
  subscription: PodcastSubscriptionDetail | null;
};

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
  status: "active" | "unsubscribed";
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
  collectionRevision: CollectionRevision;
  libraryEntriesCollectionRevision: CollectionRevision;
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

export type PodcastUnsubscribeResult = {
  podcast_id: string;
  status: "unsubscribed";
  removed_from_library_count: number;
  retained_shared_library_count: number;
  collectionRevision: CollectionRevision;
  libraryEntriesCollectionRevision: CollectionRevision;
};

type PodcastSubscribeInput = {
  provider_podcast_id: string;
  title: string;
  contributors: ContributorCredit[];
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  library_ids: string[];
};

export type PodcastSubscribeResult = {
  podcast_id: string;
  subscription_created: boolean;
  sync_status: PodcastSubscriptionSyncStatus;
  sync_enqueued: boolean;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  last_synced_at: string | null;
  window_size: number;
};

// v2 subscribe payload (D-4): the strict snake-case `ContributorCreditIn`. The
// server owns ordinal (list order), source, source_ref, and confidence — the
// client sends only the observed credit facts.
type ContributorCreditInput = {
  credited_name: string;
  role: string;
  raw_role?: string;
};

export function toPodcastContributorInputs(
  contributors: ContributorCredit[],
): ContributorCreditInput[] {
  return contributors.map((credit) => {
    const creditedName = credit.credited_name.trim();
    const role = credit.role?.trim();
    if (!creditedName || !role) {
      throw new Error("Contributor credit payload is malformed");
    }

    return {
      credited_name: creditedName,
      role,
      ...(credit.raw_role?.trim() ? { raw_role: credit.raw_role.trim() } : {}),
    };
  });
}

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
      "status",
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
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastSubscriptionSettingsResponse.data",
  );
  const status = expectString(data.status, "status");
  if (status !== "active" && status !== "unsubscribed") {
    throw new TypeError("Podcast subscription settings status is invalid");
  }
  return {
    user_id: expectString(data.user_id, "user_id"),
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    status,
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
    last_synced_at: expectNullableString(
      data.last_synced_at,
      "last_synced_at",
    ),
    updated_at: expectString(data.updated_at, "updated_at"),
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
}

export async function refreshPodcastSubscriptionSync(
  podcastId: string,
): Promise<PodcastSubscriptionSyncRefreshResult> {
  return decodePodcastSubscriptionSyncRefreshResult(
    await apiFetch<unknown>(
      `/api/podcasts/subscriptions/${podcastId}/sync`,
      { method: "POST" },
    ),
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

export async function unsubscribeFromPodcast(
  podcastId: string,
): Promise<PodcastUnsubscribeResult> {
  const response = await apiFetch<unknown>(
    `/api/podcasts/subscriptions/${podcastId}`,
    {
      method: "DELETE",
    },
  );
  const envelope = expectExactRecord(
    response,
    ["data"],
    "PodcastUnsubscribeResult",
  );
  const data = expectExactRecord(
    envelope.data,
    [
      "podcast_id",
      "status",
      "removed_from_library_count",
      "retained_shared_library_count",
      "collectionRevision",
      "libraryEntriesCollectionRevision",
    ],
    "PodcastUnsubscribeResult.data",
  );
  const collectionRevision = expectNonnegativeInteger(
    data.collectionRevision,
    "PodcastUnsubscribeResult.data.collectionRevision",
  );
  if (!Number.isSafeInteger(collectionRevision)) {
    throw new Error("Podcast unsubscribe revision must be a safe integer");
  }
  const status = expectString(data.status, "status");
  if (status !== "unsubscribed") {
    throw new Error("Podcast unsubscribe status is invalid");
  }
  const result: PodcastUnsubscribeResult = {
    podcast_id: expectString(data.podcast_id, "podcast_id"),
    status,
    removed_from_library_count: expectNonnegativeInteger(
      data.removed_from_library_count,
      "removed_from_library_count",
    ),
    retained_shared_library_count: expectNonnegativeInteger(
      data.retained_shared_library_count,
      "retained_shared_library_count",
    ),
    collectionRevision: collectionRevision as CollectionRevision,
    libraryEntriesCollectionRevision: decodeCollectionRevision(
      data.libraryEntriesCollectionRevision,
    ),
  };
  publishLibraryPlacementChange("Unknown");
  return result;
}

export async function subscribeToPodcast(
  input: PodcastSubscribeInput,
): Promise<PodcastSubscribeResult> {
  const response = await apiFetch<{ data: PodcastSubscribeResult }>(
    "/api/podcasts/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        ...input,
        contributors: toPodcastContributorInputs(input.contributors),
      }),
    },
  );
  publishLibraryPlacementChange([...input.library_ids]);
  return response.data;
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
