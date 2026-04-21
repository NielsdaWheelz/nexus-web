/**
 * Highlights pane body for media readers.
 *
 * Shows only contextual highlights for the current fragment, chapter, or PDF page.
 */

"use client";

import { useMemo, type RefObject } from "react";
import LinkedItemsPane from "@/components/LinkedItemsPane";
import type { Highlight } from "./mediaHelpers";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import StatusPill from "@/components/ui/StatusPill";
import { DEFAULT_PDF_ANCHOR_PROVIDER } from "@/lib/highlights/anchorProviders";
import styles from "./page.module.css";

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
  onSendToChat,
  onAnnotationSave,
  onAnnotationDelete,
  buildRowOptions,
  onOpenConversation,
}: {
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
  onFocusHighlight: (id: string) => void;
  onSendToChat: (id: string) => void;
  onAnnotationSave: (id: string, body: string) => Promise<void>;
  onAnnotationDelete: (id: string) => Promise<void>;
  buildRowOptions: (id: string) => ActionMenuOption[];
  onOpenConversation: (conversationId: string, title: string) => void;
}) {
  const paneHighlights = useMemo(() => {
    if (isPdf) {
      return pdfPageHighlights.map((highlight) => ({
        id: highlight.id,
        exact: highlight.exact,
        color: highlight.color,
        annotation: highlight.annotation,
        created_at: highlight.created_at,
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
  }, [fragmentHighlights, isPdf, pdfPageHighlights]);

  const anchorDescriptors = useMemo(() => {
    if (!isPdf) {
      return undefined;
    }

    return pdfPageHighlights.map((highlight) => ({
      kind: "pdf" as const,
      id: highlight.id,
      pageNumber: highlight.anchor.page_number,
      quads: highlight.anchor.quads,
    }));
  }, [isPdf, pdfPageHighlights]);

  const paneTitle = isPdf ? "Page highlights" : isEpub ? "Chapter highlights" : "Highlights";
  const paneDescription = isPdf
    ? "Showing highlights for the active page."
    : isEpub
      ? "Showing highlights in the active chapter."
      : undefined;

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
      </div>

      <div style={{ minHeight: 0, flex: 1 }}>
        <LinkedItemsPane
          highlights={paneHighlights}
          contentRef={contentRef}
          focusedId={focusedId}
          onHighlightClick={onFocusHighlight}
          highlightsVersion={isPdf ? pdfHighlightsVersion : highlightsVersion}
          onSendToChat={onSendToChat}
          layoutMode={isMobile ? "list" : "aligned"}
          anchorDescriptors={anchorDescriptors}
          anchorProvider={isPdf ? DEFAULT_PDF_ANCHOR_PROVIDER : undefined}
          onAnnotationSave={onAnnotationSave}
          onAnnotationDelete={onAnnotationDelete}
          rowOptions={buildRowOptions}
          onOpenConversation={onOpenConversation}
        />
      </div>

      {isPdf && (
        <div className={styles.pdfPagePill}>
          <StatusPill variant="info">Active page: {pdfActivePage}</StatusPill>
        </div>
      )}
    </div>
  );
}
