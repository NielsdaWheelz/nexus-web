"use client";

import { useCallback, useRef, useState } from "react";
import HoverPreview, { HOVER_PREVIEW_DELAY_MS } from "@/components/ui/HoverPreview";
import { truncateText } from "@/lib/conversations/display";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import styles from "./ReaderCitation.module.css";

export type ReaderCitationColor =
  | "yellow"
  | "green"
  | "blue"
  | "pink"
  | "purple"
  | "neutral";

export interface ReaderCitationPreview {
  title?: string;
  excerpt?: string;
  meta?: string[];
}

const colorClass = {
  yellow: styles.yellow,
  green: styles.green,
  blue: styles.blue,
  pink: styles.pink,
  purple: styles.purple,
  neutral: styles.neutral,
} satisfies Record<ReaderCitationColor, string>;

export default function ReaderCitation({
  index,
  color,
  preview,
  target,
  onActivate,
  ariaLabel,
}: {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
  onActivate: (target: ReaderSourceTarget) => void;
  ariaLabel?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const supRef = useRef<HTMLElement | null>(null);

  const captureAnchor = useCallback(() => {
    const element = supRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top };
  }, []);

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const openWithDelay = useCallback(() => {
    cancelHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      const next = captureAnchor();
      setAnchor(next);
      setShowPreview(true);
    }, HOVER_PREVIEW_DELAY_MS);
  }, [cancelHoverTimer, captureAnchor]);

  const closePreview = useCallback(() => {
    cancelHoverTimer();
    setShowPreview(false);
  }, [cancelHoverTimer]);

  const handleClick = useCallback(() => {
    if (!target) return;
    onActivate(target);
  }, [onActivate, target]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!target) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(target);
      }
    },
    [onActivate, target],
  );

  const previewBody =
    preview.title || preview.excerpt || (preview.meta && preview.meta.length > 0) ? (
      <>
        {preview.title ? <div className={styles.previewTitle}>{truncateText(preview.title, 96)}</div> : null}
        {preview.excerpt ? (
          <div className={styles.previewExcerpt}>{preview.excerpt}</div>
        ) : null}
        {preview.meta?.map((entry, i) => (
          <div key={i} className={styles.previewMeta}>
            {entry}
          </div>
        ))}
      </>
    ) : null;

  const className = `${styles.citation} ${colorClass[color]} ${
    target ? "" : styles.unavailable
  }`.trim();

  return (
    <sup
      ref={supRef}
      className={className}
      role={target ? "button" : undefined}
      tabIndex={target ? 0 : -1}
      aria-label={ariaLabel ?? (target ? `Open citation ${index}` : `Citation ${index}`)}
      onPointerEnter={openWithDelay}
      onPointerLeave={closePreview}
      onFocus={openWithDelay}
      onBlur={closePreview}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {index}
      {showPreview && anchor && previewBody ? (
        <HoverPreview anchor={anchor} onClose={closePreview}>
          {previewBody}
        </HoverPreview>
      ) : null}
    </sup>
  );
}
