import { decodePresence, type Presence } from "@/lib/api/presence";
import type {
  PositiveCount,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  decodePublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
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
  readonly unplayedCount: Presence<PositiveCount>;
  readonly publicationDate: Presence<PublicationDate>;
  readonly syncStatus: Presence<PodcastSyncStatus>;
}

export interface LibraryPodcastSubscriptionValue {
  readonly defaultPlaybackSpeed: number | null;
  readonly autoQueue: boolean;
  readonly syncStatus: (typeof SYNC_STATUSES)[number];
}

export interface LibraryEntryPlacement {
  readonly libraryEntryId: string;
  readonly position: number;
}

interface LibraryEntryBase {
  readonly placement: Presence<LibraryEntryPlacement>;
  readonly addedAt: string;
  readonly readingTimeEstimate: ReadingTimeEstimatePresence;
}

export interface LibraryMediaListItem extends LibraryEntryBase {
  readonly kind: "media";
  readonly media: LibraryMediaListValue;
}

export interface LibraryPodcastListItem extends LibraryEntryBase {
  readonly kind: "podcast";
  readonly podcast: LibraryPodcastListValue;
  readonly subscription: Presence<LibraryPodcastSubscriptionValue>;
}

export type LibraryEntryListItem =
  | LibraryMediaListItem
  | LibraryPodcastListItem;

type LibraryMediaListWire = Omit<
  LibraryMediaListValue,
  "publicationDate" | "sourceHost" | "progressFraction"
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

function decodePodcast(
  raw: unknown,
  subscription: Presence<LibraryPodcastSubscriptionValue>,
): LibraryPodcastListValue {
  const podcast = expectExactRecord(
    raw,
    ["id", "title", "contributors", "unplayedCount", "publishedDate"],
    "Library podcast list item",
  );
  const unplayedCount = expectInteger(
    podcast.unplayedCount,
    "Library podcast list item.unplayedCount",
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
    unplayedCount:
      unplayedCount === 0
        ? { kind: "Absent" }
        : { kind: "Present", value: { value: unplayedCount } },
    publicationDate: decodePresence(
      podcast.publishedDate,
      (value) =>
        decodePublicationDate(
          value,
          "Library podcast list item.publishedDate.value",
        ),
    ),
    syncStatus:
      subscription.kind === "Present"
        ? { kind: "Present", value: subscription.value.syncStatus }
        : { kind: "Absent" },
  };
}

function decodeSubscription(
  raw: unknown,
): Presence<LibraryPodcastSubscriptionValue> {
  return decodePresence(
    raw,
    (value) => {
      const subscription = expectExactRecord(
        value,
        ["defaultPlaybackSpeed", "autoQueue", "syncStatus"],
        "Library podcast subscription",
      );
      return {
        defaultPlaybackSpeed:
          subscription.defaultPlaybackSpeed === null
            ? null
            : expectFiniteNumber(
                subscription.defaultPlaybackSpeed,
                "Library podcast subscription.defaultPlaybackSpeed",
              ),
        autoQueue: expectBoolean(
          subscription.autoQueue,
          "Library podcast subscription.autoQueue",
        ),
        syncStatus: expectOneOf(
          subscription.syncStatus,
          SYNC_STATUSES,
          "Library podcast subscription.syncStatus",
        ),
      };
    },
  );
}

function decodePlacement(raw: unknown): Presence<LibraryEntryPlacement> {
  return decodePresence(raw, (value) => {
    const placement = expectExactRecord(
      value,
      ["libraryEntryId", "position"],
      "Library entry placement",
    );
    return {
      libraryEntryId: expectString(
        placement.libraryEntryId,
        "Library entry placement.libraryEntryId",
      ),
      position: expectInteger(
        placement.position,
        "Library entry placement.position",
      ),
    };
  });
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
    placement: decodePlacement(entry.placement),
    addedAt: expectString(entry.addedAt, "Library entry.addedAt"),
  };

  if (kind === "media") {
    const mediaEntry = expectExactRecord(
      raw,
      ["kind", "placement", "addedAt", "media", "readingTimeEstimate"],
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
      "kind",
      "placement",
      "addedAt",
      "podcast",
      "subscription",
      "readingTimeEstimate",
    ],
    "Library podcast entry",
  );
  const subscription = decodeSubscription(podcastEntry.subscription);
  return decodeLibraryReadingTimeEntry({
    ...common,
    kind,
    podcast: decodePodcast(podcastEntry.podcast, subscription),
    subscription,
    readingTimeEstimate: podcastEntry.readingTimeEstimate,
  });
}
