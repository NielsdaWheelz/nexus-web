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
import SelectionPopover from "@/components/SelectionPopover";
import HighlightEditor, { type Highlight } from "@/components/HighlightEditor";
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
  resolveInitialEpubChapterIdx,
  normalizeEpubToc,
  isReadableStatus,
  type EpubChapterSummary,
  type EpubChapter,
  type EpubTocResponse,
  type NormalizedTocNode,
} from "@/lib/media/epubReader";
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
  created_at: string;
  updated_at: string;
}

interface Fragment {
  id: string;
  media_id: string;
  idx: number;
  html_sanitized: string;
  canonical_text: string;
  created_at: string;
}

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

// =============================================================================
// API Functions
// =============================================================================

async function fetchHighlights(fragmentId: string): Promise<Highlight[]> {
  const response = await apiFetch<{ data: { highlights: Highlight[] } }>(
    `/api/fragments/${fragmentId}/highlights`
  );
  return response.data.highlights;
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

  // ---- Core data state ----
  const [media, setMedia] = useState<Media | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- Non-EPUB fragment state ----
  const [fragments, setFragments] = useState<Fragment[]>([]);

  // ---- EPUB state ----
  const [epubManifest, setEpubManifest] = useState<EpubChapterSummary[] | null>(null);
  const [activeChapterIdx, setActiveChapterIdx] = useState<number | null>(null);
  const [activeChapter, setActiveChapter] = useState<EpubChapter | null>(null);
  const [epubToc, setEpubToc] = useState<NormalizedTocNode[] | null>(null);
  const [tocWarning, setTocWarning] = useState(false);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [epubError, setEpubError] = useState<string | null>(null);

  // Request-version guard for stale chapter/highlight responses
  const chapterVersionRef = useRef(0);
  const highlightVersionRef = useRef(0);

  // ---- Highlight interaction state ----
  const [highlights, setHighlights] = useState<Highlight[]>([]);
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
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const [highlightsVersion, setHighlightsVersion] = useState(0);

  // ---- Derived state ----
  const isEpub = media?.kind === "epub";

  // Unified active content for both paths
  const activeContent: ActiveContent | null = useMemo(() => {
    if (isEpub && activeChapter) {
      return {
        fragmentId: activeChapter.fragment_id,
        htmlSanitized: activeChapter.html_sanitized,
        canonicalText: activeChapter.canonical_text,
      };
    }
    const frag = fragments[0] ?? null;
    if (frag) {
      return {
        fragmentId: frag.id,
        htmlSanitized: frag.html_sanitized,
        canonicalText: frag.canonical_text,
      };
    }
    return null;
  }, [isEpub, activeChapter, fragments]);

  const canRead = media ? isReadableStatus(media.processing_status) : false;

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

        if (m.kind !== "epub") {
          // Non-EPUB: load fragments
          const fragmentsResp = await apiFetch<{ data: Fragment[] }>(
            `/api/media/${id}/fragments`
          );
          if (cancelled) return;
          setFragments(fragmentsResp.data);
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
        setEpubManifest(chapters);

        const chapterParam = searchParams.get("chapter");
        const resolvedIdx = resolveInitialEpubChapterIdx(chapters, chapterParam);

        // Canonicalize URL if needed
        if (resolvedIdx !== null) {
          const requestedNum = chapterParam !== null ? Number(chapterParam) : NaN;
          if (requestedNum !== resolvedIdx || chapterParam === null) {
            router.replace(`/media/${id}?chapter=${resolvedIdx}`);
          }
          setActiveChapterIdx(resolvedIdx);
        } else {
          setEpubError("No chapters available for this EPUB.");
        }

        // Load TOC (non-blocking)
        try {
          const tocResp = await apiFetch<EpubTocResponse>(`/api/media/${id}/toc`);
          if (cancelled) return;
          const idxSet = new Set(chapters.map((c) => c.idx));
          setEpubToc(normalizeEpubToc(tocResp.data.nodes, idxSet));
        } catch {
          if (!cancelled) setTocWarning(true);
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
    setSelection(null);
    setSelectionError(null);

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
          setEpubManifest(freshManifest);
          const resolvedIdx = resolveInitialEpubChapterIdx(freshManifest, null);
          if (resolvedIdx !== null) {
            router.replace(`/media/${id}?chapter=${resolvedIdx}`);
            setActiveChapterIdx(resolvedIdx);
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
    [id, router]
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
      } catch (err) {
        if (version !== highlightVersionRef.current) return;
        console.error("Failed to load highlights:", err);
      }
    };

    loadHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when active fragment changes
  }, [activeContent?.fragmentId]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild when content changes
  }, [activeContent?.fragmentId, activeContent?.canonicalText, highlightsVersion]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const renderedHtml = activeContent
    ? applyHighlightsToHtmlMemoized(
        activeContent.htmlSanitized,
        activeContent.canonicalText,
        activeContent.fragmentId,
        highlights as HighlightInput[]
      ).html
    : "";

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  useEffect(() => {
    if (!contentRef.current) return;
    applyFocusClass(contentRef.current, focusState.focusedId);
  }, [focusState.focusedId]);

  // ==========================================================================
  // Selection Handling
  // ==========================================================================

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !contentRef.current) {
      setSelection(null);
      setSelectionError(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      setSelectionError(null);
      return;
    }

    if (isMismatchDisabled) {
      setSelection(null);
      setSelectionError("Highlights disabled due to content mismatch.");
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ range, rect });
    setSelectionError(null);
  }, [isMismatchDisabled]);

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
        setSelectionError(result.message);
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
          setSelectionError("Failed to create highlight");
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
    ]
  );

  const handleDismissPopover = useCallback(() => {
    setSelection(null);
    setSelectionError(null);
  }, []);

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
      setSelectionError(result.message);
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
        setSelectionError("Failed to update highlight bounds");
      }
    };

    updateBounds();
  }, [
    focusState.editingBounds,
    focusState.focusedId,
    selection,
    activeContent,
    isMismatchDisabled,
    highlights,
    focusHighlight,
    cancelEditBounds,
  ]);

  // ==========================================================================
  // Highlight Editing Callbacks
  // ==========================================================================

  const handleColorChange = useCallback(
    async (highlightId: string, color: HighlightColor) => {
      if (!activeContent) return;
      await updateHighlight(highlightId, { color });
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
    },
    [activeContent]
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      if (!activeContent) return;
      await deleteHighlight(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
      clearFocus();
    },
    [activeContent, clearFocus]
  );

  const handleAnnotationSave = useCallback(
    async (highlightId: string, body: string) => {
      if (!activeContent) return;
      await saveAnnotation(highlightId, body);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
    },
    [activeContent]
  );

  const handleAnnotationDelete = useCallback(
    async (highlightId: string) => {
      if (!activeContent) return;
      await deleteAnnotation(highlightId);
      const newHighlights = await fetchHighlights(activeContent.fragmentId);
      setHighlights(newHighlights);
    },
    [activeContent]
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

  const navigateToChapter = useCallback(
    (idx: number) => {
      router.push(`/media/${id}?chapter=${idx}`);
      setActiveChapterIdx(idx);
    },
    [router, id]
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

          {isMismatchDisabled && (
            <div className={styles.mismatchBanner}>
              Highlights disabled due to content mismatch. Try reloading.
            </div>
          )}

          {selectionError && (
            <div className={styles.selectionError}>{selectionError}</div>
          )}

          {!canRead ? (
            <div className={styles.notReady}>
              <p>This media is still being processed.</p>
              <p>Status: {media.processing_status}</p>
            </div>
          ) : isEpub ? (
            <EpubContentPane
              manifest={epubManifest}
              activeChapter={activeChapter}
              activeChapterIdx={activeChapterIdx}
              chapterLoading={chapterLoading}
              epubError={epubError}
              toc={epubToc}
              tocWarning={tocWarning}
              contentRef={contentRef}
              renderedHtml={renderedHtml}
              onContentClick={handleContentClick}
              onNavigate={navigateToChapter}
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
          {focusState.focusedId ? (
            <div className={styles.linkedItems}>
              {highlights
                .filter((h) => h.id === focusState.focusedId)
                .map((h) => (
                  <div key={h.id} className={`${styles.highlightItem} ${styles.focused}`}>
                    <HighlightEditor
                      highlight={h}
                      isEditingBounds={focusState.editingBounds}
                      onStartEditBounds={startEditBounds}
                      onCancelEditBounds={cancelEditBounds}
                      onColorChange={handleColorChange}
                      onDelete={handleDelete}
                      onAnnotationSave={handleAnnotationSave}
                      onAnnotationDelete={handleAnnotationDelete}
                    />
                  </div>
                ))}
            </div>
          ) : (
            <LinkedItemsPane
              highlights={highlights}
              contentRef={contentRef}
              focusedId={focusState.focusedId}
              onHighlightClick={focusHighlight}
              highlightsVersion={highlightsVersion}
              onSendToChat={handleSendToChat}
            />
          )}
        </Pane>
      )}

      {/* Selection Popover */}
      {selection && !focusState.editingBounds && contentRef.current && (
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
  manifest,
  activeChapter,
  activeChapterIdx,
  chapterLoading,
  epubError,
  toc,
  tocWarning,
  contentRef,
  renderedHtml,
  onContentClick,
  onNavigate,
}: {
  manifest: EpubChapterSummary[] | null;
  activeChapter: EpubChapter | null;
  activeChapterIdx: number | null;
  chapterLoading: boolean;
  epubError: string | null;
  toc: NormalizedTocNode[] | null;
  tocWarning: boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  renderedHtml: string;
  onContentClick: (e: React.MouseEvent) => void;
  onNavigate: (idx: number) => void;
}) {
  const [tocExpanded, setTocExpanded] = useState(false);

  if (epubError && epubError !== "processing") {
    return (
      <div className={styles.error}>
        {epubError}
      </div>
    );
  }

  if (!manifest) {
    return <div className={styles.loading}>Loading chapters...</div>;
  }

  if (manifest.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No chapters available for this EPUB.</p>
      </div>
    );
  }

  const hasToc = toc !== null && toc.length > 0;

  return (
    <div className={styles.epubContainer}>
      {/* Chapter controls */}
      <div className={styles.chapterControls}>
        <button
          className={styles.chapterNavBtn}
          disabled={activeChapter?.prev_idx == null}
          onClick={() => {
            if (activeChapter?.prev_idx != null) onNavigate(activeChapter.prev_idx);
          }}
          aria-label="Previous chapter"
        >
          ← Prev
        </button>

        <div className={styles.chapterSelector}>
          <select
            value={activeChapterIdx ?? ""}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (Number.isFinite(val)) onNavigate(val);
            }}
            className={styles.chapterSelect}
            aria-label="Select chapter"
          >
            {manifest.map((ch) => (
              <option key={ch.idx} value={ch.idx}>
                {ch.title}
              </option>
            ))}
          </select>
        </div>

        <button
          className={styles.chapterNavBtn}
          disabled={activeChapter?.next_idx == null}
          onClick={() => {
            if (activeChapter?.next_idx != null) onNavigate(activeChapter.next_idx);
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
                activeChapterIdx={activeChapterIdx}
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
  activeChapterIdx,
  onNavigate,
}: {
  nodes: NormalizedTocNode[];
  activeChapterIdx: number | null;
  onNavigate: (idx: number) => void;
}) {
  return (
    <ul className={styles.tocList}>
      {nodes.map((node) => (
        <li key={node.node_id} className={styles.tocItem}>
          {node.navigable ? (
            <button
              className={`${styles.tocLink} ${
                node.fragment_idx === activeChapterIdx ? styles.tocActive : ""
              }`}
              onClick={() => onNavigate(node.fragment_idx!)}
            >
              {node.label}
            </button>
          ) : (
            <span className={styles.tocLabel}>{node.label}</span>
          )}
          {node.children.length > 0 && (
            <TocNodeList
              nodes={node.children}
              activeChapterIdx={activeChapterIdx}
              onNavigate={onNavigate}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
