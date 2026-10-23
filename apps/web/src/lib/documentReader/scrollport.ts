// Genuine input on a reader scrollport, and the viewport measured after every
// scroll. Wheel, single-finger drag, scroll keys and scrollbar drags are the
// reader's own movement; everything else (positioning, reflow) is not.
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { Placement } from "./model";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import type { ReaderRuntime } from "./runtime";

const SCROLL_INDICATOR_IDLE_MS = 400;

/** One snapshot separates visible obstruction from the stable navigation line. */
export function readScrollport(port: HTMLElement | null): { bounds: DOMRect; readingLine: number } | null {
  if (!port?.isConnected) return null;
  const rect = port.getBoundingClientRect();
  const style = getComputedStyle(port);
  const top = Number.parseFloat(style.getPropertyValue("--reader-occlusion-top")) || 0;
  const bottom = Math.max(
    Number.parseFloat(style.getPropertyValue("--reader-occlusion-bottom")) || 0,
    Number.parseFloat(style.getPropertyValue("--reader-feedback-occlusion-bottom")) || 0,
  );
  const height = port.clientHeight - top - bottom;
  return port.clientWidth > 0 && height > 0 ? {
    bounds: new DOMRect(rect.left + port.clientLeft, rect.top + port.clientTop + top, port.clientWidth, height),
    readingLine: rect.top + port.clientTop + (Number.parseFloat(style.scrollPaddingTop) || 0),
  } : null;
}

export function measureScrollport(port: HTMLElement | null): DOMRect | null {
  return readScrollport(port)?.bounds ?? null;
}

