// Genuine input on a reader scrollport, and the viewport measured after every
// scroll. Wheel, single-finger drag, scroll keys and scrollbar drags are the
// reader's own movement; everything else (positioning, reflow) is not.
import { useEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import type { ReaderRuntime } from "./runtime";

export function useScrollport(
  ref: RefObject<HTMLElement | null>,
  runtime: ReaderRuntime,
  measure: () => void,
): void {
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const port = ref.current;
    if (!port) return;
    const release = runtime.host?.scrollport?.(port);
    let frame = 0;
    let touchY: number | null = null;
    let seek: {
      op: { settle(moved: boolean): void; cancel(): void };
      top: number;
    } | null = null;
    const scroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        measureRef.current();
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
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        void runtime.inspect({
          kind: "edge",
          edge: event.key === "Home" ? "start" : "end",
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
      finish(true);
      release?.();
    };
  }, [ref, runtime]);
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
