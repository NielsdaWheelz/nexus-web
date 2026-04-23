"use client";

import { useCallback, useEffect, useMemo, type RefObject } from "react";
import type { PdfHighlightOut } from "@/components/PdfReader";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import type { Highlight } from "./mediaHighlights";
import {
  sortContextualFragmentHighlights,
  sortContextualPdfHighlights,
} from "./mediaHighlightOrdering";
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
  const shouldAutoSelectFirstContextualHighlight = isEpub && !isMobile;

  const contextualHighlights = useMemo(() => {
    if (isPdf) {
      return sortContextualPdfHighlights(pdfPageHighlights);
    }

    return sortContextualFragmentHighlights(fragmentHighlights);
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

    return (contextualHighlights as Highlight[]).map((highlight) => ({
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      created_at: highlight.created_at,
      updated_at: highlight.updated_at,
      prefix: highlight.prefix,
      suffix: highlight.suffix,
      anchor: {
        start_offset: highlight.anchor.start_offset,
        end_offset: highlight.anchor.end_offset,
      },
      linked_conversations: highlight.linked_conversations,
      stable_order_key: [
        String(highlight.anchor.start_offset).padStart(12, "0"),
        String(highlight.anchor.end_offset).padStart(12, "0"),
        highlight.created_at,
        highlight.id,
      ].join(":"),
    }));
  }, [contextualHighlights, isPdf]);

  const selectedHighlight = useMemo(() => {
    if (contextualHighlights.length === 0) {
      return null;
    }
    if (focusedId === null) {
      if (!shouldAutoSelectFirstContextualHighlight) {
        return null;
      }
      return contextualHighlights[0]!;
    }

    const focusedHighlight = contextualHighlights.find((highlight) => highlight.id === focusedId);
    if (focusedHighlight) {
      return focusedHighlight;
    }

    if (!shouldAutoSelectFirstContextualHighlight) {
      return null;
    }
    return contextualHighlights[0]!;
  }, [contextualHighlights, focusedId, shouldAutoSelectFirstContextualHighlight]);

  useEffect(() => {
    if (contextualHighlights.length === 0) {
      if (focusedId !== null) {
        onClearFocus();
      }
      return;
    }

    if (
      !shouldAutoSelectFirstContextualHighlight ||
      !selectedHighlight ||
      focusedId === selectedHighlight.id
    ) {
      return;
    }

    onFocusHighlight(selectedHighlight.id);
  }, [
    contextualHighlights,
    focusedId,
    onClearFocus,
    onFocusHighlight,
    selectedHighlight,
    shouldAutoSelectFirstContextualHighlight,
  ]);

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
