import { MessageSquarePlus, MessagesSquare, NotebookPen, TextSelect, Trash2 } from "lucide-react";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { cx } from "@/lib/ui/cx";
import styles from "./highlightActions.module.css";

export type HighlightActionTarget =
  | { kind: "existing"; highlight: AnchoredReaderRow }
  | { kind: "selection"; color: HighlightColor };

function ColorDot({ color }: { color: HighlightColor }) {
  return <span className={cx(styles.dot, styles[`dot-${color}`])} aria-hidden="true" />;
}

/**
 * The single source of truth for highlight actions: which exist, their icons,
 * order, tone, toggled state, and gating. Pure — given the same target, flags,
 * state, and handlers it returns the same descriptors. Rendered by ActionBar in
 * the sidecar card, the reader-text click popover, and the selection popover.
 *
 * `selection` targets have no highlight yet: only color (which creates), note
 * (create-then-annotate), and the quotes (create-then-quote); never edit-bounds
 * or delete.
 */
export function buildHighlightActions({
  target,
  canQuoteToChat,
  canAddNote,
  isReflowable,
  state,
  handlers,
}: {
  target: HighlightActionTarget;
  canQuoteToChat: boolean;
  canAddNote: boolean;
  isReflowable: boolean;
  state: { isEditingBounds: boolean; deleting: boolean; changingColor: boolean };
  handlers: {
    onSelectColor: (color: HighlightColor) => void;
    onAddNote?: () => void;
    onQuoteToNewChat: () => void;
    onQuoteToExistingChat: () => void;
    onToggleEditBounds: () => void;
    onDelete: () => void;
  };
}): ActionMenuOption[] {
  const isExisting = target.kind === "existing";
  const color = isExisting ? target.highlight.color : target.color;
  const canEdit = isExisting ? target.highlight.is_owner !== false : true;
  const hasQuoteText = isExisting ? target.highlight.exact.trim().length > 0 : true;

  const options: ActionMenuOption[] = [];

  if (canEdit) {
    options.push({
      id: "color",
      label: "Highlight color",
      icon: <ColorDot color={color} />,
      disabled: state.changingColor,
      render: ({ closeMenu }) => (
        <HighlightColorPicker
          selectedColor={color}
          disabled={state.changingColor}
          disabledColors={isExisting ? [color] : []}
          onSelectColor={(next) => {
            handlers.onSelectColor(next);
            closeMenu();
          }}
        />
      ),
    });
  }

  if (canAddNote && handlers.onAddNote) {
    options.push({
      id: "note",
      label: isExisting && target.highlight.linked_note_blocks?.length ? "Edit note" : "Add note",
      icon: <NotebookPen size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onAddNote,
    });
  }

  if (canQuoteToChat && hasQuoteText) {
    options.push({
      id: "quote-new",
      label: "Quote to new chat",
      icon: <MessageSquarePlus size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onQuoteToNewChat,
    });
    options.push({
      id: "quote-existing",
      label: "Quote to existing chat",
      icon: <MessagesSquare size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onQuoteToExistingChat,
    });
  }

  if (isExisting && canEdit && isReflowable) {
    options.push({
      id: "edit-bounds",
      label: state.isEditingBounds ? "Cancel edit bounds" : "Edit bounds",
      icon: <TextSelect size={14} aria-hidden="true" />,
      pressed: state.isEditingBounds,
      onSelect: handlers.onToggleEditBounds,
    });
  }

  if (isExisting && canEdit) {
    options.push({
      id: "delete",
      label: "Delete highlight",
      icon: <Trash2 size={14} aria-hidden="true" />,
      tone: "danger",
      separatorBefore: true,
      disabled: state.deleting,
      onSelect: handlers.onDelete,
    });
  }

  return options;
}
