import { describe, expect, it } from "vitest";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { buildHighlightActions } from "./highlightActions";

const noopHandlers = {
  onSelectColor: () => {},
  onQuoteToNewChat: () => {},
  onQuoteToExistingChat: () => {},
  onToggleEditBounds: () => {},
  onDelete: () => {},
};
const idleState = { isEditingBounds: false, deleting: false, changingColor: false };

function existing(overrides: Partial<AnchoredReaderRow> = {}) {
  const highlight: AnchoredReaderRow = { id: "h1", exact: "hello", color: "yellow", ...overrides };
  return { kind: "existing" as const, highlight };
}

function ids(args: Parameters<typeof buildHighlightActions>[0]) {
  return buildHighlightActions(args).map((option) => option.id);
}

describe("buildHighlightActions", () => {
  it("offers the full owner set on reflowable text", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: true, canAddNote: false, isReflowable: true, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "quote-new", "quote-existing", "edit-bounds", "delete"]);
  });

  it("drops edit-bounds on PDF (non-reflowable)", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: true, canAddNote: false, isReflowable: false, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "quote-new", "quote-existing", "delete"]);
  });

  it("shows only quotes for a non-owner", () => {
    expect(
      ids({
        target: existing({ is_owner: false }),
        canQuoteToChat: true, canAddNote: false,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["quote-new", "quote-existing"]);
  });

  it("gates quotes off when the highlight has no quotable text", () => {
    expect(
      ids({
        target: existing({ exact: "   " }),
        canQuoteToChat: true, canAddNote: false,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color", "edit-bounds", "delete"]);
  });

  it("gates quotes off when chat quoting is unavailable", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: false, canAddNote: false, isReflowable: true, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "edit-bounds", "delete"]);
  });

  it("marks delete as a danger action with a leading divider", () => {
    const del = buildHighlightActions({
      target: existing(),
      canQuoteToChat: true, canAddNote: false,
      isReflowable: true,
      state: idleState,
      handlers: noopHandlers,
    }).find((option) => option.id === "delete");
    expect(del?.tone).toBe("danger");
    expect(del?.separatorBefore).toBe(true);
  });

  it("flips the edit-bounds label and pressed state while editing", () => {
    const editing = buildHighlightActions({
      target: existing(),
      canQuoteToChat: true, canAddNote: false,
      isReflowable: true,
      state: { ...idleState, isEditingBounds: true },
      handlers: noopHandlers,
    }).find((option) => option.id === "edit-bounds");
    expect(editing?.label).toBe("Cancel edit bounds");
    expect(editing?.pressed).toBe(true);
  });

  it("offers color plus quotes for a fresh selection, never edit/delete", () => {
    expect(
      ids({
        target: { kind: "selection", color: "green" },
        canQuoteToChat: true, canAddNote: false,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color", "quote-new", "quote-existing"]);
  });

  it("offers only color for a selection when chat quoting is unavailable", () => {
    expect(
      ids({
        target: { kind: "selection", color: "green" },
        canQuoteToChat: false, canAddNote: false,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color"]);
  });

  it("slots the note action directly after color when enabled", () => {
    expect(
      ids({
        target: existing(),
        canQuoteToChat: true, canAddNote: true,
        isReflowable: true,
        state: idleState,
        handlers: { ...noopHandlers, onAddNote: () => {} },
      }),
    ).toEqual(["color", "note", "quote-new", "quote-existing", "edit-bounds", "delete"]);
  });

  it("hides the note action when the flag is off or the handler is missing", () => {
    expect(
      ids({
        target: existing(),
        canQuoteToChat: false, canAddNote: false,
        isReflowable: false,
        state: idleState,
        handlers: { ...noopHandlers, onAddNote: () => {} },
      }),
    ).toEqual(["color", "delete"]);
    expect(
      ids({
        target: existing(),
        canQuoteToChat: false, canAddNote: true,
        isReflowable: false,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color", "delete"]);
  });

  it("labels the note action by whether a linked note exists", () => {
    const noteLabel = (overrides: Partial<AnchoredReaderRow>) =>
      buildHighlightActions({
        target: existing(overrides),
        canQuoteToChat: false, canAddNote: true,
        isReflowable: false,
        state: idleState,
        handlers: { ...noopHandlers, onAddNote: () => {} },
      }).find((option) => option.id === "note")?.label;
    expect(noteLabel({})).toBe("Add note");
    expect(noteLabel({ linked_note_blocks: [] })).toBe("Add note");
    expect(noteLabel({ linked_note_blocks: [{ note_block_id: "n1", body_text: "hi" }] })).toBe("Edit note");
  });

  it('labels the note action "Add note" for a fresh selection', () => {
    const actions = buildHighlightActions({
      target: { kind: "selection", color: "green" },
      canQuoteToChat: true, canAddNote: true,
      isReflowable: true,
      state: idleState,
      handlers: { ...noopHandlers, onAddNote: () => {} },
    });
    expect(actions.map((option) => option.id)).toEqual(["color", "note", "quote-new", "quote-existing"]);
    expect(actions.find((option) => option.id === "note")?.label).toBe("Add note");
  });

  it("disables selection color and quote actions while the selection action is busy", () => {
    const actions = buildHighlightActions({
      target: { kind: "selection", color: "green" },
      canQuoteToChat: true, canAddNote: false,
      isReflowable: true,
      state: { ...idleState, changingColor: true },
      handlers: noopHandlers,
    });

    expect(actions.map((option) => [option.id, option.disabled])).toEqual([
      ["color", true],
      ["quote-new", true],
      ["quote-existing", true],
    ]);
  });
});
