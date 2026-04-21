"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { PdfHighlightOut } from "@/components/PdfReader";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import HighlightDetailPane from "./HighlightDetailPane";
import type { Highlight } from "./mediaHelpers";
import { escapeAttrValue } from "./mediaHelpers";
import StatusPill from "@/components/ui/StatusPill";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import styles from "./page.module.css";

interface MediaHighlightsPaneBodyProps {
  isPdf: boolean;
  isEpub: boolean;
  isMobile: boolean;
  fragmentHighlights: Highlight[];
  pdfPageHighlights: PdfHighlightOut[];
  highlightsVersion: number;
  pdfHighlightsVersion: number;
  pdfActivePage: number;
  contentRef: RefObject<HTMLDivElement | null>;
  focusedId: string | null;
  onFocusHighlight: (id: string | null) => void;
  onClearFocus: () => void;
  onSendToChat: (id: string) => void;
  onColorChange: (id: string, color: HighlightColor) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  isEditingBounds: boolean;
  onAnnotationSave: (id: string, body: string) => Promise<void>;
  onAnnotationDelete: (id: string) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
  onCloseMobileDrawer?: () => void;
  mobileDetailRequestKey?: number;
}

export default function MediaHighlightsPaneBody({
  isPdf,
  isEpub,
  isMobile,
  fragmentHighlights,
  pdfPageHighlights,
  highlightsVersion,
  pdfHighlightsVersion,
  pdfActivePage,
  contentRef,
  focusedId,
  onFocusHighlight,
  onClearFocus,
  onSendToChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  isEditingBounds,
  onAnnotationSave,
  onAnnotationDelete,
  onOpenConversation,
  onCloseMobileDrawer,
  mobileDetailRequestKey = 0,
}: MediaHighlightsPaneBodyProps) {
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const detailHighlights = useMemo(() => {
    if (isPdf) {
      return [...pdfPageHighlights].sort((left, right) => {
        const leftTop = left.anchor.quads[0]?.y1 ?? 0;
        const rightTop = right.anchor.quads[0]?.y1 ?? 0;
        if (leftTop !== rightTop) {
          return leftTop - rightTop;
        }

        const leftLeft = left.anchor.quads[0]?.x1 ?? 0;
        const rightLeft = right.anchor.quads[0]?.x1 ?? 0;
        if (leftLeft !== rightLeft) {
          return leftLeft - rightLeft;
        }

        const leftCreatedAt = Date.parse(left.created_at);
        const rightCreatedAt = Date.parse(right.created_at);
        const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
        const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
        if (leftCreatedAtMs !== rightCreatedAtMs) {
          return leftCreatedAtMs - rightCreatedAtMs;
        }

        return left.id.localeCompare(right.id);
      });
    }

    return [...fragmentHighlights].sort((left, right) => {
      if (left.start_offset !== right.start_offset) {
        return left.start_offset - right.start_offset;
      }
      if (left.end_offset !== right.end_offset) {
        return left.end_offset - right.end_offset;
      }

      const leftCreatedAt = Date.parse(left.created_at);
      const rightCreatedAt = Date.parse(right.created_at);
      const leftCreatedAtMs = Number.isNaN(leftCreatedAt) ? 0 : leftCreatedAt;
      const rightCreatedAtMs = Number.isNaN(rightCreatedAt) ? 0 : rightCreatedAt;
      if (leftCreatedAtMs !== rightCreatedAtMs) {
        return leftCreatedAtMs - rightCreatedAtMs;
      }

      return left.id.localeCompare(right.id);
    });
  }, [fragmentHighlights, isPdf, pdfPageHighlights]);

  const railHighlights = useMemo(() => {
    if (isPdf) {
      return detailHighlights.map((highlight) => {
        const pdfHighlight = highlight as PdfHighlightOut;
        const quad = pdfHighlight.anchor.quads[0];
        const top = quad?.y1 ?? 0;
        const left = quad?.x1 ?? 0;

        return {
          id: pdfHighlight.id,
          exact: pdfHighlight.exact,
          color: pdfHighlight.color,
          annotation: pdfHighlight.annotation,
          created_at: pdfHighlight.created_at,
          linked_conversations: pdfHighlight.linked_conversations,
          page_number: pdfHighlight.anchor.page_number,
          quads: pdfHighlight.anchor.quads,
          stable_order_key: [
            String(pdfHighlight.anchor.page_number).padStart(8, "0"),
            top.toFixed(3).padStart(16, "0"),
            left.toFixed(3).padStart(16, "0"),
            pdfHighlight.created_at,
            pdfHighlight.id,
          ].join(":"),
        };
      });
    }

    return (detailHighlights as Highlight[]).map((highlight, index) => ({
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      created_at: highlight.created_at,
      start_offset: highlight.start_offset,
      end_offset: highlight.end_offset,
      fragment_idx: index,
      linked_conversations: highlight.linked_conversations,
      stable_order_key: [
        String(index).padStart(8, "0"),
        String(highlight.start_offset).padStart(12, "0"),
        String(highlight.end_offset).padStart(12, "0"),
        highlight.created_at,
        highlight.id,
      ].join(":"),
    }));
  }, [detailHighlights, isPdf]);

  const selectedHighlight = useMemo(() => {
    if (detailHighlights.length === 0) {
      return null;
    }
    if (focusedId) {
      const focusedHighlight = detailHighlights.find((highlight) => highlight.id === focusedId);
      if (focusedHighlight) {
        return focusedHighlight;
      }
    }
    return detailHighlights[0];
  }, [detailHighlights, focusedId]);

  useEffect(() => {
    if (detailHighlights.length === 0) {
      if (focusedId !== null) {
        onClearFocus();
      }
      return;
    }

    if (focusedId && detailHighlights.some((highlight) => highlight.id === focusedId)) {
      return;
    }

    onFocusHighlight(detailHighlights[0].id);
  }, [detailHighlights, focusedId, onClearFocus, onFocusHighlight]);

  useEffect(() => {
    if (!selectedHighlight) {
      setMobileDetailOpen(false);
    }
  }, [selectedHighlight]);

  useEffect(() => {
    if (!isMobile || !selectedHighlight || mobileDetailRequestKey === 0) {
      return;
    }
    setMobileDetailOpen(true);
  }, [isMobile, mobileDetailRequestKey, selectedHighlight]);

  const handleRailClick = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);
      if (isMobile) {
        setMobileDetailOpen(true);
      }
    },
    [isMobile, onFocusHighlight]
  );

  const handleShowInDocument = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);

      const escapedId = escapeAttrValue(highlightId);
      const anchor =
        contentRef.current?.querySelector<HTMLElement>(`[data-highlight-anchor="${escapedId}"]`) ??
        contentRef.current?.querySelector<HTMLElement>(`[data-active-highlight-ids~="${escapedId}"]`);
      anchor?.scrollIntoView({ behavior: "smooth", block: "center" });

      if (isMobile) {
        setMobileDetailOpen(false);
        onCloseMobileDrawer?.();
      }
    },
    [contentRef, isMobile, onCloseMobileDrawer, onFocusHighlight]
  );

  const paneTitle = isPdf ? "Page highlights" : isEpub ? "Section highlights" : "Highlights";
  const paneDescription = isPdf
    ? "Showing highlights for the active page."
    : isEpub
      ? "Showing highlights in the active section."
      : "Showing highlights in the current content.";

  const detailPane = (
    <HighlightDetailPane
      highlight={selectedHighlight}
      isEditingBounds={isEditingBounds}
      onShowInDocument={handleShowInDocument}
      onSendToChat={onSendToChat}
      onColorChange={onColorChange}
      onDelete={onDelete}
      onStartEditBounds={onStartEditBounds}
      onCancelEditBounds={onCancelEditBounds}
      onAnnotationSave={onAnnotationSave}
      onAnnotationDelete={onAnnotationDelete}
      onOpenConversation={onOpenConversation}
    />
  );

  return (
    <div className={styles.highlightsPaneRoot}>
      <header className={styles.highlightsPaneHeader}>
        <div>
          <h2>{paneTitle}</h2>
          <p>{paneDescription}</p>
        </div>
        {isPdf ? (
          <div className={styles.pdfPagePill}>
            <StatusPill variant="info">Active page: {pdfActivePage}</StatusPill>
          </div>
        ) : null}
      </header>

      {isMobile ? (
        <div className={styles.mobileHighlightsPane}>
          <LinkedItemsPane
            highlights={railHighlights}
            contentRef={contentRef}
            focusedId={selectedHighlight?.id ?? null}
            onHighlightClick={handleRailClick}
            highlightsVersion={isPdf ? pdfHighlightsVersion : highlightsVersion}
            alignToContent={false}
          />
          {selectedHighlight && mobileDetailOpen ? (
            <div
              className={styles.mobileHighlightDetailBackdrop}
              onClick={() => setMobileDetailOpen(false)}
            >
              <aside
                className={styles.mobileHighlightDetailSheet}
                role="dialog"
                aria-modal="true"
                aria-label="Highlight details"
                onClick={(event) => event.stopPropagation()}
              >
                <header className={styles.mobileHighlightDetailHeader}>
                  <h3>Highlight details</h3>
                  <button type="button" onClick={() => setMobileDetailOpen(false)}>
                    Close
                  </button>
                </header>
                <div className={styles.mobileHighlightDetailBody}>{detailPane}</div>
              </aside>
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.highlightsPaneDesktopBody}>
          <div className={styles.highlightsRailColumn}>
            <LinkedItemsPane
              highlights={railHighlights}
              contentRef={contentRef}
              focusedId={selectedHighlight?.id ?? null}
              onHighlightClick={handleRailClick}
              highlightsVersion={isPdf ? pdfHighlightsVersion : highlightsVersion}
              alignToContent
            />
          </div>
          <div className={styles.highlightsDetailColumn}>{detailPane}</div>
        </div>
      )}
    </div>
  );
}
