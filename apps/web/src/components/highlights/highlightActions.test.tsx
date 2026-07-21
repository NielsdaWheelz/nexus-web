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

function optionIds(target: HighlightActionTarget, onLink?: () => void): string[] {
  return buildHighlightActions({
    target,
    canQuoteToChat: true,
    canAddNote: true,
    isReflowable: true,
    state: { isEditingBounds: false, deleting: false, changingColor: false },
    handlers: {
      onSelectColor: vi.fn(),
      onAddNote: vi.fn(),
      onLink,
      onQuoteToNewChat: vi.fn(),
      onQuoteToExistingChat: vi.fn(),
      onToggleEditBounds: vi.fn(),
      onDelete: vi.fn(),
    },
  }).map((option) => option.id);
}

describe("buildHighlightActions — Link verb", () => {
  it("offers Link on an existing highlight when onLink is provided", () => {
    expect(optionIds({ kind: "existing", highlight: existingHighlight }, vi.fn())).toContain("link");
  });

  it("offers Link on a bare selection when onLink is provided", () => {
    expect(optionIds({ kind: "selection", color: "blue" }, vi.fn())).toContain("link");
  });

  it("omits Link when no onLink handler is wired", () => {
    expect(optionIds({ kind: "existing", highlight: existingHighlight })).not.toContain("link");
  });

  it("invokes the onLink handler when the Link option is selected", () => {
    const onLink = vi.fn();
    const link = buildHighlightActions({
      target: { kind: "existing", highlight: existingHighlight },
      canQuoteToChat: true,
      canAddNote: true,
      isReflowable: true,
      state: { isEditingBounds: false, deleting: false, changingColor: false },
      handlers: {
        onSelectColor: vi.fn(),
        onAddNote: vi.fn(),
        onLink,
        onQuoteToNewChat: vi.fn(),
        onQuoteToExistingChat: vi.fn(),
        onToggleEditBounds: vi.fn(),
        onDelete: vi.fn(),
      },
    }).find((option) => option.id === "link");
    link?.onSelect?.();
    expect(onLink).toHaveBeenCalledOnce();
  });
});
