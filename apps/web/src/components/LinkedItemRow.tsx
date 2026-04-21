/**
 * LinkedItemRow - Individual row component for linked-items pane.
 *
 * Each row represents one highlight with two lines:
 * - Line 1: Color swatch + full highlight text (via HighlightSnippet) + ActionMenu
 * - Line 2: Annotation body or "Add a note…" placeholder (click to edit inline)
 *
 * @see docs/v1/s2/s2_prs/s2_pr10.md §6
 */

"use client";

import {
  forwardRef,
  useCallback,
  useRef,
  useState,
} from "react";
import { MessageSquare } from "lucide-react";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import styles from "./LinkedItemsPane.module.css";

// =============================================================================
// Types
// =============================================================================

export interface LinkedItemRowHighlight {
  id: string;
  exact: string;
  color: "yellow" | "green" | "blue" | "pink" | "purple";
  annotation?: { id: string; body: string } | null;
  start_offset?: number;
  end_offset?: number;
  created_at?: string;
  fragment_id?: string;
  fragment_idx?: number;
  stable_order_key?: string;
  linked_conversations?: { conversation_id: string; title: string }[];
}

export interface LinkedItemRowProps {
  /** The highlight data to display */
  highlight: LinkedItemRowHighlight;
  /** Whether this row is currently focused */
  isFocused: boolean;
  /** Callback when row is clicked */
  onClick: (highlightId: string) => void;
  /** Callback when mouse enters row (for hover outline) */
  onMouseEnter: (highlightId: string) => void;
  /** Callback when mouse leaves row */
  onMouseLeave: () => void;
  /** Callback when "send to chat" is clicked (quote-to-chat). */
  onSendToChat?: (highlightId: string) => void;
  /** Optional style override for positioned rows. */
  style?: React.CSSProperties;
  /** Optional class name for mode-specific row styling. */
  className?: string;
  /** Optional action menu options for the row. */
  options?: ActionMenuOption[];
  /** Save annotation callback. Empty body on existing annotation triggers delete. */
  onAnnotationSave?: (highlightId: string, body: string) => Promise<void>;
  /** Delete annotation callback. */
  onAnnotationDelete?: (highlightId: string) => Promise<void>;
  /** Callback when a linked conversation is clicked. */
  onOpenConversation?: (conversationId: string, title: string) => void;
}

// =============================================================================
// Component
// =============================================================================

const LinkedItemRow = forwardRef<HTMLDivElement, LinkedItemRowProps>(
  function LinkedItemRow(
    {
      highlight,
      isFocused,
      onClick,
      onMouseEnter,
      onMouseLeave,
      onSendToChat,
      style,
      className,
      options: optionsProp,
      onAnnotationSave,
      onAnnotationDelete,
      onOpenConversation,
    },
    ref
  ) {
    const [isEditingAnnotation, setIsEditingAnnotation] = useState(false);
    const [annotationDraft, setAnnotationDraft] = useState(
      highlight.annotation?.body ?? ""
    );
    const isSavingRef = useRef(false);
    const skipBlurSaveRef = useRef(false);

    const handleClick = useCallback(() => {
      onClick(highlight.id);
    }, [onClick, highlight.id]);

    const handleMouseEnter = useCallback(() => {
      onMouseEnter(highlight.id);
    }, [onMouseEnter, highlight.id]);

    const handleAnnotationClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onAnnotationSave && !isSavingRef.current) {
          skipBlurSaveRef.current = false;
          setAnnotationDraft(highlight.annotation?.body ?? "");
          setIsEditingAnnotation(true);
        }
      },
      [highlight.annotation?.body, onAnnotationSave]
    );

    const handleSaveAnnotation = useCallback(async () => {
      if (isSavingRef.current) return;
      const trimmed = annotationDraft.trim();

      if (trimmed === (highlight.annotation?.body ?? "")) {
        setIsEditingAnnotation(false);
        return;
      }

      isSavingRef.current = true;
      setIsEditingAnnotation(false);
      try {
        if (trimmed === "" && highlight.annotation) {
          await onAnnotationDelete?.(highlight.id);
        } else if (trimmed !== "") {
          await onAnnotationSave?.(highlight.id, trimmed);
        }
      } finally {
        isSavingRef.current = false;
      }
    }, [
      annotationDraft,
      highlight.annotation,
      highlight.id,
      onAnnotationDelete,
      onAnnotationSave,
    ]);

    const handleCancelAnnotation = useCallback(() => {
      skipBlurSaveRef.current = true;
      setIsEditingAnnotation(false);
    }, []);

    const handleTextareaBlur = useCallback(() => {
      if (skipBlurSaveRef.current) {
        skipBlurSaveRef.current = false;
        return;
      }

      void handleSaveAnnotation();
    }, [handleSaveAnnotation]);

    const handleTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          handleCancelAnnotation();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          skipBlurSaveRef.current = true;
          void handleSaveAnnotation();
        }
      },
      [handleCancelAnnotation, handleSaveAnnotation]
    );

    const handleSendToChat = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onSendToChat?.(highlight.id);
      },
      [onSendToChat, highlight.id]
    );

    const annotationBody = highlight.annotation?.body;

    return (
      <div
        ref={ref}
        data-highlight-id={highlight.id}
        data-testid={`linked-item-row-${highlight.id}`}
        className={`${styles.linkedItemRow} ${isFocused ? styles.rowFocused : ""} ${
          isEditingAnnotation ? styles.annotationEditing : ""
        } ${className ?? ""}`.trim()}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {/* Line 1: swatch + text + actions */}
        <div className={styles.linkedItemRowMain}>
          <div
            className={styles.linkedItemPrimary}
            onClick={handleClick}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleClick();
              }
            }}
            role="button"
            tabIndex={0}
            aria-pressed={isFocused}
          >
            <span
              className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
              aria-hidden="true"
            />
            <HighlightSnippet exact={highlight.exact} color={highlight.color} compact className={styles.previewText} />
          </div>
          {onSendToChat && (
            <button
              type="button"
              className={styles.chatButton}
              onClick={handleSendToChat}
              aria-label="Send to chat"
            >
              <MessageSquare size={14} />
            </button>
          )}
          {optionsProp && optionsProp.length > 0 && (
            <ActionMenu
              options={optionsProp}
              className={styles.actionMenu}
            />
          )}
        </div>

        {/* Line 2: annotation or placeholder */}
        {isEditingAnnotation ? (
          <textarea
            className={styles.annotationTextarea}
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            onBlur={handleTextareaBlur}
            onKeyDown={handleTextareaKeyDown}
            onClick={(e) => e.stopPropagation()}
            rows={2}
            aria-label="Annotation"
            autoFocus
          />
        ) : (
          <span
            className={`${styles.annotationLine} ${
              !annotationBody ? styles.annotationPlaceholder : ""
            }`}
            onClick={handleAnnotationClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleAnnotationClick(e as unknown as React.MouseEvent);
              }
            }}
            role="button"
            tabIndex={0}
          >
            {annotationBody || "Add a note\u2026"}
          </span>
        )}

        {/* Line 3: linked conversations */}
        {highlight.linked_conversations?.map((conv) => (
          <button
            key={conv.conversation_id}
            type="button"
            className={styles.linkedConversationLine}
            onClick={(e) => {
              e.stopPropagation();
              onOpenConversation?.(conv.conversation_id, conv.title);
            }}
          >
            <MessageSquare size={10} />
            <span>{conv.title}</span>
          </button>
        ))}
      </div>
    );
  }
);

export default LinkedItemRow;
