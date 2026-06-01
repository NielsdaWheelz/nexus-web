"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./HoverPreview.module.css";

interface HoverPreviewAnchor {
  x: number;
  y: number;
}

export default function HoverPreview({
  anchor,
  children,
  onClose,
}: {
  anchor: HoverPreviewAnchor | "auto";
  children: ReactNode;
  onClose: () => void;
}) {
  const [touchSheet, setTouchSheet] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(hover: none)");
    setTouchSheet(query.matches);
    function onChange(event: MediaQueryListEvent) {
      setTouchSheet(event.matches);
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Key on the x/y primitives so a fresh {x,y} from the caller can't churn the
  // position effect into a loop; a point is a zero-size rect to anchor to.
  const pointX = anchor === "auto" ? null : anchor.x;
  const pointY = anchor === "auto" ? null : anchor.y;
  const anchorRect = useMemo(
    () =>
      pointX === null || pointY === null
        ? null
        : new DOMRect(pointX, pointY, 0, 0),
    [pointX, pointY],
  );
  const { ref: cardRef, style } = useAnchoredPosition(anchorRect, {
    enabled: !touchSheet && anchor !== "auto",
    placement: "above",
    align: "center",
    gap: 8,
    flip: true,
  });

  const preview = touchSheet ? (
      <div className={styles.sheetBackdrop} onClick={onClose} role="presentation">
        <div
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </div>
    ) : (
    <div
      ref={cardRef}
      className={styles.card}
      role="tooltip"
      style={style}
      onPointerLeave={onClose}
    >
      {children}
    </div>
  );

  return typeof document === "undefined" ? preview : createPortal(preview, document.body);
}

export const HOVER_PREVIEW_DELAY_MS = 150;
