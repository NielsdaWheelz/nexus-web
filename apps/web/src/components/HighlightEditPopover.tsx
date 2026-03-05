/**
 * HighlightEditPopover - Lightweight popover for infrequent highlight controls.
 *
 * Renders at page level with position: fixed, positioned relative to an anchor
 * row. Contains a color picker and an "Edit Bounds" button.
 *
 * Follows the SelectionPopover positioning pattern.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights";
import styles from "./HighlightEditPopover.module.css";

const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  purple: "Purple",
};

export interface HighlightEditPopoverProps {
  highlight: { id: string; color: HighlightColor };
  anchorRect: DOMRect;
  isEditingBounds: boolean;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onColorChange: (id: string, color: HighlightColor) => Promise<void>;
  onDismiss: () => void;
}

export default function HighlightEditPopover({
  highlight,
  anchorRect,
  isEditingBounds,
  onStartEditBounds,
  onCancelEditBounds,
  onColorChange,
  onDismiss,
}: HighlightEditPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(
    highlight.color
  );
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  // Calculate position after first render
  useEffect(() => {
    if (!popoverRef.current) return;

    const popoverRect = popoverRef.current.getBoundingClientRect();
    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Prefer right of the anchor row
    let left = anchorRect.right + padding;
    if (left + popoverRect.width > viewportWidth - padding) {
      // Fall back to left side
      left = anchorRect.left - popoverRect.width - padding;
    }
    left = Math.max(padding, Math.min(left, viewportWidth - popoverRect.width - padding));

    let top = anchorRect.top;
    top = Math.max(padding, Math.min(top, viewportHeight - popoverRect.height - padding));

    setPosition({ top, left });
  }, [anchorRect]);

  // Escape dismissal
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

  // Click-outside dismissal
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onDismiss]);

  const handleColorSelect = useCallback(
    (color: HighlightColor) => {
      setSelectedColor(color);
      void onColorChange(highlight.id, color);
    },
    [highlight.id, onColorChange]
  );

  const handleEditBoundsClick = useCallback(() => {
    if (isEditingBounds) {
      onCancelEditBounds();
    } else {
      onStartEditBounds();
    }
  }, [isEditingBounds, onCancelEditBounds, onStartEditBounds]);

  return (
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
      role="dialog"
      aria-label="Edit highlight"
    >
      <button
        type="button"
        className={styles.closeButton}
        onClick={onDismiss}
        aria-label="Close"
      >
        ×
      </button>

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
          />
        ))}
      </div>

      <button
        type="button"
        className={`${styles.editBoundsButton} ${isEditingBounds ? styles.active : ""}`}
        onClick={handleEditBoundsClick}
      >
        {isEditingBounds ? "Done editing bounds" : "Edit bounds"}
      </button>
    </div>
  );
}
