"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { preferredScrollBehavior } from "@/lib/preferredScrollBehavior";
import { useStringIdSet } from "@/lib/useStringIdSet";

const DRAG_THRESHOLD_PX = 4;
const NO_EDGES = { start: false, end: false };
const NONE: ReadonlySet<string> = new Set();

function scrollsVertically(element: HTMLElement): boolean {
  const { overflowY } = window.getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

/**
 * The desktop pane canvas: a vertical wheel over content that cannot scroll,
 * and a drag on a header's empty area, pan it; edge fades and in-view tabs
 * follow its real extent; activation scrolls a pane into view. Disabled
 * (mobile) it does nothing and reports nothing.
 */
export function usePaneCanvas(input: {
  readonly enabled: boolean;
  readonly paneIds: readonly string[];
}) {
  const { enabled } = input;
  const ref = useRef<HTMLDivElement | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const [edges, setEdges] = useState(NO_EDGES);
  const inView = useStringIdSet();
  const { add, remove } = inView;
  const paneIdsKey = input.paneIds.join(",");

  useEffect(() => () => stopDrag.current?.(), []);

  // The extent changes when the canvas resizes or scrolls, and when any pane
  // resizes, minimizes, restores or opens its Companion: observe them all.
  useEffect(() => {
    const canvas = ref.current;
    if (!enabled || !canvas) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
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
    measure();
    canvas.addEventListener("scroll", schedule, { passive: true });
    const resizes = new ResizeObserver(schedule);
    const visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-pane-id");
          if (id && entry.isIntersecting) add(id);
          else if (id) remove(id);
        }
      },
      { root: canvas, threshold: 0 },
    );
    resizes.observe(canvas);
    for (const wrap of canvas.querySelectorAll("[data-pane-id]")) {
      resizes.observe(wrap);
      visibility.observe(wrap);
    }
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("scroll", schedule);
      resizes.disconnect();
      visibility.disconnect();
    };
  }, [enabled, paneIdsKey, add, remove]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const canvas = ref.current;
      if (
        !enabled ||
        !canvas ||
        canvas.scrollWidth <= canvas.clientWidth ||
        event.deltaX !== 0 ||
        event.shiftKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      for (
        let node = target;
        node && node !== canvas;
        node = node.parentElement
      )
        if (node instanceof HTMLElement && scrollsVertically(node)) return;
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
      ref.current
        ?.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
        ?.scrollIntoView({
          inline: "center",
          block: "nearest",
          behavior: preferredScrollBehavior(),
        });
    },
    [enabled],
  );

  return {
    ref,
    onWheel,
    onChromeMouseDown,
    scrollPaneIntoView,
    edges: enabled ? edges : NO_EDGES,
    inViewPaneIds: enabled ? inView.ids : NONE,
  };
}
