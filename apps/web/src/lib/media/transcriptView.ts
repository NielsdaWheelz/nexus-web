import type { Schema } from "@/lib/api/wire";

export type TranscriptState = Schema<"TranscriptState"> | null;
export type TranscriptChapter = Readonly<Schema<"PodcastEpisodeChapterOut">>;

/** A transcript can be requested unless one exists, is on its way, or cannot exist. */
export function canRequestTranscript(
  transcriptState: TranscriptState,
): boolean {
  return (
    transcriptState !== null &&
    !["queued", "running", "ready", "partial", "unavailable"].includes(
      transcriptState,
    )
  );
}

export function shouldPollTranscriptProvisioning(
  transcriptState: TranscriptState,
): boolean {
  return transcriptState === "queued" || transcriptState === "running";
}
