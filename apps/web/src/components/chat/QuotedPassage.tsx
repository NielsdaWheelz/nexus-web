"use client";

import * as Icon from "@/lib/ui/icons";
import type { MouseEventHandler } from "react";
import Button from "@/components/ui/Button";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { getReaderQuotePreview, type ReaderSelectionKey } from "@/lib/chat/readerIntent";
import { unquotable } from "@/lib/chat/wire";
import styles from "./ChatComposer.module.css";

type Snapshot = Schema<"ReaderSelectionOut">;
export type QuoteState =
  | { kind: "Loading" }
  | { kind: "Ready"; selection: Schema<"ReaderSelectionPreview"> }
  | { kind: "Failed"; error: ApiError; retrying: boolean };

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

/** A pending or captured quote and its attachment controls. A slow read rules its region; a
 * refusal says why, ahead of transport, and remove stands beside it. */
export default function QuotedPassage({ quote, onRemove, onRetry }: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  onRetry?: () => void;
}) {
  const refused = quote.kind === "Failed" ? unquotable(quote.error) : null;
  return <div className={styles.quote} role="group" aria-label="Quoted passage">
    {onRemove ? <Button icon={<Icon.Dismiss />} onClick={onRemove} aria-label="Remove quoted passage">Remove</Button> : null}
    {quote.kind === "Ready" || quote.kind === "Sent" ? <ResourceQuotation item={quote.selection.item} />
      : quote.kind === "Loading" ? <Ruling />
      : refused !== null ? <Fact line={{ fact: refused }} />
      : <Failed error={quote.error} noun="quotes" retry={onRetry ? { run: onRetry, busy: quote.retrying } : undefined} />}
  </div>;
}
