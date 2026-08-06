import {
  BookOpenText,
  Highlighter,
  Link2,
  MessageCircleQuestion,
  MessagesSquare,
  NotebookPen,
  Share2,
} from "lucide-react";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type {
  ActionSelectDetail,
  PaneHeaderAction,
} from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import styles from "./selectionActions.module.css";

function HighlighterGlyph({ color }: { color: HighlightColor }) {
  return (
    <span className={styles.highlighterGlyph} aria-hidden="true">
      <Highlighter aria-hidden="true" />
      <span className={cx(styles.colorBar, styles[`dot-${color}`])} />
    </span>
  );
}

/**
 * Transient text-selection controls. A selection is not yet a resource, so this
 * local plan may create a Highlight and continue the initiating gesture. Once
 * materialized, every Highlight action comes from ResourceActionMenu instead.
 */
export function buildSelectionActions({
  color,
  canQuoteToChat,
  canAddNote,
  changingColor,
  handlers,
}: {
  readonly color: HighlightColor;
  readonly canQuoteToChat: boolean;
  readonly canAddNote: boolean;
  readonly changingColor: boolean;
  readonly handlers: {
    readonly onSelectColor: (color: HighlightColor) => void;
    readonly onAddNote?: () => void;
    readonly onLink?: () => void;
    readonly onShare?: (detail: ActionSelectDetail) => void;
    readonly onLearn?: () => void;
    readonly onQuoteToNewChat?: () => void;
    readonly onQuoteToExistingChat?: () => void;
  };
}): PaneHeaderAction[] {
  const options: PaneHeaderAction[] = [
    {
      kind: "custom",
      id: "color",
      label: "Highlight",
      icon: <HighlighterGlyph color={color} />,
      disabled: changingColor,
      render: ({ closeMenu }) => (
        <HighlightColorPicker
          selectedColor={color}
          disabled={changingColor}
          onSelectColor={(next) => {
            handlers.onSelectColor(next);
            closeMenu();
          }}
        />
      ),
    },
  ];

  if (canAddNote && handlers.onAddNote) {
    options.push({
      kind: "command",
      id: "note",
      label: "Note",
      icon: <NotebookPen size={14} aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onAddNote,
    });
  }
  if (handlers.onLink) {
    options.push({
      kind: "command",
      id: "link",
      label: "Link",
      icon: <Link2 size={14} aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onLink,
    });
  }
  if (handlers.onShare) {
    options.push({
      kind: "command",
      id: "share",
      label: "Share",
      icon: <Share2 size={14} aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onShare,
    });
  }
  if (handlers.onLearn) {
    options.push({
      kind: "command",
      id: "learn",
      label: "Learn",
      icon: <BookOpenText size={14} aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onLearn,
    });
  }
  if (
    canQuoteToChat &&
    handlers.onQuoteToNewChat &&
    handlers.onQuoteToExistingChat
  ) {
    options.push({
      kind: "command",
      id: "quote-new",
      label: "Ask",
      icon: <MessageCircleQuestion aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onQuoteToNewChat,
    });
    options.push({
      kind: "command",
      id: "quote-existing",
      label: "Ask in existing chat…",
      icon: <MessagesSquare size={14} aria-hidden="true" />,
      disabled: changingColor,
      onSelect: handlers.onQuoteToExistingChat,
    });
  }
  return options;
}

const DIRECT_ACTION_IDS = ["color", "note", "link", "quote-new"] as const;
const OVERFLOW_ACTION_IDS = ["learn", "quote-existing", "share"] as const;

export type SelectionActionPlan = Readonly<{
  direct: readonly PaneHeaderAction[];
  overflow: readonly PaneHeaderAction[];
}>;

export function projectSelectionActionPlan(
  actions: readonly PaneHeaderAction[],
): SelectionActionPlan {
  const byId = new Map<string, PaneHeaderAction>();
  for (const action of actions) {
    if (
      !DIRECT_ACTION_IDS.some((id) => id === action.id) &&
      !OVERFLOW_ACTION_IDS.some((id) => id === action.id)
    ) {
      throw new Error(`Unclassified fresh-selection action: ${action.id}`);
    }
    if (byId.has(action.id)) {
      throw new Error(`Duplicate fresh-selection action: ${action.id}`);
    }
    byId.set(action.id, action);
  }
  const tier = (ids: readonly string[]) =>
    ids.flatMap((id) => byId.get(id) ?? []);
  return { direct: tier(DIRECT_ACTION_IDS), overflow: tier(OVERFLOW_ACTION_IDS) };
}
