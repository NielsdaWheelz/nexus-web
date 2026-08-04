import {
  BookOpenText,
  Highlighter,
  Link2,
  MessageCircleQuestion,
  MessageSquarePlus,
  MessagesSquare,
  NotebookPen,
  TextSelect,
  Trash2,
} from "lucide-react";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { projectResourceActionToHeader } from "@/lib/actions/resourceActions";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type {
  ActionSelectDetail,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import styles from "./highlightActions.module.css";

export type HighlightActionTarget =
  | { kind: "existing"; highlight: AnchoredReaderRow }
  | { kind: "selection"; color: HighlightColor };

function ColorDot({ color }: { color: HighlightColor }) {
  return <span className={cx(styles.dot, styles[`dot-${color}`])} aria-hidden="true" />;
}

/**
 * The fresh-selection Highlight glyph. The Highlighter identifies the action on
 * its own; the bar underneath reports which ink the next swatch press lays down,
 * because colour configures Highlight rather than standing beside it.
 */
function HighlighterGlyph({ color }: { color: HighlightColor }) {
  return (
    <span className={styles.highlighterGlyph} aria-hidden="true">
      <Highlighter aria-hidden="true" />
      <span className={cx(styles.colorBar, styles[`dot-${color}`])} />
    </span>
  );
}

/**
 * The single source of truth for highlight actions: which exist, their icons,
 * order, tone, toggled state, and gating. Pure — given the same target, flags,
 * state, and handlers it returns the same descriptors. Existing Highlights are
 * rendered by ActionBar/ActionMenu; fresh selections are partitioned by
 * {@link projectSelectionActionPlan} and rendered by SelectionActionDock.
 *
 * `selection` targets have no highlight yet. Their descriptors expose the
 * complete fresh-selection action set; edit-bounds and delete remain
 * existing-highlight actions only.
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
    onLink?: () => void;
    onShare?: (detail: ActionSelectDetail) => void;
    onLearn?: () => void;
    onQuoteToNewChat?: () => void;
    onQuoteToExistingChat?: () => void;
    onToggleEditBounds: () => void;
    onDelete: () => void;
  };
}): PaneHeaderAction[] {
  const isExisting = target.kind === "existing";
  const color = isExisting ? target.highlight.color : target.color;
  const canEdit = isExisting ? target.highlight.is_owner !== false : true;
  const hasQuoteText = isExisting ? target.highlight.exact.trim().length > 0 : true;
  const quoteToNewChat = handlers.onQuoteToNewChat;
  const quoteToExistingChat = handlers.onQuoteToExistingChat;

  const options: PaneHeaderAction[] = [];

  if (canEdit) {
    options.push({
      kind: "custom",
      id: "color",
      label: isExisting ? "Highlight color" : "Highlight",
      icon: isExisting ? (
        <ColorDot color={color} />
      ) : (
        <HighlighterGlyph color={color} />
      ),
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
      label: isExisting ? (target.highlight.linked_note_blocks?.length ? "Edit note" : "Add note") : "Note",
      icon: <NotebookPen size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onAddNote,
    });
  }

  if (handlers.onLink) {
    // Link opens the universal target search (§ Reader); available on both an
    // existing highlight and a bare selection (a fresh selection materializes as
    // a Highlight only when the Link is confirmed, invariant 6).
    options.push({
      kind: "command",
      id: "link",
      label: isExisting ? "Link…" : "Link",
      icon: <Link2 size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onLink,
    });
  }

  if (canEdit && handlers.onShare) {
    const share = projectResourceActionToHeader({
      kind: "command",
      catalogKey: "Share",
      busy: !isExisting && state.changingColor,
      disabledReason: "Creating highlight",
      onSelect: handlers.onShare,
    });
    options.push(isExisting ? share : { ...share, label: "Share" });
  }

  if (hasQuoteText && handlers.onLearn) {
    options.push({
      kind: "command",
      id: "learn",
      label: "Learn",
      icon: <BookOpenText size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: handlers.onLearn,
    });
  }

  if (canQuoteToChat && hasQuoteText && quoteToNewChat && quoteToExistingChat) {
    options.push({
      kind: "command",
      id: "quote-new",
      label: isExisting ? "Ask in new chat" : "Ask",
      icon: isExisting ? (
        <MessageSquarePlus size={14} aria-hidden="true" />
      ) : (
        <MessageCircleQuestion aria-hidden="true" />
      ),
      disabled: !isExisting && state.changingColor,
      onSelect: quoteToNewChat,
    });
    options.push({
      kind: "command",
      id: "quote-existing",
      label: "Ask in existing chat…",
      icon: <MessagesSquare size={14} aria-hidden="true" />,
      disabled: !isExisting && state.changingColor,
      onSelect: quoteToExistingChat,
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

/** Semantic order of the fresh-selection toolbar: mark, interpret, connect, interrogate. */
const DIRECT_ACTION_IDS = ["color", "note", "link", "quote-new"] as const;
const OVERFLOW_ACTION_IDS = [
  "learn",
  "quote-existing",
  "ResourceAction.Share",
] as const;

export type SelectionActionPlan = Readonly<{
  direct: readonly PaneHeaderAction[];
  overflow: readonly PaneHeaderAction[];
}>;

/**
 * Partitions the fresh-selection catalog into the icon row and the overflow
 * menu. Order is the fixed id data above, never the catalog's emission order,
 * so capability decides presence and never priority. Never called for an
 * existing-Highlight target.
 */
export function projectSelectionActionPlan(
  actions: readonly PaneHeaderAction[],
): SelectionActionPlan {
  const byId = new Map<string, PaneHeaderAction>();
  for (const action of actions) {
    if (
      !DIRECT_ACTION_IDS.some((id) => id === action.id) &&
      !OVERFLOW_ACTION_IDS.some((id) => id === action.id)
    ) {
      // justify-defect: the catalog gained a fresh-selection action this
      // projection does not classify. A fallback tier would ship an unreviewed
      // slot with no owner for its order, label, or glyph.
      throw new Error(`Unclassified fresh-selection action: ${action.id}`);
    }
    if (byId.has(action.id)) {
      // justify-defect: one id names exactly one descriptor. De-duplicating
      // here would hide a catalog that emitted the same action twice.
      throw new Error(`Duplicate fresh-selection action: ${action.id}`);
    }
    byId.set(action.id, action);
  }
  const tier = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
  return { direct: tier(DIRECT_ACTION_IDS), overflow: tier(OVERFLOW_ACTION_IDS) };
}
