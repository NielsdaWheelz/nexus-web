/**
 * Linked-items pane body for media readers.
 *
 * Owns highlight scope state (chapter/book, page/document), EPUB book-scope
 * fetching, and all linked-items display. Parent (MediaPaneBody) passes
 * narrow-scope + PDF document highlights and handles reader navigation.
 */

"use client";

import { useEffect, useState, useCallback, useMemo, type RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import type { Highlight } from "@/components/HighlightEditor";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import SectionCard from "@/components/ui/SectionCard";
import StatusPill from "@/components/ui/StatusPill";
import {
  DEFAULT_HTML_ANCHOR_PROVIDER,
  DEFAULT_PDF_ANCHOR_PROVIDER,
} from "@/lib/highlights/anchorProviders";
import {
  toFragmentPaneItems,
  toMediaPaneItems,
  toPdfDocumentPaneItems,
  toPdfPageAnchorDescriptors,
  toPdfPagePaneItems,
  type MediaHighlightForIndex,
} from "@/lib/highlights/highlightIndexAdapter";
import { resolveLinkedItemsLayoutMode } from "@/lib/media/linkedItemsLayoutMode";
import { apiFetch } from "@/lib/api/client";
import styles from "./page.module.css";

export default function MediaLinkedItemsPaneBody({
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
  onScopeChange,
  onSendToChat,
  onAnnotationSave,
  onAnnotationDelete,
  buildRowOptions,
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
  onScopeChange: () => void;
  onSendToChat: (id: string) => void;
  onAnnotationSave: (id: string, body: string) => Promise<void>;
  onAnnotationDelete: (id: string) => Promise<void>;
  buildRowOptions: (id: string) => ActionMenuOption[];
}) {
  // ---- Scope state ----

  const [epubHighlightScope, setEpubHighlightScope] = useState<"chapter" | "book">("chapter");
  const [pdfHighlightScope, setPdfHighlightScope] = useState<"page" | "document">("page");

  // ---- EPUB book-scope highlights ----

  const [mediaHighlights, setMediaHighlights] = useState<MediaHighlightForIndex[]>([]);
  const [mediaHighlightsHasMore, setMediaHighlightsHasMore] = useState(false);
  const [mediaHighlightsCursor, setMediaHighlightsCursor] = useState<string | null>(null);
  const [mediaHighlightsLoading, setMediaHighlightsLoading] = useState(false);
  const [mediaHighlightsVersion, setMediaHighlightsVersion] = useState(0);

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
    if (!isEpub || epubHighlightScope !== "book") return;
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
  }, [isEpub, epubHighlightScope, mediaId, highlightMutationToken]);

  const handleLoadMoreMediaHighlights = useCallback(async () => {
    if (!isEpub || epubHighlightScope !== "book" || !mediaHighlightsCursor) return;
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
  }, [isEpub, epubHighlightScope, mediaId, mediaHighlightsCursor]);

  // ---- Derived state ----

  const paneHighlights = useMemo(() => {
    if (isPdf) {
      return pdfHighlightScope === "document"
        ? toPdfDocumentPaneItems(pdfDocumentHighlights)
        : toPdfPagePaneItems(pdfPageHighlights);
    }
    if (isEpub && epubHighlightScope === "book") {
      return toMediaPaneItems(mediaHighlights);
    }
    return toFragmentPaneItems(fragmentHighlights);
  }, [
    epubHighlightScope,
    fragmentHighlights,
    isEpub,
    isPdf,
    mediaHighlights,
    pdfDocumentHighlights,
    pdfHighlightScope,
    pdfPageHighlights,
  ]);

  const layoutMode = resolveLinkedItemsLayoutMode({
    isPdf,
    pdfHighlightScope,
    isEpub,
    epubHighlightScope,
    isMobile,
  });

  const anchorDescriptors = useMemo(() => {
    if (!isPdf || pdfHighlightScope !== "page") return undefined;
    return toPdfPageAnchorDescriptors(pdfPageHighlights);
  }, [isPdf, pdfHighlightScope, pdfPageHighlights]);

  const anchorProvider =
    isPdf && pdfHighlightScope === "page"
      ? DEFAULT_PDF_ANCHOR_PROVIDER
      : DEFAULT_HTML_ANCHOR_PROVIDER;

  const version = isPdf
    ? pdfHighlightsVersion
    : isEpub && epubHighlightScope === "book"
      ? mediaHighlightsVersion
      : highlightsVersion;

  const pdfHint = useMemo(() => {
    if (!isPdf) return "";
    if (pdfHighlightScope === "document") {
      return "Showing highlights from the entire document.";
    }
    let offPageCount = 0;
    for (const h of pdfDocumentHighlights) {
      if (h.anchor.page_number !== pdfActivePage) offPageCount++;
    }
    if (offPageCount <= 0) return "Showing highlights for this page.";
    const noun = offPageCount === 1 ? "highlight" : "highlights";
    const prefix = pdfHighlightsHasMore ? "At least " : "";
    return `${prefix}${offPageCount} ${noun} on other pages. Switch to Entire document to view them immediately.`;
  }, [isPdf, pdfHighlightScope, pdfDocumentHighlights, pdfActivePage, pdfHighlightsHasMore]);

  // ---- Click handler (scope-dependent navigation + focus) ----

  const handleHighlightClick = useCallback(
    (highlightId: string) => {
      if (isPdf && pdfHighlightScope === "document") {
        const target = pdfDocumentHighlights.find((h) => h.id === highlightId);
        if (target) {
          onNavigatePdfHighlight({
            highlightId,
            pageNumber: target.anchor.page_number,
            quads: target.anchor.quads,
          });
        }
      }

      if (isEpub && epubHighlightScope === "book") {
        const target = mediaHighlights.find((h) => h.id === highlightId);
        if (target) {
          onNavigateToFragment(highlightId, target.fragment_id, target.fragment_idx);
        }
      }

      onFocusHighlight(highlightId);
    },
    [
      isPdf,
      pdfHighlightScope,
      pdfDocumentHighlights,
      isEpub,
      epubHighlightScope,
      mediaHighlights,
      onNavigatePdfHighlight,
      onNavigateToFragment,
      onFocusHighlight,
    ]
  );

  // ---- Scope change handlers ----

  const handleEpubScopeChange = useCallback(
    (scope: "chapter" | "book") => {
      setEpubHighlightScope(scope);
      onScopeChange();
    },
    [onScopeChange]
  );

  const handlePdfScopeChange = useCallback(
    (scope: "page" | "document") => {
      setPdfHighlightScope(scope);
      onScopeChange();
    },
    [onScopeChange]
  );

  // ---- Render ----

  return (
    <>
      {isEpub && (
        <SectionCard
          title="Scope"
          className={styles.scopeCard}
          bodyClassName={styles.scopeCardBody}
        >
          <div className={styles.highlightScopeToggle} role="group" aria-label="Highlight scope">
            <button
              className={`${styles.scopeBtn} ${epubHighlightScope === "chapter" ? styles.scopeBtnActive : ""}`}
              onClick={() => handleEpubScopeChange("chapter")}
              type="button"
              aria-pressed={epubHighlightScope === "chapter"}
            >
              This chapter
            </button>
            <button
              className={`${styles.scopeBtn} ${epubHighlightScope === "book" ? styles.scopeBtnActive : ""}`}
              onClick={() => handleEpubScopeChange("book")}
              type="button"
              aria-pressed={epubHighlightScope === "book"}
            >
              Entire book
            </button>
          </div>
        </SectionCard>
      )}

      {isPdf && (
        <div className={styles.highlightScopeHeader} role="group" aria-label="Highlight scope">
          <span className={styles.highlightScopeLabel}>Scope</span>
          <div className={styles.highlightScopeToggle}>
            <button
              className={`${styles.scopeBtn} ${pdfHighlightScope === "page" ? styles.scopeBtnActive : ""}`}
              onClick={() => handlePdfScopeChange("page")}
              type="button"
              aria-pressed={pdfHighlightScope === "page"}
            >
              This page
            </button>
            <button
              className={`${styles.scopeBtn} ${pdfHighlightScope === "document" ? styles.scopeBtnActive : ""}`}
              onClick={() => handlePdfScopeChange("document")}
              type="button"
              aria-pressed={pdfHighlightScope === "document"}
            >
              Entire document
            </button>
          </div>
        </div>
      )}

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
      />

      {isPdf && (
        <div className={styles.bookHighlightsControls}>
          <p className={styles.hint}>{pdfHint}</p>
          {pdfHighlightScope === "document" && pdfHighlightsHasMore && (
            <button
              type="button"
              className={styles.loadMoreBtn}
              onClick={onLoadMorePdfHighlights}
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
    </>
  );
}
