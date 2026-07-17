/**
 * Transcript chapter shape + normalizer for the transcript reader panels.
 *
 * These operate on the media DTO's rich transcript-chapter metadata (title,
 * image, external URL) — distinct from the player descriptor's `ChapterOut`
 * (title/startMs/endMs), which drives the footer seek-track ticks. Kept separate
 * from `lib/player/chapters.ts` because the two carry different fields.
 */

export interface GlobalPlayerChapter {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms: number | null;
  url: string | null;
  image_url: string | null;
}

export interface ChapterInput {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms?: number | null;
  url?: string | null;
  image_url?: string | null;
}

export function normalizeTrackChapters(
  chapters: ReadonlyArray<ChapterInput> | null | undefined,
): GlobalPlayerChapter[] {
  if (!Array.isArray(chapters)) {
    return [];
  }
  return chapters
    .filter(
      (chapter) =>
        chapter != null &&
        Number.isFinite(chapter.chapter_idx) &&
        typeof chapter.title === "string" &&
        Number.isFinite(chapter.t_start_ms) &&
        chapter.t_start_ms >= 0,
    )
    .map((chapter) => ({
      chapter_idx: Math.max(0, Math.floor(chapter.chapter_idx)),
      title: chapter.title.trim(),
      t_start_ms: Math.max(0, Math.floor(chapter.t_start_ms)),
      t_end_ms:
        typeof chapter.t_end_ms === "number" && Number.isFinite(chapter.t_end_ms)
          ? Math.max(0, Math.floor(chapter.t_end_ms))
          : null,
      url: chapter.url ?? null,
      image_url: chapter.image_url ?? null,
    }))
    .filter((chapter) => chapter.title.length > 0)
    .sort((lhs, rhs) =>
      lhs.t_start_ms === rhs.t_start_ms
        ? lhs.chapter_idx - rhs.chapter_idx
        : lhs.t_start_ms - rhs.t_start_ms,
    );
}
