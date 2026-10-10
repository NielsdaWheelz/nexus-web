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
import {
  readMobileCssLength,
  useMobileViewport,
} from "@/lib/mobileShell/viewport";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";

export type Side = "above" | "below" | "left" | "right" | "edge";

export interface AnchorOptions {
  readonly enabled: boolean;
  /** Default "below"; with `flip`, the other side when this one does not fit. */
  readonly placement?: "above" | "below";
  readonly align?: "start" | "center" | "end";
  readonly gap?: number;
  readonly flip?: boolean;
  /** A text selection's line boxes: place against its first or last visible line. */
  readonly lines?: readonly DOMRect[];
  /** Keep clear of the mobile Nexus band and keyboard, not only the safe area. */
  readonly clearContent?: boolean;
}

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Placed {
  readonly top: number;
  readonly left: number;
  readonly side: Side;
  readonly caretX?: number;
}

const PADDING_PX = 8;

/** The visible viewport less padding, the safe-area insets and the bottom clearance. */
function viewportBounds(clearContent: boolean): Bounds {
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft ?? 0;
  const y = viewport?.offsetTop ?? 0;
  const css = (name: string) => readMobileCssLength(`var(${name})`);
  const bottom = clearContent
    ? "--mobile-content-bottom-clearance"
    : "--viewport-safe-bottom";
  return {
    left: x + PADDING_PX + css("--viewport-safe-left"),
    top: y + PADDING_PX + css("--viewport-safe-top"),
    right:
      x +
      (viewport?.width ?? innerWidth) -
      PADDING_PX -
      css("--viewport-safe-right"),
    bottom: y + (viewport?.height ?? innerHeight) - PADDING_PX - css(bottom),
  };
}

function clip(rect: DOMRect, bounds: Bounds): DOMRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  return right > left && bottom > top
    ? new DOMRect(left, top, right - left, bottom - top)
    : null;
}

/** Below or above the anchor, aligned on the cross axis, flipped when it must. */
function beside(
  anchor: DOMRect,
  box: DOMRect,
  bounds: Bounds,
  options: AnchorOptions,
): Placed {
  const gap = options.gap ?? 4;
  const below = anchor.bottom + gap;
  const above = anchor.top - box.height - gap;
  const fitsBelow = below + box.height <= bounds.bottom;
  const fitsAbove = above >= bounds.top;
  let side: Side = options.placement ?? "below";
  if (options.flip && side === "below" && !fitsBelow && fitsAbove) {
    side = "above";
  } else if (options.flip && side === "above" && !fitsAbove && fitsBelow) {
    side = "below";
  }
  const align = options.align ?? "start";
  const left =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.right - box.width
        : anchor.left + anchor.width / 2 - box.width / 2;
  return { top: side === "below" ? below : above, left, side };
}

/**
 * Against a selection: above its first visible line (below its last first on
 * phones, clear of the native selection menu), with a caret at the selection;
 * else beside the visible selection; else pinned to the nearest viewport edge.
 */
function againstSelection(
  anchor: DOMRect,
  lineRects: readonly DOMRect[],
  box: DOMRect,
  bounds: Bounds,
  phone: boolean,
): Placed {
  const gap = 8;
  const lines = lineRects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => clip(rect, bounds))
    .filter((rect): rect is DOMRect => rect !== null)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const visible = clip(anchor, bounds) ?? anchor;
  const first = lines[0] ?? visible;
  const last = lines.at(-1) ?? visible;
  const order = phone
    ? (["below", "above"] as const)
    : (["above", "below"] as const);
  for (const side of order) {
    const line = side === "above" ? first : last;
    const top =
      side === "above" ? first.top - box.height - gap : last.bottom + gap;
    if (
      side === "above" ? top < bounds.top : top + box.height > bounds.bottom
    ) {
      continue;
    }
    const caretX = clamp(anchor.left + anchor.width / 2, line.left, line.right);
    return { top, left: caretX - box.width / 2, side, caretX };
  }
  const area = lines.length
    ? lines.reduce((union, rect) => {
        const left = Math.min(union.left, rect.left);
        const top = Math.min(union.top, rect.top);
        const right = Math.max(union.right, rect.right);
        const bottom = Math.max(union.bottom, rect.bottom);
        return new DOMRect(left, top, right - left, bottom - top);
      })
    : visible;
  const middle = area.top + area.height / 2 - box.height / 2;
  if (area.right + gap + box.width <= bounds.right) {
    return { top: middle, left: area.right + gap, side: "right" };
  }
  if (area.left - gap - box.width >= bounds.left) {
    return { top: middle, left: area.left - gap - box.width, side: "left" };
  }
  // The nearest edge, ties in this order: bottom, top, right, left.
  const distances = [
    bounds.bottom - area.bottom,
    area.top - bounds.top,
    bounds.right - area.right,
    area.left - bounds.left,
  ].map(Math.abs);
  const nearest = distances.indexOf(Math.min(...distances));
  return {
    top:
      nearest === 0
        ? bounds.bottom - box.height
        : nearest === 1
          ? bounds.top
          : middle,
    left:
      nearest === 2
        ? bounds.right - box.width
        : nearest === 3
          ? bounds.left
          : area.left + area.width / 2 - box.width / 2,
    side: "edge",
  };
}

