import {
  MessageSquarePlus,
  MessagesSquare,
  NotebookPen,
  Quote,
  TextSelect,
  Trash2,
} from "lucide-react";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
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
    onCite?: () => void;
    onQuoteToNewChat: () => void;
    onQuoteToExistingChat: () => void;
    onToggleEditBounds: () => void;
    onDelete: () => void;
  };
}): PaneHeaderAction[] {
  const isExisting = target.kind === "existing";
  const color = isExisting ? target.highlight.color : target.color;
  const canEdit = isExisting ? target.highlight.is_owner !== false : true;
  const hasQuoteText = isExisting ? target.highlight.exact.trim().length > 0 : true;

  const options: PaneHeaderAction[] = [];

  if (canEdit) {
    options.push({
      kind: "custom",
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
      kind: "command",
      id: "note",
      label: isExisting && target.highlight.linked_note_blocks?.length ? "Edit note" : "Add note",
      icon: <NotebookPen size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onAddNote,
    });
  }

  if (handlers.onCite) {
    // Cite mints a cross-document footnote (§4.5); available on both an existing
    // highlight and a bare selection (create-then-annotate, like the note verb).
    options.push({
      kind: "command",
      id: "cite",
      label: "Cite a passage…",
      icon: <Quote size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onCite,
    });
  }

  if (canQuoteToChat && hasQuoteText) {
    options.push({
      kind: "command",
      id: "quote-new",
      label: "Quote to new chat",
      icon: <MessageSquarePlus size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onQuoteToNewChat,
    });
    options.push({
      kind: "command",
      id: "quote-existing",
      label: "Quote to existing chat",
      icon: <MessagesSquare size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onQuoteToExistingChat,
    });
  }

  if (isExisting && canEdit && isReflowable) {
    options.push({
      kind: "command",
      id: "edit-bounds",
      label: state.isEditingBounds ? "Cancel edit bounds" : "Edit bounds",
      icon: <TextSelect size={14} aria-hidden="true" />,
      state: { kind: "toggle", pressed: state.isEditingBounds },
      onSelect: handlers.onToggleEditBounds,
    });
  }

  if (isExisting && canEdit) {
    options.push({
      kind: "command",
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
