import type { ApiJson, Schema } from "@/lib/api/wire";
import type { TranscriptChapter } from "@/lib/media/transcriptView";

/** The media detail with the reader's chapter order and the player descriptor. */
export type MediaDetail = Omit<
  Schema<"MediaOut">,
  "chapters" | "player_descriptor"
> & {
  chapters: readonly TranscriptChapter[];
  playerDescriptor: Schema<"PlayerDescriptor"> | null;
};

export function mediaDetailFromResponse(
  response: ApiJson<"/media/{media_id}", "get">,
  expectedMediaId: string,
): MediaDetail {
  const {
    chapters,
    player_descriptor: playerDescriptor,
    ...media
  } = response.data;
  if (media.id !== expectedMediaId) {
    // justify-defect: kept until the pane passes no id (issue media-pane-contract-leftovers).
    throw new TypeError("MediaOut.id must match the requested media");
  }
  return {
    ...media,
    // Untitled chapters drop; the rest play in time order.
    chapters: chapters
      .map((chapter) => ({ ...chapter, title: chapter.title.trim() }))
      .filter((chapter) => chapter.title.length > 0)
      .sort(
        (a, b) => a.t_start_ms - b.t_start_ms || a.chapter_idx - b.chapter_idx,
      ),
    playerDescriptor,
  };
}
