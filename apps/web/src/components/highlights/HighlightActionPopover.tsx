"use client";

import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
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
  canAddNote,
  isReflowable,
  onSelectColor,
  onAddNote,
  onCite,
  onDelete,
  onQuoteToNewChat,
  onQuoteToExistingChat,
  onToggleEditBounds,
  onDismiss,
}: {
  highlight: AnchoredReaderRow;
  anchorRect: DOMRect;
  canQuoteToChat: boolean;
  canAddNote?: boolean;
  isReflowable: boolean;
  onSelectColor: (color: HighlightColor) => Promise<void>;
  onAddNote?: () => void;
  onCite?: () => void;
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
        canAddNote={canAddNote}
        isReflowable={isReflowable}
        isEditingBounds={false}
        onSelectColor={onSelectColor}
        onAddNote={onAddNote}
        onCite={onCite}
        onDelete={onDelete}
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={onQuoteToExistingChat}
        onToggleEditBounds={onToggleEditBounds}
      />
    </FloatingActionSurface>
  );
}
