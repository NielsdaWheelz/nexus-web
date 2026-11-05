"use client";

import * as Icon from "@/lib/ui/icons";
import type { MouseEventHandler } from "react";
import Button from "@/components/ui/Button";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import ResourceQuotation, { type ResourceQuotationCapture } from "@/components/resources/ResourceQuotation";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import type { Schema } from "@/lib/api/wire";
import { getReaderQuotePreview, QUOTE_CHANGED, type ReaderQuote } from "@/lib/chat/readerIntent";
import { unquotable } from "@/lib/chat/wire";
import { getWritingRuntime } from "@/lib/notes/runtime";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import styles from "./ChatComposer.module.css";

type Snapshot = Schema<"ReaderSelectionOut">;
export type QuoteState =
  | { kind: "Captured"; presentation: ResourceQuotationCapture }
  | { kind: "Loading" }
  | { kind: "Ready"; selection: Schema<"ReaderSelectionPreview"> }
  | { kind: "Failed"; error: ApiError; retrying: boolean };

/** Display only this saved capture. Its immutable input also fences the send's read. */
export function useQuotePreview(quote: ReaderQuote | null, onDefect: (defect: { error: unknown }) => void) {
  const { accountId } = useAuthenticatedAccount();
  const input = quote?.input.kind === "highlight" && quote.presentation === null ? quote.input : null;
  const preview = usePaneFreeServerValue<Schema<"ReaderSelectionPreview">>({
    key: input && quote ? `chat-reader-selection:${quote.id}` : null,
    stale: "",
    timeoutMs: 30_000,
    onDefect,
    load: async (signal) => {
      if (!input) throw new Error("A quote preview needs its observed capture");
      const writing = getWritingRuntime(accountId);
      const prefix = await writing.committedPrefix();
      const store = await writing.store;
      await store.whenUploaded(prefix, signal);
      return getReaderQuotePreview(input, signal);
    },
  });
  const shown: QuoteState | null = quote === null
    ? null
    : quote.presentation !== null ? { kind: "Captured", presentation: quote.presentation }
    : preview.status === "ready"
      ? { kind: "Ready", selection: preview.data }
      : preview.status === "failed"
        ? { kind: "Failed", error: preview.error, retrying: preview.retrying }
        : { kind: "Loading" };
  return { quote: shown, retry: preview.refetch };
}

/** A pending or captured quote and its attachment controls. A slow read rules its region; a
 * refusal says why, ahead of transport, and remove stands beside it. */
export default function QuotedPassage({ quote, inspection, stale = false, onRemove, onRetry, onReview }: {
  quote: QuoteState | { kind: "Sent"; selection: Snapshot };
  inspection?: ReaderQuote["inspection"];
  stale?: boolean;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  onRetry?: () => void;
  onReview?: () => void;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "QuotedPassage");
  const refused = quote.kind === "Failed" ? unquotable(quote.error) : null;
  const changed = stale || quote.kind === "Failed" && quote.error.code === "E_READER_SELECTION_STALE";
  const sourceControl = inspection ? (title: string) => <Button aria-label={`${inspection.target.kind === "reader_destination" ? "show quoted passage" : "open source"} in ${title}`} onClick={event => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind !== "Open") return;
    event.preventDefault();
    runtime.activateTarget({ target: { href: inspection.href }, disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" },
      entry: { kind: "InspectSource", target: inspection.target, purpose: "Open" } });
  }}>{inspection.target.kind === "reader_destination" ? title : `open source in ${title}`}</Button> : undefined;
  return <div className={styles.quote} role="group" aria-label="Quoted passage">
    {onRemove ? <Button icon={<Icon.Dismiss />} onClick={onRemove} aria-label="Remove quoted passage">Remove</Button> : null}
    {quote.kind === "Captured" ? <ResourceQuotation {...quote.presentation} renderSourceControl={sourceControl} />
      : quote.kind === "Ready" || quote.kind === "Sent" ? <ResourceQuotation item={quote.selection.item} renderSourceControl={sourceControl} /> : null}
    {changed ? <Fact line={{ fact: QUOTE_CHANGED }} verbs={onReview ? [{ label: "review passage", commandKey: "review reader quote", run: onReview }] : undefined} />
      : quote.kind === "Loading" ? <Ruling />
      : quote.kind !== "Failed" ? null
      : refused !== null ? <Fact line={{ fact: refused }} />
      : <Failed error={quote.error} noun="quotes" retry={onRetry ? { run: onRetry, busy: quote.retrying } : undefined} />}
    {!changed && onReview ? <Button onClick={onReview}>review passage</Button> : null}
  </div>;
}
