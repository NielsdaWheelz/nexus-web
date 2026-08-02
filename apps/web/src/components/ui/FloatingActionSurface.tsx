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
import { useActiveMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import { cx } from "@/lib/ui/cx";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { readViewportSafeBounds } from "@/lib/ui/viewportSafeArea";
import styles from "./FloatingActionSurface.module.css";

export type FloatingActionDismissReason = "outside-click" | "escape" | "scroll";

type FloatingActionPlacement = "above" | "below" | "right" | "left" | "edge";

type FloatingActionStyle = CSSProperties & {
  "--floating-action-caret-inline-offset"?: string;
  "--floating-action-content-max-width"?: string;
  "--floating-action-content-max-height"?: string;
};

interface FloatingActionPosition {
  style: FloatingActionStyle;
  placement: FloatingActionPlacement;
  compactWidth?: boolean;
  reflowWidth?: boolean;
}

const CARET_SIZE_PX = 6;
const CARET_EDGE_INSET_PX = CARET_SIZE_PX * 2;

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
  const isMobileViewport = useIsMobileViewport();
  const mobileViewport = useActiveMobileViewport(open && isMobileViewport);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<FloatingActionPosition>({
    style: { position: "fixed", visibility: "hidden" },
    placement: "below",
    compactWidth: false,
    reflowWidth: false,
  });

  const updatePosition = useCallback(() => {
    const surface = surfaceRef.current;
    const anchorRect = resolveRect(anchor);
    if (!open || !surface || !anchorRect) return;

    const bounds = viewportBounds(isMobileViewport, viewportPadding);
    const maxWidth = Math.max(0, bounds.maxLeft - bounds.minLeft);
    const maxHeight = Math.max(0, bounds.maxTop - bounds.minTop);
    surface.style.maxWidth = `${maxWidth}px`;
    surface.style.maxHeight = `${maxHeight}px`;
    const computedSurface = window.getComputedStyle(surface);
    const contentMaxWidth = Math.max(
      0,
      maxWidth -
        readPx(computedSurface.paddingLeft) -
        readPx(computedSurface.paddingRight) -
        readPx(computedSurface.borderLeftWidth) -
        readPx(computedSurface.borderRightWidth),
    );
    const contentMaxHeight = Math.max(
      0,
      maxHeight -
        readPx(computedSurface.paddingTop) -
        readPx(computedSurface.paddingBottom) -
        readPx(computedSurface.borderTopWidth) -
        readPx(computedSurface.borderBottomWidth),
    );
    surface.style.setProperty(
      "--floating-action-content-max-width",
      `${contentMaxWidth}px`,
    );
    surface.style.setProperty(
      "--floating-action-content-max-height",
      `${contentMaxHeight}px`,
    );
    surface.dataset.reflowWidth = "false";
    const reflowWidth =
      !isMobileViewport && surface.scrollWidth > surface.clientWidth;
    surface.dataset.reflowWidth = reflowWidth ? "true" : "false";
    const compactWidth = contentMaxWidth < 240;
    surface.dataset.compactWidth = compactWidth ? "true" : "false";
    const surfaceRect = surface.getBoundingClientRect();
    const constrain = (
      next: FloatingActionPosition,
    ): FloatingActionPosition => ({
      ...next,
      compactWidth,
      reflowWidth,
      style: {
        ...next.style,
        maxWidth,
        maxHeight,
        "--floating-action-content-max-width": `${contentMaxWidth}px`,
        "--floating-action-content-max-height": `${contentMaxHeight}px`,
      },
    });
    const clampLeft = (value: number) =>
      clamp(
        value,
        bounds.minLeft,
        Math.max(bounds.minLeft, bounds.maxLeft - surfaceRect.width),
      );
    const clampTop = (value: number) =>
      clamp(
        value,
        bounds.minTop,
        Math.max(bounds.minTop, bounds.maxTop - surfaceRect.height),
      );

    if (strategy === "text-selection") {
      setPosition(
        constrain(
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
        ),
      );
      return;
    }

    setPosition(
      constrain(
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
      ),
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
        compactWidth: false,
        reflowWidth: false,
      });
      return;
    }

    updatePosition();
    const visualViewport = window.visualViewport;
    let resizeFrame: number | null = null;
    let disposed = false;
    const scheduleResizePositionUpdate = () => {
      if (disposed || resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (!disposed) updatePosition();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleResizePositionUpdate);
    const surface = surfaceRef.current;
    if (surface) resizeObserver.observe(surface);
    const unsubscribeContentBottomClearance = isMobileViewport
      ? mobileViewport?.subscribeContentBottomClearance(
          scheduleResizePositionUpdate,
        )
      : undefined;
    const handleScroll =
      scrollBehavior === "dismiss" ? () => onDismiss("scroll") : updatePosition;
    window.addEventListener("resize", updatePosition, { passive: true });
    window.addEventListener("scroll", handleScroll, true);
    visualViewport?.addEventListener?.("resize", updatePosition);
    visualViewport?.addEventListener?.("scroll", handleScroll);
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubscribeContentBottomClearance?.();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleScroll, true);
      visualViewport?.removeEventListener?.("resize", updatePosition);
      visualViewport?.removeEventListener?.("scroll", handleScroll);
    };
  }, [
    isMobileViewport,
    mobileViewport,
    onDismiss,
    open,
    scrollBehavior,
    updatePosition,
  ]);

  useDismissOnOutsideOrEscape({
    enabled: open && Boolean(anchor),
    refs: [surfaceRef, ...additionalDismissRefs],
    onDismiss,
  });

  if (!open || !anchor || typeof document === "undefined") return null;

  const positioned = position.style.visibility !== "hidden";

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
      data-compact-width={position.compactWidth ? "true" : "false"}
      data-reflow-width={position.reflowWidth ? "true" : "false"}
      data-positioned={positioned ? "true" : "false"}
      data-strategy={strategy}
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
}): FloatingActionPosition {
  const lines = visibleSelectionLines(lineRects, anchorRect, boundary, bounds);
  const firstLineRect = lines[0] ?? anchorRect;
  const lastLineRect = lines[lines.length - 1] ?? anchorRect;
  const visibleSelectionRect =
    unionRects(lines) ?? clippedRect(anchorRect, bounds) ?? anchorRect;
  const aboveTop = firstLineRect.top - surfaceRect.height - gap;
  const belowTop = lastLineRect.bottom + gap;
  const fitsAbove = aboveTop >= bounds.minTop;
  const fitsBelow = belowTop + surfaceRect.height <= bounds.maxTop;

  const verticalPlacements: Array<"above" | "below"> = isMobileViewport
    ? ["below", "above"]
    : ["above", "below"];
  for (const candidate of verticalPlacements) {
    if (
      (candidate === "above" && !fitsAbove) ||
      (candidate === "below" && !fitsBelow)
    ) {
      continue;
    }
    const lineRect = candidate === "above" ? firstLineRect : lastLineRect;
    const top = candidate === "above" ? aboveTop : belowTop;
    const selectionCenterX = anchorRect.left + anchorRect.width / 2;
    const targetX = clamp(selectionCenterX, lineRect.left, lineRect.right);
    const left = clampLeft(targetX - surfaceRect.width / 2);
    return {
      style: selectionSurfaceStyle(top, left, targetX, surfaceRect.width),
      placement: candidate,
    };
  }

  const selectionCenterX =
    visibleSelectionRect.left + visibleSelectionRect.width / 2;
  const selectionCenterY =
    visibleSelectionRect.top + visibleSelectionRect.height / 2;
  const sideTop = clampTop(selectionCenterY - surfaceRect.height / 2);
  const rightLeft = visibleSelectionRect.right + gap;
  if (rightLeft + surfaceRect.width <= bounds.maxLeft) {
    return {
      style: { position: "fixed", top: sideTop, left: rightLeft },
      placement: "right",
    };
  }

  const leftLeft = visibleSelectionRect.left - surfaceRect.width - gap;
  if (leftLeft >= bounds.minLeft) {
    return {
      style: { position: "fixed", top: sideTop, left: leftLeft },
      placement: "left",
    };
  }

  let top = clampTop(selectionCenterY - surfaceRect.height / 2);
  let left = clampLeft(selectionCenterX - surfaceRect.width / 2);
  const bottomDistance = Math.abs(bounds.maxTop - visibleSelectionRect.bottom);
  const topDistance = Math.abs(visibleSelectionRect.top - bounds.minTop);
  const rightDistance = Math.abs(bounds.maxLeft - visibleSelectionRect.right);
  const leftDistance = Math.abs(visibleSelectionRect.left - bounds.minLeft);

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

function visibleSelectionLines(
  lineRects: DOMRect[] | undefined,
  anchorRect: DOMRect,
  boundary: HTMLElement | DOMRect | null | undefined,
  bounds: ViewportBounds,
): DOMRect[] {
  const boundaryRect = resolveRect(boundary);
  const clippingBounds = boundaryRect
    ? intersectBounds(bounds, {
        minLeft: boundaryRect.left,
        minTop: boundaryRect.top,
        maxLeft: boundaryRect.right,
        maxTop: boundaryRect.bottom,
      })
    : bounds;
  const validLines = (lineRects ?? []).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  const visibleLines = validLines
    .map((rect) => clippedRect(rect, clippingBounds))
    .filter((rect): rect is DOMRect => rect !== null);
  const fallback = clippedRect(anchorRect, clippingBounds) ?? anchorRect;
  const lines = visibleLines.length > 0 ? visibleLines : [fallback];

  return lines.sort((leftRect, rightRect) => {
    if (leftRect.top !== rightRect.top) {
      return leftRect.top - rightRect.top;
    }
    return leftRect.left - rightRect.left;
  });
}

function intersectBounds(
  left: ViewportBounds,
  right: ViewportBounds,
): ViewportBounds {
  return {
    minLeft: Math.max(left.minLeft, right.minLeft),
    minTop: Math.max(left.minTop, right.minTop),
    maxLeft: Math.min(left.maxLeft, right.maxLeft),
    maxTop: Math.min(left.maxTop, right.maxTop),
  };
}

function clippedRect(rect: DOMRect, bounds: ViewportBounds): DOMRect | null {
  const left = Math.max(rect.left, bounds.minLeft);
  const top = Math.max(rect.top, bounds.minTop);
  const right = Math.min(rect.right, bounds.maxLeft);
  const bottom = Math.min(rect.bottom, bounds.maxTop);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function unionRects(rects: DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function selectionSurfaceStyle(
  top: number,
  left: number,
  targetX: number,
  surfaceWidth: number,
): FloatingActionStyle {
  const caretInset = Math.min(CARET_EDGE_INSET_PX, surfaceWidth / 2);
  const caretOffset = clamp(
    targetX - left,
    caretInset,
    surfaceWidth - caretInset,
  );
  return {
    position: "fixed",
    top,
    left,
    "--floating-action-caret-inline-offset": `${caretOffset}px`,
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
}): FloatingActionPosition {
  let actualPlacement = placement;
  if (placement === "below") {
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - surfaceRect.height - gap;
    if (
      flip &&
      below + surfaceRect.height > bounds.maxTop &&
      above >= bounds.minTop
    ) {
      actualPlacement = "above";
    }
  } else if (placement === "above") {
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - surfaceRect.height - gap;
    if (
      flip &&
      above < bounds.minTop &&
      below + surfaceRect.height <= bounds.maxTop
    ) {
      actualPlacement = "below";
    }
  } else if (placement === "right") {
    const right = anchorRect.right + gap;
    const left = anchorRect.left - surfaceRect.width - gap;
    if (
      flip &&
      right + surfaceRect.width > bounds.maxLeft &&
      left >= bounds.minLeft
    ) {
      actualPlacement = "left";
    }
  } else {
    const right = anchorRect.right + gap;
    const left = anchorRect.left - surfaceRect.width - gap;
    if (
      flip &&
      left < bounds.minLeft &&
      right + surfaceRect.width <= bounds.maxLeft
    ) {
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

function resolveRect(
  anchor: HTMLElement | DOMRect | null | undefined,
): DOMRect | null {
  if (!anchor) return null;
  return anchor instanceof HTMLElement
    ? anchor.getBoundingClientRect()
    : anchor;
}

interface ViewportBounds {
  minLeft: number;
  minTop: number;
  maxLeft: number;
  maxTop: number;
}

function viewportBounds(
  isMobileViewport: boolean,
  viewportPadding: number,
): ViewportBounds {
  const safeBounds = isMobileViewport
    ? readViewportSafeBounds({
        viewportPadding,
        bottomClearance: readMobileContentBottomClearance(),
      })
    : readViewportSafeBounds({ viewportPadding });

  return {
    minLeft: safeBounds.left,
    minTop: safeBounds.top,
    maxLeft: safeBounds.right,
    maxTop: safeBounds.bottom,
  };
}

function readMobileContentBottomClearance(): number {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.height = "var(--mobile-content-bottom-clearance)";
  document.body.appendChild(probe);
  const clearance = readPx(window.getComputedStyle(probe).height);
  probe.remove();
  return clearance;
}

function readPx(rawValue: string | null | undefined): number {
  if (!rawValue) return 0;
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}
