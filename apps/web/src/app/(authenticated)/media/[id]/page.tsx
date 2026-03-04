/**
 * Media View Page with highlight creation and editing.
 *
 * Supports two content-loading paths:
 * - EPUB: chapter-first orchestration via /chapters + /toc endpoints.
 * - Non-EPUB: single-fragment flow via /fragments endpoint.
 *
 * @see docs/v1/s5/s5_prs/s5_pr05.md
 */

"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import ReaderContentArea from "@/components/ReaderContentArea";
import HtmlRenderer from "@/components/HtmlRenderer";
import PdfReader, {
  type PdfHighlightOut,
  type PdfReaderControlActions,
  type PdfReaderControlsState,
} from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import HighlightEditor, { type Highlight } from "@/components/HighlightEditor";
import { useToast } from "@/components/Toast";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import {
  applyHighlightsToHtmlMemoized,
  canonicalCpToRawCp,
  clearHighlightCache,
  buildCanonicalCursor,
  codepointToUtf16,
  validateCanonicalText,
  type HighlightColor,
  type HighlightInput,
  type CanonicalCursorResult,
} from "@/lib/highlights";
import {
  DEFAULT_HTML_ANCHOR_PROVIDER,
  DEFAULT_PDF_ANCHOR_PROVIDER,
  type AnchorDescriptor,
  type AnchorProvider,
} from "@/lib/highlights/anchorProviders";
import {
  sortPdfHighlightsByStableKey,
  toFragmentPaneItems,
  toMediaPaneItems,
  toPdfDocumentPaneItems,
  toPdfPageAnchorDescriptors,
  toPdfPagePaneItems,
  type MediaHighlightForIndex,
  type PaneHighlightIndexItem,
} from "@/lib/highlights/highlightIndexAdapter";
import { createPdfPaneNavigationAdapter } from "@/lib/highlights/paneRendererAdapters";
import {
  selectionToOffsets,
  findDuplicateHighlight,
} from "@/lib/highlights/selectionToOffsets";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
} from "@/lib/highlights/useHighlightInteraction";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { useReaderContext, useReaderState } from "@/lib/reader";
import {
  fetchAllEpubChapterSummaries,
  normalizeEpubNavigationToc,
  resolveInitialEpubSectionId,
  isReadableStatus,
  type EpubChapterSummary,
  type EpubChapter,
  type EpubNavigationResponse,
  type EpubNavigationSection,
  type NormalizedNavigationTocNode,
} from "@/lib/media/epubReader";
import TranscriptMediaPane, {
  type TranscriptPlaybackSource,
  type TranscriptFragment,
} from "./TranscriptMediaPane";
import styles from "./page.module.css";

// =============================================================================
// Types
// =============================================================================

interface Media {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  capabilities?: {
    can_read: boolean;
    can_highlight: boolean;
    can_quote: boolean;
    can_search: boolean;
    can_play: boolean;
    can_download_file: boolean;
  };
  playback_source?: TranscriptPlaybackSource | null;
  failure_stage?: string | null;
  last_error_code?: string | null;
  created_at: string;
  updated_at: string;
}

