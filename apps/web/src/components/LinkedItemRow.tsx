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
  useEffect,
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
    },
    ref
  ) {
    const [isEditingAnnotation, setIsEditingAnnotation] = useState(false);
    const [annotationDraft, setAnnotationDraft] = useState(
      highlight.annotation?.body ?? ""
    );
    const [isSaving, setIsSaving] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Sync draft from prop when not editing
    useEffect(() => {
      if (!isEditingAnnotation) {
        setAnnotationDraft(highlight.annotation?.body ?? "");
      }
    }, [highlight.annotation?.body, isEditingAnnotation]);

    // Auto-focus textarea on edit start
    useEffect(() => {
      if (isEditingAnnotation) {
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }
    }, [isEditingAnnotation]);

    const handleClick = useCallback(() => {
      onClick(highlight.id);
    }, [onClick, highlight.id]);

    const handleMouseEnter = useCallback(() => {
      onMouseEnter(highlight.id);
    }, [onMouseEnter, highlight.id]);

    const handleAnnotationClick = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onAnnotationSave) {
          setIsEditingAnnotation(true);
        }
      },
      [onAnnotationSave]
    );

    const handleSaveAnnotation = useCallback(async () => {
      if (isSaving) return;
      const trimmed = annotationDraft.trim();

      if (trimmed === (highlight.annotation?.body ?? "")) {
        setIsEditingAnnotation(false);
        return;
      }

      setIsSaving(true);
      try {
        if (trimmed === "" && highlight.annotation) {
          await onAnnotationDelete?.(highlight.id);
        } else if (trimmed !== "") {
          await onAnnotationSave?.(highlight.id, trimmed);
        }
      } finally {
        setIsSaving(false);
        setIsEditingAnnotation(false);
      }
    }, [
      annotationDraft,
      highlight.annotation,
      highlight.id,
      isSaving,
      onAnnotationDelete,
      onAnnotationSave,
    ]);

    const handleCancelAnnotation = useCallback(() => {
      setAnnotationDraft(highlight.annotation?.body ?? "");
      setIsEditingAnnotation(false);
    }, [highlight.annotation?.body]);

    const handleTextareaKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          handleCancelAnnotation();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
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
            ref={textareaRef}
            className={styles.annotationTextarea}
            value={annotationDraft}
            onChange={(e) => setAnnotationDraft(e.target.value)}
            onBlur={() => void handleSaveAnnotation()}
            onKeyDown={handleTextareaKeyDown}
            onClick={(e) => e.stopPropagation()}
            disabled={isSaving}
            rows={2}
            aria-label="Annotation"
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
      </div>
    );
  }
);

export default LinkedItemRow;
