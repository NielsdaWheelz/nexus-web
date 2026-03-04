"use client";

import { useRef, useState, useCallback } from "react";
import styles from "./Pane.module.css";

interface PaneProps {
  children: React.ReactNode;
  title?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  onClose?: () => void;
  contentClassName?: string;
}

export default function Pane({
  children,
  title,
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

  return (
    <div ref={paneRef} className={styles.pane} style={{ width }}>
      {title && (
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {onClose && (
            <button
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close pane"
            >
              ×
            </button>
          )}
        </div>
      )}
      <div className={`${styles.content} ${contentClassName ?? ""}`}>{children}</div>
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
    </div>
  );
}
