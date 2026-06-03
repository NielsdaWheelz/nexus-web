"use client";

import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";

/**
 * The reader-text click surface: the same {@link HighlightActionBar} the sidecar
 * uses, anchored to the highlight the user clicked. Dismisses on outside-click,
 * Escape, and scroll; the caller re-anchors when another highlight is clicked.
 */
export default function HighlightActionPopover({
  highlight,
  anchorRect,
  canQuoteToChat,
  isReflowable,
  onSelectColor,
  onDelete,
  onQuoteToNewChat,
  onQuoteToExistingChat,
  onToggleEditBounds,
  onDismiss,
}: {
  highlight: AnchoredHighlightRow;
  anchorRect: DOMRect;
  canQuoteToChat: boolean;
  isReflowable: boolean;
  onSelectColor: (color: HighlightColor) => Promise<void>;
  onDelete: () => Promise<void>;
  onQuoteToNewChat: () => void;
  onQuoteToExistingChat: () => void;
  onToggleEditBounds: () => void;
  onDismiss: () => void;
}) {
  return (
    <FloatingActionSurface
      open
      anchor={anchorRect}
      placement="below"
      align="center"
      flip
      scrollBehavior="dismiss"
      onDismiss={onDismiss}
    >
      <HighlightActionBar
        variant="existing"
        presentation="bar"
        highlight={highlight}
        canQuoteToChat={canQuoteToChat}
        isReflowable={isReflowable}
        isEditingBounds={false}
        onSelectColor={onSelectColor}
        onDelete={onDelete}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={onQuoteToExistingChat}
        onToggleEditBounds={onToggleEditBounds}
      />
    </FloatingActionSurface>
  );
}
