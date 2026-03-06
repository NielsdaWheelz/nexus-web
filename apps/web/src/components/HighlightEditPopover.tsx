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
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./HighlightEditPopover.module.css";

const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  purple: "Purple",
};

export interface HighlightEditPopoverProps {
  highlight: { id: string; color: HighlightColor; annotationBody?: string | null };
  anchorRect: DOMRect;
  isEditingBounds: boolean;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onColorChange: (id: string, color: HighlightColor) => Promise<void>;
  onAnnotationSave?: (id: string, body: string) => Promise<void>;
  onAnnotationDelete?: (id: string) => Promise<void>;
  onDismiss: () => void;
}

export default function HighlightEditPopover({
  highlight,
  anchorRect,
  isEditingBounds,
  onStartEditBounds,
  onCancelEditBounds,
  onColorChange,
  onAnnotationSave,
  onAnnotationDelete,
  onDismiss,
}: HighlightEditPopoverProps) {
  const isMobileViewport = useIsMobileViewport();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(
    highlight.color
  );
  const [annotationBody, setAnnotationBody] = useState<string>(
    highlight.annotationBody ?? ""
  );
  const [isSavingAnnotation, setIsSavingAnnotation] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  useEffect(() => {
    setSelectedColor(highlight.color);
    setAnnotationBody(highlight.annotationBody ?? "");
  }, [highlight.id, highlight.color, highlight.annotationBody]);

  // Calculate position after first render
  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
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
  }, [anchorRect, isMobileViewport]);

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
    const handlePointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
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

  const handleSaveAnnotation = useCallback(async () => {
    if (!onAnnotationSave || isSavingAnnotation) return;
    const trimmed = annotationBody.trim();
    setIsSavingAnnotation(true);
    try {
      if (trimmed === "") {
        if (onAnnotationDelete) {
          await onAnnotationDelete(highlight.id);
        } else {
          await onAnnotationSave(highlight.id, "");
        }
      } else {
        await onAnnotationSave(highlight.id, trimmed);
      }
    } finally {
      setIsSavingAnnotation(false);
    }
  }, [
    annotationBody,
    highlight.id,
    isSavingAnnotation,
    onAnnotationDelete,
    onAnnotationSave,
  ]);

  return (
    <div
      ref={popoverRef}
      className={`${styles.popover} ${isMobileViewport ? styles.mobileSheet : ""}`.trim()}
      style={
        isMobileViewport
          ? undefined
          : {
              top: `${position.top}px`,
              left: `${position.left}px`,
            }
      }
      role="dialog"
      aria-label="Edit highlight"
    >
      {isMobileViewport && <div className={styles.sheetHandle} aria-hidden="true" />}
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

      {(onAnnotationSave || onAnnotationDelete) && (
        <div className={styles.annotationSection}>
          <label htmlFor={`hl-note-${highlight.id}`} className={styles.annotationLabel}>
            Note
          </label>
          <textarea
            id={`hl-note-${highlight.id}`}
            className={styles.annotationInput}
            aria-label="Annotation note"
            value={annotationBody}
            onChange={(event) => setAnnotationBody(event.target.value)}
            rows={3}
          />
          <div className={styles.annotationActions}>
            {onAnnotationDelete && highlight.annotationBody && (
              <button
                type="button"
                className={styles.annotationDelete}
                onClick={() => void onAnnotationDelete(highlight.id)}
                disabled={isSavingAnnotation}
              >
                Delete note
              </button>
            )}
            {onAnnotationSave && (
              <button
                type="button"
                className={styles.annotationSave}
                onClick={() => void handleSaveAnnotation()}
                disabled={isSavingAnnotation}
              >
                Save note
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
