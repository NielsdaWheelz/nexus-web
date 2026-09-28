import { decodePresence, type Presence } from "@/lib/api/presence";
import type { PositiveCount, ProgressFraction } from "@/lib/consumption/activityFacts";
import { decodeContributorCredit } from "@/lib/contributors/credit";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePublicationDate, type PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaActionCapabilities } from "@/lib/media/mediaActionCapabilities";
import { decodeMediaSummary, type MediaSummary } from "@/lib/media/mediaSummary";
import {
  decodePodcastSyncStatus,
  type PodcastSyncStatus,
} from "@/lib/podcasts/types";
import { parsePlaybackRate } from "@/lib/player/playbackRate";
import {
  parsePauseShorteningMode,
  type PauseShorteningMode,
} from "@/lib/player/pauseShortening";
import { decodeReadingTimeEstimate, type ReadingTimeEstimatePresence } from "@/lib/media/readingTime";
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

const READ_STATES = ["unread", "in_progress", "finished"] as const;
const AUTHOR_MODES = ["automatic", "manual"] as const;

export interface LibraryMediaListValue {
  readonly id: string;
  readonly createdAt: string;
  readonly authorMode: "automatic" | "manual";
  readonly canonicalSourceUrl: string | null;
  readonly readState: "unread" | "in_progress" | "finished";
  readonly progressFraction: Presence<ProgressFraction>;
  readonly progressResettable: boolean;
  readonly lastEngagedAt: string | null;
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
  readonly defaultPlaybackSpeed: Presence<number>;
  readonly pauseShorteningMode: Presence<PauseShorteningMode>;
  readonly autoQueue: boolean;
  readonly syncStatus: PodcastSyncStatus;
}

export interface LibraryEntryPlacement {
  readonly libraryEntryId: string;
  readonly position: number;
}

interface LibraryEntryBase {
  readonly placement: Presence<LibraryEntryPlacement>;
  readonly addedAt: string;
}

export interface LibraryMediaListItem extends LibraryEntryBase {
  readonly kind: "media";
  readonly media: LibraryMediaListValue;
  readonly mediaSummary: MediaSummary;
}

export interface LibraryPodcastListItem extends LibraryEntryBase {
  readonly kind: "podcast";
  readonly podcast: LibraryPodcastListValue;
  readonly subscription: Presence<LibraryPodcastSubscriptionValue>;
  readonly readingTimeEstimate: ReadingTimeEstimatePresence;
}

export type LibraryEntryListItem =
  | LibraryMediaListItem
  | LibraryPodcastListItem;

function decodeMedia(raw: unknown): LibraryMediaListValue {
  const media = expectExactRecord(
    raw,
    [
      "id",
      "created_at",
      "author_mode",
      "canonical_source_url",
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
    createdAt: expectString(media.created_at, "Library media list item.created_at"),
    authorMode: expectOneOf(
      media.author_mode,
      AUTHOR_MODES,
      "Library media list item.author_mode",
    ),
    canonicalSourceUrl: expectNullableString(
      media.canonical_source_url,
      "Library media list item.canonical_source_url",
    ),
    readState: expectOneOf(
      media.read_state,
      READ_STATES,
      "Library media list item.read_state",
    ),
    progressFraction: (() => {
      if (media.progress_fraction === null) return { kind: "Absent" } as const;
      const fraction = expectFiniteNumber(media.progress_fraction, "Library media list item.progress_fraction");
      if (fraction < 0 || fraction > 1) throw new TypeError("Library media progressFraction must be in [0, 1]");
      return { kind: "Present", value: { value: fraction } } as const;
    })(),
    progressResettable: expectBoolean(
      media.progress_resettable,
      "Library media list item.progress_resettable",
    ),
    lastEngagedAt: expectNullableString(
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
        [
          "defaultPlaybackSpeed",
          "pauseShorteningMode",
          "autoQueue",
          "syncStatus",
        ],
        "Library podcast subscription",
      );
      return {
        defaultPlaybackSpeed: decodePresence(
          subscription.defaultPlaybackSpeed,
          (playbackRate) =>
            parsePlaybackRate(
              playbackRate,
              "Library podcast subscription.defaultPlaybackSpeed.value",
            ),
        ),
        pauseShorteningMode: decodePresence(
          subscription.pauseShorteningMode,
          (mode) =>
            parsePauseShorteningMode(
              mode,
              "Library podcast subscription.pauseShorteningMode.value",
            ),
        ),
        autoQueue: expectBoolean(
          subscription.autoQueue,
          "Library podcast subscription.autoQueue",
        ),
        syncStatus: decodePodcastSyncStatus(
          subscription.syncStatus,
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
      ["kind", "placement", "addedAt", "media", "mediaSummary"],
      "Library media entry",
    );
    const media = decodeMedia(mediaEntry.media);
    const mediaSummary = decodeMediaSummary(mediaEntry.mediaSummary);
    if (media.id !== mediaSummary.mediaId) {
      throw new TypeError("Library media entry identity mismatch");
    }
    return {
      ...common,
      kind,
      media,
      mediaSummary,
    };
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
  return {
    ...common,
    kind,
    podcast: decodePodcast(podcastEntry.podcast, subscription),
    subscription,
    readingTimeEstimate: decodePresence(
      podcastEntry.readingTimeEstimate,
      decodeReadingTimeEstimate,
    ),
  };
}
