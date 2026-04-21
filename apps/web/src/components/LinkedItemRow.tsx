"use client";

import { forwardRef, useCallback } from "react";
import { MessageSquare, NotebookPen } from "lucide-react";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import styles from "./LinkedItemsPane.module.css";

export interface LinkedItemRowHighlight {
  id: string;
  exact: string;
  color: "yellow" | "green" | "blue" | "pink" | "purple";
  annotation?: { id: string; body: string } | null;
  start_offset?: number;
  end_offset?: number;
  created_at?: string;
  fragment_idx?: number;
  stable_order_key?: string;
  linked_conversations?: { conversation_id: string; title: string }[];
  page_number?: number;
  quads?: PdfHighlightQuad[];
}

interface LinkedItemRowProps {
  highlight: LinkedItemRowHighlight;
  isFocused: boolean;
  onClick: (highlightId: string) => void;
  onMouseEnter: (highlightId: string) => void;
  onMouseLeave: () => void;
  style?: React.CSSProperties;
  className?: string;
}

const LinkedItemRow = forwardRef<HTMLButtonElement, LinkedItemRowProps>(function LinkedItemRow(
  { highlight, isFocused, onClick, onMouseEnter, onMouseLeave, style, className },
  ref
) {
  const handleClick = useCallback(() => {
    onClick(highlight.id);
  }, [highlight.id, onClick]);

  const handleMouseEnter = useCallback(() => {
    onMouseEnter(highlight.id);
  }, [highlight.id, onMouseEnter]);

  const linkedConversationCount = highlight.linked_conversations?.length ?? 0;
  const hasAnnotation = Boolean(highlight.annotation?.body.trim());

  return (
    <button
      ref={ref}
      type="button"
      data-highlight-id={highlight.id}
      data-testid={`linked-item-row-${highlight.id}`}
      className={`${styles.linkedItemRow} ${isFocused ? styles.rowFocused : ""} ${
        className ?? ""
      }`.trim()}
      style={style}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-pressed={isFocused}
    >
      <span
        className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
        aria-hidden="true"
      />
      <HighlightSnippet
        exact={highlight.exact}
        color={highlight.color}
        compact
        className={styles.previewText}
      />
      <span className={styles.rowMeta} aria-hidden="true">
        {hasAnnotation ? (
          <span className={styles.metaBadge} title="Has note">
            <NotebookPen size={12} />
          </span>
        ) : null}
        {linkedConversationCount > 0 ? (
          <span className={styles.metaBadge} title={`${linkedConversationCount} linked chats`}>
            <MessageSquare size={12} />
            <span>{linkedConversationCount}</span>
          </span>
        ) : null}
      </span>
    </button>
  );
});

export default LinkedItemRow;
