import type { ApiJson, Schema } from "@/lib/api/wire";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import {
  parseMediaId,
  playerDescriptorFromWire,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import type { MediaDuration } from "@/lib/media/mediaSummary";
import type { TranscriptChapter } from "@/lib/media/transcriptView";

/** Generated API facts with the reader's existing branded identities and units. */
export type MediaDetail = Omit<
  Schema<"MediaOut">,
  | "id"
  | "original_published_date"
  | "edition_published_date"
  | "duration"
  | "chapters"
  | "player_descriptor"
> & {
  id: MediaId;
  original_published_date: PublicationDate | null;
  edition_published_date: PublicationDate | null;
  duration: MediaDuration | null;
  chapters: readonly TranscriptChapter[];
  playerDescriptor: PlayerDescriptor | null;
};

function mapNullable<T, U>(value: T | null, map: (value: T) => U): U | null {
  return value !== null ? map(value) : null;
}

export function mediaDetailFromResponse(
  response: ApiJson<"/media/{media_id}", "get">,
  expectedMediaId: string,
): MediaDetail {
  const media = response.data;
  const id = parseMediaId(media.id);
  if (id !== parseMediaId(expectedMediaId)) {
    // justify-defect: one detail response cannot identify a different reader.
    throw new TypeError("MediaOut.id must match the requested media");
  }
  return {
    ...media,
    id,
    // PublicationDate's calendar validation belongs to the generated schema owner.
    original_published_date: mapNullable(media.original_published_date, (date) => date as PublicationDate),
    edition_published_date: mapNullable(media.edition_published_date, (date) => date as PublicationDate),
    chapters: media.chapters
      .map((chapter) => ({ ...chapter, title: chapter.title.trim() }))
      .filter((chapter) => chapter.title.length > 0)
      .sort(
        (left, right) =>
          left.t_start_ms - right.t_start_ms ||
          left.chapter_idx - right.chapter_idx,
      ),
    playerDescriptor: mapNullable(media.player_descriptor, playerDescriptorFromWire),
  };
}
