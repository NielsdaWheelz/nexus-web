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

import { useEffect, useState, useCallback, useRef, use, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import HtmlRenderer from "@/components/HtmlRenderer";
import PdfReader, { type PdfHighlightOut } from "@/components/PdfReader";
import SelectionPopover from "@/components/SelectionPopover";
import HighlightEditor, { type Highlight } from "@/components/HighlightEditor";
import { useToast } from "@/components/Toast";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import {
  applyHighlightsToHtmlMemoized,
  clearHighlightCache,
  buildCanonicalCursor,
  validateCanonicalText,
  type HighlightColor,
  type HighlightInput,
  type CanonicalCursorResult,
} from "@/lib/highlights";
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

type PageLinkedHighlight = {
  id: string;
  exact: string;
  color: EditorHighlight["color"];
  annotation: EditorHighlight["annotation"];
  start_offset?: number;
  end_offset?: number;
  created_at?: string;
  fragment_id?: string;
  fragment_idx?: number;
};

type EpubHighlightScope = "chapter" | "book";

type MediaHighlight = Highlight & {
  media_id: string;
  fragment_idx: number;
};

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

// =============================================================================
// Component
// =============================================================================

export default function MediaViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

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
  const [epubHighlightScope, setEpubHighlightScope] = useState<EpubHighlightScope>("chapter");

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
  const [pdfPageHighlights, setPdfPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [pdfActivePage, setPdfActivePage] = useState(1);
  const [pdfRefreshToken, setPdfRefreshToken] = useState(0);
  const [pdfHighlightsVersion, setPdfHighlightsVersion] = useState(0);
  const {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
  } = useHighlightInteraction();

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

  const linkedPaneHighlights: PageLinkedHighlight[] = useMemo(() => {
    if (isPdf) {
      return pdfPageHighlights.map((highlight) => ({
        id: highlight.id,
        exact: highlight.exact,
        color: highlight.color,
        annotation: highlight.annotation,
        created_at: highlight.created_at,
      }));
    }
    if (isEpub && epubHighlightScope === "book") {
      return mediaHighlights.map((highlight) => ({
        id: highlight.id,
        exact: highlight.exact,
        color: highlight.color,
        annotation: highlight.annotation,
        start_offset: highlight.start_offset,
        end_offset: highlight.end_offset,
        created_at: highlight.created_at,
        fragment_id: highlight.fragment_id,
        fragment_idx: highlight.fragment_idx,
      }));
    }
    return highlights.map((highlight) => ({
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      start_offset: highlight.start_offset,
      end_offset: highlight.end_offset,
      created_at: highlight.created_at,
      fragment_id: highlight.fragment_id,
    }));
  }, [highlights, isPdf, pdfPageHighlights, isEpub, epubHighlightScope, mediaHighlights]);

  const focusedHighlightForEditor = useMemo(() => {
    if (!focusState.focusedId) {
      return null;
    }
    if (isPdf) {
      const pdfHighlight = pdfPageHighlights.find((h) => h.id === focusState.focusedId);
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
    isEpub && epubHighlightScope === "book" ? "list" : "aligned";

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
    if (!isPdf) {
      setPdfPageHighlights([]);
      setPdfActivePage(1);
      setPdfRefreshToken(0);
      setPdfHighlightsVersion(0);
    }
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
          sections = navResp.data.sections;
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

        const locParam = searchParams.get("loc");
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
          setPendingAnchorId(resolvedSection.anchor_id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on media load
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
    setPendingAnchorId(section.anchor_id);
    setActiveChapterIdx(section.fragment_idx);
  }, [isEpub, epubSections, searchParams, activeSectionId]);

  // Scroll to anchor target after chapter content loads.
  useEffect(() => {
    if (!isEpub || !pendingAnchorId || !contentRef.current || !activeChapter || chapterLoading) return;

    let target: Element | null = null;
    const byId = document.getElementById(pendingAnchorId);
    if (byId && contentRef.current.contains(byId)) {
      target = byId;
    }
    if (!target) {
      // Avoid selector-escaping pitfalls for uncommon anchor names.
      target =
        Array.from(contentRef.current.querySelectorAll("[name]")).find(
          (el) => el.getAttribute("name") === pendingAnchorId
        ) ?? null;
    }

    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
    }

    setPendingAnchorId(null);
  }, [isEpub, pendingAnchorId, activeChapter, chapterLoading]);

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
            setPendingAnchorId(section.anchor_id);
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

  const handleLinkedItemClick = useCallback(
    (highlightId: string) => {
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
    async (color: HighlightColor) => {
      if (!selection || !activeContent || !cursorRef.current || isCreating) return;

      const result = selectionToOffsets(
        selection.range,
        cursorRef.current,
        activeContent.canonicalText,
        isMismatchDisabled
      );

      if (!result.success) {
        toast({ variant: "error", message: result.message });
        setSelection(null);
        return;
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
        return;
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
      } catch (err) {
        if (isApiError(err) && err.code === "E_HIGHLIGHT_CONFLICT") {
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
        } else {
          console.error("Failed to create highlight:", err);
          toast({ variant: "error", message: "Failed to create highlight" });
        }
      } finally {
        setIsCreating(false);
      }
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
    scheduleMediaHighlightsRefresh,
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

  const handleSendToChat = useCallback(
    (highlightId: string) => {
      const qp = new URLSearchParams({
        attach_type: "highlight",
        attach_id: highlightId,
      });
      router.push(`/conversations?${qp}`);
    },
    [router]
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
      setPendingAnchorId(section.anchor_id);
      setPendingHighlightId(null);
      setPendingHighlightFragmentId(null);
      setActiveChapterIdx(section.fragment_idx);
    },
    [router, id, epubSections]
  );

  const handlePdfPageHighlightsChange = useCallback(
    (nextPage: number, nextHighlights: PdfHighlightOut[]) => {
      setPdfActivePage(nextPage);
      setPdfPageHighlights(nextHighlights);
      setPdfHighlightsVersion((v) => v + 1);

      if (
        focusState.focusedId &&
        !nextHighlights.some((highlight) => highlight.id === focusState.focusedId)
      ) {
        clearFocus();
      }
    },
    [clearFocus, focusState.focusedId]
  );

  // ==========================================================================
  // Render
  // ==========================================================================

  if (loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <div className={styles.loading}>Loading media...</div>
        </Pane>
      </PaneContainer>
    );
  }

  if (error || !media) {
    return (
      <PaneContainer>
        <Pane title="Error">
          <div className={styles.errorContainer}>
            <div className={styles.error}>{error || "Media not found"}</div>
            <Link href="/libraries" className={styles.backLink}>
              ← Back to Libraries
            </Link>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  // Processing gate for EPUB-specific not-ready
  if (isEpub && epubError === "processing") {
    return (
      <PaneContainer>
        <Pane title={media.title}>
          <div className={styles.content}>
            <MediaHeader media={media} />
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
    <PaneContainer>
      {/* Content Pane */}
      <Pane title={media.title}>
        <div className={styles.content}>
          <MediaHeader media={media} />

          {!isPdf && isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
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
            <PdfReader
              mediaId={id}
              contentRef={pdfContentRef}
              focusedHighlightId={focusState.focusedId}
              editingHighlightId={
                focusState.editingBounds ? focusState.focusedId : null
              }
              highlightRefreshToken={pdfRefreshToken}
              onPageHighlightsChange={handlePdfPageHighlightsChange}
            />
          ) : isEpub ? (
            <EpubContentPane
              sections={epubSections}
              activeChapter={activeChapter}
              activeSectionId={activeSectionId}
              chapterLoading={chapterLoading}
              epubError={epubError}
              toc={epubToc}
              tocWarning={tocWarning}
              contentRef={contentRef}
              renderedHtml={renderedHtml}
              onContentClick={handleContentClick}
              onNavigate={navigateToSection}
            />
          ) : fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
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
          )}
        </div>
      </Pane>

      {/* Linked Items Pane */}
      {canRead && (
        <Pane title="Highlights" defaultWidth={360} minWidth={280}>
          {isEpub && (
            <div className={styles.highlightScopeHeader}>
              <span className={styles.highlightScopeLabel}>Scope</span>
              <div className={styles.highlightScopeToggle}>
                <button
                  className={`${styles.scopeBtn} ${
                    epubHighlightScope === "chapter" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handleEpubHighlightScopeChange("chapter")}
                  type="button"
                >
                  This chapter
                </button>
                <button
                  className={`${styles.scopeBtn} ${
                    epubHighlightScope === "book" ? styles.scopeBtnActive : ""
                  }`}
                  onClick={() => handleEpubHighlightScopeChange("book")}
                  type="button"
                >
                  Entire book
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
          />

          {isEpub && epubHighlightScope === "book" && (
            <div className={styles.bookHighlightsControls}>
              <p className={styles.hint}>Showing highlights from the entire book.</p>
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
            </div>
          )}

          {focusState.focusedId && (
            <div className={styles.linkedItems}>
              {focusedHighlightForEditor ? (
                <div
                  key={focusedHighlightForEditor.id}
                  className={`${styles.highlightItem} ${styles.focused}`}
                >
                  <HighlightEditor
                    highlight={focusedHighlightForEditor}
                    isEditingBounds={focusState.editingBounds}
                    onStartEditBounds={startEditBounds}
                    onCancelEditBounds={cancelEditBounds}
                    onColorChange={handleColorChange}
                    onDelete={handleDelete}
                    onAnnotationSave={handleAnnotationSave}
                    onAnnotationDelete={handleAnnotationDelete}
                  />
                </div>
              ) : (
                <div className={styles.noHighlights}>
                  <p>No highlight selected.</p>
                </div>
              )}
            </div>
          )}
          {isPdf && (
            <div className={styles.hint}>Active page: {pdfActivePage}</div>
          )}
        </Pane>
      )}

      {/* Selection Popover */}
      {!isPdf && selection && !focusState.editingBounds && contentRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          containerRef={contentRef}
          onCreateHighlight={handleCreateHighlight}
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

function MediaHeader({ media }: { media: Media }) {
  return (
    <div className={styles.header}>
      <Link href="/libraries" className={styles.backLink}>
        ← Back to Libraries
      </Link>
      <div className={styles.metadata}>
        <span className={styles.kind}>{media.kind}</span>
        {media.canonical_source_url && (
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
    </div>
  );
}

function EpubContentPane({
  sections,
  activeChapter,
  activeSectionId,
  chapterLoading,
  epubError,
  toc,
  tocWarning,
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
  contentRef: React.RefObject<HTMLDivElement | null>;
  renderedHtml: string;
  onContentClick: (e: React.MouseEvent) => void;
  onNavigate: (sectionId: string) => void;
}) {
  const [tocExpanded, setTocExpanded] = useState(false);

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
  const activeSectionPosition = sections.findIndex((section) => section.section_id === activeSectionId);
  const prevSection = activeSectionPosition > 0 ? sections[activeSectionPosition - 1] : null;
  const nextSection =
    activeSectionPosition >= 0 && activeSectionPosition < sections.length - 1
      ? sections[activeSectionPosition + 1]
      : null;

  return (
    <div className={styles.epubContainer}>
      {/* Chapter controls */}
      <div className={styles.chapterControls}>
        <button
          className={styles.chapterNavBtn}
          disabled={!prevSection}
          onClick={() => {
            if (prevSection) onNavigate(prevSection.section_id);
          }}
          aria-label="Previous chapter"
        >
          ← Prev
        </button>

        <div className={styles.chapterSelector}>
          <select
            value={activeSectionId ?? ""}
            onChange={(e) => {
              if (e.target.value) onNavigate(e.target.value);
            }}
            className={styles.chapterSelect}
            aria-label="Select chapter"
          >
            {sections.map((section) => (
              <option key={section.section_id} value={section.section_id}>
                {section.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className={styles.chapterNavBtn}
          disabled={!nextSection}
          onClick={() => {
            if (nextSection) onNavigate(nextSection.section_id);
          }}
          aria-label="Next chapter"
        >
          Next →
        </button>
      </div>

      {/* TOC toggle */}
      {(hasToc || tocWarning) && (
        <div className={styles.tocSection}>
          <button
            className={styles.tocToggle}
            onClick={() => setTocExpanded((v) => !v)}
            aria-label={tocExpanded ? "Collapse table of contents" : "Expand table of contents"}
          >
            {tocExpanded ? "▾" : "▸"} Table of Contents
            {tocWarning && !hasToc && (
              <span className={styles.tocWarning}> (unavailable)</span>
            )}
          </button>

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
