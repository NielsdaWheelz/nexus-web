/**
 * SelectionPopover - Selection actions for highlight and chat destinations.
 *
 * Appears when user selects text in the content area. Positioned relative
 * to the selection bounding box. Selecting a color creates the highlight
 * immediately; the chat icons create a default-color highlight and then quote
 * it into a new or an existing chat (this component owns that sequencing).
 * Dismisses on Escape, click outside, or selection collapse.
 */

"use client";

import { useCallback } from "react";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import styles from "./SelectionPopover.module.css";

interface SelectionPopoverProps<H extends { id: string }> {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => Promise<H | null>;
  onQuoteToNewChat?: (highlight: H) => void | Promise<void>;
  onQuoteToExtantChat?: (highlight: H) => void | Promise<void>;
  onAddNote?: () => void;
  onCite?: () => void;
  onDismiss: () => void;
  isCreating?: boolean;
}

export const DEFAULT_COLOR: HighlightColor = "yellow";

export default function SelectionPopover<H extends { id: string }>({
  selectionRect,
  selectionLineRects,
  containerRef,
  onCreateHighlight,
  onQuoteToNewChat,
  onQuoteToExtantChat,
  onAddNote,
  onCite,
  onDismiss,
  isCreating = false,
}: SelectionPopoverProps<H>) {
  const quoteHighlight = useCallback(
    (quote?: (highlight: H) => void | Promise<void>) => {
      if (isCreating || !quote) return;
      void (async () => {
        const highlight = await onCreateHighlight(DEFAULT_COLOR);
        if (highlight) await quote(highlight);
      })();
    },
    [isCreating, onCreateHighlight],
  );

  return (
    <FloatingActionSurface
      open
      anchor={selectionRect}
      strategy="text-selection"
      lineRects={selectionLineRects}
      boundary={containerRef.current}
      className={styles.popover}
      role="group"
      label="Selection actions"
      preservePointerSelection
      onDismiss={onDismiss}
    >
      <HighlightActionBar
        variant="selection"
        selectionColor={DEFAULT_COLOR}
        canQuoteToChat={Boolean(onQuoteToNewChat || onQuoteToExtantChat)}
        canAddNote={Boolean(onAddNote)}
        busy={isCreating}
        onSelectColor={onCreateHighlight}
        onAddNote={onAddNote}
        onCite={onCite}
        onQuoteToNewChat={() => quoteHighlight(onQuoteToNewChat)}
        onQuoteToExistingChat={() => quoteHighlight(onQuoteToExtantChat)}
      />
    </FloatingActionSurface>
  );
}
