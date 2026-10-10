import { present, type Presence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import {
  parseMediaId,
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
  | "playerDescriptor"
> & {
  id: MediaId;
  original_published_date: Presence<PublicationDate>;
  edition_published_date: Presence<PublicationDate>;
  duration: Presence<MediaDuration>;
  chapters: readonly TranscriptChapter[];
  playerDescriptor: Presence<PlayerDescriptor>;
};

function mapPresence<T, U>(value: Presence<T>, map: (value: T) => U): Presence<U> {
  return value.kind === "Present" ? present(map(value.value)) : value;
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
    original_published_date: mapPresence(media.original_published_date, (date) => date as PublicationDate),
    edition_published_date: mapPresence(media.edition_published_date, (date) => date as PublicationDate),
    chapters: media.chapters
      .map((chapter) => ({ ...chapter, title: chapter.title.trim() }))
      .filter((chapter) => chapter.title.length > 0)
      .sort(
        (left, right) =>
          left.t_start_ms - right.t_start_ms ||
          left.chapter_idx - right.chapter_idx,
      ),
    playerDescriptor: mapPresence(media.playerDescriptor, (descriptor) => ({
      ...descriptor,
      mediaId: parseMediaId(descriptor.mediaId),
    })),
  };
}
