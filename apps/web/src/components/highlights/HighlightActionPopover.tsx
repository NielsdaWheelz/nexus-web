"use client";

import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { canonicalResourceRef } from "@/lib/sharing/targets";

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
    <ResourceActionMenu
      actionSubject={{
        ref: canonicalResourceRef({ scheme: "highlight", id: highlight.id }),
      }}
      label="Highlight actions"
      placement="below"
      align="center"
      anchored={{ anchor: anchorRect, onDismiss }}
    />
  );
}
