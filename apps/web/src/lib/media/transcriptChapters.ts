/**
 * transcript chapter interval policy for the transcript reader panels.
 *
 * These operate on the media DTO's rich transcript-chapter metadata (title,
 * image, external URL) — distinct from the player descriptor's `ChapterOut`
 * (title/startMs/endMs), which drives the footer seek-track ticks. Kept separate
 * from `lib/player/chapters.ts` because the two carry different fields.
 */

import { absent, present, type Presence } from "@/lib/api/presence";
import type { TranscriptChapter } from "@/lib/media/transcriptView";

export interface TranscriptChapterInterval {
  readonly ordinal: number;
  readonly chapter: TranscriptChapter;
  readonly startMs: number;
  readonly endMs: Presence<number>;
}

export function resolveTranscriptChapterInterval({
  chapters,
  timestampMs,
}: {
  readonly chapters: readonly TranscriptChapter[];
  readonly timestampMs: number | null | undefined;
}): TranscriptChapterInterval | null {
  if (
    typeof timestampMs !== "number" ||
    !Number.isFinite(timestampMs) ||
    timestampMs < 0
  ) {
    return null;
  }

  const distinctStarts = [
    ...new Set(chapters.map(({ t_start_ms }) => t_start_ms)),
  ];
  const nextLaterStart = new Map<number, number | null>(
    distinctStarts.map((startMs, index) => [
      startMs,
      distinctStarts[index + 1] ?? null,
    ]),
  );
  let resolved: TranscriptChapterInterval | null = null;

  for (let ordinal = 0; ordinal < chapters.length; ordinal += 1) {
    const chapter = chapters[ordinal]!;
    const explicitEndMs =
      chapter.t_end_ms !== null && chapter.t_end_ms > chapter.t_start_ms
        ? chapter.t_end_ms
        : null;
    const laterStartMs = nextLaterStart.get(chapter.t_start_ms) ?? null;
    const endMs =
      explicitEndMs === null
        ? laterStartMs
        : laterStartMs === null
          ? explicitEndMs
          : Math.min(explicitEndMs, laterStartMs);
    const contains =
      timestampMs >= chapter.t_start_ms &&
      (endMs === null || timestampMs < endMs);
    if (!contains) {
      continue;
    }
    if (resolved !== null) {
      return null;
    }
    resolved = {
      ordinal,
      chapter,
      startMs: chapter.t_start_ms,
      endMs: endMs === null ? absent() : present(endMs),
    };
  }

  return resolved;
}
