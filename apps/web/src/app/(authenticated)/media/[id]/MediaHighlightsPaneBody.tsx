"use client";

import { useCallback, useMemo, useState } from "react";
import { MessageSquare, NotebookPen } from "lucide-react";
import {
  toFeedback,
  useFeedback,
} from "@/components/feedback/Feedback";
import HighlightNoteEditor, {
  highlightNoteBodyHasContent,
} from "@/components/notes/HighlightNoteEditor";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu, { type ActionMenuOption } from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { COLOR_LABELS } from "@/lib/highlights/colors";
import {
  HIGHLIGHT_COLORS,
  type HighlightColor,
} from "@/lib/highlights/segmenter";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "./mediaHighlights";
import {
  sortContextualFragmentHighlights,
  sortContextualPdfHighlights,
} from "./mediaHighlightOrdering";
import Pill from "@/components/ui/Pill";
import styles from "./MediaHighlightsPaneBody.module.css";

interface MediaHighlightsPaneBodyProps {
  isPdf: boolean;
  isEpub: boolean;
  fragmentHighlights: Highlight[];
  pdfPageHighlights: PdfHighlightOut[];
  pdfActivePage: number;
  focusedId: string | null;
  onFocusHighlight: (id: string | null) => void;
  canSendToChat: boolean;
  onSendToChat: (id: string) => void;
  onColorChange: (id: string, color: HighlightColor) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  isEditingBounds: boolean;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
  ) => Promise<void>;
  onNoteDelete: (noteBlockId: string) => Promise<void>;
  onOpenConversation: (conversationId: string, title: string) => void;
  onJumpToHighlight?: (highlightId: string) => void;
}

interface DisplayHighlight {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  is_owner: boolean;
  linked_note_blocks?: {
    note_block_id: string;
    body_pm_json?: Record<string, unknown>;
    body_markdown?: string;
    body_text: string;
  }[];
  linked_conversations?: { conversation_id: string; title: string }[];
}

function linkedNoteHasContent(note: {
  body_pm_json?: Record<string, unknown>;
  body_markdown?: string;
  body_text: string;
}): boolean {
  if (note.body_markdown?.trim()) {
    return true;
  }
  return highlightNoteBodyHasContent({
    bodyText: note.body_text,
    bodyPmJson: note.body_pm_json ?? { type: "paragraph" },
  });
}

function toDisplayHighlight(
  source: Highlight | PdfHighlightOut,
): DisplayHighlight {
  return {
    id: source.id,
    exact: source.exact,
    prefix: source.prefix,
    suffix: source.suffix,
    color: source.color,
    is_owner: source.is_owner,
    linked_note_blocks: source.linked_note_blocks,
    linked_conversations: source.linked_conversations,
  };
}

