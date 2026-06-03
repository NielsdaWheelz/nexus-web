"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { clamp } from "@/lib/clamp";
import { cx } from "@/lib/ui/cx";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import styles from "./FloatingActionSurface.module.css";

export type FloatingActionDismissReason = "outside-click" | "escape" | "scroll";

export default function FloatingActionSurface({
  open,
  anchor,
  strategy = "anchor",
  lineRects,
  boundary,
  placement = "below",
  align = "center",
  flip = false,
  gap = 8,
  viewportPadding = 8,
  scrollBehavior = "reposition",
  preservePointerSelection = false,
  dismissIgnore = false,
  additionalDismissRefs = [],
  role,
  label,
  className,
  onDismiss,
  children,
}: {
  open: boolean;
  anchor: HTMLElement | DOMRect | null;
  strategy?: "anchor" | "text-selection";
  lineRects?: DOMRect[];
  boundary?: HTMLElement | DOMRect | null;
  placement?: "below" | "above" | "left" | "right";
  align?: "start" | "center" | "end";
  flip?: boolean;
  gap?: number;
  viewportPadding?: number;
  scrollBehavior?: "reposition" | "dismiss";
  preservePointerSelection?: boolean;
  dismissIgnore?: boolean;
  additionalDismissRefs?: Array<RefObject<HTMLElement | null>>;
  role?: "group" | "toolbar" | "dialog";
  label?: string;
  className?: string;
  onDismiss: (reason: FloatingActionDismissReason) => void;
  children: ReactNode;
}) {
  const isMobileViewport = useFloatingActionMobileViewport();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    style: CSSProperties;
    placement: "above" | "below" | "right" | "left" | "edge";
  }>({
    style: { position: "fixed", visibility: "hidden" },
    placement: "below",
  });

  const updatePosition = useCallback(() => {
    const surface = surfaceRef.current;
    const anchorRect = resolveRect(anchor);
    if (!open || !surface || !anchorRect) return;

    const surfaceRect = surface.getBoundingClientRect();
    const bounds = viewportBounds(isMobileViewport, viewportPadding);
    const clampLeft = (value: number) =>
      clamp(value, bounds.minLeft, Math.max(bounds.minLeft, bounds.maxLeft - surfaceRect.width));
    const clampTop = (value: number) =>
      clamp(value, bounds.minTop, Math.max(bounds.minTop, bounds.maxTop - surfaceRect.height));

    if (strategy === "text-selection") {
      setPosition(
        textSelectionPosition({
          anchorRect,
          lineRects,
          boundary,
          surfaceRect,
          bounds,
          clampLeft,
          clampTop,
          gap,
          isMobileViewport,
        }),
      );
      return;
    }

    setPosition(
      anchoredPosition({
        anchorRect,
        surfaceRect,
        bounds,
        clampLeft,
        clampTop,
        placement,
        align,
        flip,
        gap,
      }),
    );
  }, [
    align,
    anchor,
    boundary,
    flip,
    gap,
    isMobileViewport,
    lineRects,
    open,
    placement,
    strategy,
    viewportPadding,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition({
        style: { position: "fixed", visibility: "hidden" },
        placement: "below",
      });
      return;
    }

    updatePosition();
    const visualViewport = window.visualViewport;
    const handleScroll =
      scrollBehavior === "dismiss"
        ? () => onDismiss("scroll")
        : updatePosition;
    window.addEventListener("resize", updatePosition, { passive: true });
    window.addEventListener("scroll", handleScroll, true);
    visualViewport?.addEventListener?.("resize", updatePosition);
    visualViewport?.addEventListener?.("scroll", handleScroll);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleScroll, true);
      visualViewport?.removeEventListener?.("resize", updatePosition);
      visualViewport?.removeEventListener?.("scroll", handleScroll);
    };
  }, [onDismiss, open, scrollBehavior, updatePosition]);

  useDismissOnOutsideOrEscape({
    enabled: open && Boolean(anchor),
    refs: [surfaceRef, ...additionalDismissRefs],
    onDismiss,
  });

  if (!open || !anchor || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={surfaceRef}
      className={cx(styles.surface, className)}
      style={position.style}
      role={role}
      aria-label={label}
      data-floating-action-surface="true"
      data-dismiss-ignore={dismissIgnore ? "true" : undefined}
      data-placement={position.placement}
      data-mobile={isMobileViewport ? "true" : "false"}
      onPointerDown={(event) => {
        if (preservePointerSelection) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function textSelectionPosition({
  anchorRect,
  lineRects,
  boundary,
  surfaceRect,
  bounds,
  clampLeft,
  clampTop,
  gap,
  isMobileViewport,
}: {
  anchorRect: DOMRect;
  lineRects?: DOMRect[];
  boundary?: HTMLElement | DOMRect | null;
  surfaceRect: DOMRect;
  bounds: ViewportBounds;
  clampLeft: (value: number) => number;
  clampTop: (value: number) => number;
  gap: number;
  isMobileViewport: boolean;
}): {
  style: CSSProperties;
  placement: "above" | "below" | "right" | "left" | "edge";
} {
  if (isMobileViewport) {
    const lines = (lineRects ?? [])
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((leftRect, rightRect) => {
        if (leftRect.top !== rightRect.top) {
          return leftRect.top - rightRect.top;
        }
        return leftRect.left - rightRect.left;
      });
    const firstLineRect = lines[0] ?? anchorRect;
    const lastLineRect = lines[lines.length - 1] ?? anchorRect;
    const selectionCenterX = anchorRect.left + anchorRect.width / 2;
    const selectionCenterY = anchorRect.top + anchorRect.height / 2;

    const belowTop = lastLineRect.bottom + gap;
    if (belowTop + surfaceRect.height <= bounds.maxTop) {
      return {
        style: {
          position: "fixed",
          top: belowTop,
          left: clampLeft(lastLineRect.left + lastLineRect.width / 2 - surfaceRect.width / 2),
        },
        placement: "below",
      };
    }

    const aboveTop = firstLineRect.top - surfaceRect.height - gap;
    if (aboveTop >= bounds.minTop) {
      return {
        style: {
          position: "fixed",
          top: aboveTop,
          left: clampLeft(firstLineRect.left + firstLineRect.width / 2 - surfaceRect.width / 2),
        },
        placement: "above",
      };
    }

    const sideTop = clampTop(selectionCenterY - surfaceRect.height / 2);
    const rightLeft = anchorRect.right + gap;
    if (rightLeft + surfaceRect.width <= bounds.maxLeft) {
      return {
        style: { position: "fixed", top: sideTop, left: rightLeft },
        placement: "right",
      };
    }

    const leftLeft = anchorRect.left - surfaceRect.width - gap;
    if (leftLeft >= bounds.minLeft) {
      return {
        style: { position: "fixed", top: sideTop, left: leftLeft },
        placement: "left",
      };
    }

    let top = clampTop(selectionCenterY - surfaceRect.height / 2);
    let left = clampLeft(selectionCenterX - surfaceRect.width / 2);
    const bottomDistance = Math.abs(bounds.maxTop - anchorRect.bottom);
    const topDistance = Math.abs(anchorRect.top - bounds.minTop);
    const rightDistance = Math.abs(bounds.maxLeft - anchorRect.right);
    const leftDistance = Math.abs(anchorRect.left - bounds.minLeft);

    if (
      bottomDistance <= topDistance &&
      bottomDistance <= rightDistance &&
      bottomDistance <= leftDistance
    ) {
      top = Math.max(bounds.minTop, bounds.maxTop - surfaceRect.height);
    } else if (topDistance <= rightDistance && topDistance <= leftDistance) {
      top = bounds.minTop;
    } else if (rightDistance <= leftDistance) {
      left = Math.max(bounds.minLeft, bounds.maxLeft - surfaceRect.width);
    } else {
      left = bounds.minLeft;
    }

    return {
      style: { position: "fixed", top, left },
      placement: "edge",
    };
  }

  const boundaryRect = resolveRect(boundary) ?? anchorRect;
  const left = clampLeft(anchorRect.left + anchorRect.width / 2 - surfaceRect.width / 2);
  const spaceAbove = anchorRect.top - boundaryRect.top;
  const spaceBelow = bounds.maxTop - anchorRect.bottom;
  const surfaceHeight = surfaceRect.height + gap;
  const actualPlacement =
    spaceAbove >= surfaceHeight || spaceAbove > spaceBelow ? "above" : "below";
  const top =
    actualPlacement === "above"
      ? anchorRect.top - surfaceHeight
      : anchorRect.bottom + gap;

  return {
    style: { position: "fixed", top: clampTop(top), left },
    placement: actualPlacement,
  };
}

function anchoredPosition({
  anchorRect,
  surfaceRect,
  bounds,
  clampLeft,
  clampTop,
  placement,
  align,
  flip,
  gap,
}: {
  anchorRect: DOMRect;
  surfaceRect: DOMRect;
  bounds: ViewportBounds;
  clampLeft: (value: number) => number;
  clampTop: (value: number) => number;
  placement: "below" | "above" | "left" | "right";
  align: "start" | "center" | "end";
  flip: boolean;
  gap: number;
}): {
  style: CSSProperties;
  placement: "above" | "below" | "right" | "left" | "edge";
} {
  let actualPlacement = placement;
  if (placement === "below") {
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - surfaceRect.height - gap;
    if (flip && below + surfaceRect.height > bounds.maxTop && above >= bounds.minTop) {
      actualPlacement = "above";
    }
  } else if (placement === "above") {
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - surfaceRect.height - gap;
    if (flip && above < bounds.minTop && below + surfaceRect.height <= bounds.maxTop) {
      actualPlacement = "below";
    }
  } else if (placement === "right") {
    const right = anchorRect.right + gap;
    const left = anchorRect.left - surfaceRect.width - gap;
    if (flip && right + surfaceRect.width > bounds.maxLeft && left >= bounds.minLeft) {
      actualPlacement = "left";
    }
  } else {
    const right = anchorRect.right + gap;
    const left = anchorRect.left - surfaceRect.width - gap;
    if (flip && left < bounds.minLeft && right + surfaceRect.width <= bounds.maxLeft) {
      actualPlacement = "right";
    }
  }

  const horizontal = actualPlacement === "left" || actualPlacement === "right";
  const top = horizontal
    ? align === "start"
      ? anchorRect.top
      : align === "end"
        ? anchorRect.bottom - surfaceRect.height
        : anchorRect.top + anchorRect.height / 2 - surfaceRect.height / 2
    : actualPlacement === "below"
      ? anchorRect.bottom + gap
      : anchorRect.top - surfaceRect.height - gap;
  const left = horizontal
    ? actualPlacement === "right"
      ? anchorRect.right + gap
      : anchorRect.left - surfaceRect.width - gap
    : align === "start"
      ? anchorRect.left
      : align === "end"
        ? anchorRect.right - surfaceRect.width
        : anchorRect.left + anchorRect.width / 2 - surfaceRect.width / 2;

  return {
    style: { position: "fixed", top: clampTop(top), left: clampLeft(left) },
    placement: actualPlacement,
  };
}

function resolveRect(anchor: HTMLElement | DOMRect | null | undefined): DOMRect | null {
  if (!anchor) return null;
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
}

interface ViewportBounds {
  minLeft: number;
  minTop: number;
  maxLeft: number;
  maxTop: number;
}

function viewportBounds(isMobileViewport: boolean, viewportPadding: number): ViewportBounds {
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
    ? readPx(rootStyle.getPropertyValue("--mobile-bottom-obstruction"))
    : 0;

  return {
    minLeft: viewportLeft + viewportPadding + safeAreaInsets.left,
    minTop: viewportTop + viewportPadding + safeAreaInsets.top,
    maxLeft: viewportLeft + viewportWidth - viewportPadding - safeAreaInsets.right,
    maxTop:
      viewportTop +
      viewportHeight -
      viewportPadding -
      safeAreaInsets.bottom -
      mobileBottomNavHeight,
  };
}

function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
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

function readPx(rawValue: string | null | undefined): number {
  if (!rawValue) return 0;
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

function useFloatingActionMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 768,
  );

  useLayoutEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 768);
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);

  return isMobile;
}
