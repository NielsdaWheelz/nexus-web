import { describe, expect, it } from "vitest";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import { buildHighlightActions } from "./highlightActions";

const noopHandlers = {
  onSelectColor: () => {},
  onQuoteToNewChat: () => {},
  onQuoteToExistingChat: () => {},
  onToggleEditBounds: () => {},
  onDelete: () => {},
};
const idleState = { isEditingBounds: false, deleting: false, changingColor: false };

function existing(overrides: Partial<AnchoredHighlightRow> = {}) {
  const highlight: AnchoredHighlightRow = { id: "h1", exact: "hello", color: "yellow", ...overrides };
  return { kind: "existing" as const, highlight };
}

function ids(args: Parameters<typeof buildHighlightActions>[0]) {
  return buildHighlightActions(args).map((option) => option.id);
}

describe("buildHighlightActions", () => {
  it("offers the full owner set on reflowable text", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: true, isReflowable: true, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "quote-new", "quote-existing", "edit-bounds", "delete"]);
  });

  it("drops edit-bounds on PDF (non-reflowable)", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: true, isReflowable: false, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "quote-new", "quote-existing", "delete"]);
  });

  it("shows only quotes for a non-owner", () => {
    expect(
      ids({
        target: existing({ is_owner: false }),
        canQuoteToChat: true,
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
        canQuoteToChat: true,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color", "edit-bounds", "delete"]);
  });

  it("gates quotes off when chat quoting is unavailable", () => {
    expect(
      ids({ target: existing(), canQuoteToChat: false, isReflowable: true, state: idleState, handlers: noopHandlers }),
    ).toEqual(["color", "edit-bounds", "delete"]);
  });

  it("marks delete as a danger action with a leading divider", () => {
    const del = buildHighlightActions({
      target: existing(),
      canQuoteToChat: true,
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
      canQuoteToChat: true,
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
        canQuoteToChat: true,
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
        canQuoteToChat: false,
        isReflowable: true,
        state: idleState,
        handlers: noopHandlers,
      }),
    ).toEqual(["color"]);
  });

  it("disables selection color and quote actions while the selection action is busy", () => {
    const actions = buildHighlightActions({
      target: { kind: "selection", color: "green" },
      canQuoteToChat: true,
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
