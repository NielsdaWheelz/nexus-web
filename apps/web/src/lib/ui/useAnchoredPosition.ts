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
  anchor: HTMLElement | DOMRect | null,
  opts: {
    enabled: boolean;
    placement?: "below" | "above";
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
    if (!enabled || !floating || !anchor) return;
    const a = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
    const f = floating.getBoundingClientRect();
    const padMaxLeft = Math.max(viewportPadding, window.innerWidth - viewportPadding - f.width);
    const padMaxTop = Math.max(viewportPadding, window.innerHeight - viewportPadding - f.height);

    const below = a.bottom + gap;
    const above = a.top - f.height - gap;
    let top = placement === "below" ? below : above;
    if (flip) {
      if (placement === "below" && below + f.height > window.innerHeight - viewportPadding && above >= viewportPadding) {
        top = above;
      } else if (placement === "above" && above < viewportPadding && below + f.height <= window.innerHeight - viewportPadding) {
        top = below;
      }
    }

    const left =
      align === "start"
        ? a.left
        : align === "end"
          ? a.right - f.width
          : a.left + a.width / 2 - f.width / 2;

    setStyle({
      position: "fixed",
      top: clamp(top, viewportPadding, padMaxTop),
      left: clamp(left, viewportPadding, padMaxLeft),
    });
    setAnchorRect(a);
  }, [anchor, enabled, placement, align, gap, viewportPadding, flip]);

  useLayoutEffect(() => {
    if (!enabled) {
      setStyle({ position: "fixed", visibility: "hidden" });
      setAnchorRect(null);
      return;
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [enabled, reposition]);

  return { ref, style, anchorRect };
}
