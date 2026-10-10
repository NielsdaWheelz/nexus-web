"use client";

import { useCallback, useMemo, useState } from "react";
import { useHoverPreview } from "@/components/ui/HoverPreview";
import { truncateText } from "@/lib/display/format";
import type {
  ReaderCitationPreview,
  ReaderSourceTarget,
} from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
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
  const href = activation.href;
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const [copyFailure, setCopyFailure] = useState(false);
  const activationTarget = useMemo(
    () =>
      target && href && target.href !== href ? { ...target, href } : target,
    [href, target],
  );

  const copyText = preview.copyText;
  const hasPreviewActions = Boolean(activationTarget || href || copyText);
  const hover = useHoverPreview(
    Boolean(
      preview.title ||
      preview.summary ||
      preview.excerpt ||
      (preview.meta && preview.meta.length > 0) ||
      hasPreviewActions,
    ),
  );
  const closePreview = hover.close;
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

  const previewNode = hover.render(
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
    </>,
  );

  const className = `${styles.citation} ${
    activationTarget || href ? "" : styles.unavailable
  }`.trim();

  const label =
    activationTarget || href ? `Open citation ${index}` : `Citation ${index}`;
  if (asyncDefect !== null) throw asyncDefect.error;

  if (href && !target) {
    return (
      <>
        <a
          className={className}
          href={href}
          target={externalHref ? "_blank" : undefined}
          rel={externalHref ? "noopener noreferrer" : undefined}
          aria-label={label}
          {...hover.trigger}
          onClick={(event) => {
            onActivate(activation, null, event);
            if (event.defaultPrevented) return;
            activateTargetLink({
              event,
              runtime: paneRuntime,
              href,
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
            type="button"
            className={className}
            aria-label={label}
            {...hover.trigger}
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
          className={className}
          href={targetHref}
          aria-label={label}
          {...hover.trigger}
          onClick={(event) => {
            onActivate(activation, activationTarget, event);
            if (event.defaultPrevented) return;
            activateTargetLink({
              event,
              runtime: paneRuntime,
              href: targetHref,
              labelHint: activationTarget.label,
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
        className={className}
        aria-label={label}
        {...hover.trigger}
        onClick={(event) => hover.show(event.currentTarget)}
        data-pane-find-exclude="true"
      >
        {index}
      </sup>
      {previewNode}
    </>
  );
}
