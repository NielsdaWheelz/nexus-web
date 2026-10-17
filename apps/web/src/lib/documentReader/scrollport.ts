// Genuine input on a reader scrollport, and the viewport measured after every
// scroll. Wheel, single-finger drag, scroll keys and scrollbar drags are the
// reader's own movement; everything else (positioning, reflow) is not.
import { useEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import type { ReaderRuntime } from "./runtime";

const SCROLL_INDICATOR_IDLE_MS = 400;

/** Visible content bounds, excluding the mobile chrome/keyboard padding. */
export function measureScrollport(port: HTMLElement | null): DOMRect | null {
  if (!port?.isConnected) return null;
  const rect = port.getBoundingClientRect();
  const style = getComputedStyle(port);
  const top = Number.parseFloat(style.paddingTop) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  const height = port.clientHeight - top - bottom;
  return port.clientWidth > 0 && height > 0
    ? new DOMRect(rect.left + port.clientLeft, rect.top + port.clientTop + top, port.clientWidth, height)
    : null;
}

export function useScrollport(
  ref: RefObject<HTMLElement | null>,
  runtime: ReaderRuntime,
  measure: () => void,
  indicatorRef: RefObject<HTMLDivElement | null>,
): void {
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const port = ref.current;
    if (!port) return;
    const release = runtime.host?.scrollport?.(port);
    // justify-type-assertion: DocumentReader mounts its indicator before surface effects run.
    const indicator = indicatorRef.current!;
    let frame = 0;
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
      // justify-type-assertion: DocumentReader owns the indicator as a direct frame child.
      const frameBounds = indicator.parentElement!.getBoundingClientRect();
      const portBounds = port.getBoundingClientRect();
      const portStyle = getComputedStyle(port);
      indicator.style.setProperty(
        "--scroll-indicator-inset-top",
        `${portBounds.top - frameBounds.top + Number.parseFloat(portStyle.paddingTop)}px`,
      );
      indicator.style.setProperty(
        "--scroll-indicator-inset-bottom",
        `${frameBounds.bottom - portBounds.bottom + Number.parseFloat(portStyle.paddingBottom)}px`,
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
    const scroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        measureRef.current();
        paintIndicator();
      });
    };
    const wheel = (event: WheelEvent) => {
      if (event.isTrusted && !event.ctrlKey && event.deltaY !== 0) {
        runtime.input(event.deltaY > 0 ? "forward" : "backward");
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
        runtime.input(y < touchY ? "forward" : "backward");
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
        void runtime.inspect({
          target: { kind: "edge", edge: event.key === "Home" ? "start" : "end" },
        });
      } else if (event.key === " ") {
        const button =
          event.target instanceof Element && event.target.closest("button");
        if (!button) runtime.input(event.shiftKey ? "backward" : "forward");
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        runtime.input("forward");
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        runtime.input("backward");
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
      cancelAnimationFrame(frame);
      if (idle !== null) clearTimeout(idle);
      indicator.removeAttribute("data-scrolling");
      finish(true);
      release?.();
    };
  }, [ref, runtime, indicatorRef]);
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
