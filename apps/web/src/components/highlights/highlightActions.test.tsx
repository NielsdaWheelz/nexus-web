import { describe, expect, it, vi } from "vitest";
import { buildHighlightActions, type HighlightActionTarget } from "./highlightActions";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";

// buildHighlightActions is a pure descriptor builder; a `.test.tsx` file so the
// JSX icons in the descriptors type-check. No DOM render needed.

const existingHighlight: AnchoredReaderRow = {
  id: "h1",
  exact: "a quoted line",
  color: "yellow",
  anchor: { fragment_id: "frag", start_offset: 0, end_offset: 10 },
};

function optionIds(target: HighlightActionTarget, onCite?: () => void): string[] {
  return buildHighlightActions({
    target,
    canQuoteToChat: true,
    canAddNote: true,
    isReflowable: true,
    state: { isEditingBounds: false, deleting: false, changingColor: false },
    handlers: {
      onSelectColor: vi.fn(),
      onAddNote: vi.fn(),
      onCite,
      onQuoteToNewChat: vi.fn(),
      onQuoteToExistingChat: vi.fn(),
      onToggleEditBounds: vi.fn(),
      onDelete: vi.fn(),
    },
  }).map((option) => option.id);
}

describe("buildHighlightActions — Cite verb", () => {
  it("offers Cite on an existing highlight when onCite is provided", () => {
    expect(optionIds({ kind: "existing", highlight: existingHighlight }, vi.fn())).toContain("cite");
  });

  it("offers Cite on a bare selection when onCite is provided", () => {
    expect(optionIds({ kind: "selection", color: "blue" }, vi.fn())).toContain("cite");
  });

  it("omits Cite when no onCite handler is wired", () => {
    expect(optionIds({ kind: "existing", highlight: existingHighlight })).not.toContain("cite");
  });

  it("invokes the onCite handler when the Cite option is selected", () => {
    const onCite = vi.fn();
    const cite = buildHighlightActions({
      target: { kind: "existing", highlight: existingHighlight },
      canQuoteToChat: true,
      canAddNote: true,
      isReflowable: true,
      state: { isEditingBounds: false, deleting: false, changingColor: false },
      handlers: {
        onSelectColor: vi.fn(),
        onAddNote: vi.fn(),
        onCite,
        onQuoteToNewChat: vi.fn(),
        onQuoteToExistingChat: vi.fn(),
        onToggleEditBounds: vi.fn(),
        onDelete: vi.fn(),
      },
    }).find((option) => option.id === "cite");
    cite?.onSelect?.();
    expect(onCite).toHaveBeenCalledOnce();
  });
});
