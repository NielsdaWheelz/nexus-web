import type { Presence } from "@/lib/api/presence";
import type {
  PositiveCount,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaActionCapabilities } from "@/lib/media/ingestionClient";
import type { PodcastSyncStatus } from "@/lib/status/podcastSync";
import {
  decodeLibraryReadingTimeEntry,
  type LibraryMediaKind,
  type ReadingTimeEstimatePresence,
} from "@/lib/libraries/readingTime";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

const MEDIA_KINDS = [
  "web_article",
  "epub",
  "pdf",
  "podcast_episode",
  "video",
] as const;
const PROCESSING_STATUSES = [
  "pending",
  "extracting",
  "ready_for_reading",
  "failed",
  "suspended",
] as const;
const READ_STATES = ["unread", "in_progress", "finished"] as const;
const AUTHOR_MODES = ["automatic", "manual"] as const;
const SUBSCRIPTION_STATUSES = ["active", "unsubscribed"] as const;
const SYNC_STATUSES = [
  "pending",
  "running",
  "partial",
  "complete",
  "source_limited",
  "failed",
] as const;

export interface LibraryMediaListValue {
  readonly id: string;
  readonly kind: LibraryMediaKind;
  readonly title: string;
  readonly created_at: string;
  readonly contributors: ContributorCredit[];
  readonly author_mode: "automatic" | "manual";
  readonly published_date: string | null;
  readonly publicationDate: Presence<PublicationDate>;
  readonly canonical_source_url: string | null;
  readonly sourceHost: Presence<string>;
  readonly processing_status: (typeof PROCESSING_STATUSES)[number];
  readonly read_state: "unread" | "in_progress" | "finished";
  readonly progress_fraction: number | null;
  readonly progressFraction: Presence<ProgressFraction>;
  readonly progress_resettable: boolean;
  readonly last_engaged_at: string | null;
  readonly capabilities: Pick<
    MediaActionCapabilities,
    | "can_quote"
    | "can_retry"
    | "can_refresh_source"
    | "can_retry_metadata"
    | "can_edit_authors"
    | "can_delete"
  >;
}

export interface LibraryPodcastListValue {
  readonly id: string;
  readonly title: string;
  readonly contributors: ContributorCredit[];
  readonly unplayed_count: number;
  readonly unplayedCount: Presence<PositiveCount>;
  readonly publicationDate: Presence<PublicationDate>;
  readonly syncStatus: Presence<PodcastSyncStatus>;
}

export interface LibraryPodcastSubscriptionValue {
  readonly status: "active" | "unsubscribed";
  readonly default_playback_speed: number | null;
  readonly auto_queue: boolean;
  readonly sync_status: (typeof SYNC_STATUSES)[number];
}

interface LibraryEntryBase {
  readonly id: string;
  readonly position: number;
  readonly created_at: string;
  readonly readingTimeEstimate: ReadingTimeEstimatePresence;
}

export interface LibraryMediaListItem extends LibraryEntryBase {
  readonly kind: "media";
  readonly media: LibraryMediaListValue;
}

export interface LibraryPodcastListItem extends LibraryEntryBase {
  readonly kind: "podcast";
  readonly podcast: LibraryPodcastListValue;
  readonly subscription: LibraryPodcastSubscriptionValue | null;
}

export type LibraryEntryListItem =
  | LibraryMediaListItem
  | LibraryPodcastListItem;

type LibraryMediaListWire = Omit<
  LibraryMediaListValue,
  "publicationDate" | "sourceHost" | "progressFraction"
>;
type LibraryPodcastListWire = Omit<
  LibraryPodcastListValue,
  "unplayedCount" | "publicationDate" | "syncStatus"
>;

