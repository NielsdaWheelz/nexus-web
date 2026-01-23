/**
 * Hook for highlight interaction: focus, cycling, and click handling.
 *
 * This hook manages:
 * - Focus state (which highlight is currently focused)
 * - Overlap cycling (clicking same segment cycles through overlapping highlights)
 * - Segment tracking (which segment was last clicked)
 *
 * The focus model:
 * - At most one highlight is focused at any time
 * - Focus determines which linked-item row is expanded
 * - Focus determines which highlight receives edit/delete actions
 *
 * Overlap cycling:
 * - First click on segment focuses data-highlight-top
 * - Subsequent clicks on same segment cycle through data-active-highlight-ids
 * - Clicking different segment resets cycling
 *
 * PR-10: Changed from data-highlight-ids (comma-delimited) to
 * data-active-highlight-ids (space-delimited) for efficient CSS ~= selector.
 *
 * @see docs/v1/s2/s2_prs/s2_pr09.md §9
 * @see docs/v1/s2/s2_prs/s2_pr10.md §15
 */

import { useState, useCallback, useRef } from "react";

// =============================================================================
// Types
// =============================================================================

/**
 * Highlight focus state.
 */
export type HighlightFocusState = {
  /** Currently focused highlight ID, or null if none */
  focusedId: string | null;
  /** Whether we're in edit mode for bounds */
  editingBounds: boolean;
};

/**
 * Click event data from a highlight span.
 */
export type HighlightClickData = {
  /** All highlight IDs active in this segment */
  highlightIds: string[];
  /** The topmost highlight ID */
  topmostId: string;
  /** The DOM element that was clicked */
  element: Element;
};

/**
 * Return type of useHighlightInteraction hook.
 */
export type UseHighlightInteractionReturn = {
  /** Current focus state */
  focusState: HighlightFocusState;
  
  /** Focus a specific highlight */
  focusHighlight: (highlightId: string | null) => void;
  
  /** Handle click on a highlight span */
  handleHighlightClick: (data: HighlightClickData) => void;
  
  /** Clear focus */
  clearFocus: () => void;
  
  /** Enter edit bounds mode */
  startEditBounds: () => void;
  
  /** Exit edit bounds mode */
  cancelEditBounds: () => void;
  
  /** Check if a highlight is focused */
  isHighlightFocused: (highlightId: string) => boolean;
};

// =============================================================================
// Implementation
// =============================================================================

/**
 * Hook for managing highlight interaction.
 *
 * @param onFocusChange - Optional callback when focus changes (for linked-items sync)
 * @returns Interaction state and handlers
 *
 * @example
 * ```tsx
 * const { focusState, handleHighlightClick, clearFocus } = useHighlightInteraction();
 *
 * // In highlight span click handler:
 * const onClick = (e: React.MouseEvent) => {
 *   const target = e.target as Element;
 *   const ids = target.getAttribute('data-active-highlight-ids')?.split(' ') || [];
 *   const topId = target.getAttribute('data-highlight-top') || ids[0];
 *   handleHighlightClick({ highlightIds: ids, topmostId: topId, element: target });
 * };
 *
 * // Focus CSS class:
 * const className = focusState.focusedId === highlightId ? 'hl-focused' : '';
 * ```
 */
