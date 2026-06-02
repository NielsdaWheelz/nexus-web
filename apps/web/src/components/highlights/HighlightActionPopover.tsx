"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import type { AnchoredHighlightRow } from "@/components/reader/useAnchoredHighlightProjection";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import styles from "./HighlightActionPopover.module.css";

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
  const { ref, style } = useAnchoredPosition(anchorRect, {
    enabled: true,
    placement: "below",
    align: "center",
    flip: true,
  });
  useDismissOnOutsideOrEscape({ enabled: true, refs: [ref], onDismiss });

  useEffect(() => {
    window.addEventListener("scroll", onDismiss, true);
    return () => window.removeEventListener("scroll", onDismiss, true);
  }, [onDismiss]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} style={style} className={styles.popover} role="dialog" aria-label="Highlight actions">
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
    </div>,
    document.body,
  );
}