const HIDDEN: CSSProperties = { position: "fixed", visibility: "hidden" };
const where = (rect: DOMRect) =>
  `${rect.x},${rect.y},${rect.width},${rect.height}`;

/**
 * Places a fixed floating element against a live element, a captured rect or
 * a text selection, clamped into the visible viewport, and keeps it there
 * through scroll, resize, its own resize and (with `clearContent`) mobile
 * clearance changes. Hidden until the first measure.
 */
export function useAnchoredPosition<T extends HTMLElement>(
  anchor: HTMLElement | DOMRect | RefObject<HTMLElement | null> | null,
  options: AnchorOptions,
): {
  readonly ref: RefObject<T | null>;
  readonly style: CSSProperties;
  readonly side: Side;
  /** The selection caret's offset inside the box. */
  readonly caretX: number | null;
  readonly placed: boolean;
} {
  const ref = useRef<T | null>(null);
  const [placed, setPlaced] = useState<{
    style: CSSProperties;
    side: Side;
    caretX: number | null;
  }>({ style: HIDDEN, side: "below", caretX: null });
  const mobileViewport = useMobileViewport();
  const phone = useIsMobileViewport();
  // Lines and alignment are read at measure time: a new array per render is
  // no reason to resubscribe.
  const current = useRef({ ...options, phone });
  current.current = { ...options, phone };

  const measured = useRef("");
  const measure = useCallback(() => {
    const opts = current.current;
    const element = anchor && "current" in anchor ? anchor.current : anchor;
    const floating = ref.current;
    if (!opts.enabled || !floating || !element) return;
    const rect =
      element instanceof DOMRect ? element : element.getBoundingClientRect();
    measured.current = where(rect);
    const bounds = viewportBounds(opts.clearContent === true);
    const maxWidth = Math.max(0, bounds.right - bounds.left);
    const maxHeight = Math.max(0, bounds.bottom - bounds.top);
    floating.style.maxWidth = `${maxWidth}px`;
    floating.style.maxHeight = `${maxHeight}px`;
    const box = floating.getBoundingClientRect();
    const at = opts.lines
      ? againstSelection(rect, opts.lines, box, bounds, opts.phone)
      : beside(rect, box, bounds, opts);
    const left = clamp(
      at.left,
      bounds.left,
      Math.max(bounds.left, bounds.right - box.width),
    );
    const top = clamp(
      at.top,
      bounds.top,
      Math.max(bounds.top, bounds.bottom - box.height),
    );
    const inset = Math.min(12, box.width / 2);
    const caretX =
      at.caretX === undefined
        ? null
        : clamp(at.caretX - left, inset, box.width - inset);
    // An unchanged placement keeps the state: no re-render.
    setPlaced((prev) =>
      prev.side === at.side &&
      prev.caretX === caretX &&
      prev.style.top === top &&
      prev.style.left === left &&
      prev.style.maxWidth === maxWidth &&
      prev.style.maxHeight === maxHeight
        ? prev
        : {
            style: { position: "fixed", top, left, maxWidth, maxHeight },
            side: at.side,
            caretX,
          },
    );
  }, [anchor]);

  const { enabled, clearContent } = options;
  // A layout shift that moves an anchor element (a toolbar re-laid out as its
  // data arrives) fires no event; it shows up as a re-render of the owner.
  useLayoutEffect(() => {
    const element = anchor && "current" in anchor ? anchor.current : anchor;
    if (!enabled || !(element instanceof Element)) return;
    if (where(element.getBoundingClientRect()) !== measured.current) measure();
  });
  useLayoutEffect(() => {
    if (!enabled) {
      setPlaced({ style: HIDDEN, side: "below", caretX: null });
      return;
    }
    measure();
    let frame = 0;
    const later = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const observer = new ResizeObserver(later);
    if (ref.current) observer.observe(ref.current);
    const unsubscribe = clearContent
      ? mobileViewport.subscribeContentBottomClearance(later)
      : null;
    const viewport = window.visualViewport;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    viewport?.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe?.();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      viewport?.removeEventListener("resize", measure);
    };
  }, [enabled, clearContent, measure, mobileViewport]);

  return { ref, ...placed, placed: placed.style !== HIDDEN };
}
