"use client";

import HighlightResourceActionMenu from "@/components/highlights/HighlightResourceActionMenu";
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
  highlight: Pick<AnchoredReaderRow, "id">;
  anchorRect: DOMRect;
  onDismiss: () => void;
}) {
  return (
    <HighlightResourceActionMenu
      highlight={highlight}
      anchored={{ anchor: anchorRect, onDismiss }}
    />
  );
}
