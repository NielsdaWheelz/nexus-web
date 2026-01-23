/**
 * LinkedItemRow - Individual row component for linked-items pane.
 *
 * Each row represents one highlight and includes:
 * - Color swatch
 * - Truncated exact text preview (single line)
 * - Hover and click affordance
 *
 * The row is positioned absolutely and uses CSS transforms for
 * performant scroll-synchronized positioning.
 *
 * @see docs/v1/s2/s2_prs/s2_pr10.md §6
 */

"use client";

import { forwardRef, useCallback } from "react";
import styles from "./LinkedItemsPane.module.css";

// =============================================================================
// Types
// =============================================================================

export interface LinkedItemRowHighlight {
  id: string;
  exact: string;
  color: "yellow" | "green" | "blue" | "pink" | "purple";
  annotation?: { id: string; body: string } | null;
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
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters to show in the text preview */
const MAX_PREVIEW_LENGTH = 60;

// =============================================================================
// Component
// =============================================================================

/**
 * A single row in the linked-items pane.
 *
 * Uses forwardRef to allow the parent to manipulate transform directly
 * for performant scroll-synchronized positioning.
 */
const LinkedItemRow = forwardRef<HTMLDivElement, LinkedItemRowProps>(
  function LinkedItemRow(
    { highlight, isFocused, onClick, onMouseEnter, onMouseLeave },
    ref
  ) {
    const handleClick = useCallback(() => {
      onClick(highlight.id);
    }, [onClick, highlight.id]);

    const handleMouseEnter = useCallback(() => {
      onMouseEnter(highlight.id);
    }, [onMouseEnter, highlight.id]);

    // Truncate text for preview
    const previewText =
      highlight.exact.length > MAX_PREVIEW_LENGTH
        ? `${highlight.exact.slice(0, MAX_PREVIEW_LENGTH)}…`
        : highlight.exact;

    return (
      <div
        ref={ref}
        className={`${styles.linkedItemRow} ${isFocused ? styles.rowFocused : ""}`}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onMouseLeave}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        aria-pressed={isFocused}
      >
        <span
          className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
          aria-hidden="true"
        />
        <span className={styles.previewText} title={highlight.exact}>
          {previewText}
        </span>
        {highlight.annotation && (
          <span className={styles.annotationIndicator} aria-label="Has annotation">
            💬
          </span>
        )}
      </div>
    );
  }
);

export default LinkedItemRow;
