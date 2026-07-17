/**
 * Chapter helpers for the global audio player, adapted to the canonical
 * `ChapterOut` wire shape (spec `docs/cutovers/lectern-player-lifecycle-hard-cutover.md`
 * §4): `{ title, startMs, endMs: Presence<int> }`. Chapters arrive already
 * validated, clamped, and ordered by the backend projection, so these helpers do
 * NOT re-normalize — they only look up the active chapter and place seek ticks.
 */

import { absent, present, type Presence } from "@/lib/api/presence";
import { clamp } from "@/lib/clamp";
import type { ChapterOut } from "@/lib/lectern/client";

/** A chapter tick on the seek track, positioned by its start against duration. */
export interface ChapterMarker {
  /** 0-based ordinal within the descriptor's chapter list (for "Chapter N"). */
  index: number;
  title: string;
  startMs: number;
  leftPercent: number;
}

/**
 * The active chapter at a playback position (ms). Chapters are pre-sorted by
 * `startMs`; the active one is the last whose `startMs` is at or before the
 * position. Absent when there are no chapters or the position precedes the first.
 */
export function chapterAtPositionMs(
  chapters: readonly ChapterOut[],
  positionMs: number,
): Presence<ChapterOut> {
  const clamped = Math.max(0, positionMs);
  let active: Presence<ChapterOut> = absent();
  for (const chapter of chapters) {
    if (chapter.startMs > clamped) break;
    active = present(chapter);
  }
  return active;
}

/** 0-based ordinal of the active chapter at a position, or -1 when none. */
export function chapterIndexAtPositionMs(
  chapters: readonly ChapterOut[],
  positionMs: number,
): number {
  const clamped = Math.max(0, positionMs);
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].startMs > clamped) break;
    index = i;
  }
  return index;
}

/** Seek-track tick markers positioned by `startMs` against a known duration. */
export function chapterMarkers(
  chapters: readonly ChapterOut[],
  durationMs: number,
): ChapterMarker[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  return chapters
    .map((chapter, index) => ({
      index,
      title: chapter.title,
      startMs: chapter.startMs,
      leftPercent: clamp((chapter.startMs / durationMs) * 100, 0, 100),
    }))
    .filter((marker) => Number.isFinite(marker.leftPercent));
}
