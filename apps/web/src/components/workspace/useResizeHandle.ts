"use client";

import { useCallback, useEffect, useRef } from "react";

interface UseResizeHandleInput {
  id: string;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  onResize: (id: string, widthPx: number) => void;
}

interface UseResizeHandleReturn {
  handleResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

export function useResizeHandle({
  id,
  widthPx,
  minWidthPx,
  maxWidthPx,
  onResize,
}: UseResizeHandleInput): UseResizeHandleReturn {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const clamp = useCallback(
    (value: number) => Math.min(maxWidthPx, Math.max(minWidthPx, value)),
    [maxWidthPx, minWidthPx]
  );

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    []
  );

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      resizeCleanupRef.current?.();

      const startX = event.clientX;
      const startWidth = widthPx;
      const doc = event.currentTarget.ownerDocument;
      const cleanup = () => {
        doc.body.style.cursor = "";
        doc.body.style.userSelect = "";
        doc.removeEventListener("mousemove", handleMouseMove);
        doc.removeEventListener("mouseup", handleMouseUp);
        resizeCleanupRef.current = null;
      };
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        onResize(id, clamp(startWidth + delta));
      };
      const handleMouseUp = () => {
        cleanup();
      };

      doc.body.style.cursor = "col-resize";
      doc.body.style.userSelect = "none";
      doc.addEventListener("mousemove", handleMouseMove);
      doc.addEventListener("mouseup", handleMouseUp);
      resizeCleanupRef.current = cleanup;
    },
    [clamp, id, onResize, widthPx]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onResize(id, clamp(widthPx - 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onResize(id, clamp(widthPx + 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        onResize(id, minWidthPx);
      } else if (event.key === "End") {
        event.preventDefault();
        onResize(id, maxWidthPx);
      }
    },
    [clamp, id, maxWidthPx, minWidthPx, onResize, widthPx]
  );

  return { handleResizeMouseDown, handleResizeKeyDown };
}
