"use client";

import { useCallback, useMemo, useRef, useState } from "react";
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
  copyText?: string;
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
  href,
  onActivate,
  ariaLabel,
}: {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
  href?: string | null;
  onActivate: (target: ReaderSourceTarget, event?: React.MouseEvent) => void;
  ariaLabel?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const citationRef = useRef<HTMLElement | null>(null);
  const activationTarget = useMemo(
    () => (target && href && target.href !== href ? { ...target, href } : target),
    [href, target],
  );

  const captureAnchor = useCallback(() => {
    const element = citationRef.current;
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

  const copyText = preview.copyText;
  const hasPreviewActions = Boolean(activationTarget || href || copyText);
  const externalHref = href?.startsWith("http://") || href?.startsWith("https://");

  const previewBody =
    preview.title || preview.excerpt || (preview.meta && preview.meta.length > 0) || hasPreviewActions ? (
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
        {hasPreviewActions ? (
          <div className={styles.previewActions}>
            {activationTarget ? (
              <button
                type="button"
                className={styles.previewAction}
                onClick={(event) => {
                  event.stopPropagation();
                  onActivate(activationTarget, event);
                  closePreview();
                }}
              >
                Open in context
              </button>
            ) : href ? (
              <a
                className={styles.previewAction}
                href={href}
                target={externalHref ? "_blank" : undefined}
                rel={externalHref ? "noopener noreferrer" : undefined}
                onClick={closePreview}
              >
                Open source
              </a>
            ) : null}
            {copyText ? (
              <button
                type="button"
                className={styles.previewAction}
                onClick={(event) => {
                  event.stopPropagation();
                  void navigator.clipboard.writeText(copyText);
                  closePreview();
                }}
              >
                Copy citation
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    ) : null;

  const className = `${styles.citation} ${colorClass[color]} ${
    activationTarget || href ? "" : styles.unavailable
  }`.trim();

  const label = ariaLabel ?? (activationTarget || href ? `Open citation ${index}` : `Citation ${index}`);
  const previewNode =
    showPreview && anchor && previewBody ? (
      <HoverPreview anchor={anchor} onClose={closePreview}>
        {previewBody}
      </HoverPreview>
    ) : null;

  if (href && !target) {
    return (
      <>
        <a
          ref={(element) => {
            citationRef.current = element;
          }}
          className={className}
          href={href}
          target={externalHref ? "_blank" : undefined}
          rel={externalHref ? "noopener noreferrer" : undefined}
          aria-label={label}
          onPointerEnter={openWithDelay}
          onPointerLeave={cancelHoverTimer}
          onFocus={openWithDelay}
        >
          {index}
        </a>
        {previewNode}
      </>
    );
  }

  if (activationTarget) {
    const canonicalHashHref = activationTarget.href ?? href ?? `/media/${activationTarget.media_id}`;
    return (
      <>
        <a
          ref={(element) => {
            citationRef.current = element;
          }}
          className={className}
          href={canonicalHashHref}
          aria-label={label}
          onPointerEnter={openWithDelay}
          onPointerLeave={cancelHoverTimer}
          onFocus={openWithDelay}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onActivate(activationTarget, event);
          }}
        >
          {index}
        </a>
        {previewNode}
      </>
    );
  }

  return (
    <>
      <sup
        ref={citationRef}
        className={className}
        aria-label={label}
        onPointerEnter={openWithDelay}
        onPointerLeave={cancelHoverTimer}
      >
        {index}
      </sup>
      {previewNode}
    </>
  );
}
