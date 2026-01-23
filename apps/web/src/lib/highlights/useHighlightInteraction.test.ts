/**
 * Tests for useHighlightInteraction hook.
 *
 * Tests verify:
 * - Focus state management
 * - Overlap cycling behavior
 * - Segment identity tracking
 * - Focus persistence after refetch
 * - Edit bounds mode
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §9
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useHighlightInteraction,
  parseHighlightElement,
  findHighlightElement,
  applyFocusClass,
  reconcileFocusAfterRefetch,
  type HighlightClickData,
} from "./useHighlightInteraction";

// =============================================================================
// Helper Functions
// =============================================================================

function createMockElement(highlightIds: string[], topmostId?: string): Element {
  const el = document.createElement("span");
  el.setAttribute("data-highlight-ids", highlightIds.join(","));
  el.setAttribute("data-highlight-top", topmostId || highlightIds[0]);
  return el;
}

function createClickData(
  highlightIds: string[],
  topmostId?: string
): HighlightClickData {
  return {
    highlightIds,
    topmostId: topmostId || highlightIds[0],
    element: createMockElement(highlightIds, topmostId),
  };
}

// =============================================================================
// useHighlightInteraction Tests
// =============================================================================

describe("useHighlightInteraction", () => {
  describe("initial state", () => {
    it("starts with no focus", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      expect(result.current.focusState.focusedId).toBeNull();
      expect(result.current.focusState.editingBounds).toBe(false);
    });
  });

  describe("focusHighlight", () => {
    it("focuses a highlight by ID", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });

      expect(result.current.focusState.focusedId).toBe("h1");
    });

    it("calls onFocusChange callback", () => {
      const onFocusChange = vi.fn();
      const { result } = renderHook(() =>
        useHighlightInteraction(onFocusChange)
      );

      act(() => {
        result.current.focusHighlight("h1");
      });

      expect(onFocusChange).toHaveBeenCalledWith("h1");
    });

    it("clears focus when called with null", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });
      act(() => {
        result.current.focusHighlight(null);
      });

      expect(result.current.focusState.focusedId).toBeNull();
    });
  });

  describe("clearFocus", () => {
    it("clears the focused highlight", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });
      act(() => {
        result.current.clearFocus();
      });

      expect(result.current.focusState.focusedId).toBeNull();
    });

    it("exits edit bounds mode", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
        result.current.startEditBounds();
      });
      act(() => {
        result.current.clearFocus();
      });

      expect(result.current.focusState.editingBounds).toBe(false);
    });
  });

  describe("handleHighlightClick", () => {
    it("focuses topmost highlight on first click", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      const clickData = createClickData(["h1", "h2", "h3"], "h1");

      act(() => {
        result.current.handleHighlightClick(clickData);
      });

      expect(result.current.focusState.focusedId).toBe("h1");
    });

    it("cycles through highlights on same segment", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      const element = createMockElement(["h1", "h2", "h3"], "h1");
      const clickData: HighlightClickData = {
        highlightIds: ["h1", "h2", "h3"],
        topmostId: "h1",
        element,
      };

      // First click - focus h1 (topmost)
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h1");

      // Second click - cycle to h2
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h2");

      // Third click - cycle to h3
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h3");

      // Fourth click - wrap back to h1
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h1");
    });

    it("resets cycling on different segment", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      // Click segment 1
      const segment1Element = createMockElement(["h1", "h2"], "h1");
      const segment1: HighlightClickData = {
        highlightIds: ["h1", "h2"],
        topmostId: "h1",
        element: segment1Element,
      };

      act(() => {
        result.current.handleHighlightClick(segment1);
      });
      expect(result.current.focusState.focusedId).toBe("h1");

      // Cycle to h2
      act(() => {
        result.current.handleHighlightClick(segment1);
      });
      expect(result.current.focusState.focusedId).toBe("h2");

      // Click different segment
      const segment2Element = createMockElement(["h3", "h4"], "h3");
      const segment2: HighlightClickData = {
        highlightIds: ["h3", "h4"],
        topmostId: "h3",
        element: segment2Element,
      };

      act(() => {
        result.current.handleHighlightClick(segment2);
      });
      expect(result.current.focusState.focusedId).toBe("h3");

      // Click segment 1 again - should reset to h1, not continue from h2
      act(() => {
        result.current.handleHighlightClick(segment1);
      });
      expect(result.current.focusState.focusedId).toBe("h1");
    });

    it("handles single highlight segment (no cycling)", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      const element = createMockElement(["h1"], "h1");
      const clickData: HighlightClickData = {
        highlightIds: ["h1"],
        topmostId: "h1",
        element,
      };

      // First click
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h1");

      // Second click - stays on h1
      act(() => {
        result.current.handleHighlightClick(clickData);
      });
      expect(result.current.focusState.focusedId).toBe("h1");
    });

    it("clears focus on empty highlight list", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });

      const emptyClick: HighlightClickData = {
        highlightIds: [],
        topmostId: "",
        element: document.createElement("span"),
      };

      act(() => {
        result.current.handleHighlightClick(emptyClick);
      });

      expect(result.current.focusState.focusedId).toBeNull();
    });
  });

  describe("edit bounds mode", () => {
    it("enters edit bounds mode when focused", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });
      act(() => {
        result.current.startEditBounds();
      });

      expect(result.current.focusState.editingBounds).toBe(true);
    });

    it("does not enter edit bounds mode when not focused", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.startEditBounds();
      });

      expect(result.current.focusState.editingBounds).toBe(false);
    });

    it("cancels edit bounds mode", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
        result.current.startEditBounds();
      });
      act(() => {
        result.current.cancelEditBounds();
      });

      expect(result.current.focusState.editingBounds).toBe(false);
      // Focus is preserved
      expect(result.current.focusState.focusedId).toBe("h1");
    });
  });

  describe("isHighlightFocused", () => {
    it("returns true for focused highlight", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      act(() => {
        result.current.focusHighlight("h1");
      });

      expect(result.current.isHighlightFocused("h1")).toBe(true);
      expect(result.current.isHighlightFocused("h2")).toBe(false);
    });

    it("returns false when nothing focused", () => {
      const { result } = renderHook(() => useHighlightInteraction());

      expect(result.current.isHighlightFocused("h1")).toBe(false);
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe("parseHighlightElement", () => {
  it("parses valid highlight element", () => {
    const el = createMockElement(["h1", "h2"], "h1");
    const result = parseHighlightElement(el);

    expect(result).not.toBeNull();
    expect(result!.highlightIds).toEqual(["h1", "h2"]);
    expect(result!.topmostId).toBe("h1");
    expect(result!.element).toBe(el);
  });

  it("returns null for element without data-highlight-ids", () => {
    const el = document.createElement("span");
    const result = parseHighlightElement(el);

    expect(result).toBeNull();
  });

  it("returns null for empty highlight ids", () => {
    const el = document.createElement("span");
    el.setAttribute("data-highlight-ids", "");
    const result = parseHighlightElement(el);

    expect(result).toBeNull();
  });

  it("uses first highlight as topmost if data-highlight-top missing", () => {
    const el = document.createElement("span");
    el.setAttribute("data-highlight-ids", "h1,h2,h3");
    const result = parseHighlightElement(el);

    expect(result!.topmostId).toBe("h1");
  });
});

describe("findHighlightElement", () => {
  it("finds ancestor with highlight data", () => {
    const container = document.createElement("div");
    const highlight = document.createElement("span");
    highlight.setAttribute("data-highlight-ids", "h1");
    const inner = document.createElement("em");
    highlight.appendChild(inner);
    container.appendChild(highlight);

    const result = findHighlightElement(inner);

    expect(result).toBe(highlight);
  });

  it("returns element itself if it has highlight data", () => {
    const el = createMockElement(["h1"]);
    const result = findHighlightElement(el);

    expect(result).toBe(el);
  });

  it("returns null if no highlight ancestor", () => {
    const el = document.createElement("span");
    const result = findHighlightElement(el);

    expect(result).toBeNull();
  });
});

describe("applyFocusClass", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("adds focus class to matching elements", () => {
    const container = document.createElement("div");
    const span1 = createMockElement(["h1"]);
    const span2 = createMockElement(["h2"]);
    container.appendChild(span1);
    container.appendChild(span2);
    document.body.appendChild(container);

    applyFocusClass(container, "h1");

    expect(span1.classList.contains("hl-focused")).toBe(true);
    expect(span2.classList.contains("hl-focused")).toBe(false);
  });

  it("removes focus class when cleared", () => {
    const container = document.createElement("div");
    const span = createMockElement(["h1"]);
    span.classList.add("hl-focused");
    container.appendChild(span);
    document.body.appendChild(container);

    applyFocusClass(container, null);

    expect(span.classList.contains("hl-focused")).toBe(false);
  });

  it("handles custom focus class", () => {
    const container = document.createElement("div");
    const span = createMockElement(["h1"]);
    container.appendChild(span);
    document.body.appendChild(container);

    applyFocusClass(container, "h1", "custom-focus");

    expect(span.classList.contains("custom-focus")).toBe(true);
  });

  it("handles element in multiple highlights", () => {
    const container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-highlight-ids", "h1,h2,h3");
    container.appendChild(span);
    document.body.appendChild(container);

    applyFocusClass(container, "h2");

    expect(span.classList.contains("hl-focused")).toBe(true);
  });

  it("does not match substring IDs", () => {
    const container = document.createElement("div");
    const span = document.createElement("span");
    span.setAttribute("data-highlight-ids", "h1,h12,h123");
    container.appendChild(span);
    document.body.appendChild(container);

    // "h1" should match, but searching for "h" should not match
    applyFocusClass(container, "h");

    expect(span.classList.contains("hl-focused")).toBe(false);
  });
});

describe("reconcileFocusAfterRefetch", () => {
  it("keeps focus if highlight still exists", () => {
    const newIds = new Set(["h1", "h2", "h3"]);
    const result = reconcileFocusAfterRefetch("h2", newIds);

    expect(result).toBe("h2");
  });

  it("clears focus if highlight no longer exists", () => {
    const newIds = new Set(["h1", "h3"]);
    const result = reconcileFocusAfterRefetch("h2", newIds);

    expect(result).toBeNull();
  });

  it("returns null if not focused", () => {
    const newIds = new Set(["h1", "h2"]);
    const result = reconcileFocusAfterRefetch(null, newIds);

    expect(result).toBeNull();
  });

  it("handles empty highlight set", () => {
    const newIds = new Set<string>();
    const result = reconcileFocusAfterRefetch("h1", newIds);

    expect(result).toBeNull();
  });
});
