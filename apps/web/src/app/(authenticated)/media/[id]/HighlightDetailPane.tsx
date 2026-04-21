"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import { useToast } from "@/components/Toast";
import { COLOR_LABELS } from "@/lib/highlights/colors";
import { HIGHLIGHT_COLORS, type HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "./mediaHelpers";
import styles from "./HighlightDetailPane.module.css";

type DetailHighlight = Highlight | PdfHighlightOut;

interface HighlightDetailPaneProps {
  highlight: DetailHighlight | null;
  isEditingBounds: boolean;
  onShowInDocument: (highlightId: string) => void;
  onSendToChat: (highlightId: string) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onAnnotationSave: (highlightId: string, body: string) => Promise<void>;
  onAnnotationDelete: (highlightId: string) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
}

export default function HighlightDetailPane({
  highlight,
  isEditingBounds,
  onShowInDocument,
  onSendToChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  onAnnotationSave,
  onAnnotationDelete,
  onOpenConversation,
}: HighlightDetailPaneProps) {
  const { toast } = useToast();
  const [noteBody, setNoteBody] = useState(highlight?.annotation?.body ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [changingColor, setChangingColor] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setNoteBody(highlight?.annotation?.body ?? "");
    setSavingNote(false);
    setChangingColor(false);
    setDeleting(false);
  }, [highlight?.id, highlight?.annotation?.body, highlight?.updated_at]);

  const canEdit = highlight !== null && (!("is_owner" in highlight) || highlight.is_owner);
  const noteChanged = noteBody.trim() !== (highlight?.annotation?.body ?? "");

  const handleSaveNote = useCallback(async () => {
    if (!highlight || !canEdit || savingNote) {
      return;
    }

    const trimmed = noteBody.trim();
    if (trimmed === (highlight.annotation?.body ?? "")) {
      return;
    }

    setSavingNote(true);
    try {
      if (trimmed) {
        await onAnnotationSave(highlight.id, trimmed);
      } else {
        await onAnnotationDelete(highlight.id);
      }
    } catch (error) {
      toast({ variant: "error", message: "Failed to save note" });
      console.error("highlight_detail_note_save_failed", error);
    } finally {
      setSavingNote(false);
    }
  }, [
    canEdit,
    highlight,
    noteBody,
    onAnnotationDelete,
    onAnnotationSave,
    savingNote,
    toast,
  ]);

  const handleDelete = useCallback(async () => {
    if (!highlight || !canEdit || deleting) {
      return;
    }
    if (!window.confirm("Delete this highlight?")) {
      return;
    }

    setDeleting(true);
    try {
      await onDelete(highlight.id);
    } catch (error) {
      toast({ variant: "error", message: "Failed to delete highlight" });
      console.error("highlight_detail_delete_failed", error);
      setDeleting(false);
    }
  }, [canEdit, deleting, highlight, onDelete, toast]);

  const handleColorChange = useCallback(
    async (color: HighlightColor) => {
      if (!highlight || !canEdit || changingColor || highlight.color === color) {
        return;
      }

      setChangingColor(true);
      try {
        await onColorChange(highlight.id, color);
      } catch (error) {
        toast({ variant: "error", message: "Failed to change color" });
        console.error("highlight_detail_color_change_failed", error);
      } finally {
        setChangingColor(false);
      }
    },
    [canEdit, changingColor, highlight, onColorChange, toast]
  );

  if (!highlight) {
    return (
      <div className={styles.emptyState}>
        <p>Select a highlight to inspect it.</p>
      </div>
    );
  }

  return (
    <div className={styles.detailPane}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Highlight</h3>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => onShowInDocument(highlight.id)}
          >
            Show in document
          </button>
        </div>
        <div className={styles.quoteCard}>
          <HighlightSnippet
            prefix={highlight.prefix}
            exact={highlight.exact}
            suffix={highlight.suffix}
            color={highlight.color}
          />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Actions</h3>
        </div>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => onSendToChat(highlight.id)}
          >
            Send to chat
          </button>
          {canEdit ? (
            isEditingBounds ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onCancelEditBounds}
              >
                Cancel edit bounds
              </button>
            ) : (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onStartEditBounds}
              >
                Edit bounds
              </button>
            )
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className={styles.dangerButton}
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete highlight"}
            </button>
          ) : null}
        </div>
        {isEditingBounds ? (
          <p className={styles.editHint}>Select new text in the reader to replace this highlight.</p>
        ) : null}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Color</h3>
        </div>
        <div className={styles.colorRow}>
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`${styles.colorButton} ${styles[`color-${color}`]} ${
                highlight.color === color ? styles.colorButtonSelected : ""
              }`.trim()}
              aria-label={COLOR_LABELS[color]}
              aria-pressed={highlight.color === color}
              disabled={!canEdit || changingColor}
              onClick={() => void handleColorChange(color)}
            />
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Note</h3>
          {canEdit ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void handleSaveNote()}
              disabled={!noteChanged || savingNote}
            >
              {savingNote ? "Saving..." : "Save note"}
            </button>
          ) : null}
        </div>
        {canEdit ? (
          <textarea
            className={styles.noteTextarea}
            value={noteBody}
            onChange={(event) => setNoteBody(event.target.value)}
            placeholder="Add a note about this highlight..."
            rows={5}
            maxLength={10000}
            aria-label="Note"
          />
        ) : (
          <div className={styles.readOnlyNote}>
            {highlight.annotation?.body?.trim() || "No note."}
          </div>
        )}
      </section>

      {highlight.linked_conversations && highlight.linked_conversations.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Linked chats</h3>
          </div>
          <div className={styles.conversationList}>
            {highlight.linked_conversations.map((conversation) => (
              <button
                key={conversation.conversation_id}
                type="button"
                className={styles.conversationButton}
                onClick={() =>
                  onOpenConversation(conversation.conversation_id, conversation.title)
                }
              >
                <MessageSquare size={14} />
                <span>{conversation.title}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
