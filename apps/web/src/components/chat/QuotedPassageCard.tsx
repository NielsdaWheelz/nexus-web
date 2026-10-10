"use client";

import { useCallback, useState } from "react";
import { BookOpen, ExternalLink, X } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { ReaderSelectionKey } from "@/lib/chat/readerIntent";
import { failureDetail } from "@/lib/chat/wire";
import type { ReaderSourceTarget } from "@/lib/resourceGraph/citations";
import styles from "./ChatComposer.module.css";

type Snapshot = Schema<"ReaderSelectionOut">;
export type QuoteState =
  | { kind: "Loading" }
  | { kind: "Ready"; selection: Schema<"ReaderSelectionPreview"> }
  | { kind: "Failed"; feedback: FeedbackContent };

/** Hydrate the highlight a quote launch names; the send carries only its key and revision. */
export function useQuotePreview(key: ReaderSelectionKey | null) {
  const [generation, setGeneration] = useState(0);
  const preview = useResource<Schema<"ReaderSelectionPreview">>({
    cacheKey:
      key &&
      `chat-reader-selection:${key.mediaId}:${key.highlightId}:${generation}`,
    load: async (signal) => {
      if (!key) throw new Error("A quote preview needs its key");
      const path = `/api/chat-reader-selections/highlights/${key.highlightId}?media_id=${key.mediaId}`;
      type Read = ApiJson<
        "/chat-reader-selections/highlights/{highlight_id}",
        "get"
      >;
      return (await apiFetch<Read>(path as ApiPath, { signal })).data;
    },
  });
  const retry = useCallback(() => setGeneration((value) => value + 1), []);
  const quote: QuoteState | null = !key
    ? null
    : preview.status === "ready"
      ? { kind: "Ready", selection: preview.data }
      : preview.status === "error"
        ? {
            kind: "Failed",
            feedback: {
              tone: "Danger",
              title: "This quote can’t be attached.",
              message: failureDetail(preview.error.code),
              requestId: preview.error.requestId,
            },
          }
        : { kind: "Loading" };
  return { quote, retry };
}

/** Reopen the passage from the immutable snapshot's locator, never the live highlight. */
export function readerTargetFromSelection(
  selection: Snapshot,
): ReaderSourceTarget {
  return {
    kind: "media",
    media_id: selection.key.media_id,
    locator: selection.locator,
    snippet: selection.exact,
    label: selection.source_label,
  };
}

/** The quoted passage: pending above the composer (removable) or sent above its turn. */
export default function QuotedPassageCard({
  quote,
  onOpen,
  onRemove,
  onRetry,
}: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  onOpen(selection: Snapshot): void;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const selection =
    quote.kind === "Ready" || quote.kind === "Sent" ? quote.selection : null;
  const reachable = selection?.activation.kind !== "none";
  return (
    <figure
      className={styles.quote}
      data-state={
        selection ? (reachable ? "available" : "unavailable") : quote.kind
      }
      aria-label="Quoted passage"
    >
      <div className={styles.quoteHead}>
        <span className={styles.kicker}>Quoted passage</span>
        {onRemove ? (
          <button
            type="button"
            className={styles.quoteButton}
            onClick={onRemove}
            aria-label="Remove quoted passage"
          >
            <X size={15} aria-hidden="true" /> Remove
          </button>
        ) : null}
      </div>
      {selection ? (
        <>
          <div className={styles.quoteSource}>
            from{" "}
            {reachable ? (
              <button
                type="button"
                className={styles.quoteButton}
                onClick={() => onOpen(selection)}
                aria-label={`Open source: ${selection.source_label}`}
              >
                {selection.activation.kind === "external" ? (
                  <ExternalLink size={13} aria-hidden="true" />
                ) : (
                  <BookOpen size={13} aria-hidden="true" />
                )}
                {selection.source_label}
              </button>
            ) : (
              <span>{selection.source_label} · Source unavailable</span>
            )}
          </div>
          <blockquote className={styles.quoteText}>
            <HighlightSnippet
              exact={selection.exact}
              prefix={selection.prefix}
              suffix={selection.suffix}
            />
          </blockquote>
        </>
      ) : quote.kind === "Failed" ? (
        <FeedbackNotice
          content={quote.feedback}
          announcement="None"
          actions={onRetry ? [{ label: "Retry", onClick: onRetry }] : undefined}
        />
      ) : (
        <p className={styles.status}>Loading quoted passage…</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {onRemove && selection ? "Quoted passage attached." : ""}
      </p>
    </figure>
  );
}
