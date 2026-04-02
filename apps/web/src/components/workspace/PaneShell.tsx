"use client";

import { useCallback, useEffect, useRef } from "react";
import SurfaceHeader, { type SurfaceHeaderOption } from "@/components/ui/SurfaceHeader";
import styles from "./PaneShell.module.css";

export type PaneBodyMode = "standard" | "document";

interface PaneShellProps {
  paneId: string;
  title: string;
  subtitle?: React.ReactNode;
  toolbar?: React.ReactNode;
  actions?: React.ReactNode;
  options?: SurfaceHeaderOption[];
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  bodyMode: PaneBodyMode;
  onResizePane: (paneId: string, widthPx: number) => void;
  isActive?: boolean;
  isMobile?: boolean;
  children: React.ReactNode;
}

export default function PaneShell({
  paneId,
  title,
  subtitle,
  toolbar,
  actions,
  options,
  widthPx,
  minWidthPx,
  maxWidthPx,
  bodyMode,
  onResizePane,
  isActive = false,
  isMobile = false,
  children,
}: PaneShellProps) {
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

  return (
    <section
      className={styles.paneShell}
      data-pane-shell="true"
      data-active={isActive ? "true" : "false"}
      data-mobile={isMobile ? "true" : "false"}
      style={
        isMobile
          ? { width: "100%", minWidth: "100%", maxWidth: "100%" }
          : { width: `${widthPx}px`, minWidth: `${minWidthPx}px`, maxWidth: `${maxWidthPx}px` }
      }
    >
      <div
        className={styles.chrome}
        data-testid="pane-shell-chrome"
        data-pane-chrome-focus="true"
        tabIndex={-1}
      >
        <SurfaceHeader title={title} subtitle={subtitle} options={options} actions={actions} />
        {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      </div>
      <div
        className={styles.body}
        data-testid="pane-shell-body"
        data-body-mode={bodyMode}
        data-pane-content="true"
        style={
          bodyMode === "document"
            ? {
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflow: "hidden",
              }
            : {
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflowY: "auto",
                overflowX: "hidden",
              }
        }
      >
        {children}
      </div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label={`Resize pane ${title}`}
        aria-orientation="vertical"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
      />
    </section>
  );
}
