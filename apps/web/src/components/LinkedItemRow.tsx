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

import { forwardRef, useCallback, useMemo } from "react";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import ContextRow from "@/components/ui/ContextRow";
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
  /** Optional expanded inline content rendered beneath the row preview. */
  expandedContent?: React.ReactNode;
  /** Optional action menu options for the row. */
  options?: ActionMenuOption[];
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
    {
      highlight,
      isFocused,
      onClick,
      onMouseEnter,
      onMouseLeave,
      onSendToChat,
      style,
      className,
      expandedContent,
      options: optionsProp,
    },
    ref
  ) {
    const handleClick = useCallback(() => {
      onClick(highlight.id);
    }, [onClick, highlight.id]);

    const handleMouseEnter = useCallback(() => {
      onMouseEnter(highlight.id);
    }, [onMouseEnter, highlight.id]);

    const isExpanded = Boolean(expandedContent);

    // Build menu options: "Quote to chat" from onSendToChat + any extra options
    const menuOptions = useMemo(() => {
      const items: ActionMenuOption[] = [];
      if (onSendToChat) {
        items.push({
          id: "quote-to-chat",
          label: "Quote to chat",
          onSelect: () => onSendToChat(highlight.id),
        });
      }
      if (optionsProp) {
        items.push(...optionsProp);
      }
      return items;
    }, [onSendToChat, highlight.id, optionsProp]);

    // Truncate text for preview
    const previewText =
      highlight.exact.length > MAX_PREVIEW_LENGTH
        ? `${highlight.exact.slice(0, MAX_PREVIEW_LENGTH)}…`
        : highlight.exact;

    return (
      <div
        ref={ref}
        data-highlight-id={highlight.id}
        className={`${styles.linkedItemRow} ${isFocused ? styles.rowFocused : ""} ${
          isExpanded ? styles.rowExpanded : ""
        } ${className ?? ""}`.trim()}
        style={style}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <ContextRow
          mainClassName={styles.linkedItemRowMain}
          leading={
            <span
              className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
              aria-hidden="true"
            />
          }
          title={previewText}
          titleClassName={styles.previewText}
          trailing={
            <>
              {highlight.annotation && (
                <span className={styles.annotationIndicator} role="img" aria-label="Has annotation">
                  💬
                </span>
              )}
              {menuOptions.length > 0 && (
                <ActionMenu
                  options={menuOptions}
                  className={styles.actionMenu}
                />
              )}
            </>
          }
          onMainClick={handleClick}
          onMainKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleClick();
            }
          }}
          mainRole="button"
          mainTabIndex={0}
          ariaPressed={isFocused}
          ariaExpanded={isExpanded}
          expandedContent={
            expandedContent ? (
              <div
                onClick={(event) => {
                  event.stopPropagation();
                }}
              >
                {expandedContent}
              </div>
            ) : undefined
          }
          expandedClassName={styles.rowExpansion}
        />
      </div>
    );
  }
);

export default LinkedItemRow;
