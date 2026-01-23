/**
 * AnnotationEditor - Annotation text editor for highlights.
 *
 * Provides a textarea for editing annotation text with:
 * - Plain text only
 * - Max 10,000 characters
 * - Save via button or Cmd+Enter
 * - Empty body → delete annotation
 * - No autosave
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §10
 */

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import styles from "./AnnotationEditor.module.css";

// =============================================================================
// Types
// =============================================================================

export interface Annotation {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface AnnotationEditorProps {
  /** The highlight ID this annotation belongs to */
  highlightId: string;
  /** The existing annotation, or null if none */
  annotation: Annotation | null;
  /** Callback when annotation is saved */
  onSave: (highlightId: string, body: string) => Promise<void>;
  /** Callback when annotation is deleted */
  onDelete: (highlightId: string) => Promise<void>;
  /** Whether the editor is disabled */
  disabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_ANNOTATION_LENGTH = 10000;

// =============================================================================
// Component
// =============================================================================

export default function AnnotationEditor({
  highlightId,
  annotation,
  onSave,
  onDelete,
  disabled = false,
}: AnnotationEditorProps) {
  const [body, setBody] = useState(annotation?.body || "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset body when annotation changes (e.g., after refetch)
  useEffect(() => {
    setBody(annotation?.body || "");
    setIsDirty(false);
    setError(null);
  }, [annotation?.body, annotation?.updated_at]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= MAX_ANNOTATION_LENGTH) {
      setBody(value);
      setIsDirty(true);
      setError(null);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (isSaving || disabled) return;

    const trimmedBody = body.trim();
    setIsSaving(true);
    setError(null);

    try {
      if (trimmedBody === "") {
        // Empty body → delete annotation
        if (annotation) {
          await onDelete(highlightId);
        }
        setBody("");
      } else {
        // Save annotation
        await onSave(highlightId, trimmedBody);
      }
      setIsDirty(false);
    } catch (err) {
      setError("Failed to save annotation");
      console.error("Annotation save failed:", err);
      // Keep text intact in editor
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, disabled, body, annotation, highlightId, onDelete, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd+Enter or Ctrl+Enter to save
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave]
  );

  const handleClear = useCallback(async () => {
    if (isSaving || disabled) return;

    if (!annotation) {
      // No annotation to delete, just clear the textarea
      setBody("");
      setIsDirty(false);
      return;
    }

    const confirmed = window.confirm("Delete this annotation?");
    if (!confirmed) return;

    setIsSaving(true);
    setError(null);

    try {
      await onDelete(highlightId);
      setBody("");
      setIsDirty(false);
    } catch (err) {
      setError("Failed to delete annotation");
      console.error("Annotation delete failed:", err);
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, disabled, annotation, highlightId, onDelete]);

  const hasContent = body.trim().length > 0;
  const isNewAnnotation = !annotation;
  const showClearButton = annotation || body.length > 0;

  return (
    <div className={styles.editor}>
      <label className={styles.label}>
        {isNewAnnotation ? "Add Note" : "Note"}
      </label>
      
      {error && <div className={styles.error}>{error}</div>}

      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={body}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Add a note about this highlight..."
        disabled={disabled || isSaving}
        maxLength={MAX_ANNOTATION_LENGTH}
        rows={3}
      />

      <div className={styles.footer}>
        <span className={styles.charCount}>
          {body.length.toLocaleString()}/{MAX_ANNOTATION_LENGTH.toLocaleString()}
        </span>
        
        <div className={styles.actions}>
          {showClearButton && (
            <button
              type="button"
              className={styles.clearButton}
              onClick={handleClear}
              disabled={disabled || isSaving}
            >
              {annotation ? "Delete" : "Clear"}
            </button>
          )}
          
          <button
            type="button"
            className={styles.saveButton}
            onClick={handleSave}
            disabled={disabled || isSaving || !isDirty}
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className={styles.hint}>
        {hasContent && isDirty && (
          <span>Press <kbd>⌘</kbd>+<kbd>Enter</kbd> to save</span>
        )}
      </div>
    </div>
  );
}