export function useHighlightInteraction(
  onFocusChange?: (highlightId: string | null) => void
): UseHighlightInteractionReturn {
  // Focus state
  const [focusState, setFocusState] = useState<HighlightFocusState>({
    focusedId: null,
    editingBounds: false,
  });

  // Track last clicked segment for cycling
  const lastClickedSegment = useRef<{
    element: Element | null;
    cycleIndex: number;
    highlightIds: string[];
  }>({
    element: null,
    cycleIndex: 0,
    highlightIds: [],
  });

  /**
   * Focus a specific highlight.
   */
  const focusHighlight = useCallback(
    (highlightId: string | null) => {
      setFocusState((prev) => ({
        ...prev,
        focusedId: highlightId,
        // Exit edit bounds mode when changing focus
        editingBounds: highlightId === null ? false : prev.editingBounds,
      }));
      onFocusChange?.(highlightId);
    },
    [onFocusChange]
  );

  /**
   * Clear focus entirely.
   */
  const clearFocus = useCallback(() => {
    setFocusState({ focusedId: null, editingBounds: false });
    lastClickedSegment.current = {
      element: null,
      cycleIndex: 0,
      highlightIds: [],
    };
    onFocusChange?.(null);
  }, [onFocusChange]);

  /**
   * Enter edit bounds mode for the currently focused highlight.
   */
  const startEditBounds = useCallback(() => {
    setFocusState((prev) => ({
      ...prev,
      editingBounds: prev.focusedId !== null,
    }));
  }, []);

  /**
   * Exit edit bounds mode.
   */
  const cancelEditBounds = useCallback(() => {
    setFocusState((prev) => ({
      ...prev,
      editingBounds: false,
    }));
  }, []);

  /**
   * Handle click on a highlight span.
   *
   * Implements cycling behavior:
   * - First click: focus topmost highlight
   * - Subsequent clicks on same segment: cycle through highlights
   * - Click on different segment: reset to topmost
   */
  const handleHighlightClick = useCallback(
    (data: HighlightClickData) => {
      const { highlightIds, topmostId, element } = data;

      if (highlightIds.length === 0) {
        clearFocus();
        return;
      }

      const lastClicked = lastClickedSegment.current;

      // Check if clicking the same segment
      const isSameSegment = element === lastClicked.element;

      if (isSameSegment && highlightIds.length > 1) {
        // Cycle to next highlight
        const nextIndex = (lastClicked.cycleIndex + 1) % highlightIds.length;
        const nextHighlightId = highlightIds[nextIndex];

        lastClickedSegment.current = {
          element,
          cycleIndex: nextIndex,
          highlightIds,
        };

        focusHighlight(nextHighlightId);
      } else {
        // New segment or single highlight: focus topmost
        lastClickedSegment.current = {
          element,
          cycleIndex: 0,
          highlightIds,
        };

        focusHighlight(topmostId);
      }
    },
    [clearFocus, focusHighlight]
  );

  /**
   * Check if a highlight is currently focused.
   */
  const isHighlightFocused = useCallback(
    (highlightId: string) => {
      return focusState.focusedId === highlightId;
    },
    [focusState.focusedId]
  );

  return {
    focusState,
    focusHighlight,
    handleHighlightClick,
    clearFocus,
    startEditBounds,
    cancelEditBounds,
    isHighlightFocused,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse highlight data from a DOM element's data attributes.
 *
 * PR-10: Uses data-active-highlight-ids (space-delimited) instead of
 * data-highlight-ids (comma-delimited) for efficient CSS ~= selector.
 *
 * @param element - Element with data-active-highlight-ids and data-highlight-top
 * @returns HighlightClickData or null if not a highlight span
 */
export function parseHighlightElement(element: Element): HighlightClickData | null {
  const idsAttr = element.getAttribute("data-active-highlight-ids");
  if (!idsAttr) {
    return null;
  }

  // Space-delimited per PR-10
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

/**
 * Find the closest ancestor with highlight data attributes.
 *
 * PR-10: Uses data-active-highlight-ids instead of data-highlight-ids.
 *
 * @param element - Starting element
 * @returns Element with highlight data or null
 */
export function findHighlightElement(element: Element | null): Element | null {
  while (element) {
    if (element.hasAttribute("data-active-highlight-ids")) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * Apply focus class to all spans containing a highlight ID.
 *
 * This is a DOM-based approach that doesn't require re-rendering.
 * Call this when focus changes to update visual state.
 *
 * PR-10: Uses data-active-highlight-ids with ~= selector for efficient
 * space-delimited token matching.
 *
 * @param container - The container element to search within
 * @param highlightId - The highlight ID to focus (or null to clear)
 * @param focusClass - The CSS class to apply (default: "hl-focused")
 */
export function applyFocusClass(
  container: Element,
  highlightId: string | null,
  focusClass: string = "hl-focused"
): void {
  // Remove focus class from all elements
  const focusedElements = container.querySelectorAll(`.${focusClass}`);
  focusedElements.forEach((el) => el.classList.remove(focusClass));

  // Add focus class to elements containing the focused highlight
  // Using ~= selector for O(1) space-delimited token matching (PR-10)
  if (highlightId) {
    const selector = `[data-active-highlight-ids~="${highlightId}"]`;
    const elements = container.querySelectorAll(selector);
    elements.forEach((el) => el.classList.add(focusClass));
  }
}

/**
 * Update focus state after highlights refetch.
 *
 * After any highlight mutation + refetch:
 * - If focused highlight ID still exists → keep focus
 * - If focused highlight ID no longer exists → clear focus
 *
 * @param currentFocusedId - Currently focused highlight ID
 * @param newHighlightIds - Set of highlight IDs after refetch
 * @returns The new focused ID (same or null)
 */
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
