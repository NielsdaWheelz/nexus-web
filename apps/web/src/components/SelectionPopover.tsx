/**
 * SelectionPopover - Color picker for highlight creation.
 *
 * Appears when user selects text in the content area. Positioned relative
 * to the selection bounding box. Selecting a color creates the highlight
 * immediately. Dismisses on Escape, click outside, or selection collapse.
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights/segmenter";
import { COLOR_LABELS } from "@/lib/highlights/colors";
import styles from "./SelectionPopover.module.css";

// =============================================================================
// Types
// =============================================================================

export interface SelectionPopoverProps {
  selectionRect: DOMRect;
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => void | Promise<void | string | null>;
  onDismiss: () => void;
  isCreating?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_COLOR: HighlightColor = "yellow";

// =============================================================================
// Component
// =============================================================================

export default function SelectionPopover({
  selectionRect,
  containerRef,
  onCreateHighlight,
  onDismiss,
  isCreating = false,
}: SelectionPopoverProps) {
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(DEFAULT_COLOR);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Calculate position relative to selection and viewport
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  // Calculate position on mount and when selection changes
  useEffect(() => {
    if (!popoverRef.current || !containerRef.current) return;

    const popoverRect = popoverRef.current.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Calculate horizontal position (center above selection)
    let left = selectionRect.left + selectionRect.width / 2 - popoverRect.width / 2;

    // Clamp to viewport bounds with padding
    const padding = 8;
    left = Math.max(padding, Math.min(left, viewportWidth - popoverRect.width - padding));

    // Calculate vertical position (prefer above selection)
    const spaceAbove = selectionRect.top - containerRect.top;
    const spaceBelow = viewportHeight - selectionRect.bottom;
    const popoverHeight = popoverRect.height + 8; // 8px gap

    let top: number;
    if (spaceAbove >= popoverHeight || spaceAbove > spaceBelow) {
      // Position above selection
      top = selectionRect.top - popoverHeight;
    } else {
      // Position below selection
      top = selectionRect.bottom + 8;
    }

    // Clamp to viewport
    top = Math.max(padding, Math.min(top, viewportHeight - popoverRect.height - padding));

    setPosition({ top, left });
  }, [selectionRect, containerRef]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element) {
        const preserveSelectionTarget = target.closest(
          '[data-selection-popover-ignore-outside="true"]',
        );
        if (preserveSelectionTarget) {
          return;
        }
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };

    // Use mousedown to catch the click before selection collapse
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onDismiss]);

  const handleColorSelect = useCallback(
    (color: HighlightColor) => {
      setSelectedColor(color);
      if (!isCreating) {
        void onCreateHighlight(color);
      }
    },
    [isCreating, onCreateHighlight]
  );

  return (
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
      role="dialog"
      aria-label="Highlight actions"
    >
      <div className={styles.colorPicker}>
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`${styles.colorButton} ${styles[`color-${color}`]} ${
              selectedColor === color ? styles.selected : ""
            }`}
            onClick={() => handleColorSelect(color)}
            aria-label={`${COLOR_LABELS[color]}${selectedColor === color ? " (selected)" : ""}`}
            aria-pressed={selectedColor === color}
            disabled={isCreating}
          />
        ))}
      </div>
    </div>
  );
}