interface Fragment {
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

type EditorHighlight = Highlight;

interface SelectionState {
  range: Range;
  rect: DOMRect;
}

// Active content state used by both paths
interface ActiveContent {
  fragmentId: string;
  htmlSanitized: string;
  canonicalText: string;
}

type PageLinkedHighlight = PaneHighlightIndexItem;

type EpubHighlightScope = "chapter" | "book";
type PdfHighlightScope = "page" | "document";

type MediaHighlight = MediaHighlightForIndex;

type PdfDocumentHighlight = PdfHighlightOut;

type PdfHighlightNavigationTarget = {
  highlightId: string;
  pageNumber: number;
  quads: PdfHighlightOut["anchor"]["quads"];
};

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getPaneScrollContainer(
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

const TEXT_ANCHOR_TOP_PADDING_PX = 56;

function findFirstVisibleCanonicalOffset(
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

function scrollToCanonicalTextAnchor(
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
// API Functions
// =============================================================================

async function fetchHighlights(fragmentId: string): Promise<Highlight[]> {
  const response = await apiFetch<{ data: { highlights: Highlight[] } }>(
    `/api/fragments/${fragmentId}/highlights`
  );
  return response.data.highlights;
}

async function fetchMediaHighlights(
  mediaId: string,
  cursor: string | null,
  limit = 50
): Promise<{ highlights: MediaHighlight[]; hasMore: boolean; nextCursor: string | null }> {
  const params = new URLSearchParams({
    limit: String(limit),
    mine_only: "false",
  });
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await apiFetch<{
    data: {
      highlights: MediaHighlight[];
      page: { has_more: boolean; next_cursor: string | null };
    };
  }>(`/api/media/${mediaId}/highlights?${params.toString()}`);

  return {
    highlights: response.data.highlights,
    hasMore: response.data.page.has_more,
    nextCursor: response.data.page.next_cursor,
  };
}

async function fetchPdfHighlightsIndex(
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

async function createHighlight(
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

async function updateHighlight(
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

async function deleteHighlight(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}`, {
    method: "DELETE",
  });
}

async function saveAnnotation(
  highlightId: string,
  body: string
): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

async function deleteAnnotation(highlightId: string): Promise<void> {
  await apiFetch(`/api/highlights/${highlightId}/annotation`, {
    method: "DELETE",
  });
}

function toEditorHighlightFromPdf(highlight: PdfHighlightOut): EditorHighlight {
  return {
    id: highlight.id,
    fragment_id: "",
    start_offset: 0,
    end_offset: 0,
    color: highlight.color,
    exact: highlight.exact,
    prefix: highlight.prefix,
    suffix: highlight.suffix,
    created_at: highlight.created_at,
    updated_at: highlight.updated_at,
    annotation: highlight.annotation,
  };
}

async function fetchChapterDetail(
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

function buildManifestFallbackSections(
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

interface NavigationTocNodeLike {
  section_id: string | null;
  href: string | null;
  children: NavigationTocNodeLike[];
}

function parseAnchorIdFromHref(href: string | null): string | null {
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

function resolveSectionAnchorId(
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

// =============================================================================
// Component
// =============================================================================

export default function MediaViewPage() {
  const id = usePaneParam("id");
  if (!id) {
    throw new Error("media route requires an id");
  }
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const { toast } = useToast();
  const { profile: readerProfile } = useReaderContext();
  const {
    state: readerState,
    loading: readerStateLoading,
    save: saveReaderState,
  } = useReaderState({
    mediaId: id,
    debounceMs: 500,
  });
  const scrollRestoreAppliedRef = useRef(false);
  const lastSavedTextAnchorOffsetRef = useRef<number | null>(null);

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [activeTranscriptFragmentId, setActiveTranscriptFragmentId] = useState<string | null>(
    null
  );

  // ---- EPUB state ----
  const [epubSections, setEpubSections] = useState<EpubNavigationSection[] | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [activeChapterIdx, setActiveChapterIdx] = useState<number | null>(null);
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  const [pendingHighlightId, setPendingHighlightId] = useState<string | null>(null);
  const [pendingHighlightFragmentId, setPendingHighlightFragmentId] = useState<string | null>(
    null
  );
  const [activeChapter, setActiveChapter] = useState<EpubChapter | null>(null);
  const [epubToc, setEpubToc] = useState<NormalizedNavigationTocNode[] | null>(null);
  const [tocWarning, setTocWarning] = useState(false);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);
  const [epubTocExpanded, setEpubTocExpanded] = useState(false);
  const [epubHighlightScope, setEpubHighlightScope] = useState<EpubHighlightScope>("chapter");
  const [pdfHighlightScope, setPdfHighlightScope] = useState<PdfHighlightScope>("page");
  const [pdfControlsState, setPdfControlsState] = useState<PdfReaderControlsState | null>(null);
  const pdfControlsRef = useRef<PdfReaderControlActions | null>(null);

  // Request-version guard for stale chapter/highlight responses
  const chapterVersionRef = useRef(0);
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [mediaHighlights, setMediaHighlights] = useState<MediaHighlight[]>([]);
  const [mediaHighlightsHasMore, setMediaHighlightsHasMore] = useState(false);
  const [mediaHighlightsCursor, setMediaHighlightsCursor] = useState<string | null>(null);
  const [mediaHighlightsLoading, setMediaHighlightsLoading] = useState(false);
  const [mediaHighlightsVersion, setMediaHighlightsVersion] = useState(0);
  const [pdfDocumentHighlights, setPdfDocumentHighlights] = useState<PdfDocumentHighlight[]>([]);
  const [pdfHighlightsHasMore, setPdfHighlightsHasMore] = useState(false);
  const [pdfHighlightsCursor, setPdfHighlightsCursor] = useState<string | null>(null);
  const [pdfHighlightsLoading, setPdfHighlightsLoading] = useState(false);
  const [pdfPageHighlights, setPdfPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [pdfActivePage, setPdfActivePage] = useState(1);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);
  const [pdfHighlightsVersion, setPdfHighlightsVersion] = useState(0);
  const [pdfNavigationTarget, setPdfNavigationTarget] =
    useState<PdfHighlightNavigationTarget | null>(null);
  const {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
  } = useHighlightInteraction();
  const focusedHighlightIdRef = useRef<string | null>(focusState.focusedId);
  const pdfDocumentHighlightIdsRef = useRef<Set<string>>(new Set());

  // Selection state for creating highlights
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const [highlightsVersion, setHighlightsVersion] = useState(0);

  // ---- Derived state ----
  const isEpub = media?.kind === "epub";
  const isPdf = media?.kind === "pdf";
  const isTranscriptMedia =
    media?.kind === "podcast_episode" || media?.kind === "video";
  const canRead = media
    ? isTranscriptMedia
      ? (media.capabilities?.can_read ?? isReadableStatus(media.processing_status))
      : isReadableStatus(media.processing_status)
    : false;
  const readerProfileOverride = useMemo(() => {
    if (!readerState) {
      return null;
    }
    return {
      theme: readerState.theme,
      font_family: readerState.font_family,
      font_size_px: readerState.font_size_px,
      line_height: readerState.line_height,
      column_width_ch: readerState.column_width_ch,
      focus_mode: readerState.focus_mode,
      default_view_mode: readerState.view_mode,
    };
  }, [readerState]);
  const focusModeEnabled = Boolean(readerState?.focus_mode ?? readerProfile.focus_mode);
  const showHighlightsPane = canRead && !focusModeEnabled;
  const canPlay = media?.capabilities?.can_play ?? false;
  const playbackSource = media?.playback_source ?? null;
  const isPlaybackOnlyTranscript =
    isTranscriptMedia &&
    media?.processing_status === "failed" &&
    media?.last_error_code === "E_TRANSCRIPT_UNAVAILABLE" &&
    canPlay;

  const activeTranscriptFragment = useMemo(() => {
    if (!isTranscriptMedia || fragments.length === 0) {
      return null;
    }
    return (
      fragments.find((fragment) => fragment.id === activeTranscriptFragmentId) ??
      fragments[0]
    );
  }, [activeTranscriptFragmentId, fragments, isTranscriptMedia]);

  useEffect(() => {
    focusedHighlightIdRef.current = focusState.focusedId;
  }, [focusState.focusedId]);

  useEffect(() => {
    pdfDocumentHighlightIdsRef.current = new Set(
      pdfDocumentHighlights.map((highlight) => highlight.id)
    );
  }, [pdfDocumentHighlights]);

  const linkedPaneHighlights: PageLinkedHighlight[] = useMemo(() => {
    if (isPdf) {
      return pdfHighlightScope === "document"
        ? toPdfDocumentPaneItems(pdfDocumentHighlights)
        : toPdfPagePaneItems(pdfPageHighlights);
    }
    if (isEpub && epubHighlightScope === "book") {
      return toMediaPaneItems(mediaHighlights);
    }
    return toFragmentPaneItems(highlights);
  }, [
    epubHighlightScope,
    highlights,
    isEpub,
    isPdf,
    mediaHighlights,
    pdfDocumentHighlights,
    pdfHighlightScope,
    pdfPageHighlights,
  ]);
  const pdfPaneNavigationAdapter = useMemo(
    () => createPdfPaneNavigationAdapter(pdfDocumentHighlights),
    [pdfDocumentHighlights]
  );

  const focusedHighlightForEditor = useMemo(() => {
    if (!focusState.focusedId) {
      return null;
    }
    if (isPdf) {
      const pdfHighlight =
        pdfPageHighlights.find((h) => h.id === focusState.focusedId) ??
        pdfDocumentHighlights.find((h) => h.id === focusState.focusedId);
      return pdfHighlight ? toEditorHighlightFromPdf(pdfHighlight) : null;
    }
    if (isEpub && epubHighlightScope === "book") {
      const mediaHighlight = mediaHighlights.find((h) => h.id === focusState.focusedId);
      if (mediaHighlight) {
        return mediaHighlight;
      }
    }
    return highlights.find((h) => h.id === focusState.focusedId) ?? null;
  }, [
    focusState.focusedId,
    highlights,
    isPdf,
    pdfPageHighlights,
    pdfDocumentHighlights,
    isEpub,
    epubHighlightScope,
    mediaHighlights,
  ]);

  const linkedItemsContentRef = isPdf ? pdfContentRef : contentRef;
  const linkedItemsVersion = isPdf
    ? pdfHighlightsVersion
    : isEpub && epubHighlightScope === "book"
      ? mediaHighlightsVersion
      : highlightsVersion;
  const linkedItemsLayoutMode: "aligned" | "list" =
    isPdf
      ? pdfHighlightScope === "document"
        ? "list"
        : "aligned"
      : isEpub && epubHighlightScope === "book"
        ? "list"
        : "aligned";
  const linkedItemsAnchorDescriptors: AnchorDescriptor[] | undefined = useMemo(() => {
    if (!isPdf || pdfHighlightScope !== "page") {
      return undefined;
    }
    return toPdfPageAnchorDescriptors(pdfPageHighlights);
  }, [isPdf, pdfHighlightScope, pdfPageHighlights]);
  const linkedItemsAnchorProvider: AnchorProvider =
    isPdf && pdfHighlightScope === "page"
      ? DEFAULT_PDF_ANCHOR_PROVIDER
      : DEFAULT_HTML_ANCHOR_PROVIDER;

  const pdfOffPageHighlightCount = useMemo(() => {
    if (!isPdf) return 0;
    let count = 0;
    for (const highlight of pdfDocumentHighlights) {
      if (highlight.anchor.page_number !== pdfActivePage) {
        count += 1;
      }
    }
    return count;
  }, [isPdf, pdfDocumentHighlights, pdfActivePage]);

  const pdfLinkedItemsHint = useMemo(() => {
    if (!isPdf) return "";
    if (pdfHighlightScope === "document") {
      return "Showing highlights from the entire document.";
    }
    if (pdfOffPageHighlightCount <= 0) {
      return "Showing highlights for this page.";
    }
    const noun = pdfOffPageHighlightCount === 1 ? "highlight" : "highlights";
    const prefix = pdfHighlightsHasMore ? "At least " : "";
    return `${prefix}${pdfOffPageHighlightCount} ${noun} on other pages. Switch to Entire document to view them immediately.`;
  }, [isPdf, pdfHighlightScope, pdfHighlightsHasMore, pdfOffPageHighlightCount]);

  // Unified active content for both paths
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isPdf) {
      return null;
    }
    if (isEpub && activeChapter) {
      return {
        fragmentId: activeChapter.fragment_id,
        htmlSanitized: activeChapter.html_sanitized,
        canonicalText: activeChapter.canonical_text,
      };
    }
    const frag = isTranscriptMedia ? activeTranscriptFragment : (fragments[0] ?? null);
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
      };
    }
    return null;
  }, [isPdf, isEpub, isTranscriptMedia, activeChapter, activeTranscriptFragment, fragments]);

  useEffect(() => {
    // Reset PDF-specific pane state whenever media identity/type changes.
    // This prevents stale cross-document rows from flashing during navigation.
    setPdfDocumentHighlights([]);
    setPdfHighlightsHasMore(false);
    setPdfHighlightsCursor(null);
    setPdfHighlightsLoading(false);
    setPdfPageHighlights([]);
    setPdfActivePage(1);
    setPdfRefreshToken(0);
    setPdfHighlightsVersion(0);
    setPdfNavigationTarget(null);
    setPdfHighlightScope("page");
  }, [isPdf, id]);

  useEffect(() => {
    if (!isEpub || epubHighlightScope !== "book") {
      setMediaHighlights([]);
      setMediaHighlightsHasMore(false);
      setMediaHighlightsCursor(null);
      setMediaHighlightsLoading(false);
      setMediaHighlightsVersion(0);
    }
  }, [isEpub, epubHighlightScope]);

  useEffect(() => {
    if (!isEpub || epubHighlightScope !== "book" || !media?.id) return;
    let cancelled = false;

    const loadMediaHighlights = async () => {
      setMediaHighlightsLoading(true);
      try {
        const page = await fetchMediaHighlights(media.id, null);
        if (cancelled) return;
        setMediaHighlights(page.highlights);
        setMediaHighlightsHasMore(page.hasMore);
        setMediaHighlightsCursor(page.nextCursor);
        setMediaHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load media highlights:", err);
      } finally {
        if (!cancelled) {
          setMediaHighlightsLoading(false);
        }
      }
    };

    loadMediaHighlights();
    return () => {
      cancelled = true;
    };
  }, [isEpub, epubHighlightScope, media?.id]);

  useEffect(() => {
    if (!isPdf || !media?.id) return;
    let cancelled = false;

    const loadPdfHighlights = async () => {
      setPdfHighlightsLoading(true);
      try {
        const page = await fetchPdfHighlightsIndex(media.id, null);
        if (cancelled) return;
        setPdfDocumentHighlights(sortPdfHighlightsByStableKey(page.highlights));
        setPdfHighlightsHasMore(page.hasMore);
        setPdfHighlightsCursor(page.nextCursor);
        setPdfHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load PDF highlights:", err);
      } finally {
        if (!cancelled) {
          setPdfHighlightsLoading(false);
        }
      }
    };

    loadPdfHighlights();
    return () => {
      cancelled = true;
    };
  }, [isPdf, media?.id, pdfRefreshToken]);

  // ==========================================================================
  // Data Fetching — initial load
  // ==========================================================================

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        const mediaResp = await apiFetch<{ data: Media }>(`/api/media/${id}`);
        if (cancelled) return;
        const m = mediaResp.data;
        setMedia(m);

        if (m.kind !== "epub" && m.kind !== "pdf") {
          // Non-EPUB: load fragments
          const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
            `/api/media/${id}/fragments`
          );
          if (cancelled) return;
          setFragments(fragmentsResp.data);
          setActiveTranscriptFragmentId(fragmentsResp.data[0]?.id ?? null);
        }

        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.status === 404) {
            setError("Media not found or you don't have access to it.");
          } else {
            setError(err.message);
          }
        } else {
          setError("Failed to load media");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => { cancelled = true; };
  }, [id]);

  // ==========================================================================
  // EPUB orchestration — manifest + TOC + initial chapter
  // ==========================================================================

  useEffect(() => {
    if (!media || media.kind !== "epub" || !isReadableStatus(media.processing_status)) return;

    let cancelled = false;

    const loadEpub = async () => {
      try {
        // Load manifest
        const chapters = await fetchAllEpubChapterSummaries(apiFetch, id);
        if (cancelled) return;

        let sections: EpubNavigationSection[] = [];
        setTocWarning(false);

        try {
          const navResp = await apiFetch<EpubNavigationResponse>(`/api/media/${id}/navigation`);
          if (cancelled) return;
          sections = navResp.data.sections.map((section) => ({
            ...section,
            anchor_id: resolveSectionAnchorId(
              section.section_id,
              section.anchor_id,
              navResp.data.toc_nodes as unknown as NavigationTocNodeLike[]
            ),
          }));
          const sectionIdSet = new Set(sections.map((section) => section.section_id));
          setEpubToc(normalizeEpubNavigationToc(navResp.data.toc_nodes, sectionIdSet));
        } catch {
          // Keep reading available even if navigation contract is temporarily unavailable.
          sections = buildManifestFallbackSections(chapters);
          if (!cancelled) {
            setTocWarning(true);
            setEpubToc(null);
          }
        }

        if (sections.length === 0) {
          sections = buildManifestFallbackSections(chapters);
        }
        setEpubSections(sections);

        const locParam = searchParams.get("loc") ?? readerState?.section_id ?? null;
        const chapterParam = searchParams.get("chapter");
        const resolvedSectionId = resolveInitialEpubSectionId(sections, locParam, chapterParam);

        if (resolvedSectionId !== null) {
          const resolvedSection = sections.find((section) => section.section_id === resolvedSectionId);
          if (!resolvedSection) {
            setEpubError("No chapters available for this EPUB.");
            return;
          }
          if (locParam !== resolvedSectionId || chapterParam !== null) {
            router.replace(`/media/${id}?loc=${encodeURIComponent(resolvedSectionId)}`);
          }
          setActiveSectionId(resolvedSectionId);
          setPendingAnchorId(resolvedSection.anchor_id ?? resolvedSection.section_id);
          setActiveChapterIdx(resolvedSection.fragment_idx);
        } else {
          setEpubError("No chapters available for this EPUB.");
        }
      } catch (err) {
        if (cancelled) return;
        if (isApiError(err)) {
          if (err.code === "E_MEDIA_NOT_READY") {
            setEpubError("processing");
          } else if (err.status === 404) {
            setError("Media not found or you don't have access to it.");
          } else {
            setEpubError(err.message);
          }
        } else {
          setEpubError("Failed to load EPUB chapters.");
        }
      }
    };

    loadEpub();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstraps on media lifecycle changes
  }, [media?.id, media?.kind, media?.processing_status]);

  // ==========================================================================
  // EPUB — fetch active chapter on idx change
  // ==========================================================================

  useEffect(() => {
    if (!isEpub || activeChapterIdx === null) return;

    const version = ++chapterVersionRef.current;
    const controller = new AbortController();

    setChapterLoading(true);
    clearFocus();
    setHighlights([]);
    setHighlightsVersion((v) => v + 1);
    setSelection(null);

    const load = async () => {
      try {
        const chapter = await fetchChapterDetail(id, activeChapterIdx, controller.signal);
        if (version !== chapterVersionRef.current) return;
        setActiveChapter(chapter);
        setEpubError(null);
      } catch (err) {
        if (controller.signal.aborted || version !== chapterVersionRef.current) return;
        await handleChapterFetchError(err, version);
      } finally {
        if (version === chapterVersionRef.current) {
          setChapterLoading(false);
        }
      }
    };

    load();
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on chapter idx change
  }, [isEpub, activeChapterIdx, id]);

  // EPUB URL/state sync for browser back/forward on ?loc=
  useEffect(() => {
    if (!isEpub || !epubSections || epubSections.length === 0) return;
    const locParam = searchParams.get("loc");
    if (!locParam || locParam === activeSectionId) return;
    const section = epubSections.find((item) => item.section_id === locParam);
    if (!section) return;
    setActiveSectionId(section.section_id);
    setPendingAnchorId(section.anchor_id ?? section.section_id);
    setActiveChapterIdx(section.fragment_idx);
  }, [isEpub, epubSections, searchParams, activeSectionId]);

  // EPUB: persist section for resume
  useEffect(() => {
    if (!isEpub || !activeSectionId) return;
    saveReaderState({
      locator_kind: "epub_section",
      section_id: activeSectionId,
      fragment_id: null,
      offset: null,
      page: null,
      zoom: null,
    });
  }, [isEpub, activeSectionId, saveReaderState]);

  useEffect(() => {
    scrollRestoreAppliedRef.current = false;
    lastSavedTextAnchorOffsetRef.current = null;
  }, [id, isEpub, isPdf, activeContent?.fragmentId]);

  // Web article/transcript: restore canonical text-anchor from reader state.
  useEffect(() => {
    if (
      isPdf ||
      isEpub ||
      !activeContent ||
      !readerState ||
      readerState.locator_kind !== "fragment_offset" ||
      readerState.offset === null ||
      scrollRestoreAppliedRef.current
    ) {
      return;
    }
    if (isMismatchDisabled) {
      return;
    }
    const resumeOffset = readerState.offset;

    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 24;

    const attemptRestore = () => {
      attempts += 1;
      const cursor = cursorRef.current;
      if (!cursor) {
        if (attempts < maxAttempts) {
          rafId = window.requestAnimationFrame(attemptRestore);
        }
        return;
      }

      const restored = scrollToCanonicalTextAnchor(
        container,
        cursor,
        resumeOffset
      );
      if (restored) {
        scrollRestoreAppliedRef.current = true;
      } else if (attempts < maxAttempts) {
        rafId = window.requestAnimationFrame(attemptRestore);
      }
    };

    rafId = window.requestAnimationFrame(attemptRestore);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isPdf,
    isEpub,
    activeContent,
    readerState,
    readerState?.locator_kind,
    readerState?.offset,
    isMismatchDisabled,
  ]);

  // Web article/transcript: persist canonical text-anchor for resume.
  useEffect(() => {
    if (isPdf || isEpub || !activeContent || isMismatchDisabled) {
      return;
    }
    const container = getPaneScrollContainer(contentRef.current);
    if (!container) {
      return;
    }

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        const cursor = cursorRef.current;
        if (!cursor) {
          return;
        }
        const anchorOffset = findFirstVisibleCanonicalOffset(container, cursor);
        if (anchorOffset === null) {
          return;
        }
        if (lastSavedTextAnchorOffsetRef.current === anchorOffset) {
          return;
        }
        lastSavedTextAnchorOffsetRef.current = anchorOffset;
        saveReaderState({
          locator_kind: "fragment_offset",
          fragment_id: activeContent.fragmentId,
          offset: anchorOffset,
          section_id: null,
          page: null,
          zoom: null,
        });
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [isPdf, isEpub, activeContent, saveReaderState, isMismatchDisabled]);

  // Scroll to anchor target after chapter content loads.
  useEffect(() => {
    if (!isEpub || !pendingAnchorId || !contentRef.current || !activeChapter || chapterLoading) {
      return;
    }

    let cancelled = false;
    let rafId = 0;
    const MAX_ATTEMPTS = 24;

    const findTarget = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root) {
        return null;
      }

      const byId =
        Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
          (el) => el.getAttribute("id") === pendingAnchorId
        ) ?? null;
      if (byId) {
        return byId;
      }

      return (
        Array.from(root.querySelectorAll<HTMLElement>("[name]")).find(
          (el) => el.getAttribute("name") === pendingAnchorId
        ) ?? null
      );
    };

    const findTargetBySectionLabel = (): HTMLElement | null => {
      const root = contentRef.current;
      if (!root || !epubSections || !activeSectionId) {
        return null;
      }

      const section =
        epubSections.find((item) => item.section_id === activeSectionId) ??
        epubSections.find((item) => item.section_id === pendingAnchorId);
      if (!section) {
        return null;
      }

      const normalizedLabel = section.label.replace(/^chapter\s+\d+\s*:\s*/i, "").trim();
      if (!normalizedLabel) {
        return null;
      }

      const headings = Array.from(
        root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      );
      return (
        headings.find((heading) => heading.textContent?.trim() === normalizedLabel) ??
        headings.find((heading) =>
          heading.textContent?.trim().toLowerCase().includes(normalizedLabel.toLowerCase())
        ) ??
        null
      );
    };

    const attemptScroll = (attempt: number) => {
      if (cancelled) {
        return;
      }

      const target = findTarget() ?? findTargetBySectionLabel();
      if (target) {
        target.scrollIntoView({ block: "start", behavior: "auto" });
        setPendingAnchorId(null);
        return;
      }

      if (attempt >= MAX_ATTEMPTS) {
        setPendingAnchorId(null);
        return;
      }

      rafId = window.requestAnimationFrame(() => attemptScroll(attempt + 1));
    };

    attemptScroll(0);

    return () => {
      cancelled = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    isEpub,
    pendingAnchorId,
    activeChapter,
    chapterLoading,
    epubSections,
    activeSectionId,
  ]);

  // Chapter fetch error recovery matrix
  const handleChapterFetchError = useCallback(
    async (err: unknown, requestVersion: number) => {
      if (!isApiError(err)) {
        setEpubError("Failed to load chapter.");
        return;
      }

      if (err.code === "E_CHAPTER_NOT_FOUND") {
        // Re-sync manifest once and re-resolve
        try {
          const freshManifest = await fetchAllEpubChapterSummaries(apiFetch, id);
          if (requestVersion !== chapterVersionRef.current) return;
          const fallbackSections = buildManifestFallbackSections(freshManifest);
          setEpubSections(fallbackSections);
          const resolvedSectionId = resolveInitialEpubSectionId(
            fallbackSections,
            activeSectionId,
            null
          );
          if (resolvedSectionId !== null) {
            const section = fallbackSections.find((s) => s.section_id === resolvedSectionId)!;
            router.replace(`/media/${id}?loc=${encodeURIComponent(resolvedSectionId)}`);
            setActiveSectionId(resolvedSectionId);
            setPendingAnchorId(section.anchor_id ?? section.section_id);
            setActiveChapterIdx(section.fragment_idx);
          } else {
            setEpubError("No chapters available for this EPUB.");
          }
        } catch {
          setEpubError("Failed to recover chapter list.");
        }
        return;
      }

      if (err.code === "E_MEDIA_NOT_READY") {
        setEpubError("processing");
        return;
      }

      if (err.status === 404) {
        setError("Media not found or you don't have access to it.");
        return;
      }

      setEpubError(err.message);
    },
    [activeSectionId, id, router]
  );

  // ==========================================================================
  // Highlight loading — reacts to active content
  // ==========================================================================

  useEffect(() => {
    if (!activeContent) return;

    const version = ++highlightVersionRef.current;

    const loadHighlights = async () => {
      try {
        const data = await fetchHighlights(activeContent.fragmentId);
        if (version !== highlightVersionRef.current) return;
        setHighlights(data);
        setHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (version !== highlightVersionRef.current) return;
        console.error("Failed to load highlights:", err);
      }
    };

    loadHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when active fragment changes
  }, [activeContent?.fragmentId]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const renderedHtml = useMemo(
    () =>
      activeContent
        ? applyHighlightsToHtmlMemoized(
            activeContent.htmlSanitized,
            activeContent.canonicalText,
            activeContent.fragmentId,
            highlights as HighlightInput[]
          ).html
        : "",
    [activeContent, highlights]
  );

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  useEffect(() => {
    if (!activeContent || !contentRef.current) return;

    const cursor = buildCanonicalCursor(contentRef.current);
    const isValid = validateCanonicalText(
      cursor,
      activeContent.canonicalText,
      activeContent.fragmentId
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild when rendered content changes
  }, [activeContent?.fragmentId, activeContent?.canonicalText, renderedHtml]);

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, focusState.focusedId);
  }, [focusState.focusedId]);

  const refreshMediaHighlights = useCallback(async () => {
    if (!isEpub || epubHighlightScope !== "book" || !media?.id) return;
    const page = await fetchMediaHighlights(media.id, null);
    setMediaHighlights(page.highlights);
    setMediaHighlightsHasMore(page.hasMore);
    setMediaHighlightsCursor(page.nextCursor);
    setMediaHighlightsVersion((v) => v + 1);
  }, [isEpub, epubHighlightScope, media?.id]);

  const scheduleMediaHighlightsRefresh = useCallback(() => {
    void refreshMediaHighlights().catch((err) => {
      console.error("Failed to refresh media highlights:", err);
    });
  }, [refreshMediaHighlights]);

  const refreshPdfHighlightsIndex = useCallback(async () => {
    if (!isPdf || !media?.id) return;
    const page = await fetchPdfHighlightsIndex(media.id, null);
    setPdfDocumentHighlights(sortPdfHighlightsByStableKey(page.highlights));
    setPdfHighlightsHasMore(page.hasMore);
    setPdfHighlightsCursor(page.nextCursor);
    setPdfHighlightsVersion((v) => v + 1);
  }, [isPdf, media?.id]);

  const schedulePdfHighlightsRefresh = useCallback(() => {
    void refreshPdfHighlightsIndex().catch((err) => {
      console.error("Failed to refresh PDF highlight index:", err);
    });
  }, [refreshPdfHighlightsIndex]);

  const handleLoadMoreMediaHighlights = useCallback(async () => {
    if (!isEpub || epubHighlightScope !== "book" || !media?.id || !mediaHighlightsCursor) return;
    setMediaHighlightsLoading(true);
    try {
      const next = await fetchMediaHighlights(media.id, mediaHighlightsCursor);
      setMediaHighlights((prev) => [...prev, ...next.highlights]);
      setMediaHighlightsHasMore(next.hasMore);
      setMediaHighlightsCursor(next.nextCursor);
      setMediaHighlightsVersion((v) => v + 1);
    } catch (err) {
      console.error("Failed to load more media highlights:", err);
    } finally {
      setMediaHighlightsLoading(false);
    }
  }, [isEpub, epubHighlightScope, media?.id, mediaHighlightsCursor]);

  const handleLoadMorePdfHighlights = useCallback(async () => {
    if (!isPdf || !media?.id || !pdfHighlightsCursor) return;
    setPdfHighlightsLoading(true);
    try {
      const next = await fetchPdfHighlightsIndex(media.id, pdfHighlightsCursor);
      setPdfDocumentHighlights((prev) => sortPdfHighlightsByStableKey([...prev, ...next.highlights]));
      setPdfHighlightsHasMore(next.hasMore);
      setPdfHighlightsCursor(next.nextCursor);
      setPdfHighlightsVersion((v) => v + 1);
    } catch (err) {
      console.error("Failed to load more PDF highlights:", err);
    } finally {
      setPdfHighlightsLoading(false);
    }
  }, [isPdf, media?.id, pdfHighlightsCursor]);

  const handleLinkedItemClick = useCallback(
    (highlightId: string) => {
      if (isPdf) {
        if (pdfHighlightScope === "document") {
          setPdfNavigationTarget(pdfPaneNavigationAdapter.resolveNavigationRequest(highlightId));
        }
        focusHighlight(highlightId);
        return;
      }

      if (isEpub && epubHighlightScope === "book") {
        const target = mediaHighlights.find((h) => h.id === highlightId);
        if (target && activeContent?.fragmentId !== target.fragment_id) {
          setPendingAnchorId(null);
          setPendingHighlightId(highlightId);
          setPendingHighlightFragmentId(target.fragment_id);
          const section = epubSections?.find((item) => item.fragment_idx === target.fragment_idx);
          if (section) {
            router.push(`/media/${id}?loc=${encodeURIComponent(section.section_id)}`);
            setActiveSectionId(section.section_id);
            setActiveChapterIdx(section.fragment_idx);
          } else {
            setActiveChapterIdx(target.fragment_idx);
          }
        } else {
          setPendingHighlightId(null);
          setPendingHighlightFragmentId(null);
        }
      }
      focusHighlight(highlightId);
    },
    [
      isPdf,
      pdfHighlightScope,
      pdfPaneNavigationAdapter,
      isEpub,
      epubHighlightScope,
      mediaHighlights,
      activeContent?.fragmentId,
      epubSections,
      router,
      id,
      focusHighlight,
    ]
  );

  useEffect(() => {
    if (
      !isEpub ||
      !pendingHighlightId ||
      !pendingHighlightFragmentId ||
      !activeContent ||
      activeContent.fragmentId !== pendingHighlightFragmentId ||
      !contentRef.current ||
      chapterLoading
    ) {
      return;
    }

    const escapedId = escapeAttrValue(pendingHighlightId);
    const anchor = contentRef.current.querySelector<HTMLElement>(
      `[data-highlight-anchor="${escapedId}"]`
    );
    if (anchor) {
      anchor.scrollIntoView({ behavior: "auto", block: "center" });
      focusHighlight(pendingHighlightId);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      return;
    }

    if (highlights.some((item) => item.id === pendingHighlightId)) {
      console.warn("pending_highlight_anchor_missing", { highlightId: pendingHighlightId });
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
    }
  }, [
    isEpub,
    pendingHighlightId,
    pendingHighlightFragmentId,
    activeContent,
    chapterLoading,
    renderedHtml,
    highlights,
    focusHighlight,
  ]);

  const handleEpubHighlightScopeChange = useCallback(
    (scope: EpubHighlightScope) => {
      setEpubHighlightScope(scope);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      clearFocus();
    },
    [clearFocus]
  );

  const handlePdfHighlightScopeChange = useCallback(
    (scope: PdfHighlightScope) => {
      setPdfHighlightScope(scope);
      setPdfNavigationTarget(null);
      clearFocus();
    },
    [clearFocus]
  );

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  const handleSelectionChange = useCallback(() => {
    if (isPdf) {
      setSelection(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }

    if (isMismatchDisabled) {
      setSelection(null);
      toast({ variant: "warning", message: "Highlights disabled due to content mismatch." });
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ range: range.cloneRange(), rect });
  }, [isMismatchDisabled, isPdf, toast]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  // ==========================================================================
  // Highlight Creation
  // ==========================================================================

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<string | null> => {
      if (!selection || !activeContent || !cursorRef.current || isCreating) return null;

      const result = selectionToOffsets(
        selection.range,
        cursorRef.current,
        activeContent.canonicalText,
        isMismatchDisabled
      );

      if (!result.success) {
        toast({ variant: "error", message: result.message });
        setSelection(null);
        return null;
      }

      const duplicateId = findDuplicateHighlight(
        highlights,
        result.startOffset,
        result.endOffset
      );

      if (duplicateId) {
        focusHighlight(duplicateId);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        return duplicateId;
      }

      setIsCreating(true);

      try {
        await createHighlight(
          activeContent.fragmentId,
          result.startOffset,
          result.endOffset,
          color
        );

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        clearHighlightCache();
        scheduleMediaHighlightsRefresh();

        const newHighlight = newHighlights.find(
          (h) =>
            h.start_offset === result.startOffset &&
            h.end_offset === result.endOffset
        );
        if (newHighlight) {
          focusHighlight(newHighlight.id);
        }

        setSelection(null);
        window.getSelection()?.removeAllRanges();
        return newHighlight?.id ?? null;
      } catch (err) {
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
          try {
            const newHighlights = await fetchHighlights(activeContent.fragmentId);
            setHighlights(newHighlights);
            setHighlightsVersion((v) => v + 1);
            clearHighlightCache();
            scheduleMediaHighlightsRefresh();

            const existing = newHighlights.find(
              (h) =>
                h.start_offset === result.startOffset &&
                h.end_offset === result.endOffset
            );
            if (existing) {
              focusHighlight(existing.id);
            }

            setSelection(null);
            window.getSelection()?.removeAllRanges();
            return existing?.id ?? null;
          } catch (refreshErr) {
            console.error("Failed to refresh highlights after conflict:", refreshErr);
            toast({ variant: "error", message: "Failed to resolve existing highlight" });
            return null;
          }
        } else {
          console.error("Failed to create highlight:", err);
          toast({ variant: "error", message: "Failed to create highlight" });
          return null;
        }
      } finally {
        setIsCreating(false);
      }
      return null;
    },
    [
      selection,
      activeContent,
      isCreating,
      isMismatchDisabled,
      highlights,
      focusHighlight,
      toast,
      scheduleMediaHighlightsRefresh,
    ]
  );

  const handleDismissPopover = useCallback(() => {
    setSelection(null);
  }, []);

  const handleTranscriptSegmentSelect = useCallback(
    (fragment: TranscriptFragment) => {
      setActiveTranscriptFragmentId(fragment.id);
      clearFocus();
      setHighlights([]);
      setHighlightsVersion((v) => v + 1);
      setSelection(null);
    },
    [clearFocus]
  );

  // ==========================================================================
  // Highlight Click Handling
  // ==========================================================================

  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      const highlightEl = findHighlightElement(target);

      if (highlightEl) {
        const clickData = parseHighlightElement(highlightEl);
        if (clickData) {
          handleHighlightClick(clickData);
          return;
        }
      }

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        clearFocus();
      }
    },
    [handleHighlightClick, clearFocus]
  );

  // ==========================================================================
  // Edit Bounds Mode
  // ==========================================================================

  useEffect(() => {
    if (
      isPdf ||
      !focusState.editingBounds ||
      !selection ||
      !activeContent ||
      !cursorRef.current
    )
      return;

    const focusedHighlight = highlights.find(
      (h) => h.id === focusState.focusedId
    );
    if (!focusedHighlight) return;

    const result = selectionToOffsets(
      selection.range,
      cursorRef.current,
      activeContent.canonicalText,
      isMismatchDisabled
    );

    if (!result.success) {
      toast({ variant: "error", message: result.message });
      return;
    }

    const updateBounds = async () => {
      try {
        await updateHighlight(focusedHighlight.id, {
          start_offset: result.startOffset,
          end_offset: result.endOffset,
        });

        const newHighlights = await fetchHighlights(activeContent.fragmentId);
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        clearHighlightCache();

        const newIds = new Set(newHighlights.map((h) => h.id));
        const reconciledFocus = reconcileFocusAfterRefetch(
          focusState.focusedId,
          newIds
        );
        if (reconciledFocus !== focusState.focusedId) {
          focusHighlight(reconciledFocus);
        }

        cancelEditBounds();
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      } catch (err) {
        console.error("Failed to update bounds:", err);
        toast({ variant: "error", message: "Failed to update highlight bounds" });
      }
    };

    updateBounds();
  }, [
    focusState.editingBounds,
    focusState.focusedId,
    isPdf,
    selection,
    activeContent,
    isMismatchDisabled,
    highlights,
    focusHighlight,
    cancelEditBounds,
    toast,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      if (isPdf) {
        await updateHighlight(highlightId, { color });
        setPdfRefreshToken((v) => v + 1);
        setPdfHighlightsVersion((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      await updateHighlight(highlightId, { color });
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      if (isPdf) {
        await deleteHighlight(highlightId);
        setPdfRefreshToken((v) => v + 1);
        setPdfHighlightsVersion((v) => v + 1);
        clearFocus();
        return;
      }
      if (!activeContent) return;
      await deleteHighlight(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
      scheduleMediaHighlightsRefresh();
      clearFocus();
    },
    [activeContent, clearFocus, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleAnnotationSave = useCallback(
    async (highlightId: string, body: string) => {
      if (isPdf) {
        await saveAnnotation(highlightId, body);
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      await saveAnnotation(highlightId, body);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  const handleAnnotationDelete = useCallback(
    async (highlightId: string) => {
      if (isPdf) {
        await deleteAnnotation(highlightId);
        setPdfRefreshToken((v) => v + 1);
        return;
      }
      if (!activeContent) return;
      await deleteAnnotation(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      scheduleMediaHighlightsRefresh();
    },
    [activeContent, isPdf, scheduleMediaHighlightsRefresh]
  );

  // ==========================================================================
  // Quote-to-Chat
  // ==========================================================================

  const buildQuoteRoute = useCallback((highlightId: string): string => {
    const qp = new URLSearchParams({
      attach_type: "highlight",
      attach_id: highlightId,
    });
    return `/conversations?${qp}`;
  }, []);

  const openQuoteRoute = useCallback(
    (highlightId: string) => {
      const route = buildQuoteRoute(highlightId);
      if (!requestOpenInAppPane(route)) {
        router.push(route);
      }
    },
    [buildQuoteRoute, router]
  );

  const handleSendToChat = useCallback(
    (highlightId: string) => {
      openQuoteRoute(highlightId);
    },
    [openQuoteRoute]
  );

  const handleQuoteSelectionToNewChat = useCallback(
    async (color: HighlightColor) => {
      const highlightId = await handleCreateHighlight(color);
      if (!highlightId) return;
      openQuoteRoute(highlightId);
    },
    [handleCreateHighlight, openQuoteRoute]
  );

  // ==========================================================================
  // EPUB Chapter Navigation
  // ==========================================================================

  const navigateToSection = useCallback(
    (sectionId: string) => {
      const section = epubSections?.find((item) => item.section_id === sectionId);
      if (!section) return;
      router.push(`/media/${id}?loc=${encodeURIComponent(sectionId)}`);
      setActiveSectionId(sectionId);
      setPendingAnchorId(section.anchor_id ?? section.section_id);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      setActiveChapterIdx(section.fragment_idx);
    },
    [router, id, epubSections]
  );

  const activeSectionPosition = useMemo(() => {
    if (!epubSections || !activeSectionId) {
      return -1;
    }
    return epubSections.findIndex((section) => section.section_id === activeSectionId);
  }, [activeSectionId, epubSections]);
  const prevSection =
    activeSectionPosition > 0 && epubSections
      ? epubSections[activeSectionPosition - 1]
      : null;
  const nextSection =
    activeSectionPosition >= 0 &&
    epubSections &&
    activeSectionPosition < epubSections.length - 1
      ? epubSections[activeSectionPosition + 1]
      : null;
  const hasEpubToc = epubToc !== null && epubToc.length > 0;

  const handlePdfPageHighlightsChange = useCallback(
    (nextPage: number, nextHighlights: PdfHighlightOut[]) => {
      setPdfActivePage(nextPage);
      setPdfPageHighlights(nextHighlights);
      setPdfHighlightsVersion((v) => v + 1);

      const focusedHighlightId = focusedHighlightIdRef.current;
      if (
        focusedHighlightId &&
        !nextHighlights.some((highlight) => highlight.id === focusedHighlightId) &&
        !pdfDocumentHighlightIdsRef.current.has(focusedHighlightId)
      ) {
        clearFocus();
      }
    },
    [clearFocus]
  );

  const handleCollapseHighlightDetails = useCallback(() => {
    cancelEditBounds();
    focusHighlight(null);
  }, [cancelEditBounds, focusHighlight]);

  const renderExpandedLinkedItem = useCallback(
    (highlightId: string) => {
      if (!focusedHighlightForEditor || focusedHighlightForEditor.id !== highlightId) {
        return null;
      }

      return (
        <div className={styles.inlineHighlightEditor}>
          <div className={styles.inlineHighlightEditorHeader}>
            <button
              type="button"
              className={styles.collapseInlineEditorBtn}
              onClick={(event) => {
                event.stopPropagation();
                handleCollapseHighlightDetails();
              }}
            >
              Collapse
            </button>
          </div>
          <HighlightEditor
            highlight={focusedHighlightForEditor}
            isEditingBounds={focusState.editingBounds}
            onStartEditBounds={startEditBounds}
            onCancelEditBounds={cancelEditBounds}
            onColorChange={handleColorChange}
            onDelete={handleDelete}
            onAnnotationSave={handleAnnotationSave}
            onAnnotationDelete={handleAnnotationDelete}
            compact
          />
        </div>
      );
    },
    [
      focusedHighlightForEditor,
      focusState.editingBounds,
      startEditBounds,
      cancelEditBounds,
      handleColorChange,
      handleDelete,
      handleAnnotationSave,
      handleAnnotationDelete,
      handleCollapseHighlightDetails,
    ]
  );

  const mediaHeaderMeta = (
    <div className={styles.metadata}>
      <span className={styles.kind}>{media?.kind}</span>
      {media?.canonical_source_url && (
        <a
          href={media.canonical_source_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.sourceLink}
        >
          View Source ↗
        </a>
      )}
    </div>
  );

  const mediaPaneNavigation =
    isPdf && canRead && pdfControlsState
      ? {
          label: `Page ${pdfControlsState.pageNumber} of ${pdfControlsState.numPages || 0}`,
          previous: {
            label: "Previous page",
            onClick: () => {
              pdfControlsRef.current?.goToPreviousPage();
            },
            disabled: !pdfControlsState.canGoPrev,
          },
          next: {
            label: "Next page",
            onClick: () => {
              pdfControlsRef.current?.goToNextPage();
            },
            disabled: !pdfControlsState.canGoNext,
          },
        }
      : isEpub && canRead
        ? {
            label:
              activeSectionPosition >= 0 && epubSections
                ? `${activeSectionPosition + 1} / ${epubSections.length}`
                : undefined,
            previous: {
              label: "Previous chapter",
              onClick: () => {
                if (prevSection) {
                  navigateToSection(prevSection.section_id);
                }
              },
              disabled: !prevSection,
            },
            next: {
              label: "Next chapter",
              onClick: () => {
                if (nextSection) {
                  navigateToSection(nextSection.section_id);
                }
              },
              disabled: !nextSection,
            },
          }
        : undefined;

  const mediaPaneActions =
    isPdf && canRead && pdfControlsState ? (
      <div className={styles.headerActions}>
        <button
          type="button"
          className={styles.headerActionBtn}
          onMouseDown={(event) => {
            event.preventDefault();
            pdfControlsRef.current?.captureSelectionSnapshot();
          }}
          onClick={() => pdfControlsRef.current?.createHighlight("yellow")}
          disabled={!pdfControlsState.canCreateHighlight || pdfControlsState.isCreating}
          aria-label="Highlight selection"
          data-create-attempts={pdfControlsState.createTelemetry.attempts}
          data-create-post-requests={pdfControlsState.createTelemetry.postRequests}
          data-create-patch-requests={pdfControlsState.createTelemetry.patchRequests}
          data-create-successes={pdfControlsState.createTelemetry.successes}
          data-create-errors={pdfControlsState.createTelemetry.errors}
          data-create-last-outcome={pdfControlsState.createTelemetry.lastOutcome}
          data-page-render-epoch={pdfControlsState.pageRenderEpoch}
          data-selection-popover-ignore-outside="true"
        >
          {pdfControlsState.highlightLabel}
        </button>
        <span className={styles.zoomLabel}>{pdfControlsState.zoomPercent}%</span>
        <button
          type="button"
          className={styles.headerActionBtn}
          onClick={() => pdfControlsRef.current?.zoomOut()}
          disabled={!pdfControlsState.canZoomOut}
          aria-label="Zoom out"
        >
          Zoom out
        </button>
        <button
          type="button"
          className={styles.headerActionBtn}
          onClick={() => pdfControlsRef.current?.zoomIn()}
          disabled={!pdfControlsState.canZoomIn}
          aria-label="Zoom in"
        >
          Zoom in
        </button>
      </div>
    ) : isEpub && canRead && epubSections ? (
      <div className={styles.headerActions}>
        <select
          value={activeSectionId ?? ""}
          onChange={(event) => {
            if (event.target.value) {
              navigateToSection(event.target.value);
            }
          }}
          className={styles.headerSelect}
          aria-label="Select chapter"
        >
          {epubSections.map((section) => (
            <option key={section.section_id} value={section.section_id}>
              {section.label}
            </option>
          ))}
        </select>
        {(hasEpubToc || tocWarning) && (
          <button
            type="button"
            className={styles.headerActionBtn}
            onClick={() => setEpubTocExpanded((value) => !value)}
            aria-label={
              epubTocExpanded ? "Collapse table of contents" : "Expand table of contents"
            }
          >
            {epubTocExpanded ? "Hide TOC" : "Show TOC"}
          </button>
        )}
      </div>
    ) : null;
  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <StateMessage variant="loading">Loading media...</StateMessage>
        </Pane>
      </PaneContainer>
    );
  }

  if (error || !media) {
    return (
      <PaneContainer>
        <Pane title="Error" back={{ label: "Back to Libraries", href: "/libraries" }}>
          <div className={styles.errorContainer}>
            <StateMessage variant="error">{error || "Media not found"}</StateMessage>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  // Processing gate for EPUB-specific not-ready
  if (isEpub && epubError === "processing") {
    return (
      <PaneContainer>
        <Pane
          title={media.title}
          back={{ label: "Back to Libraries", href: "/libraries" }}
          headerMeta={mediaHeaderMeta}
        >
          <div className={styles.content}>
            <div className={styles.notReady}>
              <p>This EPUB is still being processed.</p>
              <p>Status: {media.processing_status}</p>
            </div>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  return (
    <PaneContainer
      mobileLabels={showHighlightsPane ? ["Content", "Highlights"] : undefined}
    >
      {/* Content Pane */}
      <Pane
        title={media.title}
        back={{ label: "Back to Libraries", href: "/libraries" }}
        headerMeta={mediaHeaderMeta}
        navigation={mediaPaneNavigation}
        headerActions={mediaPaneActions}
        options={[
          ...(media.canonical_source_url
            ? [
                {
                  id: "open-source",
                  label: "Open source",
                  href: media.canonical_source_url,
                },
              ]
            : []),
          ...(isEpub && (hasEpubToc || tocWarning)
            ? [
                {
                  id: "toggle-toc",
                  label: epubTocExpanded ? "Hide table of contents" : "Show table of contents",
                  onSelect: () => setEpubTocExpanded((value) => !value),
                },
              ]
            : []),
        ]}
      >
        <div className={styles.content}>
          {!isPdf && isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}
          {focusModeEnabled && (
            <div className={styles.focusModeBanner}>
              <StatusPill variant="info">
                Focus mode enabled: highlights pane hidden.
              </StatusPill>
            </div>
          )}

          {isTranscriptMedia ? (
            <TranscriptMediaPane
              mediaKind={media.kind === "video" ? "video" : "podcast_episode"}
              playbackSource={playbackSource}
              canonicalSourceUrl={media.canonical_source_url}
              isPlaybackOnlyTranscript={isPlaybackOnlyTranscript}
              canRead={canRead}
              processingStatus={media.processing_status}
              fragments={fragments}
              activeFragment={activeTranscriptFragment}
              renderedHtml={renderedHtml}
              contentRef={contentRef}
              onSegmentSelect={handleTranscriptSegmentSelect}
              onContentClick={handleContentClick}
            />
          ) : !canRead ? (
            <div className={styles.notReady}>
              {isPdf && media.processing_status === "failed" ? (
                <>
                  {media.last_error_code === "E_PDF_PASSWORD_REQUIRED" ? (
                    <p>This PDF is password-protected and cannot be opened in v1.</p>
                  ) : (
                    <p>This PDF cannot be opened right now.</p>
                  )}
                  {media.last_error_code && <p>Error: {media.last_error_code}</p>}
                </>
              ) : (
                <>
                  <p>This media is still being processed.</p>
                  <p>Status: {media.processing_status}</p>
                </>
              )}
            </div>
          ) : isPdf ? (
            readerStateLoading ? (
              <div className={styles.notReady}>
                <p>Loading reader state...</p>
              </div>
            ) : (
              <PdfReader
                mediaId={id}
                contentRef={pdfContentRef}
                focusedHighlightId={focusState.focusedId}
                editingHighlightId={
                  focusState.editingBounds ? focusState.focusedId : null
                }
                highlightRefreshToken={pdfRefreshToken}
                onPageHighlightsChange={handlePdfPageHighlightsChange}
                navigateToHighlight={pdfNavigationTarget}
                onHighlightNavigationComplete={() => setPdfNavigationTarget(null)}
                onHighlightsMutated={schedulePdfHighlightsRefresh}
                onQuoteToChat={handleSendToChat}
                showToolbar={false}
                onControlsStateChange={setPdfControlsState}
                onControlsReady={(controls) => {
                  pdfControlsRef.current = controls;
                }}
                initialPageNumber={
                  readerState?.locator_kind === "pdf_page"
                    ? readerState.page ?? undefined
                    : undefined
                }
                initialZoom={
                  readerState?.locator_kind === "pdf_page"
                    ? readerState.zoom ?? undefined
                    : undefined
                }
                onResumeStateChange={(pageNumber, zoom) =>
                  saveReaderState({
                    locator_kind: "pdf_page",
                    page: pageNumber,
                    zoom,
                    fragment_id: null,
                    offset: null,
                    section_id: null,
                  })
                }
              />
            )
          ) : isEpub ? (
            <ReaderContentArea profileOverride={readerProfileOverride}>
              <EpubContentPane
                sections={epubSections}
                activeChapter={activeChapter}
                activeSectionId={activeSectionId}
                chapterLoading={chapterLoading}
                epubError={epubError}
                toc={epubToc}
                tocWarning={tocWarning}
                tocExpanded={epubTocExpanded}
                contentRef={contentRef}
                renderedHtml={renderedHtml}
                onContentClick={handleContentClick}
                onNavigate={navigateToSection}
              />
            </ReaderContentArea>
          ) : fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
            <ReaderContentArea profileOverride={readerProfileOverride}>
              <div
                ref={contentRef}
                className={styles.fragments}
                onClick={handleContentClick}
              >
                <HtmlRenderer
                  htmlSanitized={renderedHtml}
                  className={styles.fragment}
                />
              </div>
            </ReaderContentArea>
          )}
        </div>
      </Pane>

      {/* Linked Items Pane */}
      {showHighlightsPane && (
        <Pane title="Highlights" defaultWidth={360} minWidth={280}>
          {isEpub && (
            <SectionCard
              title="Scope"
              className={styles.scopeCard}
              bodyClassName={styles.scopeCardBody}
            >
              <div
                className={styles.highlightScopeToggle}
                role="group"
                aria-label="Highlight scope"
              >
                <button
                  className={`${styles.scopeBtn} ${
                    epubHighlightScope === "chapter" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handleEpubHighlightScopeChange("chapter")}
                  type="button"
                  aria-pressed={epubHighlightScope === "chapter"}
                >
                  This chapter
                </button>
                <button
                  className={`${styles.scopeBtn} ${
                    epubHighlightScope === "book" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handleEpubHighlightScopeChange("book")}
                  type="button"
                  aria-pressed={epubHighlightScope === "book"}
                >
                  Entire book
                </button>
              </div>
            </SectionCard>
          )}
          {isPdf && (
            <div
              className={styles.highlightScopeHeader}
              role="group"
              aria-label="Highlight scope"
            >
              <span className={styles.highlightScopeLabel}>Scope</span>
              <div className={styles.highlightScopeToggle}>
                <button
                  className={`${styles.scopeBtn} ${
                    pdfHighlightScope === "page" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handlePdfHighlightScopeChange("page")}
                  type="button"
                  aria-pressed={pdfHighlightScope === "page"}
                >
                  This page
                </button>
                <button
                  className={`${styles.scopeBtn} ${
                    pdfHighlightScope === "document" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handlePdfHighlightScopeChange("document")}
                  type="button"
                  aria-pressed={pdfHighlightScope === "document"}
                >
                  Entire document
                </button>
              </div>
            </div>
          )}

          <LinkedItemsPane
            highlights={linkedPaneHighlights}
            contentRef={linkedItemsContentRef}
            focusedId={focusState.focusedId}
            onHighlightClick={handleLinkedItemClick}
            highlightsVersion={linkedItemsVersion}
            onSendToChat={handleSendToChat}
            layoutMode={linkedItemsLayoutMode}
            anchorDescriptors={linkedItemsAnchorDescriptors}
            anchorProvider={linkedItemsAnchorProvider}
            renderExpandedContent={renderExpandedLinkedItem}
          />

          {isPdf && (
            <div className={styles.bookHighlightsControls}>
              <p className={styles.hint}>{pdfLinkedItemsHint}</p>
              {pdfHighlightScope === "document" && pdfHighlightsHasMore && (
                <button
                  type="button"
                  className={styles.loadMoreBtn}
                  onClick={handleLoadMorePdfHighlights}
                  disabled={pdfHighlightsLoading}
                >
                  {pdfHighlightsLoading ? "Loading..." : "Load more"}
                </button>
              )}
            </div>
          )}

          {isEpub && epubHighlightScope === "book" && (
            <SectionCard
              title="Book Highlights"
              description="Showing highlights from the entire book."
              className={styles.bookHighlightsCard}
            >
              {mediaHighlightsHasMore && (
                <button
                  type="button"
                  className={styles.loadMoreBtn}
                  onClick={handleLoadMoreMediaHighlights}
                  disabled={mediaHighlightsLoading}
                >
                  {mediaHighlightsLoading ? "Loading..." : "Load more"}
                </button>
              )}
            </SectionCard>
          )}

          {isPdf && (
            <div className={styles.pdfPagePill}>
              <StatusPill variant="info">Active page: {pdfActivePage}</StatusPill>
            </div>
          )}
        </Pane>
      )}

      {/* Selection Popover */}
      {!isPdf && selection && !focusState.editingBounds && contentRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          containerRef={contentRef}
          onCreateHighlight={handleCreateHighlight}
          onQuoteToNewChat={handleQuoteSelectionToNewChat}
          onDismiss={handleDismissPopover}
          isCreating={isCreating}
        />
      )}
    </PaneContainer>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function EpubContentPane({
  sections,
  activeChapter,
  activeSectionId,
  chapterLoading,
  epubError,
  toc,
  tocWarning,
  tocExpanded,
  contentRef,
  renderedHtml,
  onContentClick,
  onNavigate,
}: {
  sections: EpubNavigationSection[] | null;
  activeChapter: EpubChapter | null;
  activeSectionId: string | null;
  chapterLoading: boolean;
  epubError: string | null;
  toc: NormalizedNavigationTocNode[] | null;
  tocWarning: boolean;
  tocExpanded: boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  renderedHtml: string;
  onContentClick: (e: React.MouseEvent) => void;
  onNavigate: (sectionId: string) => void;
}) {
  if (epubError && epubError !== "processing") {
    return (
      <div className={styles.error}>
        {epubError}
      </div>
    );
  }

  if (!sections) {
    return <div className={styles.loading}>Loading chapters...</div>;
  }

  if (sections.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No chapters available for this EPUB.</p>
      </div>
    );
  }

  const hasToc = toc !== null && toc.length > 0;

  return (
    <div className={styles.epubContainer}>
      {(hasToc || tocWarning) && (
        <div className={styles.tocSection}>
          <div className={styles.tocToggle}>
            Table of Contents
            {tocWarning && !hasToc && <span className={styles.tocWarning}> (unavailable)</span>}
          </div>

          {tocExpanded && hasToc && (
            <div className={styles.tocTree}>
              <TocNodeList
                nodes={toc!}
                activeSectionId={activeSectionId}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </div>
      )}

      {/* Chapter content */}
      {chapterLoading ? (
        <div className={styles.loading}>Loading chapter...</div>
      ) : activeChapter ? (
        <div
          ref={contentRef}
          className={styles.fragments}
          onClick={onContentClick}
        >
          <HtmlRenderer
            htmlSanitized={renderedHtml}
            className={styles.fragment}
          />
        </div>
      ) : null}
    </div>
  );
}

function TocNodeList({
  nodes,
  activeSectionId,
  onNavigate,
}: {
  nodes: NormalizedNavigationTocNode[];
  activeSectionId: string | null;
  onNavigate: (sectionId: string) => void;
}) {
  return (
    <ul className={styles.tocList}>
      {nodes.map((node) => (
        <li key={node.node_id} className={styles.tocItem}>
          {node.navigable ? (
            <button
              className={`${styles.tocLink} ${
                node.section_id === activeSectionId ? styles.tocActive : ""
              }`}
              onClick={() => node.section_id && onNavigate(node.section_id)}
            >
              {node.label}
            </button>
          ) : (
            <span className={styles.tocLabel}>{node.label}</span>
          )}
          {node.children.length > 0 && (
            <TocNodeList
              nodes={node.children}
              activeSectionId={activeSectionId}
              onNavigate={onNavigate}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
