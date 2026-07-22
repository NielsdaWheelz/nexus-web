"use client";

import {
  AlertCircle,
  Ban,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  X,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import { cx } from "@/lib/ui/cx";
import styles from "./QuotedPassageCard.module.css";

/**
 * `QuotedPassageCard` — the human projection of the answer-determining reader
 * quote. It renders the same editorial passage in two modes, sharing one visual
 * language so the pending draft and the sent transcript read as one thing:
 *
 * 1. `pending` — above the composer textarea, from a `PendingTurnContext`. It is
 *    editable (Remove) and, until the canonical preview has hydrated, it names
 *    exactly why send is paused (loading / retryable failure / non-sendable).
 * 2. `sent` — above the user-message body, from an immutable `ReaderSelectionOut`.
 *    Read-only: no Remove, and a source that has since disappeared collapses to
 *    plain "Source unavailable" text rather than a dead control.
 *
 * The card owns presentation only. `Conversation` gates send on the context
 * kind, performs source activation (`activateResource`), and announces
 * remove/replace across renders; this card owns a polite live region for the
 * state transitions it can itself observe.
 */

type QuotedPassageCardProps =
  | {
      mode: "pending";
      context: PendingTurnContext;
      onRemove: () => void;
      onRetry: () => void;
      onActivateSource: (selection: ReaderSelectionOut) => void;
    }
  | {
      mode: "sent";
      selection: ReaderSelectionOut;
      onActivateSource: (selection: ReaderSelectionOut) => void;
    };

const NON_SENDABLE_COPY: Record<
  "Forbidden" | "GeometryOnly" | "TooLarge",
  { title: string; detail: string }
> = {
  Forbidden: {
    title: "You can't quote this passage",
    detail: "Its highlight isn't available to you, so it can't be sent.",
  },
  GeometryOnly: {
    title: "Nothing to quote here",
    detail: "This highlight marks a picture or region — there's no text to quote.",
  },
  TooLarge: {
    title: "This passage is too long to quote",
    detail: "Highlight a shorter passage, then quote it.",
  },
};

export default function QuotedPassageCard(props: QuotedPassageCardProps) {
  let state: string;
  let announcement: string;
  let body: ReactNode;

  if (props.mode === "sent") {
    state = props.selection.activation.kind === "none" ? "unavailable" : "available";
    announcement = "";
    body = (
      <AvailableBody
        selection={props.selection}
        onActivateSource={props.onActivateSource}
      />
    );
  } else {
    const context = props.context;
    switch (context.kind) {
      case "ReaderHighlight": {
        state =
          context.preview.activation.kind === "none" ? "unavailable" : "available";
        announcement =
          context.preview.activation.kind === "none"
            ? "Quoted passage attached. Its source is unavailable."
            : "Quoted passage attached.";
        body = (
          <AvailableBody
            selection={context.preview}
            onActivateSource={props.onActivateSource}
          />
        );
        break;
      }
      case "Loading": {
        state = "loading";
        announcement = "Loading the quoted passage.";
        body = <LoadingBody />;
        break;
      }
      case "LoadFailed": {
        state = "failed";
        announcement = "The quoted passage failed to load.";
        body = <FailedBody error={context.error} onRetry={props.onRetry} />;
        break;
      }
      case "NonSendable": {
        const copy = NON_SENDABLE_COPY[context.reason];
        state = "nonsendable";
        announcement = "This passage can't be quoted.";
        body = <NonSendableBody copy={copy} />;
        break;
      }
    }
  }

  return (
    <figure
      className={styles.card}
      data-mode={props.mode}
      data-state={state}
      aria-label="Quoted passage"
    >
      <div className={styles.head}>
        <span className={styles.kicker}>Quoted passage</span>
        {props.mode === "pending" ? <RemoveButton onRemove={props.onRemove} /> : null}
      </div>
      {body}
      {/* Polite status for the transitions the card can observe (loading →
          attached, failure, non-sendable). Never steals focus; removal and
          replacement are announced by the owning Conversation across renders. */}
      <p className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </p>
    </figure>
  );
}

function AvailableBody({
  selection,
  onActivateSource,
}: {
  selection: ReaderSelectionOut;
  onActivateSource: (selection: ReaderSelectionOut) => void;
}) {
  const quoteId = useId();
  const quoteRef = useRef<HTMLQuoteElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Detect whether the stored text is taller than the four-line clamp. The full
  // `exact` is always in the DOM; the clamp is purely visual, so the disclosure
  // only appears when there is genuinely more to reveal.
  useLayoutEffect(() => {
    const el = quoteRef.current;
    if (!el) return;
    const measure = () => {
      if (expanded) return;
      setOverflowing(el.scrollHeight - el.clientHeight > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, selection.exact, selection.prefix, selection.suffix]);

  const showToggle = overflowing || expanded;

  return (
    <>
      <SourceLine selection={selection} onActivate={onActivateSource} />
      <blockquote
        ref={quoteRef}
        id={quoteId}
        className={cx(styles.quote, !expanded && styles.quoteClamped)}
      >
        <HighlightSnippet
          exact={selection.exact}
          prefix={selection.prefix}
          suffix={selection.suffix}
        />
      </blockquote>
      {showToggle ? (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.disclosure}
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={quoteId}
            aria-label={expanded ? "Collapse quoted passage" : "Expand quoted passage"}
          >
            {expanded ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            <span>{expanded ? "Collapse" : "Expand"}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}

function SourceLine({
  selection,
  onActivate,
}: {
  selection: ReaderSelectionOut;
  onActivate: (selection: ReaderSelectionOut) => void;
}) {
  const { activation, sourceLabel } = selection;
  const activatable = activation.kind === "route" || activation.kind === "external";

  return (
    <div className={styles.sourceLine}>
      <span className={styles.sourcePrefix}>from</span>
      {activatable ? (
        <button
          type="button"
          className={styles.sourceButton}
          onClick={() => onActivate(selection)}
          aria-label={`Open source: ${sourceLabel}`}
        >
          {activation.kind === "external" ? (
            <ExternalLink size={13} aria-hidden="true" className={styles.sourceIcon} />
          ) : (
            <BookOpen size={13} aria-hidden="true" className={styles.sourceIcon} />
          )}
          <span className={styles.sourceName}>{sourceLabel}</span>
        </button>
      ) : (
        <span className={styles.sourceUnavailable}>
          <span className={styles.sourceName}>{sourceLabel}</span>
          <span className={styles.sourceDot} aria-hidden="true">
            &middot;
          </span>
          Source unavailable
        </span>
      )}
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      className={styles.remove}
      onClick={onRemove}
      aria-label="Remove quoted passage"
    >
      <X size={15} aria-hidden="true" className={styles.removeIcon} />
      <span className={styles.removeLabel}>Remove</span>
    </button>
  );
}

function LoadingBody() {
  return (
    <div className={styles.loading}>
      <span className={styles.loadingDot} aria-hidden="true" />
      <span>Loading quoted passage&hellip;</span>
    </div>
  );
}

function FailedBody({
  error,
  onRetry,
}: {
  error: FeedbackContent;
  onRetry: () => void;
}) {
  return (
    <div className={styles.notice}>
      <AlertCircle size={15} aria-hidden="true" className={styles.noticeIcon} />
      <div className={styles.noticeBody}>
        <p className={styles.noticeTitle}>{error.title}</p>
        {error.message ? <p className={styles.noticeDetail}>{error.message}</p> : null}
        <div className={styles.noticeActions}>
          <button
            type="button"
            className={styles.retry}
            onClick={onRetry}
            aria-label="Retry loading quoted passage"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

function NonSendableBody({ copy }: { copy: { title: string; detail: string } }) {
  return (
    <div className={styles.notice}>
      <Ban size={15} aria-hidden="true" className={styles.noticeIcon} />
      <div className={styles.noticeBody}>
        <p className={styles.noticeTitle}>{copy.title}</p>
        <p className={styles.noticeDetail}>{copy.detail}</p>
      </div>
    </div>
  );
}
