"use client";

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { PdfHighlightOut } from "@/components/PdfReader";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import type { Highlight } from "./mediaHighlights";
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
}: MediaHighlightsPaneBodyProps) {
  const lastResolvedIndexRef = useRef(0);

  const contextualHighlights = useMemo(() => {
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

  const paneHighlights = useMemo(() => {
    if (isPdf) {
      return contextualHighlights.map((highlight) => {
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
          updated_at: pdfHighlight.updated_at,
          prefix: pdfHighlight.prefix,
          suffix: pdfHighlight.suffix,
          is_owner: pdfHighlight.is_owner,
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

    return (contextualHighlights as Highlight[]).map((highlight, index) => ({
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      created_at: highlight.created_at,
      updated_at: highlight.updated_at,
      prefix: highlight.prefix,
      suffix: highlight.suffix,
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
  }, [contextualHighlights, isPdf]);

  const selectedHighlight = useMemo(() => {
    if (contextualHighlights.length === 0) {
      return null;
    }
    if (focusedId) {
      const focusedHighlight = contextualHighlights.find((highlight) => highlight.id === focusedId);
      if (focusedHighlight) {
        return focusedHighlight;
      }
    }
    return contextualHighlights[Math.min(lastResolvedIndexRef.current, contextualHighlights.length - 1)];
  }, [contextualHighlights, focusedId]);

  useEffect(() => {
    if (!selectedHighlight) {
      return;
    }
    const selectedIndex = contextualHighlights.findIndex(
      (highlight) => highlight.id === selectedHighlight.id
    );
    if (selectedIndex >= 0) {
      lastResolvedIndexRef.current = selectedIndex;
    }
  }, [contextualHighlights, selectedHighlight]);

  useEffect(() => {
    if (contextualHighlights.length === 0) {
      if (focusedId !== null) {
        onClearFocus();
      }
      return;
    }

    if (!selectedHighlight || focusedId === selectedHighlight.id) {
      return;
    }

    onFocusHighlight(selectedHighlight.id);
  }, [contextualHighlights, focusedId, onClearFocus, onFocusHighlight, selectedHighlight]);

  const handleHighlightClick = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);
    },
    [onFocusHighlight]
  );

  const paneTitle = isPdf ? "Page highlights" : isEpub ? "Section highlights" : "Highlights";
  const paneDescription = isMobile
    ? isPdf
      ? "Showing visible highlights on the active page."
      : isEpub
        ? "Showing visible highlights in the active section."
        : "Showing visible highlights in the current content."
    : isPdf
      ? "Showing highlights for the active page."
      : isEpub
        ? "Showing highlights in the active section."
        : "Showing highlights in the current content.";

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

      <div className={styles.highlightsPaneBody}>
        <LinkedItemsPane
          highlights={paneHighlights}
          contentRef={contentRef}
          focusedId={selectedHighlight?.id ?? null}
          onHighlightClick={handleHighlightClick}
          highlightsVersion={isPdf ? pdfHighlightsVersion : highlightsVersion}
          isMobile={isMobile}
          isEditingBounds={isEditingBounds}
          onSendToChat={onSendToChat}
          onColorChange={onColorChange}
          onDelete={onDelete}
          onStartEditBounds={onStartEditBounds}
          onCancelEditBounds={onCancelEditBounds}
          onAnnotationSave={onAnnotationSave}
          onAnnotationDelete={onAnnotationDelete}
          onOpenConversation={onOpenConversation}
        />
      </div>
    </div>
  );
}
