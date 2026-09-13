"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import HoverPreview, {
  HOVER_PREVIEW_DELAY_MS,
} from "@/components/ui/HoverPreview";
import { truncateText } from "@/lib/conversations/display";
import type { ReaderCitationPreview } from "@/lib/conversations/readerCitation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import {
  hrefForResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import styles from "./ReaderCitation.module.css";
import {
  ClipboardWriteUnavailableError,
  copyText as copyToClipboard,
} from "@/lib/ui/copyText";
import {
  FeedbackNotice,
  useFeedback,
} from "@/components/feedback/Feedback";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { secondaryActivationForResource } from "@/lib/resources/activation";

export default function ReaderCitation({
  index,
  preview,
  activation,
  target,
  onActivate,
}: {
  index: number;
  preview: ReaderCitationPreview;
  activation: ResourceActivation;
  target: ReaderSourceTarget | null;
  onActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const feedback = useFeedback();
  const paneRuntime = usePaneRuntime();
  const href = hrefForResourceActivation(activation);
  const [showPreview, setShowPreview] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const [copyFailure, setCopyFailure] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const citationRef = useRef<HTMLElement | null>(null);
  const activationTarget = useMemo(
    () =>
      target && href && target.href !== href ? { ...target, href } : target,
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
  const externalHref =
    href?.startsWith("http://") || href?.startsWith("https://");
  const copyCitation = useCallback(async () => {
    if (!copyText) return;
    try {
      await copyToClipboard(copyText);
      setCopyFailure(false);
      feedback.publish({
        kind: "Hud",
        content: {
          tone: "Success",
          title: "Citation copied",
        },
      });
      closePreview();
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) {
        setAsyncDefect({ error });
        return;
      }
      setCopyFailure(true);
    }
  }, [closePreview, copyText, feedback]);

  const previewBody =
    preview.title ||
    preview.summary ||
    preview.excerpt ||
    (preview.meta && preview.meta.length > 0) ||
    hasPreviewActions ? (
      <>
        {preview.title ? (
          <div className={styles.previewTitle}>
            {truncateText(preview.title, 96)}
          </div>
        ) : null}
        {preview.summary ? (
          <div className={styles.previewSummary}>
            {truncateText(preview.summary, 140)}
          </div>
        ) : null}
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
                  onActivate(activation, activationTarget, event);
                  closePreview();
                }}
              >
                Open in context
              </button>
            ) : href ? (
              <button
                type="button"
                className={styles.previewAction}
                onClick={(event) => {
                  event.stopPropagation();
                  onActivate(activation, null, event);
                  closePreview();
                }}
              >
                Open source
              </button>
            ) : null}
            {copyText && !copyFailure ? (
              <button
                type="button"
                className={styles.previewAction}
                onClick={(event) => {
                  event.stopPropagation();
                  void copyCitation();
                }}
              >
                Copy citation
              </button>
            ) : null}
          </div>
        ) : null}
        {copyFailure ? (
          <FeedbackNotice
            content={{ tone: "Danger", title: "Citation wasn’t copied" }}
            announcement="Assertive"
            actions={[{ label: "Retry", onClick: () => void copyCitation() }]}
          />
        ) : null}
      </>
    ) : null;

  const className = `${styles.citation} ${
    activationTarget || href ? "" : styles.unavailable
  }`.trim();

  const label =
    activationTarget || href ? `Open citation ${index}` : `Citation ${index}`;
  const previewNode =
    showPreview && anchor && previewBody ? (
      <HoverPreview anchor={anchor} onClose={closePreview}>
        {previewBody}
      </HoverPreview>
    ) : null;

  if (asyncDefect !== null) throw asyncDefect.error;

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
          onClick={(event) => {
            onActivate(activation, null, event);
            if (event.defaultPrevented) return;
            activateTargetLink({
              event,
              runtime: paneRuntime,
              href,
              secondaryActivation:
                secondaryActivationForResource(activation) ?? undefined,
              sourceAnchor: event.currentTarget,
            });
          }}
          data-workspace-rich-target="true"
          data-pane-find-exclude="true"
        >
          {index}
        </a>
        {previewNode}
      </>
    );
  }

  if (activationTarget) {
    const targetHref = activationTarget.href ?? href ?? null;
    if (!targetHref) {
      return (
        <>
          <button
            ref={(element) => {
              citationRef.current = element;
            }}
            type="button"
            className={className}
            aria-label={label}
            onPointerEnter={openWithDelay}
            onPointerLeave={cancelHoverTimer}
            onFocus={openWithDelay}
            onClick={(event) => {
              onActivate(activation, activationTarget, event);
            }}
            data-pane-find-exclude="true"
          >
            {index}
          </button>
          {previewNode}
        </>
      );
    }
    return (
      <>
        <a
          ref={(element) => {
            citationRef.current = element;
          }}
          className={className}
          href={targetHref}
          aria-label={label}
          onPointerEnter={openWithDelay}
          onPointerLeave={cancelHoverTimer}
          onFocus={openWithDelay}
          onClick={(event) => {
            onActivate(activation, activationTarget, event);
            if (event.defaultPrevented) return;
            activateTargetLink({
              event,
              runtime: paneRuntime,
              href: targetHref,
              labelHint: activationTarget.label,
              secondaryActivation:
                secondaryActivationForResource(activation) ?? undefined,
              sourceAnchor: event.currentTarget,
            });
          }}
          data-workspace-rich-target="true"
          data-pane-find-exclude="true"
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
        data-pane-find-exclude="true"
      >
        {index}
      </sup>
      {previewNode}
    </>
  );
}
