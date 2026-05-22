/**
 * Track chapter shape and helpers for the global audio player.
 *
 * Chapters are sourced from the media's transcript metadata, normalized into
 * a deterministic shape, compared structurally, and looked up by current
 * playback time.
 */

export interface GlobalPlayerChapter {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms: number | null;
  url: string | null;
  image_url: string | null;
}

export function normalizeTrackChapters(
  chapters: GlobalPlayerChapter[] | null | undefined,
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

export function areTrackChaptersEqual(
  lhs: GlobalPlayerChapter[] | null | undefined,
  rhs: GlobalPlayerChapter[] | null | undefined,
): boolean {
  const lhsNormalized = normalizeTrackChapters(lhs);
  const rhsNormalized = normalizeTrackChapters(rhs);
  if (lhsNormalized.length !== rhsNormalized.length) {
    return false;
  }
  return lhsNormalized.every((chapter, index) => {
    const rhsChapter = rhsNormalized[index];
    return (
      chapter.chapter_idx === rhsChapter.chapter_idx &&
      chapter.title === rhsChapter.title &&
      chapter.t_start_ms === rhsChapter.t_start_ms &&
      chapter.t_end_ms === rhsChapter.t_end_ms &&
      chapter.url === rhsChapter.url &&
      chapter.image_url === rhsChapter.image_url
    );
  });
}

export function getTrackChapterAtSeconds(
  chapters: GlobalPlayerChapter[] | null | undefined,
  currentSeconds: number,
): GlobalPlayerChapter | null {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return null;
  }
  const currentMs = Math.max(0, Math.floor(currentSeconds * 1000));
  let activeChapter: GlobalPlayerChapter | null = null;
  for (const chapter of chapters) {
    if (chapter.t_start_ms > currentMs) {
      break;
    }
    activeChapter = chapter;
  }
  return activeChapter;
}