export default function MediaHighlightsPaneBody({
  isPdf,
  isEpub,
  fragmentHighlights,
  pdfPageHighlights,
  pdfActivePage,
  focusedId,
  onFocusHighlight,
  canSendToChat,
  onSendToChat,
  onColorChange,
  onDelete,
  onStartEditBounds,
  onCancelEditBounds,
  isEditingBounds,
  onNoteSave,
  onNoteDelete,
  onOpenConversation,
  onJumpToHighlight,
}: MediaHighlightsPaneBodyProps) {
  const feedback = useFeedback();
  const [changingColor, setChangingColor] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const orderedHighlights = useMemo<DisplayHighlight[]>(() => {
    if (isPdf) {
      return sortContextualPdfHighlights(pdfPageHighlights).map(
        toDisplayHighlight,
      );
    }
    return sortContextualFragmentHighlights(fragmentHighlights).map(
      toDisplayHighlight,
    );
  }, [fragmentHighlights, isPdf, pdfPageHighlights]);

  const handleRowClick = useCallback(
    (highlightId: string) => {
      onFocusHighlight(highlightId);
      onJumpToHighlight?.(highlightId);
    },
    [onFocusHighlight, onJumpToHighlight],
  );

  const handleDelete = useCallback(
    async (highlight: DisplayHighlight) => {
      if (highlight.is_owner === false || deleting) return;
      if (!window.confirm("Delete this highlight?")) return;
      setDeleting(true);
      try {
        await onDelete(highlight.id);
      } catch (error) {
        feedback.show(
          toFeedback(error, { fallback: "Failed to delete highlight" }),
        );
        console.error("highlights_inspector_delete_failed", error);
      } finally {
        setDeleting(false);
      }
    },
    [deleting, feedback, onDelete],
  );

  const handleColorChange = useCallback(
    async (highlight: DisplayHighlight, color: HighlightColor) => {
      if (
        highlight.is_owner === false ||
        changingColor ||
        highlight.color === color
      ) {
        return;
      }
      setChangingColor(true);
      try {
        await onColorChange(highlight.id, color);
      } catch (error) {
        feedback.show(
          toFeedback(error, { fallback: "Failed to change color" }),
        );
        console.error("highlights_inspector_color_change_failed", error);
      } finally {
        setChangingColor(false);
      }
    },
    [changingColor, feedback, onColorChange],
  );

  const paneTitle = "Highlights";
  const paneDescription = isPdf
    ? "Highlights for the active page."
    : isEpub
      ? "Highlights in the active section."
      : "Highlights in this document.";

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h3 className={styles.heading}>{paneTitle}</h3>
          <p className={styles.description}>{paneDescription}</p>
        </div>
        {isPdf ? (
          <div className={styles.pdfPagePill}>
            <Pill tone="info">Page {pdfActivePage}</Pill>
          </div>
        ) : null}
      </header>

      {orderedHighlights.length === 0 ? (
        <p className={styles.empty}>No highlights yet.</p>
      ) : (
        <ul className={styles.list}>
          {orderedHighlights.map((highlight) => {
            const isFocused = focusedId === highlight.id;
            const canEdit = highlight.is_owner !== false;
            const linkedNotes = highlight.linked_note_blocks ?? [];
            const notesToRender = linkedNotes.length > 0 ? linkedNotes : [null];
            const hasNote = linkedNotes.some(linkedNoteHasContent);
            const linkedConversationCount =
              highlight.linked_conversations?.length ?? 0;
            const menuOptions: ActionMenuOption[] = [];
            if (isFocused && canEdit) {
              menuOptions.push({
                id: isEditingBounds ? "cancel-edit-bounds" : "edit-bounds",
                label: isEditingBounds ? "Cancel edit bounds" : "Edit bounds",
                onSelect: () => {
                  if (isEditingBounds) {
                    onCancelEditBounds();
                    return;
                  }
                  onStartEditBounds();
                },
              });
              for (const color of HIGHLIGHT_COLORS) {
                menuOptions.push({
                  id: `color-${color}`,
                  label:
                    highlight.color === color
                      ? `Color: ${COLOR_LABELS[color]} (current)`
                      : `Color: ${COLOR_LABELS[color]}`,
                  disabled: changingColor || highlight.color === color,
                  onSelect: () => {
                    void handleColorChange(highlight, color);
                  },
                });
              }
              menuOptions.push({
                id: "delete-highlight",
                label: deleting ? "Deleting..." : "Delete highlight",
                tone: "danger",
                disabled: deleting,
                onSelect: () => {
                  void handleDelete(highlight);
                },
              });
            }
            return (
              <li
                key={highlight.id}
                className={`${styles.row} ${isFocused ? styles.rowFocused : ""}`.trim()}
                data-highlight-id={highlight.id}
                data-testid={`highlights-inspector-row-${highlight.id}`}
              >
                <div className={styles.rowTop}>
                  <Button
                    variant="ghost"
                    className={styles.rowPreviewButton}
                    onClick={() => handleRowClick(highlight.id)}
                    aria-pressed={isFocused}
                    aria-expanded={isFocused}
                  >
                    <span
                      className={`${styles.colorSwatch} ${styles[`swatch-${highlight.color}`]}`}
                      aria-hidden="true"
                    />
                    <HighlightSnippet
                      exact={highlight.exact}
                      color={highlight.color}
                      compact
                      className={styles.previewText}
                    />
                    <span className={styles.rowMeta} aria-hidden="true">
                      {hasNote ? (
                        <span className={styles.metaBadge} title="Has note">
                          <NotebookPen size={12} />
                        </span>
                      ) : null}
                      {linkedConversationCount > 0 ? (
                        <span
                          className={styles.metaBadge}
                          title={`${linkedConversationCount} linked chats`}
                        >
                          <MessageSquare size={12} />
                          <span>{linkedConversationCount}</span>
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  {isFocused ? (
                    <div className={styles.rowActions}>
                      {canSendToChat ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          iconOnly
                          aria-label="Ask in chat"
                          onClick={() => onSendToChat(highlight.id)}
                        >
                          <MessageSquare size={14} aria-hidden="true" />
                        </Button>
                      ) : null}
                      {menuOptions.length > 0 ? (
                        <ActionMenu options={menuOptions} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {isFocused ? (
                  <div className={styles.rowExpanded}>
                    <div className={styles.quoteCard}>
                      <HighlightSnippet
                        prefix={highlight.prefix}
                        exact={highlight.exact}
                        suffix={highlight.suffix}
                        color={highlight.color}
                      />
                    </div>
                    {isEditingBounds ? (
                      <p className={styles.editHint}>
                        Select new text in the reader to replace this highlight.
                      </p>
                    ) : null}
                    {notesToRender.length > 0 ? (
                      <div className={styles.noteEditorList}>
                        {notesToRender.map((note, index) => (
                          <div
                            key={
                              note?.note_block_id ??
                              `new-note-${highlight.id}-${index}`
                            }
                            className={styles.noteEditor}
                          >
                            <HighlightNoteEditor
                              highlightId={highlight.id}
                              note={note}
                              editable={true}
                              onSave={onNoteSave}
                              onDelete={onNoteDelete}
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {highlight.linked_conversations &&
                    highlight.linked_conversations.length > 0 ? (
                      <div className={styles.conversationList}>
                        {highlight.linked_conversations.map((conversation) => (
                          <Button
                            key={conversation.conversation_id}
                            variant="secondary"
                            size="md"
                            className={styles.conversationButton}
                            onClick={() =>
                              onOpenConversation(
                                conversation.conversation_id,
                                conversation.title,
                              )
                            }
                            leadingIcon={<MessageSquare size={14} />}
                          >
                            <span>{conversation.title}</span>
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
