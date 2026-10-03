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

export function mediaDetailFromResponse(
  response: ApiJson<"/media/{media_id}", "get">,
  expectedMediaId: string,
): MediaDetail {
  const value = response.data;
  const id = value.id as MediaId;
  if (id !== parseMediaId(expectedMediaId)) {
    throw new TypeError("MediaOut.id must match the requested media");
  }
  return {
    ...value,
    id,
    original_published_date:
      value.original_published_date.kind === "Present"
        ? present(value.original_published_date.value as PublicationDate)
        : value.original_published_date,
    edition_published_date:
      value.edition_published_date.kind === "Present"
        ? present(value.edition_published_date.value as PublicationDate)
        : value.edition_published_date,
    duration:
      value.duration.kind === "Present"
        ? present({
            modality: value.duration.value.modality,
            estimate: {
              totalMinutes: {
                value: value.duration.value.estimate.totalMinutes,
              },
              remainingMinutes:
                value.duration.value.estimate.remainingMinutes.kind === "Present"
                  ? present({
                      value: value.duration.value.estimate.remainingMinutes.value,
                    })
                  : value.duration.value.estimate.remainingMinutes,
            },
          })
        : value.duration,
    chapters: value.chapters
      .map((chapter) => ({ ...chapter, title: chapter.title.trim() }))
      .filter((chapter) => chapter.title.length > 0)
      .sort(
        (left, right) =>
          left.t_start_ms - right.t_start_ms ||
          left.chapter_idx - right.chapter_idx,
      ),
    playerDescriptor:
      value.playerDescriptor.kind === "Present"
        ? present({
            ...value.playerDescriptor.value,
            mediaId: value.playerDescriptor.value.mediaId as MediaId,
          })
        : value.playerDescriptor,
  };
}
