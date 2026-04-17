import { apiFetch } from "@/lib/api/client";
import {
  canonicalCpToRawCp,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import { codepointToUtf16 } from "@/lib/highlights/selectionToOffsets";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { type Highlight } from "@/components/HighlightEditor";
import { type PdfHighlightOut } from "@/components/PdfReader";
import { type GlobalPlayerChapter } from "@/lib/player/globalPlayer";
import {
  type EpubChapter,
  type EpubChapterSummary,
  type EpubNavigationSection,
} from "@/lib/media/epubReader";

// =============================================================================
// Types
// =============================================================================

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

export interface Media {
  id: string;
  kind: string;
  title: string;
  podcast_title?: string | null;
  podcast_image_url?: string | null;
  canonical_source_url: string | null;
  processing_status: string;
  transcript_state?:
    | "not_requested"
    | "queued"
    | "running"
    | "failed_provider"
    | "failed_quota"
    | "unavailable"
    | "ready"
    | "partial"
    | null;
  transcript_coverage?: "none" | "partial" | "full" | null;
  capabilities?: {
    can_read: boolean;
    can_highlight: boolean;
    can_quote: boolean;
    can_search: boolean;
    can_play: boolean;
    can_download_file: boolean;
  };
  playback_source?: TranscriptPlaybackSource | null;
  chapters?: TranscriptChapter[];
  listening_state?: {
    position_ms: number;
    playback_speed: number;
  } | null;
  subscription_default_playback_speed?: number | null;
  failure_stage?: string | null;
  last_error_code?: string | null;
  description_html?: string | null;
  description_text?: string | null;
  created_at: string;
  updated_at: string;
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

export interface TranscriptRequestForecast {
  requiredMinutes: number;
  remainingMinutes: number | null;
  fitsBudget: boolean;
}

export interface MeResponse {
  user_id: string;
  default_library_id: string | null;
}

export interface LibraryMediaSummary {
  id: string;
}

export interface SelectionState {
  range: Range;
  rect: DOMRect;
  lineRects: DOMRect[];
}

/** Active content state used by both paths */
export interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
}

export type PdfDocumentHighlight = PdfHighlightOut;

export type PdfHighlightNavigationTarget = {
  highlightId: string;
  pageNumber: number;
  quads: PdfHighlightOut["anchor"]["quads"];
};

export interface NavigationTocNodeLike {
  section_id: string | null;
  href: string | null;
  children: NavigationTocNodeLike[];
}

// =============================================================================
// Constants
// =============================================================================

export const TEXT_ANCHOR_TOP_PADDING_PX = 56;
export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;
export const DOCUMENT_PROCESSING_POLL_INTERVAL_MS = 3000;
export const LIBRARY_MEDIA_PAGE_SIZE = 200;

// =============================================================================
// DOM / Utility helpers
// =============================================================================

export function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function getPaneScrollContainer(
  contentNode: HTMLDivElement | null
): HTMLElement | null {
  if (!contentNode) {
    return null;
  }

  const paneContent = contentNode.closest<HTMLElement>('[data-pane-content="true"]');
  if (paneContent) {
    return paneContent;
  }

  if (typeof document !== "undefined" && document.scrollingElement) {
    return document.scrollingElement as HTMLElement;
  }
  return null;
}

export function formatResumeTime(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
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

export function findFirstVisibleCanonicalOffset(
  container: HTMLElement,
  cursor: CanonicalCursorResult
): number | null {
  const containerRect = container.getBoundingClientRect();
  const probeTop =
    containerRect.top +
    Math.min(
      TEXT_ANCHOR_TOP_PADDING_PX,
      Math.max(8, Math.floor(containerRect.height * 0.12))
    );

  for (const entry of cursor.nodes) {
    const anchorElement = entry.node.parentElement;
    if (!anchorElement) {
      continue;
    }
    const rect = anchorElement.getBoundingClientRect();
    if (rect.bottom < probeTop || rect.top > containerRect.bottom) {
      continue;
    }
    if ((entry.node.textContent ?? "").trim().length === 0) {
      continue;
    }
    return entry.start;
  }
  return null;
}

export function scrollToCanonicalTextAnchor(
  container: HTMLElement,
  cursor: CanonicalCursorResult,
  canonicalOffset: number
): boolean {
  if (cursor.nodes.length === 0) {
    return false;
  }

  const clampedOffset = Math.max(0, Math.min(canonicalOffset, cursor.length));
  const targetNode =
    cursor.nodes.find((entry) => clampedOffset >= entry.start && clampedOffset < entry.end) ??
    cursor.nodes.find((entry) => entry.start >= clampedOffset) ??
    cursor.nodes[cursor.nodes.length - 1];

  if (!targetNode) {
    return false;
  }

  const rawText = targetNode.node.textContent ?? "";
  const nodeCanonicalLength = Math.max(0, targetNode.end - targetNode.start);
  const localCanonicalOffset = Math.max(
    0,
    Math.min(clampedOffset - targetNode.start, nodeCanonicalLength)
  );
  const localRawCpOffset = canonicalCpToRawCp(
    rawText,
    localCanonicalOffset,
    targetNode.trimLeadCp
  );
  const localRawUtf16Offset = Math.max(
    0,
    Math.min(codepointToUtf16(rawText, localRawCpOffset), rawText.length)
  );

  const range = document.createRange();
  range.setStart(targetNode.node, localRawUtf16Offset);
  range.collapse(true);

  const containerRect = container.getBoundingClientRect();
  const targetRect = range.getBoundingClientRect();
  if (targetRect.width > 0 || targetRect.height > 0) {
    const delta = targetRect.top - containerRect.top - TEXT_ANCHOR_TOP_PADDING_PX;
    container.scrollTop = Math.max(0, container.scrollTop + delta);
    return true;
  }

  const fallbackElement = targetNode.node.parentElement;
  if (fallbackElement) {
    fallbackElement.scrollIntoView({ block: "start", behavior: "auto" });
    return true;
  }
  return false;
}

// =============================================================================
// API functions
// =============================================================================

export async function fetchHighlights(fragmentId: string): Promise<Highlight[]> {
  const response = await apiFetch<{ data: { highlights: Highlight[] } }>(
    `/api/fragments/${fragmentId}/highlights`,
    { cache: "no-store" }
  );
  return response.data.highlights;
}

export async function fetchPdfHighlightsIndex(
  mediaId: string,
  cursor: string | null,
  limit = 100
): Promise<{ highlights: PdfDocumentHighlight[]; hasMore: boolean; nextCursor: string | null }> {
  const params = new URLSearchParams({
    limit: String(limit),
    mine_only: "false",
  });
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await apiFetch<{
    data: {
      highlights: PdfDocumentHighlight[];
      page: { has_more: boolean; next_cursor: string | null };
    };
  }>(`/api/media/${mediaId}/pdf-highlights/index?${params.toString()}`);

  return {
    highlights: response.data.highlights,
    hasMore: response.data.page.has_more,
    nextCursor: response.data.page.next_cursor,
  };
}

export async function createHighlight(
  fragmentId: string,
  startOffset: number,
  endOffset: number,
  color: HighlightColor
): Promise<Highlight> {
  const response = await apiFetch<{ data: Highlight }>(
    `/api/fragments/${fragmentId}/highlights`,
    {
      method: "POST",
      body: JSON.stringify({
        start_offset: startOffset,
        end_offset: endOffset,
        color,
      }),
    }
  );
  return response.data;
}

export async function updateHighlight(
  highlightId: string,
  updates: {
    start_offset?: number;
    end_offset?: number;
    color?: HighlightColor;
  }
): Promise<Highlight> {
  const response = await apiFetch<{ data: Highlight }>(
    `/api/highlights/${highlightId}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    }
  );
  return response.data;
}

export async function deleteHighlight(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}`, {
    method: "DELETE",
  });
}

export async function saveAnnotation(
  highlightId: string,
  body: string
): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

export async function deleteAnnotation(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "DELETE",
  });
}