function decodeMedia(raw: unknown): LibraryMediaListWire {
  const media = expectExactRecord(
    raw,
    [
      "id",
      "kind",
      "title",
      "created_at",
      "contributors",
      "author_mode",
      "published_date",
      "canonical_source_url",
      "processing_status",
      "read_state",
      "progress_fraction",
      "progress_resettable",
      "last_engaged_at",
      "capabilities",
    ],
    "Library media list item",
  );
  const capabilities = expectExactRecord(
    media.capabilities,
    [
      "can_quote",
      "can_retry",
      "can_refresh_source",
      "can_retry_metadata",
      "can_edit_authors",
      "can_delete",
    ],
    "Library media list item.capabilities",
  );
  return {
    id: expectString(media.id, "Library media list item.id"),
    kind: expectOneOf(media.kind, MEDIA_KINDS, "Library media list item.kind"),
    title: expectString(media.title, "Library media list item.title"),
    created_at: expectString(
      media.created_at,
      "Library media list item.created_at",
    ),
    contributors: expectArray(
      media.contributors,
      (credit, index) =>
        decodeContributorCredit(
          credit,
          index,
          "Library entry contributors",
        ),
      "Library media list item.contributors",
    ),
    author_mode: expectOneOf(
      media.author_mode,
      AUTHOR_MODES,
      "Library media list item.author_mode",
    ),
    published_date: expectNullableString(
      media.published_date,
      "Library media list item.published_date",
    ),
    canonical_source_url: expectNullableString(
      media.canonical_source_url,
      "Library media list item.canonical_source_url",
    ),
    processing_status: expectOneOf(
      media.processing_status,
      PROCESSING_STATUSES,
      "Library media list item.processing_status",
    ),
    read_state: expectOneOf(
      media.read_state,
      READ_STATES,
      "Library media list item.read_state",
    ),
    progress_fraction:
      media.progress_fraction === null
        ? null
        : expectFiniteNumber(
            media.progress_fraction,
            "Library media list item.progress_fraction",
          ),
    progress_resettable: expectBoolean(
      media.progress_resettable,
      "Library media list item.progress_resettable",
    ),
    last_engaged_at: expectNullableString(
      media.last_engaged_at,
      "Library media list item.last_engaged_at",
    ),
    capabilities: {
      can_quote: expectBoolean(
        capabilities.can_quote,
        "Library media list item.capabilities.can_quote",
      ),
      can_retry: expectBoolean(
        capabilities.can_retry,
        "Library media list item.capabilities.can_retry",
      ),
      can_refresh_source: expectBoolean(
        capabilities.can_refresh_source,
        "Library media list item.capabilities.can_refresh_source",
      ),
      can_retry_metadata: expectBoolean(
        capabilities.can_retry_metadata,
        "Library media list item.capabilities.can_retry_metadata",
      ),
      can_edit_authors: expectBoolean(
        capabilities.can_edit_authors,
        "Library media list item.capabilities.can_edit_authors",
      ),
      can_delete: expectBoolean(
        capabilities.can_delete,
        "Library media list item.capabilities.can_delete",
      ),
    },
  };
}

function decodePodcast(raw: unknown): LibraryPodcastListWire {
  const podcast = expectExactRecord(
    raw,
    ["id", "title", "contributors", "unplayed_count"],
    "Library podcast list item",
  );
  return {
    id: expectString(podcast.id, "Library podcast list item.id"),
    title: expectString(podcast.title, "Library podcast list item.title"),
    contributors: expectArray(
      podcast.contributors,
      (credit, index) =>
        decodeContributorCredit(
          credit,
          index,
          "Library entry contributors",
        ),
      "Library podcast list item.contributors",
    ),
    unplayed_count: expectInteger(
      podcast.unplayed_count,
      "Library podcast list item.unplayed_count",
    ),
  };
}

function decodeSubscription(
  raw: unknown,
): LibraryPodcastSubscriptionValue | null {
  if (raw === null) return null;
  const subscription = expectExactRecord(
    raw,
    ["status", "default_playback_speed", "auto_queue", "sync_status"],
    "Library podcast subscription",
  );
  return {
    status: expectOneOf(
      subscription.status,
      SUBSCRIPTION_STATUSES,
      "Library podcast subscription.status",
    ),
    default_playback_speed:
      subscription.default_playback_speed === null
        ? null
        : expectFiniteNumber(
            subscription.default_playback_speed,
            "Library podcast subscription.default_playback_speed",
          ),
    auto_queue: expectBoolean(
      subscription.auto_queue,
      "Library podcast subscription.auto_queue",
    ),
    sync_status: expectOneOf(
      subscription.sync_status,
      SYNC_STATUSES,
      "Library podcast subscription.sync_status",
    ),
  };
}

export function decodeLibraryEntryListItem(
  raw: unknown,
): LibraryEntryListItem {
  const entry = expectRecord(raw, "Library entry");
  const kind = expectOneOf(
    entry.kind,
    ["media", "podcast"] as const,
    "Library entry.kind",
  );
  const common = {
    id: expectString(entry.id, "Library entry.id"),
    position: expectInteger(entry.position, "Library entry.position"),
    created_at: expectString(entry.created_at, "Library entry.created_at"),
  };

  if (kind === "media") {
    const mediaEntry = expectExactRecord(
      raw,
      ["id", "kind", "position", "created_at", "media", "readingTimeEstimate"],
      "Library media entry",
    );
    return decodeLibraryReadingTimeEntry({
      ...common,
      kind,
      media: decodeMedia(mediaEntry.media),
      readingTimeEstimate: mediaEntry.readingTimeEstimate,
    });
  }

  const podcastEntry = expectExactRecord(
    raw,
    [
      "id",
      "kind",
      "position",
      "created_at",
      "podcast",
      "subscription",
      "readingTimeEstimate",
    ],
    "Library podcast entry",
  );
  return decodeLibraryReadingTimeEntry({
    ...common,
    kind,
    podcast: decodePodcast(podcastEntry.podcast),
    subscription: decodeSubscription(podcastEntry.subscription),
    readingTimeEstimate: podcastEntry.readingTimeEstimate,
  });
}
