"use client";

import { useRef, useState, useCallback, type KeyboardEvent } from "react";
import styles from "./Pane.module.css";
import SurfaceHeader, {
  type SurfaceHeaderBackAction,
  type SurfaceHeaderNavigation,
  type SurfaceHeaderOption,
} from "@/components/ui/SurfaceHeader";

interface PaneProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: React.ReactNode;
  back?: SurfaceHeaderBackAction;
  navigation?: SurfaceHeaderNavigation;
  options?: SurfaceHeaderOption[];
  headerActions?: React.ReactNode;
  headerMeta?: React.ReactNode;
  header?: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  onClose?: () => void;
  contentClassName?: string;
}

export default function Pane({
  children,
  title,
  subtitle,
  back,
  navigation,
  options,
  headerActions,
  headerMeta,
  header,
  defaultWidth = 480,
  minWidth = 280,
  maxWidth = 900,
  onClose,
  contentClassName,
}: PaneProps) {
  const [width, setWidth] = useState(defaultWidth);
  const paneRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!paneRef.current) return;
        const paneRect = paneRef.current.getBoundingClientRect();
        const newWidth = moveEvent.clientX - paneRect.left;
        const clampedWidth = Math.min(maxWidth, Math.max(minWidth, newWidth));
        setWidth(clampedWidth);
      };

      const handleMouseUp = () => {
        isResizing.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [minWidth, maxWidth]
  );
  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setWidth((current) => Math.max(minWidth, current - 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setWidth((current) => Math.min(maxWidth, current + 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        setWidth(minWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        setWidth(maxWidth);
      }
    },
    [maxWidth, minWidth]
  );

  return (
    <div ref={paneRef} className={styles.pane} style={{ width }}>
      {header
        ? header
        : title && (
            <SurfaceHeader
              title={title}
              subtitle={subtitle}
              back={back}
              navigation={navigation}
              options={options}
              actions={
                <>
                  {headerActions}
                  {onClose && (
                    <button
                      type="button"
                      className={styles.closeBtn}
                      onClick={onClose}
                      aria-label="Close pane"
                    >
                      ×
                    </button>
                  )}
                </>
              }
              meta={headerMeta}
            />
          )}
      <div className={`${styles.content} ${contentClassName ?? ""}`.trim()}>{children}</div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane"
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onKeyDown={handleResizeKeyDown}
      />
    </div>
  );
}
