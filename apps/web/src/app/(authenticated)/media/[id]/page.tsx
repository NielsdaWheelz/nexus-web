/**
 * Media View Page with highlight creation and editing.
 *
 * This page displays a media item with:
 * - Content pane: Rendered HTML with highlights
 * - Linked-items pane: Vertically aligned highlight rows (PR-10)
 * - Selection popover for creating highlights
 * - Full highlight interaction (focus, cycling, edit bounds)
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md
 * @see docs/v1/s2/s2_prs/s2_pr10.md
 */

"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

  // Core data state
  const [media, setMedia] = useState<Media | null>(null);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Highlight interaction state
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

  // Mismatch state (disable highlighting if canonical text doesn't match)
  const [isMismatchDisabled, setIsMismatchDisabled] = useState(false);

  // Refs
  const contentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);

  // Version tracking for re-rendering highlights
  const [highlightsVersion, setHighlightsVersion] = useState(0);

  // Get the first fragment (web articles have exactly one)
  const fragment = fragments[0] || null;

  // ==========================================================================
  // Data Fetching
  // ==========================================================================

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [mediaData, fragmentsData] = await Promise.all([
          apiFetch<Media>(`/api/media/${id}`),
          apiFetch<Fragment[]>(`/api/media/${id}/fragments`),
        ]);
        setMedia(mediaData);
        setFragments(fragmentsData);
        setError(null);
      } catch (err) {
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
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  // Fetch highlights when fragment is available
  useEffect(() => {
    if (!fragment) return;

    const loadHighlights = async () => {
      try {
        const data = await fetchHighlights(fragment.id);
        setHighlights(data);
      } catch (err) {
        console.error("Failed to load highlights:", err);
      }
    };

    loadHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when fragment ID changes
  }, [fragment?.id]);

  // ==========================================================================
  // Canonical Cursor Building
  // ==========================================================================

  useEffect(() => {
    if (!fragment || !contentRef.current) return;

    // Build canonical cursor from rendered content
    const cursor = buildCanonicalCursor(contentRef.current);
    const isValid = validateCanonicalText(
      cursor,
      fragment.canonical_text,
      fragment.id
    );

    cursorRef.current = cursor;
    setIsMismatchDisabled(!isValid);

    if (!isValid) {
      console.warn("Canonical text mismatch - highlights disabled");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild cursor when fragment content changes or highlights version bumps
  }, [fragment?.id, fragment?.canonical_text, highlightsVersion]);

  // ==========================================================================
  // Highlight Rendering
  // ==========================================================================

  const renderedHtml = fragment
    ? applyHighlightsToHtmlMemoized(
        fragment.html_sanitized,
        fragment.canonical_text,
        fragment.id,
        highlights as HighlightInput[]
      ).html
    : "";

  // ==========================================================================
  // Focus Sync
  // ==========================================================================

  // Apply focus class when focus changes
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

    // Check if selection is within our content
    if (!contentRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      setSelectionError(null);
      return;
    }

    // Check mismatch state
    if (isMismatchDisabled) {
      setSelection(null);
      setSelectionError("Highlights disabled due to content mismatch.");
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ range, rect });
    setSelectionError(null);
  }, [isMismatchDisabled]);

  // Listen for selection changes
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
      if (!selection || !fragment || !cursorRef.current || isCreating) return;

      // Convert selection to offsets
      const result = selectionToOffsets(
        selection.range,
        cursorRef.current,
        fragment.canonical_text,
        isMismatchDisabled
      );

      if (!result.success) {
        setSelectionError(result.message);
        setSelection(null);
        // Show toast (for now just log)
        console.warn("Selection error:", result.message);
        return;
      }

      // Check for duplicate
      const duplicateId = findDuplicateHighlight(
        highlights,
        result.startOffset,
        result.endOffset
      );

      if (duplicateId) {
        // Focus existing highlight instead
        focusHighlight(duplicateId);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        return;
      }

      setIsCreating(true);

      try {
        await createHighlight(
          fragment.id,
          result.startOffset,
          result.endOffset,
          color
        );

        // Refetch highlights
        const newHighlights = await fetchHighlights(fragment.id);
        setHighlights(newHighlights);
        setHighlightsVersion((v) => v + 1);
        clearHighlightCache();

        // Find and focus the newly created highlight
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
          // 409 conflict - refetch and focus
          const newHighlights = await fetchHighlights(fragment.id);
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
      fragment,
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

      // Clicked outside highlights - only clear if not selecting
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

  // Handle selection while in edit bounds mode
  useEffect(() => {
    if (!focusState.editingBounds || !selection || !fragment || !cursorRef.current)
      return;

    const focusedHighlight = highlights.find(
      (h) => h.id === focusState.focusedId
    );
    if (!focusedHighlight) return;

    // Convert selection to offsets
    const result = selectionToOffsets(
      selection.range,
      cursorRef.current,
      fragment.canonical_text,
      isMismatchDisabled
    );

    if (!result.success) {
      setSelectionError(result.message);
      return;
    }

    // Update highlight bounds
    const updateBounds = async () => {
      try {
        await updateHighlight(focusedHighlight.id, {
          start_offset: result.startOffset,
          end_offset: result.endOffset,
        });

        // Refetch and reconcile focus
        const newHighlights = await fetchHighlights(fragment.id);
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
    fragment,
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
      if (!fragment) return;

      await updateHighlight(highlightId, { color });

      // Refetch
      const newHighlights = await fetchHighlights(fragment.id);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();
    },
    [fragment]
  );

  const handleDelete = useCallback(
    async (highlightId: string) => {
      if (!fragment) return;

      await deleteHighlight(highlightId);

      // Refetch
      const newHighlights = await fetchHighlights(fragment.id);
      setHighlights(newHighlights);
      setHighlightsVersion((v) => v + 1);
      clearHighlightCache();

      // Clear focus
      clearFocus();
    },
    [fragment, clearFocus]
  );

  const handleAnnotationSave = useCallback(
    async (highlightId: string, body: string) => {
      if (!fragment) return;

      await saveAnnotation(highlightId, body);

      // Refetch
      const newHighlights = await fetchHighlights(fragment.id);
      setHighlights(newHighlights);
    },
    [fragment]
  );

  const handleAnnotationDelete = useCallback(
    async (highlightId: string) => {
      if (!fragment) return;

      await deleteAnnotation(highlightId);

      // Refetch
      const newHighlights = await fetchHighlights(fragment.id);
      setHighlights(newHighlights);
    },
    [fragment]
  );

  // ==========================================================================
  // Quote-to-Chat (S3 PR-07)
  // ==========================================================================

  const handleSendToChat = useCallback(
    (highlightId: string) => {
      // Per s3_pr07 §6.2: route determines target.
      // Since we're on /media/:id (not /conversations/:id), navigate to
      // /conversations with the highlight pre-attached as a query param.
      const params = new URLSearchParams({
        attach_type: "highlight",
        attach_id: highlightId,
      });
      router.push(`/conversations?${params}`);
    },
    [router]
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

  const canRead =
    media.processing_status === "ready" ||
    media.processing_status === "ready_for_reading";

  return (
    <PaneContainer>
      {/* Content Pane */}
      <Pane title={media.title}>
        <div className={styles.content}>
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

      {/* Linked Items Pane - Vertically aligned with highlights (PR-10) */}
      {canRead && (
        <Pane title="Highlights" defaultWidth={360} minWidth={280}>
          {focusState.focusedId ? (
            // When a highlight is focused, show the editor
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
            // When no highlight is focused, show aligned rows
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
