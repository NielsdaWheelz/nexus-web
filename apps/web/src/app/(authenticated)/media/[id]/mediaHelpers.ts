import { apiFetch } from "@/lib/api/client";
import {
  canonicalCpToRawCp,
  type CanonicalCursorResult,
} from "@/lib/highlights/canonicalCursor";
import { codepointToUtf16 } from "@/lib/highlights/selectionToOffsets";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { type GlobalPlayerChapter } from "@/lib/player/globalPlayer";
import {
  type EpubNavigationSection,
  type EpubSectionContent,
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

export interface MediaAuthor {
  id: string;
  name: string;
  role: string | null;
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
  authors: MediaAuthor[];
  published_date?: string | null;
  publisher?: string | null;
  language?: string | null;
  listening_state?: {
    position_ms: number;
    duration_ms?: number | null;
    playback_speed: number;
    is_completed?: boolean;
  } | null;
  subscription_default_playback_speed?: number | null;
  episode_state?: "unplayed" | "in_progress" | "played" | null;
  failure_stage?: string | null;
  last_error_code?: string | null;
  description?: string | null;
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

export interface Highlight {
  id: string;
  fragment_id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  annotation: {
    id: string;
    body: string;
    created_at: string;
    updated_at: string;
  } | null;
  linked_conversations?: { conversation_id: string; title: string }[];
}

export interface MeResponse {
  user_id: string;
  default_library_id: string | null;
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

export interface NavigationTocNodeLike {
  section_id: string | null;
  href: string | null;
  children: NavigationTocNodeLike[];
}

export interface EpubInternalLinkTarget {
  sectionId: string;
  anchorId: string | null;
}

interface TranscriptFragmentSelectionOptions {
  activeFragmentId?: string | null;
  requestedFragmentId?: string | null;
  requestedStartMs?: number | null;
  readerResumeFragmentId?: string | null;
  waitForInitialResumeState?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const TEXT_ANCHOR_TOP_PADDING_PX = 56;
export const TRANSCRIPT_PROVISIONING_POLL_INTERVAL_MS = 3000;
export const DOCUMENT_PROCESSING_POLL_INTERVAL_MS = 3000;
export const LIBRARY_ENTRY_PAGE_SIZE = 200;
export const READER_POSITION_BUCKET_CP = 1024;

const READER_QUOTE_EXACT_CP = 48;
const READER_QUOTE_CONTEXT_CP = 24;

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

export function getPaneScrollTopPaddingPx(container: HTMLElement): number {
  if (typeof window === "undefined") {
    return TEXT_ANCHOR_TOP_PADDING_PX;
  }

  const parsed = Number.parseFloat(window.getComputedStyle(container).scrollPaddingTop);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return TEXT_ANCHOR_TOP_PADDING_PX;
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

function getMediaAuthorNames(
  authors: MediaAuthor[] | null | undefined
): string[] {
  if (!Array.isArray(authors)) {
    return [];
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const author of authors) {
    const name = author?.name?.trim();
    if (!name) {
      continue;
    }
    const dedupeKey = name.toLocaleLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    names.push(name);
  }
  return names;
}

export function formatMediaAuthors(
  authors: MediaAuthor[] | null | undefined,
  maxNames: number = Number.POSITIVE_INFINITY
): string | null {
  const names = getMediaAuthorNames(authors);
  if (names.length === 0) {
    return null;
  }

  const visibleCount =
    Number.isFinite(maxNames) && maxNames > 0
      ? Math.max(1, Math.floor(maxNames))
      : names.length;

  if (names.length <= visibleCount) {
    return names.join(", ");
  }

  return `${names.slice(0, visibleCount).join(", ")} +${names.length - visibleCount}`;
}

export function buildCompactMediaPaneTitle(
  media: Pick<Media, "title" | "authors"> | null | undefined
): string {
  const title = media?.title?.trim();
  if (!title) {
    return "Media";
  }

  const authorSummary = formatMediaAuthors(media?.authors, 1);
  if (!authorSummary) {
    return title;
  }

  const compactTitle = `${title} · ${authorSummary}`;
  return compactTitle.length <= 56 ? compactTitle : title;
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
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const probeTop =
    containerRect.top +
    Math.min(
      topPaddingPx,
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
  const topPaddingPx = getPaneScrollTopPaddingPx(container);
  const targetRect = range.getBoundingClientRect();
  if (targetRect.width > 0 || targetRect.height > 0) {
    const delta = targetRect.top - containerRect.top - topPaddingPx;
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

export function buildCanonicalQuoteWindow(
  canonicalText: string,
  canonicalOffset: number
): {
  quote: string | null;
  quotePrefix: string | null;
  quoteSuffix: string | null;
} {
  const chars = [...canonicalText];
  if (chars.length === 0) {
    return { quote: null, quotePrefix: null, quoteSuffix: null };
  }

  const clampedOffset = Math.max(0, Math.min(Math.floor(canonicalOffset), chars.length - 1));
  const quoteStart = Math.min(
    clampedOffset,
    Math.max(0, chars.length - READER_QUOTE_EXACT_CP)
  );
  const quoteEnd = Math.min(chars.length, quoteStart + READER_QUOTE_EXACT_CP);
  const prefixStart = Math.max(0, quoteStart - READER_QUOTE_CONTEXT_CP);
  const suffixEnd = Math.min(chars.length, quoteEnd + READER_QUOTE_CONTEXT_CP);

  const quote = chars.slice(quoteStart, quoteEnd).join("");
  const quotePrefix = chars.slice(prefixStart, quoteStart).join("");
  const quoteSuffix = chars.slice(quoteEnd, suffixEnd).join("");

  return {
    quote: quote.length > 0 ? quote : null,
    quotePrefix: quotePrefix.length > 0 ? quotePrefix : null,
    quoteSuffix: quoteSuffix.length > 0 ? quoteSuffix : null,
  };
}

export function findCanonicalOffsetFromQuote(
  canonicalText: string,
  quote: string | null,
  quotePrefix: string | null,
  quoteSuffix: string | null
): number | null {
  if (!quote) {
    return null;
  }

  const chars = [...canonicalText];
  const quoteChars = [...quote];
  const prefixChars = quotePrefix ? [...quotePrefix] : [];
  const suffixChars = quoteSuffix ? [...quoteSuffix] : [];
  if (quoteChars.length === 0 || chars.length < quoteChars.length) {
    return null;
  }

  let bestOffset: number | null = null;
  let bestScore = -1;

  for (let start = 0; start <= chars.length - quoteChars.length; start += 1) {
    let matchesQuote = true;
    for (let idx = 0; idx < quoteChars.length; idx += 1) {
      if (chars[start + idx] !== quoteChars[idx]) {
        matchesQuote = false;
        break;
      }
    }
    if (!matchesQuote) {
      continue;
    }

    let score = 0;
    if (prefixChars.length > 0 && start >= prefixChars.length) {
      let matchesPrefix = true;
      for (let idx = 0; idx < prefixChars.length; idx += 1) {
        if (chars[start - prefixChars.length + idx] !== prefixChars[idx]) {
          matchesPrefix = false;
          break;
        }
      }
      if (matchesPrefix) {
        score += 2;
      }
    }
    if (suffixChars.length > 0 && start + quoteChars.length + suffixChars.length <= chars.length) {
      let matchesSuffix = true;
      for (let idx = 0; idx < suffixChars.length; idx += 1) {
        if (chars[start + quoteChars.length + idx] !== suffixChars[idx]) {
          matchesSuffix = false;
          break;
        }
      }
      if (matchesSuffix) {
        score += 1;
      }
    }

    if (bestOffset === null || score > bestScore) {
      bestOffset = start;
      bestScore = score;
      if (score === 3) {
        break;
      }
    }
  }

  return bestOffset;
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
): Promise<void> {
  const hasStartOffset = typeof updates.start_offset === "number";
  const hasEndOffset = typeof updates.end_offset === "number";

  if (hasStartOffset !== hasEndOffset) {
    throw new Error("Fragment highlight updates require both start_offset and end_offset.");
  }

  const body: {
    color?: HighlightColor;
    anchor?: {
      type: "fragment_offsets";
      start_offset: number;
      end_offset: number;
    };
  } = {};

  if (updates.color !== undefined) {
    body.color = updates.color;
  }

  if (hasStartOffset && hasEndOffset) {
    body.anchor = {
      type: "fragment_offsets",
      start_offset: updates.start_offset as number,
      end_offset: updates.end_offset as number,
    };
  }

  await apiFetch(`/api/highlights/${highlightId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
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

export async function fetchEpubSectionContent(
  mediaId: string,
  sectionId: string,
  signal?: AbortSignal
): Promise<EpubSectionContent> {
  const resp = await apiFetch<{ data: EpubSectionContent }>(
    `/api/media/${mediaId}/sections/${encodeURIComponent(sectionId)}`,
    signal ? { signal } : {}
  );
  return resp.data;
}

// =============================================================================
// EPUB navigation helpers
// =============================================================================

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

export function buildEpubLocationHref(
  mediaId: string,
  sectionId: string,
  options?: {
    fragmentId?: string | null;
    highlightId?: string | null;
  }
): string {
  const params = new URLSearchParams();
  params.set("loc", sectionId);
  if (options?.fragmentId) {
    params.set("fragment", options.fragmentId);
  }
  if (options?.highlightId) {
    params.set("highlight", options.highlightId);
  }
  return `/media/${mediaId}?${params.toString()}`;
}

const EPUB_LINK_ORIGIN = "https://epub.local";
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function decodeEpubHrefPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeEpubHref(
  href: string,
  baseHref: string | null
): { path: string | null; anchorId: string | null } | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("#")) {
    return {
      path: null,
      anchorId: decodeEpubHrefPart(trimmed.slice(1)) || null,
    };
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("?") || URI_SCHEME_RE.test(trimmed)) {
    return null;
  }

  if (!baseHref) {
    return null;
  }

  try {
    const baseUrl = new URL(baseHref, `${EPUB_LINK_ORIGIN}/`);
    const resolved = new URL(trimmed, baseUrl);
    return {
      path: resolved.pathname.replace(/^\/+/, "") || null,
      anchorId: resolved.hash ? decodeEpubHrefPart(resolved.hash.slice(1)) || null : null,
    };
  } catch {
    return null;
  }
}

export function resolveEpubInternalLinkTarget(
  href: string | null,
  currentSectionId: string | null,
  sections: EpubNavigationSection[] | null
): EpubInternalLinkTarget | null {
  if (!href) {
    return null;
  }

  const currentSection =
    currentSectionId && sections
      ? sections.find((section) => section.section_id === currentSectionId) ?? null
      : null;
  const target = normalizeEpubHref(href, currentSection?.href_path ?? "index.xhtml");
  if (!target) {
    return null;
  }

  if (target.path === null) {
    return currentSectionId
      ? {
          sectionId: currentSectionId,
          anchorId: target.anchorId,
        }
      : null;
  }

  if (!sections || sections.length === 0) {
    return null;
  }

  let pathMatch: EpubInternalLinkTarget | null = null;

  for (const section of sections) {
    if (!section.href_path || section.href_path !== target.path) {
      continue;
    }

    if (target.anchorId && section.anchor_id === target.anchorId) {
      return {
        sectionId: section.section_id,
        anchorId: target.anchorId,
      };
    }

    if (pathMatch === null) {
      pathMatch = {
        sectionId: section.section_id,
        anchorId: target.anchorId ?? section.anchor_id,
      };
    }
  }

  return pathMatch;
}
