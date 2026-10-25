"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import { useStringIdSet } from "@/lib/useStringIdSet";

const DRAG_THRESHOLD_PX = 4;
const NO_EDGES = { start: false, end: false };
const NONE: ReadonlySet<string> = new Set();

function paneGeometry(canvas: HTMLElement, pane: Element) {
  const bounds = pane.getBoundingClientRect();
  return {
    x: bounds.left - canvas.getBoundingClientRect().left + canvas.scrollLeft,
    width: bounds.width,
    canvasWidth: canvas.clientWidth,
  };
}

function scrollsVertically(element: HTMLElement): boolean {
  const { overflowY } = window.getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

function reachesCanvas(
  target: EventTarget | null,
  canvas: HTMLElement,
  dx: number,
): boolean {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== canvas;
    node = node.parentElement
  ) {
    if (!(node instanceof HTMLElement)) continue;
    const { overflowX, overscrollBehaviorX } = getComputedStyle(node);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    if (
      overscrollBehaviorX === "contain" ||
      overscrollBehaviorX === "none" ||
      (dx < 0 && node.scrollLeft > 0) ||
      (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
    )
      return false;
  }
  return true;
}

/**
 * The desktop pane canvas: a vertical wheel over content that cannot scroll,
 * and a drag on a header's empty area, pan it; edge fades and in-view chips
 * follow its real extent; activation scrolls a pane into view. Disabled
 * (mobile) it does nothing and reports nothing.
 */
export function usePaneCanvas(input: {
  readonly mode: "Disabled" | "Canvas" | "Maximized";
  readonly paneIds: readonly string[];
}) {
  const { mode } = input;
  const enabled = mode === "Canvas";
  const ref = useRef<HTMLDivElement | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const heldPane = useRef<
    ({ readonly id: string } & ReturnType<typeof paneGeometry>) | null
  >(null);
  const [edges, setEdges] = useState(NO_EDGES);
  const [measurement, setMeasurement] = useState<{
    mode: "Canvas" | "Maximized";
    widthPx: number;
  } | null>(null);
  const inView = useStringIdSet();
  const { add, remove } = inView;
  const paneIdsKey = input.paneIds.join(",");
  const releaseHeldTarget = useCallback(() => {
    heldPane.current = null;
  }, []);

  useLayoutEffect(() => {
    if (mode === "Canvas") return;
    stopDrag.current?.();
    heldPane.current = null;
    if (mode === "Disabled") setMeasurement(null);
  }, [mode]);

  useEffect(
    () => () => {
      stopDrag.current?.();
      heldPane.current = null;
    },
    [],
  );

  // Activation owns exposure until the user pans the canvas. Reading and
  // controls inside a pane keep their own vertical, typing and key behavior.
  useEffect(() => {
    const canvas = ref.current;
    if (!enabled || !canvas) {
      heldPane.current = null;
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof Node) ||
        !canvas.contains(event.target) ||
        isEditableTarget(event.target)
      )
        return;
      if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        (event.target === canvas &&
          (event.key === "Home" || event.key === "End"))
      ) {
        const dx = event.key === "ArrowLeft" || event.key === "Home" ? -1 : 1;
        if (!reachesCanvas(event.target, canvas, dx)) return;
        heldPane.current = null;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== canvas) return;
      const bounds = canvas.getBoundingClientRect();
      const gutterTop = bounds.top + canvas.clientTop + canvas.clientHeight;
      const gutterBottom =
        bounds.bottom - parseFloat(getComputedStyle(canvas).borderBottomWidth);
      if (
        event.clientY >= gutterTop &&
        event.clientY < gutterBottom &&
        event.clientX >= bounds.left + canvas.clientLeft &&
        event.clientX < bounds.left + canvas.clientLeft + canvas.clientWidth
      )
        heldPane.current = null;
    };
    let touchStart: { x: number; y: number; lastX: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      touchStart = touch
        ? { x: touch.clientX, y: touch.clientY, lastX: touch.clientX }
        : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (event.defaultPrevented || !touch || !touchStart) return;
      const dx = Math.abs(touch.clientX - touchStart.x);
      const dy = Math.abs(touch.clientY - touchStart.y);
      const direction = touchStart.lastX - touch.clientX;
      touchStart.lastX = touch.clientX;
      if (
        dx >= DRAG_THRESHOLD_PX &&
        dx > dy &&
        direction !== 0 &&
        reachesCanvas(event.target, canvas, direction)
      ) {
        heldPane.current = null;
        touchStart = null;
      }
    };
    const onTouchEnd = () => {
      touchStart = null;
    };
    // React controls consume keys at the root before this window listener.
    window.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: true });
    canvas.addEventListener("touchend", onTouchEnd, { passive: true });
    canvas.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled]);

  // The extent changes when the canvas resizes or scrolls, and when any pane
  // resizes, minimizes, restores or opens its Companion: observe them all.
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (mode === "Disabled" || !canvas) return;
    if (
      heldPane.current &&
      !canvas.querySelector(`[data-pane-id="${CSS.escape(heldPane.current.id)}"]`)
    )
      heldPane.current = null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const shell = mode === "Maximized"
        ? canvas.querySelector<HTMLElement>("[data-pane-id]:not([hidden]) [data-pane-shell]")
        : null;
      const shellStyle = shell ? getComputedStyle(shell) : null;
      const borderPx = shellStyle
        ? parseFloat(shellStyle.borderInlineStartWidth) + parseFloat(shellStyle.borderInlineEndWidth)
        : 0;
      const widthPx = canvas.clientWidth - borderPx;
      setMeasurement((current) =>
        current?.mode === mode && current.widthPx === widthPx
          ? current
          : { mode, widthPx },
      );
      if (!enabled) return;
      const start = canvas.scrollLeft > 0;
      const end =
        canvas.scrollLeft + canvas.clientWidth < canvas.scrollWidth - 1;
      setEdges((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    const resize = () => {
      const held = enabled ? heldPane.current : null;
      if (held) {
        const pane = canvas.querySelector(
          `[data-pane-id="${CSS.escape(held.id)}"]`,
        );
        if (!pane) heldPane.current = null;
        else {
          const next = paneGeometry(canvas, pane);
          if (
            Math.abs(next.x - held.x) >= 1 ||
            Math.abs(next.width - held.width) >= 1 ||
            next.canvasWidth !== held.canvasWidth
          ) {
            heldPane.current = { id: held.id, ...next };
            pane.scrollIntoView({
              inline: "nearest",
              block: "nearest",
              behavior: "instant",
            });
          }
        }
      }
      schedule();
    };
    measure();
    if (enabled) canvas.addEventListener("scroll", schedule, { passive: true });
    const resizes = new ResizeObserver(resize);
    const visibility = enabled ? new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-pane-id");
          if (id && entry.isIntersecting) add(id);
          else if (id) remove(id);
        }
      },
      { root: canvas, threshold: 0 },
    ) : null;
    resizes.observe(canvas);
    for (const wrap of canvas.querySelectorAll("[data-pane-id]")) {
      resizes.observe(wrap);
      visibility?.observe(wrap);
    }
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("scroll", schedule);
      resizes.disconnect();
      visibility?.disconnect();
    };
  }, [mode, enabled, paneIdsKey, add, remove]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const canvas = ref.current;
      if (!enabled || !canvas || event.defaultPrevented || event.ctrlKey) return;
      if (event.deltaX !== 0 || event.shiftKey) {
        const dx = event.deltaX || event.deltaY;
        if (dx !== 0 && reachesCanvas(event.target, canvas, dx))
          heldPane.current = null;
        return;
      }
      if (canvas.scrollWidth <= canvas.clientWidth) return;
      const target = event.target instanceof Element ? event.target : null;
      for (
        let node = target;
        node && node !== canvas;
        node = node.parentElement
      )
        if (node instanceof HTMLElement && scrollsVertically(node)) return;
      if (event.deltaY !== 0) heldPane.current = null;
      canvas.scrollLeft += event.deltaY;
    },
    [enabled],
  );

  const onChromeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const canvas = ref.current;
      if (
        !enabled ||
        !canvas ||
        event.button !== 0 ||
        (event.target instanceof Element &&
          event.target.closest(
            "button, a, input, select, textarea, [role='button'], [contenteditable]",
          ))
      )
        return;
      stopDrag.current?.();
      const startX = event.clientX;
      const startScrollLeft = canvas.scrollLeft;
      const doc = event.currentTarget.ownerDocument;
      let dragging = false;
      const move = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (!dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        if (!dragging) {
          dragging = true;
          heldPane.current = null;
          doc.body.style.cursor = "grabbing";
          doc.body.style.userSelect = "none";
        }
        canvas.scrollLeft = startScrollLeft - dx;
      };
      const stop = () => {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        doc.removeEventListener("mousemove", move);
        doc.removeEventListener("mouseup", stop);
        stopDrag.current = null;
      };
      doc.addEventListener("mousemove", move);
      doc.addEventListener("mouseup", stop);
      stopDrag.current = stop;
    },
    [enabled],
  );

  const scrollPaneIntoView = useCallback(
    (paneId: string) => {
      if (!enabled) return;
      const canvas = ref.current;
      const pane = canvas?.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`);
      if (!canvas || !pane) return;
      heldPane.current = { id: paneId, ...paneGeometry(canvas, pane) };
      pane.scrollIntoView({
        inline: "center",
        block: "nearest",
        behavior: "instant",
      });
    },
    [enabled],
  );

  return {
    ref,
    onWheel,
    onChromeMouseDown,
    scrollPaneIntoView,
    releaseHeldTarget,
    availableWidthPx: mode !== "Disabled" && measurement?.mode === mode
      ? measurement.widthPx
      : null,
    edges: enabled ? edges : NO_EDGES,
    inViewPaneIds: enabled ? inView.ids : NONE,
  };
}
