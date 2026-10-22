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
import { readMobileCssLength } from "@/lib/mobileShell/viewport";
import { getBrowserViewportKind } from "@/lib/renderEnvironment/provider";

export type Side = "above" | "below" | "left" | "right" | "edge";
export type AnchorState = "visible" | "offscreen" | "unavailable";
export interface AnchorMeasurement {
  /** null keeps an unavailable passage's draft pinned inside its live pane. */
  readonly rect: DOMRect | null;
  readonly lines: readonly DOMRect[];
  readonly bounds: DOMRect;
}
export type MeasuredAnchor = () => AnchorMeasurement | null;

export interface AnchorOptions {
  readonly enabled: boolean;
  /** Default "below"; with `flip`, the other side when this one does not fit. */
  readonly placement?: "above" | "below" | "right";
  readonly align?: "start" | "center" | "end";
  readonly gap?: number;
  readonly flip?: boolean;
  /** A text selection's line boxes: place against its first or last visible line. */
  readonly lines?: readonly DOMRect[];
  /** Keep clear of the mobile Nexus band and keyboard, not only the safe area. */
  readonly subscribeContentClearance?: (listener: () => void) => () => void;
  /** Clamp details beside their trigger, without covering its direct action. */
  readonly keepAnchorVisible?: boolean;
  /** Source-owned layout changes, such as reader reflow or pdf zoom. */
  readonly subscribeAnchor?: (listener: () => void) => () => void;
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
  const visualBottom = y + (viewport?.height ?? innerHeight);
  const bottom = clearContent
    ? Math.min(visualBottom, innerHeight - css("--mobile-content-bottom-clearance"))
    : visualBottom - css("--viewport-safe-bottom");
  return {
    left: x + PADDING_PX + css("--viewport-safe-left"),
    top: y + PADDING_PX + css("--viewport-safe-top"),
    right:
      x +
      (viewport?.width ?? innerWidth) -
      PADDING_PX -
      css("--viewport-safe-right"),
    bottom: bottom - PADDING_PX,
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

/** Beside the anchor, aligned on the cross axis, flipped when it must. */
function beside(
  anchor: DOMRect,
  box: DOMRect,
  bounds: Bounds,
  options: AnchorOptions,
): Placed {
  const gap = options.gap ?? 4;
  if (options.placement === "right") {
    const right = anchor.right + gap;
    const left = anchor.left - box.width - gap;
    const side = options.flip && right + box.width > bounds.right && left >= bounds.left
      ? "left"
      : "right";
    const align = options.align ?? "start";
    const top = align === "start"
      ? anchor.top
      : align === "end"
        ? anchor.bottom - box.height
        : anchor.top + anchor.height / 2 - box.height / 2;
    return { top, left: side === "right" ? right : left, side };
  }
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

/** The nearest edge, ties in this order: bottom, top, right, left. */
function atEdge(area: DOMRect, box: DOMRect, bounds: Bounds): Placed {
  const distances = [
    bounds.bottom - area.bottom,
    area.top - bounds.top,
    bounds.right - area.right,
    area.left - bounds.left,
  ].map(Math.abs);
  const nearest = area.bottom <= bounds.top ? 1 :
    area.top >= bounds.bottom ? 0 :
    area.right <= bounds.left ? 3 :
    area.left >= bounds.right ? 2 :
    distances.indexOf(Math.min(...distances));
  return {
    top:
      nearest === 0 ? bounds.bottom - box.height :
      nearest === 1 ? bounds.top : area.top + area.height / 2 - box.height / 2,
    left:
      nearest === 2 ? bounds.right - box.width :
      nearest === 3 ? bounds.left : area.left + area.width / 2 - box.width / 2,
    side: "edge",
  };
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
  const first = lines[0] ?? (lineRects.length ? null : clip(anchor, bounds));
  if (!first) return atEdge(anchor, box, bounds);
  const last = lines.at(-1) ?? first;
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
    : first;
  const middle = area.top + area.height / 2 - box.height / 2;
  if (area.right + gap + box.width <= bounds.right) {
    return { top: middle, left: area.right + gap, side: "right" };
  }
  if (area.left - gap - box.width >= bounds.left) {
    return { top: middle, left: area.left - gap - box.width, side: "left" };
  }
  return atEdge(area, box, bounds);
}

const HIDDEN: CSSProperties = { position: "fixed", visibility: "hidden" };

/**
 * Places a fixed floating element against a live element, a captured rect or
 * a text selection, clamped into the visible viewport, and keeps it there
 * through scroll, resize, its own resize and supplied content-clearance changes.
 * Without that capability it uses viewport/safe-area bounds. Hidden until the
 * first measure. Publishes the pixel cap
 * `--anchored-max-width` before measuring and in styles so minimums can yield.
 * Each enabled commit measures the current host and applies its owned position
 * synchronously, before consumers snapshot layout; content replacement cannot
 * publish against the previous host size while waiting for ResizeObserver.
 * Size probing preserves the host's scroll; internal scrolling never repositions
 * the host against its external anchor.
 */
export function useAnchoredPosition<T extends HTMLElement>(
  anchor: HTMLElement | DOMRect | RefObject<HTMLElement | null> | MeasuredAnchor | null,
  options: AnchorOptions,
): {
  readonly ref: RefObject<T | null>;
  readonly style: CSSProperties;
  readonly side: Side;
  /** The selection caret's offset inside the box. */
  readonly caretX: number | null;
  readonly placed: boolean;
  readonly anchorState: AnchorState;
} {
  const ref = useRef<T | null>(null);
  const [placed, setPlaced] = useState<{
    style: CSSProperties;
    side: Side;
    caretX: number | null;
    anchorState: AnchorState;
  }>({ style: HIDDEN, side: "below", caretX: null, anchorState: "unavailable" });
  // Lines and alignment are read at measure time: a new array per render is
  // no reason to resubscribe.
  const current = useRef(options);
  current.current = options;

  const measure = useCallback(() => {
    const opts = current.current;
    const element = anchor && "current" in anchor ? anchor.current : anchor;
    const floating = ref.current;
    const hide = () => setPlaced((previous) => previous.style === HIDDEN ? previous : {
      style: HIDDEN, side: "below", caretX: null, anchorState: "unavailable",
    });
    if (!opts.enabled || !floating || !element) return hide();
    let measurement: AnchorMeasurement | null = null;
    let rect: DOMRect | null;
    if (typeof element === "function") {
      measurement = element();
      if (!measurement) return hide();
      rect = measurement.rect;
    } else {
      rect = element instanceof DOMRect ? element : element.getBoundingClientRect();
    }
    const viewport = viewportBounds(opts.subscribeContentClearance !== undefined);
    const bounds = measurement ? {
      left: Math.max(viewport.left, measurement.bounds.left + PADDING_PX),
      top: Math.max(viewport.top, measurement.bounds.top + PADDING_PX),
      right: Math.min(viewport.right, measurement.bounds.right - PADDING_PX),
      bottom: Math.min(viewport.bottom, measurement.bounds.bottom - PADDING_PX),
    } : viewport;
    const maxWidth = bounds.right - bounds.left;
    let maxHeight = bounds.bottom - bounds.top;
    if (maxWidth <= 0 || maxHeight <= 0) return hide();
    const scrollLeft = floating.scrollLeft;
    const scrollTop = floating.scrollTop;
    const maxWidthPx = `${maxWidth}px`;
    floating.style.maxWidth = maxWidthPx;
    floating.style.setProperty("--anchored-max-width", maxWidthPx);
    floating.style.maxHeight = `${maxHeight}px`;
    let box = floating.getBoundingClientRect();
    let placement = opts.placement;
    if (rect !== null && opts.keepAnchorVisible && !opts.lines && placement !== "right") {
      const gap = opts.gap ?? 4;
      const above = Math.max(0, Math.min(rect.top - gap, bounds.bottom) - bounds.top);
      const below = Math.max(0, bounds.bottom - Math.max(rect.bottom + gap, bounds.top));
      placement ??= "below";
      if (opts.flip && box.height > (placement === "above" ? above : below)) {
        placement = above > below ? "above" : "below";
      }
      maxHeight = Math.min(maxHeight, placement === "above" ? above : below);
      floating.style.maxHeight = `${maxHeight}px`;
      box = floating.getBoundingClientRect();
    }
    const lines = measurement?.lines ?? opts.lines;
    const visible = lines?.length
      ? lines.some((line) => clip(line, bounds))
      : rect && clip(rect, bounds);
    const anchorState = rect === null ? "unavailable" : visible ? "visible" : "offscreen";
    const at: Placed = rect === null ? {
      top: bounds.bottom - box.height,
      left: bounds.left + (maxWidth - box.width) / 2,
      side: "edge",
    } : opts.lines
      ? againstSelection(rect, lines ?? [], box, bounds, getBrowserViewportKind() === "mobile")
      : beside(rect, box, bounds, opts.keepAnchorVisible ? { ...opts, placement, flip: false } : opts);
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
    floating.style.top = `${top}px`;
    floating.style.left = `${left}px`;
    floating.scrollLeft = scrollLeft;
    floating.scrollTop = scrollTop;
    // An unchanged placement keeps the state: no re-render.
    setPlaced((prev) =>
      prev.side === at.side &&
      prev.anchorState === anchorState &&
      prev.caretX === caretX &&
      prev.style.top === top &&
      prev.style.left === left &&
      prev.style.maxWidth === maxWidth &&
      prev.style.maxHeight === maxHeight
        ? prev
        : {
            style: {
              position: "fixed", top, left, maxWidth, maxHeight,
              "--anchored-max-width": maxWidthPx,
            },
            side: at.side,
            caretX,
            anchorState,
          },
    );
  }, [anchor]);

  const { enabled, subscribeContentClearance, subscribeAnchor } = options;
  useLayoutEffect(() => {
    if (enabled) measure();
  });
  useLayoutEffect(() => {
    if (!enabled) {
      setPlaced({ style: HIDDEN, side: "below", caretX: null, anchorState: "unavailable" });
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
    const element = anchor && "current" in anchor ? anchor.current : anchor;
    if (element instanceof HTMLElement) observer.observe(element);
    const unsubscribe = subscribeContentClearance?.(later);
    const unsubscribeAnchor = subscribeAnchor?.(later);
    const viewport = window.visualViewport;
    const scroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      measure();
    };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    viewport?.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe?.();
      unsubscribeAnchor?.();
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      viewport?.removeEventListener("resize", measure);
    };
  }, [anchor, enabled, subscribeContentClearance, subscribeAnchor, measure]);

  return { ref, ...placed, placed: placed.style !== HIDDEN };
}
