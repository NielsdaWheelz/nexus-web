"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useStringIdSet } from "@/lib/useStringIdSet";
import { preferredScrollBehavior } from "@/lib/preferredScrollBehavior";

const PANE_CANVAS_DRAG_THRESHOLD_PX = 4;
const EMPTY_EDGES = { atStart: false, atEnd: false };
const EMPTY_IN_VIEW_PANE_IDS = new Set<string>();

function wheelTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export function usePaneCanvas({
  mode,
  paneIds,
}: {
  mode: "desktop" | "disabled";
  paneIds: readonly string[];
}) {
  const enabled = mode === "desktop";
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [edges, setEdges] = useState(EMPTY_EDGES);
  const inViewPaneIds = useStringIdSet();
  const {
    add: markPaneInView,
    remove: markPaneOutOfView,
    clear: clearPanesInView,
  } = inViewPaneIds;

  const paneIdsKey = paneIds.join(",");

  useEffect(
    () => () => {
      cleanupRef.current?.();
    },
    []
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!enabled) {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      if (canvas.scrollWidth <= canvas.clientWidth) {
        return;
      }
      if (event.deltaX !== 0) {
        return;
      }
      if (event.shiftKey) {
        return;
      }
      let node = wheelTargetElement(event.target);
      while (node && node !== canvas) {
        if (node.scrollHeight > node.clientHeight) {
          return;
        }
        node = node.parentElement;
      }
      canvas.scrollLeft += event.deltaY;
    },
    [enabled]
  );

  const handleChromeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest(
          "button, a, input, select, textarea, [role='button'], [contenteditable]"
        )
      ) {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      cleanupRef.current?.();

      const startX = event.clientX;
      const startScrollLeft = canvas.scrollLeft;
      const doc = event.currentTarget.ownerDocument;
      let dragging = false;
      const cleanup = () => {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        doc.removeEventListener("mousemove", handleMouseMove);
        doc.removeEventListener("mouseup", handleMouseUp);
        cleanupRef.current = null;
      };
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (!dragging && Math.abs(dx) < PANE_CANVAS_DRAG_THRESHOLD_PX) {
          return;
        }
        if (!dragging) {
          dragging = true;
          doc.body.style.cursor = "grabbing";
          doc.body.style.userSelect = "none";
        }
        canvas.scrollLeft = startScrollLeft - dx;
      };
      const handleMouseUp = () => {
        cleanup();
      };

      doc.addEventListener("mousemove", handleMouseMove);
      doc.addEventListener("mouseup", handleMouseUp);
      cleanupRef.current = cleanup;
    },
    [enabled]
  );

  const measureEdges = useCallback(() => {
    if (!enabled) {
      setEdges(EMPTY_EDGES);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    setEdges({
      atStart: canvas.scrollLeft > 0,
      atEnd: canvas.scrollLeft + canvas.clientWidth < canvas.scrollWidth - 1,
    });
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      return;
    }
    cleanupRef.current?.();
    if (scrollFrameRef.current != null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    setEdges(EMPTY_EDGES);
    clearPanesInView();
  }, [enabled, clearPanesInView]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    measureEdges();

    const handleScroll = () => {
      if (scrollFrameRef.current != null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        measureEdges();
      });
    };

    canvas.addEventListener("scroll", handleScroll, { passive: true });
    const observer = new ResizeObserver(measureEdges);
    observer.observe(canvas);
    return () => {
      canvas.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current != null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      observer.disconnect();
    };
  }, [enabled, paneIdsKey, measureEdges]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-pane-id");
          if (!id) {
            continue;
          }
          if (entry.isIntersecting) {
            markPaneInView(id);
          } else {
            markPaneOutOfView(id);
          }
        }
      },
      { root: canvas, threshold: 0 }
    );
    for (const wrap of canvas.querySelectorAll("[data-pane-id]")) {
      observer.observe(wrap);
    }
    return () => observer.disconnect();
  }, [enabled, paneIdsKey, markPaneInView, markPaneOutOfView]);

  const scrollPaneIntoView = useCallback((paneId: string) => {
    if (!enabled) {
      return;
    }
    canvasRef.current
      ?.querySelector('[data-pane-id="' + CSS.escape(paneId) + '"]')
      ?.scrollIntoView({
        inline: "center",
        block: "nearest",
        behavior: preferredScrollBehavior(),
      });
  }, [enabled]);

  return {
    canvasRef,
    onWheel,
    edges: enabled ? edges : EMPTY_EDGES,
    inViewPaneIds: enabled ? inViewPaneIds.ids : EMPTY_IN_VIEW_PANE_IDS,
    handleChromeMouseDown,
    scrollPaneIntoView,
  };
}
