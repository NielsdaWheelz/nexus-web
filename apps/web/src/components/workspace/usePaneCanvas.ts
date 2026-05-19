"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PANE_CANVAS_DRAG_THRESHOLD_PX = 4;

export function usePaneCanvas({
  enabled,
  paneIds,
}: {
  enabled: boolean;
  paneIds: string[];
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [edges, setEdges] = useState({ atStart: false, atEnd: false });
  const [inViewPaneIds, setInViewPaneIds] = useState<Set<string>>(new Set());

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
      let node: HTMLElement | null = event.target as HTMLElement;
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
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    setEdges({
      atStart: canvas.scrollLeft > 0,
      atEnd: canvas.scrollLeft + canvas.clientWidth < canvas.scrollWidth - 1,
    });
  }, []);

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
        setInViewPaneIds((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const id = entry.target.getAttribute("data-pane-id");
            if (!id) {
              continue;
            }
            if (entry.isIntersecting) {
              next.add(id);
            } else {
              next.delete(id);
            }
          }
          return next;
        });
      },
      { root: canvas, threshold: 0 }
    );
    for (const wrap of canvas.querySelectorAll("[data-pane-id]")) {
      observer.observe(wrap);
    }
    return () => observer.disconnect();
  }, [enabled, paneIdsKey]);

  const scrollPaneIntoView = useCallback((paneId: string) => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? "auto"
      : "smooth";
    canvasRef.current
      ?.querySelector('[data-pane-id="' + CSS.escape(paneId) + '"]')
      ?.scrollIntoView({ inline: "center", block: "nearest", behavior });
  }, []);

  return {
    canvasRef,
    onWheel,
    edges,
    inViewPaneIds,
    handleChromeMouseDown,
    scrollPaneIntoView,
  };
}