export async function fetchChapterDetail(
  mediaId: string,
  idx: number,
  signal?: AbortSignal
): Promise<EpubChapter> {
  const resp = await apiFetch<{ data: EpubChapter }>(
    `/api/media/${mediaId}/chapters/${idx}`,
    signal ? { signal } : {}
  );
  return resp.data;
}

// =============================================================================
// EPUB navigation helpers
// =============================================================================

export function buildManifestFallbackSections(
  manifest: EpubChapterSummary[]
): EpubNavigationSection[] {
  return manifest.map((chapter, ordinal) => ({
    section_id: `frag-${chapter.idx}`,
    label: chapter.title,
    fragment_idx: chapter.idx,
    anchor_id: null,
    source_node_id: chapter.primary_toc_node_id,
    source: "fragment_fallback",
    ordinal,
  }));
}

export function parseAnchorIdFromHref(href: string | null): string | null {
  if (!href || !href.includes("#")) {
    return null;
  }
  const fragment = href.split("#", 2)[1];
  if (!fragment) {
    return null;
  }
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export function resolveSectionAnchorId(
  sectionId: string,
  sectionAnchorId: string | null,
  tocNodes: NavigationTocNodeLike[] | null
): string | null {
  if (sectionAnchorId) {
    return sectionAnchorId;
  }
  if (!tocNodes || tocNodes.length === 0) {
    return null;
  }

  const stack = [...tocNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.section_id === sectionId) {
      const anchor = parseAnchorIdFromHref(node.href);
      if (anchor) {
        return anchor;
      }
    }
    if (node.children.length > 0) {
      stack.push(...node.children);
    }
  }

  return null;
}
