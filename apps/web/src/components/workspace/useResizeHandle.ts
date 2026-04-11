"use client";

import { useCallback, useEffect, useRef } from "react";

interface UseResizeHandleInput {
  paneId: string;
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  onResizePane: (paneId: string, widthPx: number) => void;
}

interface UseResizeHandleReturn {
  handleResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

export function useResizeHandle({
  paneId,
  widthPx,
  minWidthPx,
  maxWidthPx,
  onResizePane,
}: UseResizeHandleInput): UseResizeHandleReturn {
  const resizeCleanupRef = useRef<(() => void) | null>(null);

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
        const nextWidth = Math.min(maxWidthPx, Math.max(minWidthPx, startWidth + delta));
        onResizePane(paneId, nextWidth);
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
    [maxWidthPx, minWidthPx, onResizePane, paneId, widthPx]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onResizePane(paneId, Math.max(minWidthPx, widthPx - 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onResizePane(paneId, Math.min(maxWidthPx, widthPx + 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        onResizePane(paneId, minWidthPx);
      } else if (event.key === "End") {
        event.preventDefault();
        onResizePane(paneId, maxWidthPx);
      }
    },
    [maxWidthPx, minWidthPx, onResizePane, paneId, widthPx]
  );

  return { handleResizeMouseDown, handleResizeKeyDown };
}
