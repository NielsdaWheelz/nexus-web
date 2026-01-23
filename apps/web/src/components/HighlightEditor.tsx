/**
 * HighlightEditor - Edit bounds, color, and delete highlights.
 *
 * Shown in the linked-items pane for the focused highlight.
 * Provides controls for:
 * - Editing bounds (enters edit mode, next selection replaces bounds)
 * - Changing color
 * - Deleting the highlight
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §8
 */

"use client";

import { useState, useCallback } from "react";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights";
import AnnotationEditor from "./AnnotationEditor";
import styles from "./HighlightEditor.module.css";

// =============================================================================
// Types
// =============================================================================

export interface Highlight {
  id: string;
  fragment_id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  annotation: {
    id: string;
    body: string;
    created_at: string;
    updated_at: string;
  } | null;
}

export interface HighlightEditorProps {
  /** The highlight being edited */
  highlight: Highlight;
  /** Whether in edit bounds mode */
  isEditingBounds: boolean;
  /** Callback to start editing bounds */
  onStartEditBounds: () => void;
  /** Callback to cancel editing bounds */
  onCancelEditBounds: () => void;
  /** Callback when color is changed */
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  /** Callback when highlight is deleted */
  onDelete: (highlightId: string) => Promise<void>;
  /** Callback when annotation is saved */
  onAnnotationSave: (highlightId: string, body: string) => Promise<void>;
  /** Callback when annotation is deleted */
  onAnnotationDelete: (highlightId: string) => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
  purple: "Purple",
};

// =============================================================================
// Component
// =============================================================================

export default function HighlightEditor({
  highlight,
  isEditingBounds,
  onStartEditBounds,
  onCancelEditBounds,
  onColorChange,
  onDelete,
  onAnnotationSave,
  onAnnotationDelete,
}: HighlightEditorProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isChangingColor, setIsChangingColor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleColorChange = useCallback(
    async (color: HighlightColor) => {
      if (color === highlight.color || isChangingColor) return;

      setIsChangingColor(true);
      setError(null);

      try {
        await onColorChange(highlight.id, color);
      } catch (err) {
        setError("Failed to change color");
        console.error("Color change failed:", err);
      } finally {
        setIsChangingColor(false);
      }
    },
    [highlight.id, highlight.color, isChangingColor, onColorChange]
  );

  const handleDelete = useCallback(async () => {
    if (isDeleting) return;

    const confirmed = window.confirm("Delete this highlight?");
    if (!confirmed) return;

    setIsDeleting(true);
    setError(null);

    try {
      await onDelete(highlight.id);
    } catch (err) {
      setError("Failed to delete highlight");
      console.error("Delete failed:", err);
      setIsDeleting(false);
    }
  }, [highlight.id, isDeleting, onDelete]);

  return (
    <div className={styles.editor}>
      {/* Highlighted text preview */}
      <div className={styles.preview}>
        <span className={styles.previewPrefix}>{highlight.prefix}</span>
        <mark className={`${styles.previewHighlight} ${styles[`color-${highlight.color}`]}`}>
          {highlight.exact}
        </mark>
        <span className={styles.previewSuffix}>{highlight.suffix}</span>
      </div>

      {/* Error display */}
      {error && <div className={styles.error}>{error}</div>}

      {/* Edit bounds mode */}
      {isEditingBounds ? (
        <div className={styles.editBoundsMode}>
          <p className={styles.editBoundsHint}>
            Select new text to update highlight bounds
          </p>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onCancelEditBounds}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          {/* Color picker */}
          <div className={styles.section}>
            <label className={styles.label}>Color</label>
            <div className={styles.colorPicker}>
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`${styles.colorButton} ${styles[`color-${color}`]} ${
                    highlight.color === color ? styles.selected : ""
                  }`}
                  onClick={() => handleColorChange(color)}
                  aria-label={`${COLOR_LABELS[color]}${
                    highlight.color === color ? " (selected)" : ""
                  }`}
                  aria-pressed={highlight.color === color}
                  disabled={isChangingColor || isDeleting}
                />
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onStartEditBounds}
              disabled={isDeleting}
            >
              Edit Bounds
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.deleteButton}`}
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </>
      )}

      {/* Annotation editor */}
      {!isEditingBounds && (
        <AnnotationEditor
          highlightId={highlight.id}
          annotation={highlight.annotation}
          onSave={onAnnotationSave}
          onDelete={onAnnotationDelete}
          disabled={isDeleting}
        />
      )}
    </div>
  );
}
