"use client";

import { useEffect, useRef } from "react";
import styles from "./ResizeHandle.module.css";

/**
 * A column's right-edge separator: drag, or ←/→ (16px), Home, End. It reports
 * clamped widths; the owner stores them.
 */
export default function ResizeHandle(props: {
  readonly label: string;
  /** The id of the region it resizes. */
  readonly controls: string;
  readonly widthPx: number;
  readonly minWidthPx: number;
  readonly maxWidthPx: number;
  readonly onResize: (widthPx: number) => void;
}) {
  const { widthPx, minWidthPx, maxWidthPx, onResize } = props;
  const clamp = (value: number) =>
    Math.min(maxWidthPx, Math.max(minWidthPx, value));
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  return (
    <div
      className={styles.handle}
      role="separator"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-orientation="vertical"
      aria-valuemin={minWidthPx}
      aria-valuemax={maxWidthPx}
      aria-valuenow={widthPx}
      tabIndex={0}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        stopDrag.current?.();
        const startX = event.clientX;
        const doc = event.currentTarget.ownerDocument;
        const move = (moveEvent: MouseEvent) =>
          onResize(clamp(widthPx + moveEvent.clientX - startX));
        const stop = () => {
          doc.body.style.cursor = "";
          doc.body.style.userSelect = "";
          doc.removeEventListener("mousemove", move);
          doc.removeEventListener("mouseup", stop);
          stopDrag.current = null;
        };
        doc.body.style.cursor = "col-resize";
        doc.body.style.userSelect = "none";
        doc.addEventListener("mousemove", move);
        doc.addEventListener("mouseup", stop);
        stopDrag.current = stop;
      }}
      onKeyDown={(event) => {
        const byKey: Partial<Record<string, number>> = {
          ArrowLeft: clamp(widthPx - 16),
          ArrowRight: clamp(widthPx + 16),
          Home: minWidthPx,
          End: maxWidthPx,
        };
        const next = byKey[event.key];
        if (next === undefined) return;
        event.preventDefault();
        onResize(next);
      }}
    />
  );
}
