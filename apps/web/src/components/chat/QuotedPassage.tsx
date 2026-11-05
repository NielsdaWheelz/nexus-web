"use client";

import * as Icon from "@/lib/ui/icons";
import type { MouseEventHandler } from "react";
import Button from "@/components/ui/Button";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useTransportVerbs, type CommandVerb } from "@/components/feedback/stage";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import type { Schema } from "@/lib/api/wire";
import { QUOTE_CHANGED, type ReaderQuote, type ReaderQuoteState } from "@/lib/chat/readerIntent";
import { unquotable } from "@/lib/chat/wire";
import { isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import styles from "./ChatComposer.module.css";

/** Saved evidence has a native link; a draft inspects its frozen, in-memory destination. */
export default function QuotedPassage({ quote, inspection, onRemove, onRetry, onReview }: {
  quote: ReaderQuoteState | { kind: "Sent"; selection: Schema<"ReaderSelectionOut"> };
  inspection?: ReaderQuote["inspection"];
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  onRetry?: () => void;
  onReview?: () => void;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "QuotedPassage");
  const transportVerbs = useTransportVerbs();
  const error = quote.kind === "Failed" && quote.failure.kind === "Read" ? quote.failure.error : null;
  if (error !== null && (!isApiError(error) || isSameSystemApiDefect(error)) && !isAuthoredStorageFailure(error)) throw error;
  const changed = quote.kind === "Failed" && quote.failure.kind === "Stale" || isApiError(error) && error.code === "E_READER_SELECTION_STALE";
  const refused = isApiError(error) ? unquotable(error) : null;
  const retry: CommandVerb | undefined = onRetry ? { label: "retry", commandKey: "prepare reader quote", run: onRetry } : undefined;
  const item = quote.kind === "Ready" || quote.kind === "Failed" ? quote.preview?.item ?? null : quote.kind === "Sent" ? quote.selection.item : null;
  return <div className={styles.quote} role="group" aria-label="quoted passage">
    {onRemove ? <Button icon={<Icon.Dismiss />} onClick={onRemove} aria-label="remove quoted passage">remove</Button> : null}
    {item ? <ResourceQuotation item={item} renderSourceControl={inspection ? title =>
      <Button aria-label={`${inspection.target.kind === "reader_destination" ? "show quoted passage" : "open source"} in ${title}`} onClick={event => {
        const activation = workspaceTargetActivationIntent(event);
        if (activation.kind !== "Open") return;
        event.preventDefault();
        runtime.activateTarget({ target: { href: inspection.href }, disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" },
          entry: { kind: "InspectSource", target: inspection.target, purpose: "Open" } });
      }}>{inspection.target.kind === "reader_destination" ? title : `open source in ${title}`}</Button> : undefined} /> : null}
    {changed ? <Fact line={{ fact: QUOTE_CHANGED }} verbs={onReview ? [{ label: "review passage", commandKey: "review reader quote", run: onReview }] : undefined} />
      : quote.kind === "Loading" || quote.kind === "Unprepared" ? <Ruling />
      : error !== null ? <Fact line={refused ? { fact: refused } : { ...(isApiError(error) ? TRANSPORT_LINES[transportOf(error)].read("quotes") : {}), fact: "couldn’t prepare this quote." }}
        verbs={isApiError(error) ? transportVerbs(transportOf(error), { retry }) ?? undefined : retry ? [retry] : undefined} /> : null}
  </div>;
}
