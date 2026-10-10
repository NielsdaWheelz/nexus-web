import type { Schema } from "@/lib/api/wire";

export type TranscriptState = Schema<"TranscriptState"> | null;
export type TranscriptChapter = Readonly<Schema<"PodcastEpisodeChapterOut">>;

export function shouldPollTranscriptProvisioning(
  transcriptState: TranscriptState,
): boolean {
  return transcriptState === "queued" || transcriptState === "running";
}
