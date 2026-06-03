/**
 * SelectionPopover - Selection actions for highlight and chat destinations.
 *
 * Appears when user selects text in the content area. Positioned relative
 * to the selection bounding box. Selecting a color creates the highlight
 * immediately, and the chat icons quote the selection into a new or an
 * existing chat. Dismisses on Escape, click outside, or selection collapse.
 */

"use client";

import { useCallback } from "react";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import styles from "./SelectionPopover.module.css";

interface SelectionPopoverProps {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => void | Promise<void | string | null>;
  onQuoteToNewChat?: () => void | Promise<void>;
  onQuoteToExtantChat?: () => void | Promise<void>;
  onDismiss: () => void;
  isCreating?: boolean;
}

const DEFAULT_COLOR: HighlightColor = "yellow";

export default function SelectionPopover({
  selectionRect,
  selectionLineRects,
  containerRef,
  onCreateHighlight,
  onQuoteToNewChat,
  onQuoteToExtantChat,
  onDismiss,
  isCreating = false,
}: SelectionPopoverProps) {
  const handleQuoteToNewChat = useCallback(() => {
    if (!isCreating) {
      void onQuoteToNewChat?.();
    }
  }, [isCreating, onQuoteToNewChat]);

  const handleQuoteToExtantChat = useCallback(() => {
    if (!isCreating) {
      void onQuoteToExtantChat?.();
    }
  }, [isCreating, onQuoteToExtantChat]);

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
        busy={isCreating}
        onSelectColor={onCreateHighlight}
        onQuoteToNewChat={handleQuoteToNewChat}
        onQuoteToExistingChat={handleQuoteToExtantChat}
      />
    </FloatingActionSurface>
  );
}
