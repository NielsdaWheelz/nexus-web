"use client";

import { X } from "lucide-react";
import {
  FeedbackNotice,
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { getReaderQuotePreview, type ReaderSelectionKey } from "@/lib/chat/readerIntent";
import { failureDetail } from "@/lib/chat/wire";
import styles from "./ChatComposer.module.css";

type Snapshot = Schema<"ReaderSelectionOut">;
export type QuoteState =
  | { kind: "Loading" }
  | { kind: "Ready"; selection: Schema<"ReaderSelectionPreview"> }
  | { kind: "Failed"; feedback: FeedbackContent; retrying: boolean };

/** Hydrate the highlight a quote launch names; the send carries only its key and revision. */
export function useQuotePreview(key: ReaderSelectionKey | null) {
  const preview = usePaneFreeServerValue<Schema<"ReaderSelectionPreview">>({
    key:
      key &&
      `chat-reader-selection:${key.mediaId}:${key.highlightId}`,
    stale: "",
    load: async (signal) => {
      if (!key) throw new Error("A quote preview needs its key");
      return getReaderQuotePreview({ key, signal });
    },
  });
  const quote: QuoteState | null = !key
    ? null
    : preview.status === "ready"
      ? { kind: "Ready", selection: preview.data }
      : preview.status === "failed"
        ? {
            kind: "Failed",
            retrying: preview.retrying,
            feedback: {
              tone: "Danger",
              title: "This quote can’t be attached.",
              message: failureDetail(preview.error.code),
              requestId: preview.error.requestId,
            },
          }
        : { kind: "Loading" };
  return { quote, retry: preview.refetch };
}

/** A pending or captured quote uses the same resource row as every other reference. */
export default function QuotedPassage({ quote, occurrenceKey, onRemove, onRetry }: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  occurrenceKey: string;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const selection = quote.kind === "Ready" || quote.kind === "Sent" ? quote.selection : null;
  return <figure className={styles.quote} aria-label="Quoted passage">
    {onRemove ? <button type="button" className={styles.quoteButton} onClick={onRemove} aria-label="Remove quoted passage"><X size={15} aria-hidden="true" /> Remove</button> : null}
    {selection ? <ResourceOutlineList scope={occurrenceKey} ariaLabel="Quoted passage">
      <ResourceOutlineRow incoming={null} item={selection.item} occurrenceKey={occurrenceKey} historical={quote.kind === "Sent"} occurrenceLabel="quoted passage" />
    </ResourceOutlineList> : quote.kind === "Failed" ? <FeedbackNotice content={quote.feedback} announcement="None" actions={onRetry ? [{ label: "retry", onClick: onRetry, busy: quote.retrying }] : undefined} /> : <FeedbackStatus content={{ tone: "Neutral", title: "loading quoted passage…" }} announcement="None" />}
    <p className="sr-only" role="status" aria-live="polite">{onRemove && selection ? "Quoted passage attached." : ""}</p>
  </figure>;
}
