"use client";

import { X } from "lucide-react";
import type { MouseEventHandler } from "react";
import Button from "@/components/ui/Button";
import { Fact, Failed } from "@/components/feedback/Fact";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { getReaderQuotePreview, type ReaderSelectionKey } from "@/lib/chat/readerIntent";
import styles from "./ChatComposer.module.css";

type Snapshot = Schema<"ReaderSelectionOut">;
export type QuoteState =
  | { kind: "Loading" }
  | { kind: "Ready"; selection: Schema<"ReaderSelectionPreview"> }
  | { kind: "Failed"; error: ApiError; retrying: boolean };

/** The reader's refusals of a passage, ahead of transport (python/nexus/services/chat/quotes.py). */
const UNQUOTABLE = new Set([
  "E_READER_SELECTION_NOT_FOUND",
  "E_READER_SELECTION_FORBIDDEN",
  "E_READER_SELECTION_GEOMETRY_ONLY",
  "E_READER_SELECTION_TOO_LARGE",
]);

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
        ? { kind: "Failed", error: preview.error, retrying: preview.retrying }
        : { kind: "Loading" };
  return { quote, retry: preview.refetch };
}

/** A pending or captured quote and its attachment controls. A pending one paints nothing until it
 * lands; one the reader refuses says so, and remove stands beside it. */
export default function QuotedPassage({ quote, onRemove, onRetry }: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  onRetry?: () => void;
}) {
  return <div className={styles.quote} role="group" aria-label="Quoted passage">
    {onRemove ? <Button icon={<X />} onClick={onRemove} aria-label="Remove quoted passage">Remove</Button> : null}
    {quote.kind === "Ready" || quote.kind === "Sent" ? <ResourceQuotation item={quote.selection.item} />
      : quote.kind === "Loading" ? null
      : UNQUOTABLE.has(quote.error.code) ? <Fact line={{ fact: "this passage can’t be quoted." }} />
      : <Failed error={quote.error} noun="quotes" retry={onRetry ? { run: onRetry, busy: quote.retrying } : undefined} />}
  </div>;
}