export function useScrollport(
  ref: RefObject<HTMLElement | null>,
  runtime: ReaderRuntime,
  measure: (cause: "Observation" | "Geometry") => void,
  layout: { readonly placement: RefObject<Placement | null>; change(): void },
  indicatorRef: RefObject<HTMLDivElement | null>,
  feedbackRef: RefObject<HTMLDivElement | null>,
): (reason: "Occlusion" | "Layout") => void {
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const invalidate = useRef<(reason: "Occlusion" | "Layout") => void>(() => {});
  const geometryChanged = useCallback((reason: "Occlusion" | "Layout") => invalidate.current(reason), []);
  useLayoutEffect(() => {
    const port = ref.current;
    if (!port) return;
    // justify-type-assertion: DocumentReader mounts its indicator before surface effects run.
    const indicator = indicatorRef.current!;
    let frame = 0;
    let scrolled = false;
    let pending: { reason: "Occlusion" | "Layout"; placement: Placement | null } | null = null;
    // justify-type-assertion: DocumentReader mounts the feedback stack beside its indicator.
    const feedback = feedbackRef.current!;
    // justify-type-assertion: DocumentReader owns the indicator as a direct frame child.
    const readerFrame = indicator.parentElement!;
    const syncFeedback = () => {
      const overlay = port.style.getPropertyValue("--reader-content-inset-top") !== "";
      readerFrame.toggleAttribute("data-reader-overlay", overlay);
      const style = getComputedStyle(port);
      feedback.style.bottom = overlay ? `${Number.parseFloat(style.getPropertyValue("--reader-occlusion-bottom")) || 0}px` : "";
      const bounds = feedback.getBoundingClientRect();
      const height = overlay ? bounds.height : 0;
      const previous = Number.parseFloat(port.style.getPropertyValue("--reader-feedback-height")) || 0;
      port.style.setProperty("--reader-feedback-height", `${height}px`);
      port.style.setProperty("--reader-feedback-occlusion-bottom", `${overlay && height > 0 ? Math.max(0, port.getBoundingClientRect().bottom - bounds.top) : 0}px`);
      return height !== previous;
    };
    let idle: ReturnType<typeof setTimeout> | null = null;
    let touchY: number | null = null;
    let seek: {
      op: { settle(moved: boolean): void; cancel(): void };
      top: number;
    } | null = null;
    // WebView suppresses native scrollbars inside nested scrollports. This
    // passive overlay reports pixel position; it never changes reading intent.
    const paintIndicator = () => {
      if (indicator.clientHeight === 0) return;
      const frameBounds = readerFrame.getBoundingClientRect();
      const snapshot = readScrollport(port);
      if (!snapshot) return;
      const portBounds = snapshot.bounds;
      indicator.style.setProperty(
        "--scroll-indicator-inset-top",
        `${portBounds.top - frameBounds.top}px`,
      );
      indicator.style.setProperty(
        "--scroll-indicator-inset-bottom",
        `${frameBounds.bottom - portBounds.bottom}px`,
      );
      const height = port.clientHeight;
      const width = port.clientWidth;
      const maxTop = port.scrollHeight - height;
      const maxLeft = port.scrollWidth - width;
      const trackHeight = indicator.clientHeight;
      const trackWidth = indicator.clientWidth;
      const thumbHeight =
        maxTop > 0
          ? Math.min(trackHeight, Math.max(24, trackHeight * height / port.scrollHeight))
          : 0;
      const thumbWidth =
        maxLeft > 0
          ? Math.min(trackWidth, Math.max(24, trackWidth * width / port.scrollWidth))
          : 0;
      const top =
        maxTop > 0
          ? Math.max(0, Math.min(maxTop, port.scrollTop)) / maxTop * (trackHeight - thumbHeight)
          : 0;
      const left =
        maxLeft > 0
          ? Math.max(0, Math.min(maxLeft, port.scrollLeft)) / maxLeft * (trackWidth - thumbWidth)
          : 0;
      // Zero-sized thumbs still cast shadows; hide axes without overflow.
      indicator.style.setProperty("--scroll-indicator-vertical-display", maxTop > 0 ? "block" : "none");
      indicator.style.setProperty("--scroll-indicator-horizontal-display", maxLeft > 0 ? "block" : "none");
      indicator.style.setProperty("--scroll-indicator-height", `${thumbHeight}px`);
      indicator.style.setProperty("--scroll-indicator-width", `${thumbWidth}px`);
      indicator.style.setProperty("--scroll-indicator-top", `${top}px`);
      indicator.style.setProperty("--scroll-indicator-left", `${left}px`);
      if (maxTop <= 0 && maxLeft <= 0) {
        indicator.removeAttribute("data-scrolling");
        return;
      }
      indicator.dataset.scrolling = "";
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        indicator.removeAttribute("data-scrolling");
      }, SCROLL_INDICATOR_IDLE_MS);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        const geometry = pending;
        pending = null;
        const observation = scrolled;
        scrolled = false;
        if (geometry?.reason === "Layout") {
          if (geometry.placement !== null) {
            void runtime.reflow({ placement: geometry.placement, change: () => layoutRef.current.change() });
          } else {
            layoutRef.current.change();
            if (observation) measureRef.current("Observation");
          }
        } else {
          measureRef.current(observation ? "Observation" : "Geometry");
        }
        paintIndicator();
      });
    };
    invalidate.current = (reason) => {
      if (syncFeedback()) reason = "Layout";
      // Capture once before a later observation can replace the pre-change passage.
      if (pending?.reason !== "Layout") pending = { reason, placement: layoutRef.current.placement.current };
      schedule();
    };
    const release = runtime.host?.scrollport?.(port, geometryChanged);
    syncFeedback();
    const feedbackObserver = new ResizeObserver(() => geometryChanged("Layout"));
    feedbackObserver.observe(feedback);
    const scroll = () => {
      scrolled = true;
      schedule();
    };
    const retirePlacement = () => {
      // New input owns the passage before the queued layout frame begins.
      if (pending) pending.placement = null;
      layoutRef.current.placement.current = null;
    };
    const input = (direction: "forward" | "backward") => {
      retirePlacement();
      runtime.input(direction);
    };
    const wheel = (event: WheelEvent) => {
      if (event.isTrusted && !event.ctrlKey && event.deltaY !== 0) {
        input(event.deltaY > 0 ? "forward" : "backward");
      }
    };
    const touchStart = (event: TouchEvent) => {
      touchY =
        event.isTrusted && event.touches.length === 1
          ? event.touches[0].clientY
          : null;
    };
    const touchMove = (event: TouchEvent) => {
      const y =
        event.isTrusted && event.touches.length === 1
          ? event.touches[0].clientY
          : null;
      if (y !== null && touchY !== null && y !== touchY) {
        input(y < touchY ? "forward" : "backward");
      }
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (
        !event.isTrusted ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.shiftKey && event.key !== " ") ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        retirePlacement();
        void runtime.inspect({
          target: { kind: "edge", edge: event.key === "Home" ? "start" : "end" },
        });
      } else if (event.key === " ") {
        const button =
          event.target instanceof Element && event.target.closest("button");
        if (!button) input(event.shiftKey ? "backward" : "forward");
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        input("forward");
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        input("backward");
      }
    };
    // Scrollbar presses target the scrollport itself; a press that moves nothing settles as Unchanged.
    const pointerDown = (event: PointerEvent) => {
      if (
        !event.isTrusted ||
        event.button !== 0 ||
        event.pointerType === "touch"
      )
        return;
      if (event.target !== port) return;
      retirePlacement();
      const op = runtime.seek();
      if (op) seek = { op, top: port.scrollTop };
    };
    const finish = (cancelled: boolean) => {
      if (!seek) return;
      const { op, top } = seek;
      seek = null;
      if (cancelled) op.cancel();
      else op.settle(port.scrollTop !== top);
    };
    const up = () => finish(false);
    const cancel = () => finish(true);
    const passive = { passive: true };
    port.addEventListener("scroll", scroll, passive);
    port.addEventListener("wheel", wheel, passive);
    port.addEventListener("touchstart", touchStart, passive);
    port.addEventListener("touchmove", touchMove, passive);
    port.addEventListener("keydown", key);
    port.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      port.removeEventListener("scroll", scroll);
      port.removeEventListener("wheel", wheel);
      port.removeEventListener("touchstart", touchStart);
      port.removeEventListener("touchmove", touchMove);
      port.removeEventListener("keydown", key);
      port.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      release?.();
      invalidate.current = () => {};
      cancelAnimationFrame(frame);
      feedbackObserver.disconnect();
      readerFrame.removeAttribute("data-reader-overlay");
      feedback.style.removeProperty("bottom");
      port.style.removeProperty("--reader-feedback-height");
      port.style.removeProperty("--reader-feedback-occlusion-bottom");
      if (idle !== null) clearTimeout(idle);
      indicator.removeAttribute("data-scrolling");
      finish(true);
    };
  }, [ref, runtime, indicatorRef, feedbackRef, geometryChanged]);
  return geometryChanged;
}

/** Resolves on the next frame, or at once when aborted. */
export function nextFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = requestAnimationFrame(() => resolve());
    const abort = () => {
      cancelAnimationFrame(id);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
