import { present, type Presence } from "@/lib/api/presence";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { parseMediaId, type MediaId, type PlayerDescriptor } from "@/lib/lectern/contract";
import type { MediaDuration } from "@/lib/media/mediaSummary";

/** Generated API facts with the reader's existing branded identities and units. */
export type MediaDetail = Omit<
  Schema<"MediaOut">,
  "id" | "original_published_date" | "edition_published_date" | "duration" | "playerDescriptor"
> & {
  id: MediaId;
  original_published_date: Presence<PublicationDate>;
  edition_published_date: Presence<PublicationDate>;
  duration: Presence<MediaDuration>;
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
    duration: mapPresence(media.duration, (duration) => ({
      modality: duration.modality,
      estimate: {
        totalMinutes: { value: duration.estimate.totalMinutes },
        remainingMinutes: mapPresence(duration.estimate.remainingMinutes, (value) => ({ value })),
      },
    })),
    playerDescriptor: mapPresence(media.playerDescriptor, (descriptor) => ({
      ...descriptor,
      mediaId: parseMediaId(descriptor.mediaId),
    })),
  };
}
