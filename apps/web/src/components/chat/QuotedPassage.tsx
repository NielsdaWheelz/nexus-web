"use client";

import { X } from "lucide-react";
import type { MouseEventHandler } from "react";
import Button from "@/components/ui/Button";
import {
  FeedbackFailure,
  FeedbackBusy,
  useFeedbackOccurrence,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
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
      `chat-reader-selection:${key.mediaId ?? key.captureId}:${key.highlightId}`,
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

/** A pending or captured quote retains its attachment controls and feedback. */
export default function QuotedPassage({ quote, onRemove, onRetry }: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  onRetry?: () => void;
}) {
  const occurrence = useFeedbackOccurrence(quote.kind === "Failed");
  const selection = quote.kind === "Ready" || quote.kind === "Sent" ? quote.selection : null;
  return <div className={styles.quote} role="group" aria-label="Quoted passage">
    {onRemove ? <Button icon={<X />} onClick={onRemove} aria-label="Remove quoted passage">Remove</Button> : null}
    {selection ? <ResourceQuotation item={selection.item} /> : quote.kind === "Failed" ? <FeedbackFailure scope="Local" occurrence={occurrence} content={quote.feedback} announcement="None" actions={onRetry ? [{ label: "retry", onClick: onRetry, busy: quote.retrying }] : undefined} /> : <FeedbackBusy pending />}
    <p className="sr-only" role="status" aria-live="polite">{onRemove && selection ? "Quoted passage attached." : ""}</p>
  </div>;
}
