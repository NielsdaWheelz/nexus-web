import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ListPage } from "@/lib/api/useServerList";
import type { PositiveCount } from "@/lib/consumption/activityFacts";
import { decodePublicationDate, type PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaSummary } from "@/lib/media/mediaSummary";

export type LibraryMediaListValue = Omit<
  Schema<"LibraryEntryMediaOut">,
  | "created_at"
  | "author_mode"
  | "canonical_source_url"
  | "last_engaged_at"
> & {
  createdAt: string;
  authorMode: Schema<"LibraryEntryMediaOut">["author_mode"];
  canonicalSourceUrl: string | null;
  lastEngagedAt: string | null;
};

export type LibraryPodcastListValue = Omit<
  Schema<"LibraryEntryPodcastOut">,
  "unplayed_count" | "published_date"
> & {
  unplayedCount: PositiveCount | null;
  publicationDate: PublicationDate | null;
  syncStatus: Schema<"PodcastSyncStatus"> | null;
};
export type LibraryPodcastSubscriptionValue = Schema<"LibraryEntryPodcastSubscriptionOut">;
export type LibraryEntryPlacement = Schema<"LibraryEntryPlacementOut">;
export type LibraryMediaListItem = Omit<
  Schema<"LibraryMediaListItemOut">,
  "media" | "media_summary"
> & { media: LibraryMediaListValue; mediaSummary: MediaSummary };
export type LibraryPodcastListItem = Omit<
  Schema<"LibraryPodcastListItemOut">,
  "podcast"
> & { podcast: LibraryPodcastListValue };
export type LibraryEntryListItem = LibraryMediaListItem | LibraryPodcastListItem;

/** The media or podcast an entry files: its row identity. */
export function libraryEntryTargetId(entry: LibraryEntryListItem): string {
  return entry.kind === "media" ? entry.media.id : entry.podcast.id;
}

export function libraryEntryListItemFromWire(
  entry: Schema<"LibraryMediaListItemOut"> | Schema<"LibraryPodcastListItemOut">,
): LibraryEntryListItem {
  if (entry.kind === "media") {
    const mediaSummary = entry.media_summary;
    if (entry.media.id !== mediaSummary.media_id) {
      throw new TypeError("Library media entry identity mismatch");
    }
    const { media_summary: _summary, ...rest } = entry;
    return {
      ...rest,
      mediaSummary,
      media: {
        id: entry.media.id,
        createdAt: entry.media.created_at,
        authorMode: entry.media.author_mode,
        canonicalSourceUrl: entry.media.canonical_source_url,
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
      unplayedCount: entry.podcast.unplayed_count === 0
        ? null
        : { value: entry.podcast.unplayed_count },
      publicationDate: entry.podcast.published_date !== null
        ? decodePublicationDate(
            entry.podcast.published_date,
            "Library podcast list item.published_date",
          )
        : null,
      syncStatus: entry.subscription !== null
        ? entry.subscription.sync_status
        : null,
    },
  };
}

export function libraryEntryPageFromWire(
  page: ApiJson<"/libraries/{library_id}/entries", "get">["data"],
): ListPage<LibraryEntryListItem> {
  return { items: page.items.map(libraryEntryListItemFromWire), next_cursor: page.next_cursor };
}
