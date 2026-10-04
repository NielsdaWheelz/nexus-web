import { absent, present, type Presence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  decodeCollectionCursor,
  decodeCollectionRevision,
  type CollectionPage,
} from "@/lib/api/collectionPage";
import type { PositiveCount, ProgressFraction } from "@/lib/consumption/activityFacts";
import { decodePublicationDate, type PublicationDate } from "@/lib/dates/publicationDate";
import { mediaSummaryFromWire, type MediaSummary } from "@/lib/media/mediaSummary";
import type { PodcastSyncStatus } from "@/lib/podcasts/types";
import { readingTimeEstimateFromWire, type ReadingTimeEstimatePresence } from "@/lib/media/readingTime";

export type LibraryMediaListValue = Omit<
  Schema<"LibraryEntryMediaOut">,
  | "created_at"
  | "author_mode"
  | "canonical_source_url"
  | "read_state"
  | "progress_fraction"
  | "progress_resettable"
  | "last_engaged_at"
> & {
  createdAt: string;
  authorMode: Schema<"LibraryEntryMediaOut">["author_mode"];
  canonicalSourceUrl: string | null;
  readState: Schema<"LibraryEntryMediaOut">["read_state"];
  progressFraction: Presence<ProgressFraction>;
  progressResettable: boolean;
  lastEngagedAt: string | null;
};

export type LibraryPodcastListValue = Omit<
  Schema<"LibraryEntryPodcastOut">,
  "unplayedCount" | "publishedDate"
> & {
  unplayedCount: Presence<PositiveCount>;
  publicationDate: Presence<PublicationDate>;
  syncStatus: Presence<PodcastSyncStatus>;
};
export type LibraryPodcastSubscriptionValue = Schema<"LibraryEntryPodcastSubscriptionOut">;
export type LibraryEntryPlacement = Schema<"LibraryEntryPlacementOut">;
export type LibraryMediaListItem = Omit<
  Schema<"LibraryMediaListItemOut">,
  "media" | "mediaSummary"
> & { media: LibraryMediaListValue; mediaSummary: MediaSummary };
export type LibraryPodcastListItem = Omit<
  Schema<"LibraryPodcastListItemOut">,
  "podcast" | "readingTimeEstimate"
> & {
  podcast: LibraryPodcastListValue;
  readingTimeEstimate: ReadingTimeEstimatePresence;
};
export type LibraryEntryListItem = LibraryMediaListItem | LibraryPodcastListItem;

export function libraryEntryListItemFromWire(
  entry: Schema<"LibraryMediaListItemOut"> | Schema<"LibraryPodcastListItemOut">,
): LibraryEntryListItem {
  if (entry.kind === "media") {
    const mediaSummary = mediaSummaryFromWire(entry.mediaSummary);
    if (entry.media.id !== mediaSummary.mediaId) {
      throw new TypeError("Library media entry identity mismatch");
    }
    return {
      ...entry,
      mediaSummary,
      media: {
        id: entry.media.id,
        createdAt: entry.media.created_at,
        authorMode: entry.media.author_mode,
        canonicalSourceUrl: entry.media.canonical_source_url,
        readState: entry.media.read_state,
        progressFraction: entry.media.progress_fraction === null
          ? absent()
          : present({ value: entry.media.progress_fraction }),
        progressResettable: entry.media.progress_resettable,
        lastEngagedAt: entry.media.last_engaged_at,
        capabilities: entry.media.capabilities,
      },
    };
  }
  return {
    ...entry,
    podcast: {
      id: entry.podcast.id,
      title: entry.podcast.title,
      contributors: entry.podcast.contributors,
      unplayedCount: entry.podcast.unplayedCount === 0
        ? absent()
        : present({ value: entry.podcast.unplayedCount }),
      publicationDate: entry.podcast.publishedDate.kind === "Present"
        ? present(decodePublicationDate(
            entry.podcast.publishedDate.value,
            "Library podcast list item.publishedDate.value",
          ))
        : absent(),
      syncStatus: entry.subscription.kind === "Present"
        ? present(entry.subscription.value.syncStatus)
        : absent(),
    },
    readingTimeEstimate: entry.readingTimeEstimate.kind === "Present"
      ? present(readingTimeEstimateFromWire(entry.readingTimeEstimate.value))
      : absent(),
  };
}

export function libraryEntryPageFromWire(
  page: ApiJson<"/libraries/{library_id}/entries", "get">["data"],
): CollectionPage<LibraryEntryListItem> {
  return {
    items: page.items.map(libraryEntryListItemFromWire),
    collectionRevision: decodeCollectionRevision(page.collectionRevision),
    nextCursor: page.nextCursor.kind === "Present"
      ? present(decodeCollectionCursor(page.nextCursor.value))
      : absent(),
  };
}
