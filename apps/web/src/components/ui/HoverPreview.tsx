"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./HoverPreview.module.css";

export interface HoverPreviewAnchor {
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
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
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

  useLayoutEffect(() => {
    if (touchSheet || anchor === "auto") {
      setPosition(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const margin = 8;
    let left = anchor.x - cardRect.width / 2;
    let top = anchor.y - cardRect.height - margin;
    if (left < margin) left = margin;
    if (left + cardRect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - cardRect.width;
    }
    if (top < margin) {
      top = anchor.y + margin;
    }
    setPosition({ left, top });
  }, [anchor, touchSheet]);

  if (touchSheet) {
    return (
      <div className={styles.sheetBackdrop} onClick={onClose} role="presentation">
        <div
          ref={cardRef}
          className={styles.sheet}
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className={styles.card}
      role="tooltip"
      style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
      onPointerLeave={onClose}
    >
      {children}
    </div>
  );
}

export const HOVER_PREVIEW_DELAY_MS = 150;
