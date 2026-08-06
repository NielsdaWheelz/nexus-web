"use client";

import HighlightResourceActionMenu from "@/components/highlights/HighlightResourceActionMenu";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";

/**
 * The reader-text click surface: the same canonical menu the sidecar
 * uses, anchored to the highlight the user clicked. Dismisses on outside-click,
 * Escape, and scroll; the caller re-anchors when another highlight is clicked.
 */
export default function HighlightActionPopover({
  highlight,
  anchorRect,
  onDismiss,
}: {
  highlight: AnchoredReaderRow;
  anchorRect: DOMRect;
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
      <HighlightResourceActionMenu highlight={highlight} />
    </FloatingActionSurface>
  );
}
