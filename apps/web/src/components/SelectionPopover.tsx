/**
 * SelectionPopover - Selection actions for highlight + Ask.
 *
 * Appears when user selects text in the content area. Positioned relative
 * to the selection bounding box. Selecting a color creates the highlight
 * immediately, and the Ask icon emits the active selection color.
 * Dismisses on Escape, click outside, or selection collapse.
 */

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import Button from "@/components/ui/Button";
import styles from "./SelectionPopover.module.css";

export interface SelectionPopoverProps {
  selectionRect: DOMRect;
  selectionLineRects?: DOMRect[];
  containerRef: React.RefObject<HTMLElement | null>;
  onCreateHighlight: (color: HighlightColor) => void | Promise<void | string | null>;
  onAsk?: (color: HighlightColor) => void | Promise<void>;
  onDismiss: () => void;
  isCreating?: boolean;
}

const DEFAULT_COLOR: HighlightColor = "yellow";
const VIEWPORT_PADDING_PX = 8;
const POPOVER_GAP_PX = 8;
const MOBILE_BOTTOM_NAV_HEIGHT_VAR = "--mobile-bottom-nav-height";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function readPx(rawValue: string | null | undefined): number {
  if (!rawValue) {
    return 0;
  }
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  if (typeof document === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.inset = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.paddingTop = "env(safe-area-inset-top)";
  probe.style.paddingRight = "env(safe-area-inset-right)";
  probe.style.paddingBottom = "env(safe-area-inset-bottom)";
  probe.style.paddingLeft = "env(safe-area-inset-left)";
  document.body.appendChild(probe);

  const computed = window.getComputedStyle(probe);
  const insets = {
    top: readPx(computed.paddingTop),
    right: readPx(computed.paddingRight),
    bottom: readPx(computed.paddingBottom),
    left: readPx(computed.paddingLeft),
  };

  probe.remove();
  return insets;
}

export default function SelectionPopover({
  selectionRect,
  selectionLineRects,
  containerRef,
  onCreateHighlight,
  onAsk,
  onDismiss,
  isCreating = false,
}: SelectionPopoverProps) {
  const isMobileViewport = useIsMobileViewport();
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(DEFAULT_COLOR);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: "above" | "below" | "right" | "left" | "edge";
  }>({
    top: 0,
    left: 0,
    placement: "below",
  });

  const updatePosition = useCallback(() => {
    if (!popoverRef.current) {
      return;
    }

    if (!isMobileViewport && !containerRef.current) {
      return;
    }

    const popoverRect = popoverRef.current.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const safeAreaInsets = readSafeAreaInsets();
    const rootStyle = getComputedStyle(document.documentElement);
    const viewportLeft = isMobileViewport ? (visualViewport?.offsetLeft ?? 0) : 0;
    const viewportTop = isMobileViewport ? (visualViewport?.offsetTop ?? 0) : 0;
    const viewportWidth = isMobileViewport
      ? (visualViewport?.width ?? window.innerWidth)
      : window.innerWidth;
    const viewportHeight = isMobileViewport
      ? (visualViewport?.height ?? window.innerHeight)
      : window.innerHeight;
    const mobileBottomNavHeight = isMobileViewport
      ? readPx(rootStyle.getPropertyValue(MOBILE_BOTTOM_NAV_HEIGHT_VAR))
      : 0;
    const minLeft = viewportLeft + VIEWPORT_PADDING_PX + safeAreaInsets.left;
    const minTop = viewportTop + VIEWPORT_PADDING_PX + safeAreaInsets.top;
    const maxLeft = viewportLeft + viewportWidth - VIEWPORT_PADDING_PX - safeAreaInsets.right;
    const maxTop =
      viewportTop +
      viewportHeight -
      VIEWPORT_PADDING_PX -
      safeAreaInsets.bottom -
      mobileBottomNavHeight;
    const clampLeft = (value: number) =>
      clamp(value, minLeft, Math.max(minLeft, maxLeft - popoverRect.width));
    const clampTop = (value: number) =>
      clamp(value, minTop, Math.max(minTop, maxTop - popoverRect.height));

    if (isMobileViewport) {
      const lineRects = (selectionLineRects ?? [])
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .sort((leftRect, rightRect) => {
          if (leftRect.top !== rightRect.top) {
            return leftRect.top - rightRect.top;
          }
          return leftRect.left - rightRect.left;
        });
      const firstLineRect = lineRects[0] ?? selectionRect;
      const lastLineRect = lineRects[lineRects.length - 1] ?? selectionRect;
      const selectionCenterX = selectionRect.left + selectionRect.width / 2;
      const selectionCenterY = selectionRect.top + selectionRect.height / 2;

      const belowTop = lastLineRect.bottom + POPOVER_GAP_PX;
      if (belowTop + popoverRect.height <= maxTop) {
        setPosition({
          top: belowTop,
          left: clampLeft(lastLineRect.left + lastLineRect.width / 2 - popoverRect.width / 2),
          placement: "below",
        });
        return;
      }

      const aboveTop = firstLineRect.top - popoverRect.height - POPOVER_GAP_PX;
      if (aboveTop >= minTop) {
        setPosition({
          top: aboveTop,
          left: clampLeft(firstLineRect.left + firstLineRect.width / 2 - popoverRect.width / 2),
          placement: "above",
        });
        return;
      }

      const sideTop = clampTop(selectionCenterY - popoverRect.height / 2);
      const rightLeft = selectionRect.right + POPOVER_GAP_PX;
      if (rightLeft + popoverRect.width <= maxLeft) {
        setPosition({ top: sideTop, left: rightLeft, placement: "right" });
        return;
      }

      const leftLeft = selectionRect.left - popoverRect.width - POPOVER_GAP_PX;
      if (leftLeft >= minLeft) {
        setPosition({ top: sideTop, left: leftLeft, placement: "left" });
        return;
      }

      let top = clampTop(selectionCenterY - popoverRect.height / 2);
      let left = clampLeft(selectionCenterX - popoverRect.width / 2);
      const bottomDistance = Math.abs(maxTop - selectionRect.bottom);
      const topDistance = Math.abs(selectionRect.top - minTop);
      const rightDistance = Math.abs(maxLeft - selectionRect.right);
      const leftDistance = Math.abs(selectionRect.left - minLeft);

      if (
        bottomDistance <= topDistance &&
        bottomDistance <= rightDistance &&
        bottomDistance <= leftDistance
      ) {
        top = Math.max(minTop, maxTop - popoverRect.height);
      } else if (topDistance <= rightDistance && topDistance <= leftDistance) {
        top = minTop;
      } else if (rightDistance <= leftDistance) {
        left = Math.max(minLeft, maxLeft - popoverRect.width);
      } else {
        left = minLeft;
      }

      setPosition({ top, left, placement: "edge" });
      return;
    }

    const containerRect = containerRef.current?.getBoundingClientRect() ?? selectionRect;
    const left = clampLeft(selectionRect.left + selectionRect.width / 2 - popoverRect.width / 2);
    const spaceAbove = selectionRect.top - containerRect.top;
    const spaceBelow = maxTop - selectionRect.bottom;
    const popoverHeight = popoverRect.height + POPOVER_GAP_PX;
    const placement =
      spaceAbove >= popoverHeight || spaceAbove > spaceBelow ? "above" : "below";
    const top =
      placement === "above"
        ? selectionRect.top - popoverHeight
        : selectionRect.bottom + POPOVER_GAP_PX;

    setPosition({
      top: clampTop(top),
      left,
      placement,
    });
  }, [containerRef, isMobileViewport, selectionLineRects, selectionRect]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", updatePosition, { passive: true });
    window.addEventListener("scroll", updatePosition, { passive: true });
    visualViewport?.addEventListener?.("resize", updatePosition);
    visualViewport?.addEventListener?.("scroll", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition);
      visualViewport?.removeEventListener?.("resize", updatePosition);
      visualViewport?.removeEventListener?.("scroll", updatePosition);
    };
  }, [updatePosition]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        const preserveSelectionTarget = target.closest(
          '[data-selection-popover-ignore-outside="true"]'
        );
        if (preserveSelectionTarget) {
          return;
        }
      }

      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onDismiss();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onDismiss]);

  const handleColorSelect = useCallback(
    (color: HighlightColor) => {
      setSelectedColor(color);
      if (!isCreating) {
        void onCreateHighlight(color);
      }
    },
    [isCreating, onCreateHighlight]
  );

  const handleAsk = useCallback(() => {
    if (isCreating || !onAsk) {
      return;
    }
    void onAsk(selectedColor);
  }, [isCreating, onAsk, selectedColor]);

  const handlePopoverPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  return (
    <div
      ref={popoverRef}
      className={`${styles.popover} ${isMobileViewport ? styles.mobilePopover : ""}`.trim()}
      style={{
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
      role="dialog"
      aria-label="Highlight actions"
      data-placement={position.placement}
      data-mobile={isMobileViewport ? "true" : "false"}
      onPointerDown={handlePopoverPointerDown}
    >
      <HighlightColorPicker
        selectedColor={selectedColor}
        onSelectColor={handleColorSelect}
        disabled={isCreating}
        className={styles.colorPicker}
      />
      {onAsk ? (
        <Button
          variant="secondary"
          size="sm"
          iconOnly
          className={styles.askButton}
          onClick={handleAsk}
          disabled={isCreating}
          aria-label="Ask"
          title="Ask"
        >
          <MessageSquare size={14} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
