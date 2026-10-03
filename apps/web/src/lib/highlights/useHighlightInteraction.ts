import { useState, useCallback, useRef } from "react";
import { escapeAttrValue } from "./escapeAttrValue";

export type HighlightFocusState = {
  focusedId: string | null;
  editingBounds: boolean;
};

export type HighlightClickData = {
  highlightIds: string[];
  topmostId: string;
  element: Element;
};

export type UseHighlightInteractionReturn = {
  focusState: HighlightFocusState;
  focusHighlight: (highlightId: string | null) => void;
  handleHighlightClick: (data: HighlightClickData) => void;
  clearFocus: () => void;
  startEditBounds: () => void;
  cancelEditBounds: () => void;
};

/** Focus owns emphasis and the edit target, never scrolling or verbosity. */
export function useHighlightInteraction(): UseHighlightInteractionReturn {
  const [focusState, setFocusState] = useState<HighlightFocusState>({
    focusedId: null,
    editingBounds: false,
  });
  const lastClickedSegment = useRef<{
    element: Element | null;
    cycleIndex: number;
  }>({ element: null, cycleIndex: 0 });

  // Null ends bounds editing but preserves the overlap cycle.
  const focusHighlight = useCallback((highlightId: string | null) => {
    setFocusState((prev) => {
      const editingBounds = highlightId === null ? false : prev.editingBounds;
      if (prev.focusedId === highlightId && prev.editingBounds === editingBounds)
        return prev;
      return { focusedId: highlightId, editingBounds };
    });
  }, []);

  // Explicit clear also forgets the clicked segment and cycle.
  const clearFocus = useCallback(() => {
    setFocusState((prev) => {
      if (prev.focusedId === null && !prev.editingBounds) return prev;
      return { focusedId: null, editingBounds: false };
    });
    lastClickedSegment.current = { element: null, cycleIndex: 0 };
  }, []);

  const startEditBounds = useCallback(() => {
    setFocusState((prev) => ({
      ...prev,
      editingBounds: prev.focusedId !== null,
    }));
  }, []);

  const cancelEditBounds = useCallback(() => {
    setFocusState((prev) => ({ ...prev, editingBounds: false }));
  }, []);

  const handleHighlightClick = useCallback(
    ({ highlightIds, topmostId, element }: HighlightClickData) => {
      if (highlightIds.length === 0) {
        clearFocus();
        return;
      }
      // The producer orders current ids with topmost first. Never cache that list.
      const lastClicked = lastClickedSegment.current;
      const advanceCycle =
        element === lastClicked.element && highlightIds.length > 1;
      const cycleIndex = advanceCycle
        ? (lastClicked.cycleIndex + 1) % highlightIds.length
        : 0;
      lastClickedSegment.current = { element, cycleIndex };
      focusHighlight(advanceCycle ? highlightIds[cycleIndex] : topmostId);
    },
    [clearFocus, focusHighlight],
  );

  return {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
  };
}

/** Parse the producer's space-delimited active ids and optional topmost id. */
export function parseHighlightElement(element: Element): HighlightClickData | null {
  const idsAttr = element.getAttribute("data-active-highlight-ids");
  if (!idsAttr) {
    return null;
  }

  const highlightIds = idsAttr.split(" ").filter(Boolean);
  if (highlightIds.length === 0) {
    return null;
  }

  const topmostId = element.getAttribute("data-highlight-top") || highlightIds[0];

  return {
    highlightIds,
    topmostId,
    element,
  };
}

/** Find the nearest highlight-bearing ancestor. */
export function findHighlightElement(element: Element | null): Element | null {
  while (element) {
    if (element.hasAttribute("data-active-highlight-ids")) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

/** Paint exact id tokens across every matching span, without scrolling. */
export function applyFocusClass(
  container: Element,
  highlightId: string | null,
  focusClass: string = "hl-focused"
): void {
  // Remove focus class from all elements
  const focusedElements = container.querySelectorAll(`.${focusClass}`);
  focusedElements.forEach((el) => el.classList.remove(focusClass));

  // Add focus class to elements containing the focused highlight
  // Use ~= selector for exact space-delimited token matching.
  if (highlightId) {
    const selector = `[data-active-highlight-ids~="${escapeAttrValue(highlightId)}"]`;
    const elements = container.querySelectorAll(selector);
    elements.forEach((el) => el.classList.add(focusClass));
  }
}

/** Keep focus after refetch only while the id still exists. */
export function reconcileFocusAfterRefetch(
  currentFocusedId: string | null,
  newHighlightIds: Set<string>
): string | null {
  if (currentFocusedId === null) {
    return null;
  }
  
  if (newHighlightIds.has(currentFocusedId)) {
    return currentFocusedId;
  }
  
  return null;
}
