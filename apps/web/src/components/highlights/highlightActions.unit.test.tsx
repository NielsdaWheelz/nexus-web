import { describe, expect, it } from "vitest";
import { buildHighlightActions } from "./highlightActions";

const idleState = {
  isEditingBounds: false,
  deleting: false,
  changingColor: false,
};
const noop = () => {};

function selectionActions({
  canQuoteToChat = true,
  canAddNote = true,
  changingColor = false,
}: {
  canQuoteToChat?: boolean;
  canAddNote?: boolean;
  changingColor?: boolean;
} = {}) {
  return buildHighlightActions({
    target: { kind: "selection", color: "yellow" },
    canQuoteToChat,
    canAddNote,
    isReflowable: false,
    state: { ...idleState, changingColor },
    handlers: {
      onSelectColor: noop,
      onAddNote: canAddNote ? noop : undefined,
      onLink: noop,
      onShare: noop,
      onLearn: noop,
      onQuoteToNewChat: canQuoteToChat ? noop : undefined,
      onQuoteToExistingChat: canQuoteToChat ? noop : undefined,
      onToggleEditBounds: noop,
      onDelete: noop,
    },
  });
}

describe("fresh-selection action contract", () => {
  it("publishes the seven visible actions in canonical order and groups", () => {
    expect(
      selectionActions().map(({ id, label, separatorBefore }) => ({
        id,
        label,
        separatorBefore: separatorBefore ?? false,
      })),
    ).toEqual([
      { id: "color", label: "Colour", separatorBefore: false },
      { id: "note", label: "Note", separatorBefore: false },
      { id: "link", label: "Link", separatorBefore: false },
      {
        id: "ResourceAction.Share",
        label: "Share",
        separatorBefore: true,
      },
      { id: "learn", label: "Learn", separatorBefore: true },
      { id: "quote-new", label: "New chat", separatorBefore: false },
      {
        id: "quote-existing",
        label: "Existing chat",
        separatorBefore: false,
      },
    ]);
  });

  it("removes unavailable destinations without reordering survivors and disables creation races", () => {
    expect(
      selectionActions({ canQuoteToChat: false, canAddNote: false }).map(
        ({ id }) => id,
      ),
    ).toEqual(["color", "link", "ResourceAction.Share", "learn"]);
    expect(
      selectionActions({ changingColor: true }).map(({ disabled }) => disabled),
    ).toEqual([true, true, true, true, true, true, true]);
  });
});
