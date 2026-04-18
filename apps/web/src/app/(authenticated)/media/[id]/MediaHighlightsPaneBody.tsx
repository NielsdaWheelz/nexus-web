/**
 * Highlights pane body for media readers.
 *
 * Owns the local contextual-vs-all-highlights view, EPUB all-highlights
 * fetching, and highlights display. Parent (MediaPaneBody) passes
 * contextual highlights plus the PDF document index and handles reader
 * navigation.
 */

"use client";

import { useEffect, useState, useCallback, useMemo, type RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import type { Highlight } from "@/components/HighlightEditor";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import StatusPill from "@/components/ui/StatusPill";
import { DEFAULT_PDF_ANCHOR_PROVIDER } from "@/lib/highlights/anchorProviders";
import {
  encodePdfStableOrderKey,
  sortPdfHighlightsByStableKey,
  toPdfStableOrderKey,
} from "@/lib/highlights/highlightIndexAdapter";
import { apiFetch } from "@/lib/api/client";
import styles from "./page.module.css";

type HighlightsView = "contextual" | "all";

interface MediaHighlightForIndex extends Highlight {
  fragment_idx: number;
}

export default function MediaHighlightsPaneBody({
  mediaId,
  isPdf,
  isEpub,
  isMobile,
  fragmentHighlights,
  pdfPageHighlights,
  pdfDocumentHighlights,
  highlightsVersion,
  pdfHighlightsVersion,
  pdfActivePage,
  pdfHighlightsHasMore,
  pdfHighlightsLoading,
  onLoadMorePdfHighlights,
  highlightMutationToken,
  contentRef,
  focusedId,
  onFocusHighlight,
  onNavigatePdfHighlight,
  onNavigateToFragment,
  onHighlightsViewChange,
  onSendToChat,
  onAnnotationSave,
  onAnnotationDelete,
  buildRowOptions,
  onOpenConversation,
}: {
  mediaId: string;
  isPdf: boolean;
  isEpub: boolean;
  isMobile: boolean;
  fragmentHighlights: Highlight[];
  pdfPageHighlights: PdfHighlightOut[];
  pdfDocumentHighlights: PdfHighlightOut[];
  highlightsVersion: number;
  pdfHighlightsVersion: number;
  pdfActivePage: number;
  pdfHighlightsHasMore: boolean;
  pdfHighlightsLoading: boolean;
  onLoadMorePdfHighlights: () => void;
  highlightMutationToken: number;
  contentRef: RefObject<HTMLDivElement | null>;
  focusedId: string | null;
  onFocusHighlight: (id: string) => void;
  onNavigatePdfHighlight: (target: {
    highlightId: string;
    pageNumber: number;
    quads: PdfHighlightOut["anchor"]["quads"];
  }) => void;
  onNavigateToFragment: (
    highlightId: string,
    fragmentId: string,
    fragmentIdx: number
  ) => void;
  onHighlightsViewChange: () => void;
  onSendToChat: (id: string) => void;
  onAnnotationSave: (id: string, body: string) => Promise<void>;
  onAnnotationDelete: (id: string) => Promise<void>;
  buildRowOptions: (id: string) => ActionMenuOption[];
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const [highlightsView, setHighlightsView] = useState<HighlightsView>("contextual");
  const isAllHighlights = highlightsView === "all";
  const canShowAllHighlights = isPdf || isEpub;
  const showPdfPageHighlights = isPdf && !isAllHighlights;
  const showPdfAllHighlights = isPdf && isAllHighlights;
  const showEpubAllHighlights = isEpub && isAllHighlights;

  // ---- EPUB all-highlights fetch ----

  const [mediaHighlights, setMediaHighlights] = useState<MediaHighlightForIndex[]>([]);
  const [mediaHighlightsHasMore, setMediaHighlightsHasMore] = useState(false);
  const [mediaHighlightsCursor, setMediaHighlightsCursor] = useState<string | null>(null);
  const [mediaHighlightsLoading, setMediaHighlightsLoading] = useState(false);
  const [mediaHighlightsVersion, setMediaHighlightsVersion] = useState(0);

  useEffect(() => {
    setHighlightsView("contextual");
  }, [mediaId]);

  useEffect(() => {
    if (!showEpubAllHighlights) {
      setMediaHighlights([]);
      setMediaHighlightsHasMore(false);
      setMediaHighlightsCursor(null);
      setMediaHighlightsLoading(false);
      setMediaHighlightsVersion(0);
    }
  }, [showEpubAllHighlights]);

  useEffect(() => {
    if (!showEpubAllHighlights) return;
    let cancelled = false;

    const load = async () => {
      setMediaHighlightsLoading(true);
      try {
        const params = new URLSearchParams({ limit: "50", mine_only: "false" });
        const resp = await apiFetch<{
          data: {
            highlights: MediaHighlightForIndex[];
            page: { has_more: boolean; next_cursor: string | null };
          };
        }>(`/api/media/${mediaId}/highlights?${params.toString()}`);
        if (cancelled) return;
        setMediaHighlights(resp.data.highlights);
        setMediaHighlightsHasMore(resp.data.page.has_more);
        setMediaHighlightsCursor(resp.data.page.next_cursor);
        setMediaHighlightsVersion((v) => v + 1);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load media highlights:", err);
      } finally {
        if (!cancelled) setMediaHighlightsLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [showEpubAllHighlights, mediaId, highlightMutationToken]);

  const handleLoadMoreMediaHighlights = useCallback(async () => {
    if (!showEpubAllHighlights || !mediaHighlightsCursor) return;
    setMediaHighlightsLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "50",
        mine_only: "false",
        cursor: mediaHighlightsCursor,
      });
      const resp = await apiFetch<{
        data: {
          highlights: MediaHighlightForIndex[];
          page: { has_more: boolean; next_cursor: string | null };
        };
      }>(`/api/media/${mediaId}/highlights?${params.toString()}`);
      setMediaHighlights((prev) => [...prev, ...resp.data.highlights]);
      setMediaHighlightsHasMore(resp.data.page.has_more);
      setMediaHighlightsCursor(resp.data.page.next_cursor);
      setMediaHighlightsVersion((v) => v + 1);
    } catch (err) {
      console.error("Failed to load more media highlights:", err);
    } finally {
      setMediaHighlightsLoading(false);
    }
  }, [showEpubAllHighlights, mediaId, mediaHighlightsCursor]);

  const handleShowAllHighlights = useCallback(() => {
    if (!canShowAllHighlights || isAllHighlights) return;
    setHighlightsView("all");
    onHighlightsViewChange();
  }, [canShowAllHighlights, isAllHighlights, onHighlightsViewChange]);

  const handleShowContextualHighlights = useCallback(() => {
    if (!isAllHighlights) return;
    setHighlightsView("contextual");
    onHighlightsViewChange();
  }, [isAllHighlights, onHighlightsViewChange]);

  // ---- Derived state ----

  const paneHighlights = useMemo(() => {
    if (showPdfAllHighlights) {
      return sortPdfHighlightsByStableKey(pdfDocumentHighlights).map((highlight) => {
        const stableOrderKey = toPdfStableOrderKey(highlight);
        const firstQuad = highlight.anchor.quads[0];
        const top = firstQuad
          ? Math.min(firstQuad.y1, firstQuad.y2, firstQuad.y3, firstQuad.y4)
          : 0;
        const bottom = firstQuad
          ? Math.max(firstQuad.y1, firstQuad.y2, firstQuad.y3, firstQuad.y4)
          : 0;
        return {
          id: highlight.id,
          exact: highlight.exact,
          color: highlight.color,
          annotation: highlight.annotation,
          created_at: highlight.created_at,
          fragment_idx: stableOrderKey.page_number,
          start_offset: Math.round(top * 1000),
          end_offset: Math.round(bottom * 1000),
          stable_order_key: encodePdfStableOrderKey(stableOrderKey),
          linked_conversations: highlight.linked_conversations,
        };
      });
    }

    if (showPdfPageHighlights) {
      return pdfPageHighlights.map((highlight) => ({
        id: highlight.id,
        exact: highlight.exact,
        color: highlight.color,
        annotation: highlight.annotation,
        created_at: highlight.created_at,
        linked_conversations: highlight.linked_conversations,
      }));
    }

    if (showEpubAllHighlights) {
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
        linked_conversations: highlight.linked_conversations,
      }));
    }

    return fragmentHighlights.map((highlight) => ({
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      start_offset: highlight.start_offset,
      end_offset: highlight.end_offset,
      created_at: highlight.created_at,
      fragment_id: highlight.fragment_id,
      linked_conversations: highlight.linked_conversations,
    }));
  }, [
    fragmentHighlights,
    mediaHighlights,
    pdfDocumentHighlights,
    pdfPageHighlights,
    showEpubAllHighlights,
    showPdfAllHighlights,
    showPdfPageHighlights,
  ]);

  const layoutMode = isMobile || isAllHighlights ? "list" : "aligned";

  const anchorDescriptors = useMemo(() => {
    if (!showPdfPageHighlights) return undefined;
    return pdfPageHighlights.map((highlight) => ({
      kind: "pdf" as const,
      id: highlight.id,
      pageNumber: highlight.anchor.page_number,
      quads: highlight.anchor.quads,
    }));
  }, [showPdfPageHighlights, pdfPageHighlights]);

  const anchorProvider = showPdfPageHighlights ? DEFAULT_PDF_ANCHOR_PROVIDER : undefined;

  let version = highlightsVersion;
  if (showPdfPageHighlights || showPdfAllHighlights) {
    version = pdfHighlightsVersion;
  } else if (showEpubAllHighlights) {
    version = mediaHighlightsVersion;
  }

  const pdfHint = useMemo(() => {
    if (!showPdfPageHighlights) return undefined;
    let offPageCount = 0;
    for (const h of pdfDocumentHighlights) {
      if (h.anchor.page_number !== pdfActivePage) offPageCount++;
    }
    if (offPageCount <= 0) return "Showing highlights for the active page.";
    const noun = offPageCount === 1 ? "highlight" : "highlights";
    const prefix = pdfHighlightsHasMore ? "At least " : "";
    return `${prefix}${offPageCount} ${noun} on other pages. Open All highlights to view them immediately.`;
  }, [showPdfPageHighlights, pdfDocumentHighlights, pdfActivePage, pdfHighlightsHasMore]);

  let paneTitle = "Highlights";
  let paneDescription: string | undefined;
  if (isAllHighlights) {
    paneTitle = "All highlights";
    if (isPdf) {
      paneDescription = "Showing highlights from the entire document.";
    } else if (isEpub) {
      paneDescription = "Showing highlights from the entire book.";
    }
  } else if (isPdf) {
    paneTitle = "Page highlights";
    paneDescription = pdfHint;
  } else if (isEpub) {
    paneTitle = "Chapter highlights";
    paneDescription = "Showing highlights in the active chapter.";
  }

  // ---- Click handler (view-dependent navigation + focus) ----

  const handleHighlightClick = useCallback(
    (highlightId: string) => {
      if (showPdfAllHighlights) {
        const target = pdfDocumentHighlights.find((h) => h.id === highlightId);
        if (target) {
          onNavigatePdfHighlight({
            highlightId,
            pageNumber: target.anchor.page_number,
            quads: target.anchor.quads,
          });
        }
      }

      if (showEpubAllHighlights) {
        const target = mediaHighlights.find((h) => h.id === highlightId);
        if (target) {
          onNavigateToFragment(highlightId, target.fragment_id, target.fragment_idx);
        }
      }

      onFocusHighlight(highlightId);
    },
    [
      pdfDocumentHighlights,
      mediaHighlights,
      onNavigatePdfHighlight,
      onNavigateToFragment,
      onFocusHighlight,
      showEpubAllHighlights,
      showPdfAllHighlights,
    ]
  );

  // ---- Render ----

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        minHeight: 0,
        flex: 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: "var(--font-size-lg)",
              color: "var(--color-text)",
            }}
          >
            {paneTitle}
          </h2>
          {paneDescription ? (
            <p
              style={{
                margin: "var(--space-1) 0 0",
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-muted)",
              }}
            >
              {paneDescription}
            </p>
          ) : null}
        </div>

        {canShowAllHighlights ? (
          <button
            type="button"
            className={styles.paneActionButton}
            onClick={isAllHighlights ? handleShowContextualHighlights : handleShowAllHighlights}
          >
            {isAllHighlights ? "Back to highlights" : "All highlights"}
          </button>
        ) : null}
      </div>

      <div style={{ minHeight: 0, flex: 1 }}>
        <LinkedItemsPane
          highlights={paneHighlights}
          contentRef={contentRef}
          focusedId={focusedId}
          onHighlightClick={handleHighlightClick}
          highlightsVersion={version}
          onSendToChat={onSendToChat}
          layoutMode={layoutMode}
          anchorDescriptors={anchorDescriptors}
          anchorProvider={anchorProvider}
          onAnnotationSave={onAnnotationSave}
          onAnnotationDelete={onAnnotationDelete}
          rowOptions={buildRowOptions}
          onOpenConversation={onOpenConversation}
        />
      </div>

      {showPdfAllHighlights && pdfHighlightsHasMore && (
        <button
          type="button"
          className={styles.loadMoreBtn}
          onClick={onLoadMorePdfHighlights}
          disabled={pdfHighlightsLoading}
        >
          {pdfHighlightsLoading ? "Loading..." : "Load more"}
        </button>
      )}

      {showEpubAllHighlights && mediaHighlightsHasMore && (
        <button
          type="button"
          className={styles.loadMoreBtn}
          onClick={handleLoadMoreMediaHighlights}
          disabled={mediaHighlightsLoading}
        >
          {mediaHighlightsLoading ? "Loading..." : "Load more"}
        </button>
      )}

      {isPdf && (
        <div className={styles.pdfPagePill}>
          <StatusPill variant="info">Active page: {pdfActivePage}</StatusPill>
        </div>
      )}
    </div>
  );
}
