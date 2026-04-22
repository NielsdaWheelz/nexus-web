"use client";

import { type GlobalPlayerChapter } from "@/lib/player/globalPlayer";

export interface TranscriptPlaybackSource {
  kind: "external_audio" | "external_video";
  stream_url: string;
  source_url: string;
  provider?: string | null;
  provider_video_id?: string | null;
  watch_url?: string | null;
  embed_url?: string | null;
}

export interface TranscriptFragment {
  id: string;
  canonical_text: string;
  t_start_ms?: number | null;
  t_end_ms?: number | null;
  speaker_label?: string | null;
}

export interface TranscriptChapter {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms?: number | null;
  url?: string | null;
  image_url?: string | null;
}

export interface TranscriptRequestForecast {
  requiredMinutes: number;
  remainingMinutes: number | null;
  fitsBudget: boolean;
}

export interface Fragment {
  id: string;
  media_id: string;
  idx: number;
  html_sanitized: string;
  canonical_text: string;
  t_start_ms?: number | null;
  t_end_ms?: number | null;
  speaker_label?: string | null;
  created_at: string;
}

interface TranscriptFragmentSelectionOptions {
  activeFragmentId?: string | null;
  requestedFragmentId?: string | null;
  requestedStartMs?: number | null;
  readerResumeFragmentId?: string | null;
  waitForInitialResumeState?: boolean;
}

export function formatTranscriptTimestampMs(
  timestampMs: number | null | undefined
): string | null {
  if (timestampMs == null || timestampMs < 0) {
    return null;
  }

  const totalSeconds = Math.floor(timestampMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function findNearestTranscriptFragmentByStartMs(
  fragments: readonly Fragment[],
  requestedStartMs: number
): Fragment | null {
  let nearest: Fragment | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const fragment of fragments) {
    if (fragment.t_start_ms == null) {
      continue;
    }

    if (
      fragment.t_end_ms != null &&
      requestedStartMs >= fragment.t_start_ms &&
      requestedStartMs <= fragment.t_end_ms
    ) {
      return fragment;
    }

    const distance = Math.abs(fragment.t_start_ms - requestedStartMs);
    if (distance < nearestDistance) {
      nearest = fragment;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function resolveActiveTranscriptFragment(
  fragments: readonly Fragment[],
  {
    activeFragmentId = null,
    requestedFragmentId = null,
    requestedStartMs = null,
    readerResumeFragmentId = null,
    waitForInitialResumeState = false,
  }: TranscriptFragmentSelectionOptions
): Fragment | null {
  if (fragments.length === 0) {
    return null;
  }

  if (activeFragmentId) {
    const activeFragment = fragments.find((fragment) => fragment.id === activeFragmentId);
    if (activeFragment) {
      return activeFragment;
    }
  }

  if (requestedFragmentId) {
    const requestedFragment = fragments.find(
      (fragment) => fragment.id === requestedFragmentId
    );
    if (requestedFragment) {
      return requestedFragment;
    }
  }

  if (requestedStartMs != null) {
    const nearestFragment = findNearestTranscriptFragmentByStartMs(
      fragments,
      requestedStartMs
    );
    if (nearestFragment) {
      return nearestFragment;
    }
  }

  if (
    activeFragmentId == null &&
    !requestedFragmentId &&
    requestedStartMs == null &&
    waitForInitialResumeState
  ) {
    return null;
  }

  if (readerResumeFragmentId) {
    const resumedFragment = fragments.find(
      (fragment) => fragment.id === readerResumeFragmentId
    );
    if (resumedFragment) {
      return resumedFragment;
    }
  }

  return fragments[0] ?? null;
}

export function normalizeTranscriptChapters(
  chapters: TranscriptChapter[] | null | undefined
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
        chapter.title.trim().length > 0 &&
        Number.isFinite(chapter.t_start_ms) &&
        chapter.t_start_ms >= 0
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
    .sort((lhs, rhs) =>
      lhs.t_start_ms === rhs.t_start_ms
        ? lhs.chapter_idx - rhs.chapter_idx
        : lhs.t_start_ms - rhs.t_start_ms
    );
}
