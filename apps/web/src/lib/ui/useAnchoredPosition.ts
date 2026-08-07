"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { clamp } from "@/lib/clamp";
import { readViewportSafeBounds } from "@/lib/ui/viewportSafeArea";

/**
 * Position a portaled floating element next to an anchor (a live element or a
 * captured rect), clamped into the viewport and kept in sync on scroll/resize.
 *
 * The floating element must carry the returned `ref` so its size can be
 * measured; `style` is `position: fixed` and is hidden until the first measure
 * to avoid a flash at the origin. `anchorRect` exposes the resolved anchor box
 * for callers that size themselves against it (e.g. match the trigger width).
 *
 * Dismiss listeners are not owned here — pair with useDismissOnOutsideOrEscape.
 */
export function useAnchoredPosition<T extends HTMLElement = HTMLDivElement>(
  anchor: HTMLElement | DOMRect | RefObject<HTMLElement | null> | null,
  opts: {
    enabled: boolean;
    placement?: "below" | "above" | "left" | "right";
    align?: "start" | "center" | "end";
    gap?: number;
    viewportPadding?: number;
    flip?: boolean;
  },
): {
  ref: RefObject<T | null>;
  style: CSSProperties;
  anchorRect: DOMRect | null;
} {
  const {
    enabled,
    placement = "below",
    align = "start",
    gap = 4,
    viewportPadding = 8,
    flip = false,
  } = opts;
  const ref = useRef<T | null>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const reposition = useCallback(() => {
    const floating = ref.current;
    const anchorElement =
      anchor !== null && "current" in anchor ? anchor.current : anchor;
    if (!enabled || !floating || !anchorElement) return;
    const a =
      anchorElement instanceof HTMLElement
        ? anchorElement.getBoundingClientRect()
        : anchorElement;
    const bounds = readViewportSafeBounds({ viewportPadding });
    const maxWidth = Math.max(0, bounds.right - bounds.left);
    const maxHeight = Math.max(0, bounds.bottom - bounds.top);
    floating.style.maxWidth = `${maxWidth}px`;
    floating.style.maxHeight = `${maxHeight}px`;
    const f = floating.getBoundingClientRect();
    const maxLeft = Math.max(bounds.left, bounds.right - f.width);
    const maxTop = Math.max(bounds.top, bounds.bottom - f.height);

    const horizontal = placement === "left" || placement === "right";

    let top: number;
    let left: number;
    if (horizontal) {
      // `left`/`right` float beside the anchor; `align` runs the vertical axis.
      const right = a.right + gap;
      const leftSide = a.left - f.width - gap;
      left = placement === "right" ? right : leftSide;
      if (flip) {
        if (
          placement === "right" &&
          right + f.width > bounds.right &&
          leftSide >= bounds.left
        ) {
          left = leftSide;
        } else if (
          placement === "left" &&
          leftSide < bounds.left &&
          right + f.width <= bounds.right
        ) {
          left = right;
        }
      }
      top =
        align === "start"
          ? a.top
          : align === "end"
            ? a.bottom - f.height
            : a.top + a.height / 2 - f.height / 2;
    } else {
      // `below`/`above` float under/over the anchor; `align` runs the horizontal axis.
      const below = a.bottom + gap;
      const above = a.top - f.height - gap;
      top = placement === "below" ? below : above;
      if (flip) {
        if (
          placement === "below" &&
          below + f.height > bounds.bottom &&
          above >= bounds.top
        ) {
          top = above;
        } else if (
          placement === "above" &&
          above < bounds.top &&
          below + f.height <= bounds.bottom
        ) {
          top = below;
        }
      }
      left =
        align === "start"
          ? a.left
          : align === "end"
            ? a.right - f.width
            : a.left + a.width / 2 - f.width / 2;
    }

    setStyle({
      position: "fixed",
      top: clamp(top, bounds.top, maxTop),
      left: clamp(left, bounds.left, maxLeft),
      maxWidth,
      maxHeight,
    });
    setAnchorRect((current) =>
      current &&
      current.x === a.x &&
      current.y === a.y &&
      current.width === a.width &&
      current.height === a.height
        ? current
        : a,
    );
  }, [anchor, enabled, placement, align, gap, viewportPadding, flip]);

  useLayoutEffect(() => {
    if (!enabled) {
      setStyle({ position: "fixed", visibility: "hidden" });
      setAnchorRect(null);
      return;
    }
    reposition();
    const viewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(reposition);
    const floating = ref.current;
    if (floating) resizeObserver.observe(floating);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    viewport?.addEventListener("resize", reposition);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
      viewport?.removeEventListener("resize", reposition);
    };
  }, [enabled, reposition]);

  return { ref, style, anchorRect };
}
