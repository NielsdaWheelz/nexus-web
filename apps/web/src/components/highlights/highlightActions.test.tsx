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
    const onLink = vi.fn();
    const actions = buildHighlightActions({
      target: { kind: "selection", color: "blue" },
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
    });
    expect(actions.find((action) => action.id === "link")?.label).toBe("Link");
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
    link?.onSelect?.({ triggerEl: null });
    expect(onLink).toHaveBeenCalledOnce();
  });
});

describe("buildHighlightActions — shared Share projection", () => {
  it("uses the catalog id, copy, and behavior", () => {
    const onShare = vi.fn();
    const share = buildHighlightActions({
      target: { kind: "existing", highlight: existingHighlight },
      canQuoteToChat: false,
      canAddNote: false,
      isReflowable: true,
      state: { isEditingBounds: false, deleting: false, changingColor: false },
      handlers: {
        onSelectColor: vi.fn(),
        onShare,
        onQuoteToNewChat: vi.fn(),
        onQuoteToExistingChat: vi.fn(),
        onToggleEditBounds: vi.fn(),
        onDelete: vi.fn(),
      },
    }).find((option) => option.id === "ResourceAction.Share");

    expect(share).toMatchObject({
      label: "Share…",
      restoreFocusOnClose: false,
    });
    share?.onSelect?.({ triggerEl: null });
    expect(onShare).toHaveBeenCalledOnce();
  });
});

describe("buildHighlightActions — Learn", () => {
  it("offers one Learn action for a quotable selection or saved Highlight", () => {
    const onLearn = vi.fn();
    for (const target of [
      { kind: "selection", color: "yellow" } as const,
      { kind: "existing", highlight: existingHighlight } as const,
    ]) {
      const learn = buildHighlightActions({
        target,
        canQuoteToChat: false,
        canAddNote: false,
        isReflowable: false,
        state: {
          isEditingBounds: false,
          deleting: false,
          changingColor: false,
        },
        handlers: {
          onSelectColor: vi.fn(),
          onLearn,
          onQuoteToNewChat: vi.fn(),
          onQuoteToExistingChat: vi.fn(),
          onToggleEditBounds: vi.fn(),
          onDelete: vi.fn(),
        },
      }).find((option) => option.id === "learn");
      expect(learn?.label).toBe("Learn");
      learn?.onSelect?.({ triggerEl: null });
    }
    expect(onLearn).toHaveBeenCalledTimes(2);
  });

  it("does not offer Learn for a geometry-only saved Highlight", () => {
    const actions = buildHighlightActions({
      target: {
        kind: "existing",
        highlight: { ...existingHighlight, exact: "   " },
      },
      canQuoteToChat: false,
      canAddNote: false,
      isReflowable: false,
      state: {
        isEditingBounds: false,
        deleting: false,
        changingColor: false,
      },
      handlers: {
        onSelectColor: vi.fn(),
        onLearn: vi.fn(),
        onQuoteToNewChat: vi.fn(),
        onQuoteToExistingChat: vi.fn(),
        onToggleEditBounds: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    expect(actions.map((action) => action.id)).not.toContain("learn");
  });
});
