"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import styles from "./Pane.module.css";

interface PaneProps {
  children: React.ReactNode;
  title?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  onClose?: () => void;
}

export default function Pane({
  children,
  title,
  defaultWidth = 480,
  minWidth = 280,
  maxWidth = 900,
  onClose,
}: PaneProps) {
  const [width, setWidth] = useState(defaultWidth);
  const paneRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current || !paneRef.current) return;

      const paneRect = paneRef.current.getBoundingClientRect();
      const newWidth = e.clientX - paneRect.left;
      const clampedWidth = Math.min(maxWidth, Math.max(minWidth, newWidth));
      setWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [minWidth, maxWidth]);

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
      <div className={styles.content}>{children}</div>
      <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
    </div>
  );
}
