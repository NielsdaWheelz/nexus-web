"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FeedbackNotice, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import type { ServerValue } from "@/lib/api/serverState";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { Catalog, Message } from "@/lib/chat/wire";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import { AssistantReport } from "./AssistantTrust";
import type { ActivateSource } from "./ChatSurface";
import type { ChatStore } from "./conversationStore";
import GenerationPicker from "./GenerationPicker";
import styles from "./MessageFooter.module.css";

export type MessageDialogRequest = {
  readonly messageId: string;
  readonly opener: HTMLButtonElement | null;
} & (
  | { readonly kind: "Sources" }
  | { readonly kind: "Information" }
  | { readonly kind: "Repeat"; readonly operation: "rerun" | "regenerate" }
);

/** Requested information keeps its message identity even when the active path changes. */
export default function MessageDialogs({ request, messages, command, catalog, store, activate, region, onClose }: {
  request: MessageDialogRequest | null;
  messages: ReadonlyMap<string, Message>;
  command: CommandState;
  catalog: ServerValue<Catalog>;
  store: ChatStore;
  activate: ActivateSource;
  region: RefObject<HTMLDivElement | null>;
  onClose(request: MessageDialogRequest): void;
}) {
  const feedback = useFeedback();
  const lastRequest = useRef(request);
  const skipReturn = useRef(false);
  if (request && lastRequest.current !== request) {
    lastRequest.current = request;
    skipReturn.current = false;
  }
  const message = request ? messages.get(request.messageId) : null;
  useLayoutEffect(() => {
    if (!request || message) return;
    skipReturn.current = true;
    onClose(request);
    feedback.publish({ kind: "Hud", content: { tone: "Neutral", title: "message no longer available" } });
    region.current?.focus({ preventScroll: true });
  }, [request, message, onClose, feedback, region]);
  const close = () => { if (request) onClose(request); };
  const follow: ActivateSource = (activation, target, event) => {
    skipReturn.current = true;
    close();
    activate(activation, target, event);
  };
  const title = request?.kind === "Sources" ? "sources"
    : request?.kind === "Repeat" ? `${request.operation} with…` : "message information";
  return <Dialog open={request !== null} title={title} onClose={close}
    initialFocus={(panel) => request?.kind === "Information" ? panel
      : request?.kind === "Sources" ? panel.querySelector<HTMLElement>('button:not(:disabled):not([aria-label="Close dialog"])') ?? panel
      : panel.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled):not([aria-label="Close dialog"])') ?? panel}
    returnFocusTo={() => lastRequest.current?.opener?.isConnected ? { element: lastRequest.current.opener, preventScroll: true } : null}
    returnFocusFallback={() => region.current ? { element: region.current, preventScroll: true } : null}
    skipReturnFocus={() => skipReturn.current}>
    {message && request ? request.kind === "Sources" ? <Sources message={message} activate={follow} />
      : request.kind === "Information" ? <Information message={message} activate={follow} />
      : <Repeat key={`${message.id}:${request.operation}`} message={message} operation={request.operation}
          command={command} catalog={catalog} store={store} onClose={() => onClose(request)} /> : null}
  </Dialog>;
}

function Sources({ message, activate }: { message: Message; activate: ActivateSource }) {
  return <ol className={styles.sources} aria-label="Sources">{message.citations.map((citation) => {
    const source = toReaderCitationData(citation);
    const label = `${citation.ordinal}. ${source.preview.title || `source ${citation.ordinal}`}`;
    return <li key={citation.ordinal}>{source.activation.kind === "none" ?
      <span className={styles.source}>{label} · unavailable</span> :
      <button type="button" className={styles.source} onClick={(event) => activate(source.activation, source.target, event)}>{label}</button>}
    </li>;
  })}</ol>;
}

function Information({ message, activate }: { message: Message; activate: ActivateSource }) {
  const display = useRenderEnvironment();
  return <div className={styles.dialogBody}>
    <p className={styles.muted}>created <time dateTime={message.created_at}>{formatDisplayDate(message.created_at, display, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "long",
    }) ?? message.created_at}</time></p>
    {message.role === "assistant" ? <AssistantReport message={message} activate={activate} /> : null}
  </div>;
}

function Repeat({ message, operation, command, catalog, store, onClose }: {
  message: Message;
  operation: "rerun" | "regenerate";
  command: CommandState;
  catalog: ServerValue<Catalog>;
  store: ChatStore;
  onClose(): void;
}) {
  const source = message.trust_trail?.run?.run_selection.selection ?? null;
  const repeated = command.kind !== "Idle" && command.command.kind === "Repeat" && command.command.messageId === message.id && command.command.operation === operation ? command.command : null;
  const matching = repeated !== null;
  const [draft, setDraft] = useState<SelectionEditor>(() => {
    const selection = repeated?.selection ?? source;
    return selection ? { kind: "Selected", selection } : { kind: "Uninitialized" };
  });
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const frozen = matching && command.kind !== "RefreshRequired";
  const reason = catalog.status === "ready" ? unavailability(catalog.data, draft) : "model availability is not loaded";
  const submit = async (retry: "Command" | "Refresh" | null) => {
    setFailure(null);
    let outcome: CommandOutcome;
    if (retry === "Command") outcome = await store.retryCommand();
    else if (retry === "Refresh") outcome = await store.refreshCommand();
    else {
      if (draft.kind !== "Selected") return;
      outcome = await store.repeat(operation, message.id, draft.selection);
    }
    if (outcome.kind === "Gone" || (outcome.kind === "Settled" && (retry !== "Refresh" || command.kind === "Reconciling"))) onClose();
    else if ("feedback" in outcome) setFailure(outcome.feedback);
  };
  const shownFailure = matching && command.kind !== "Idle" ? command.feedback ?? failure : failure;
  if (!source) return <p>model not recorded</p>;
  return <div className={styles.dialogBody}>
    <GenerationPicker catalogRead={catalog} value={draft} onChange={setDraft} disabled={frozen} />
    {reason ? <p className={styles.muted} role="status">{reason}</p> : null}
    {shownFailure ? <FeedbackNotice content={shownFailure} announcement="Polite" /> : null}
    {matching && (command.kind === "Sending" || command.kind === "Reconciling") ? <p role="status">{operation === "rerun" ? "rerunning…" : "regenerating…"}</p> : null}
    <div className={styles.dialogActions}>
      <Button variant="ghost" size="sm" className={styles.dialogControl} onClick={onClose}>cancel</Button>
      {matching && command.kind === "Unconfirmed" ? <Button variant="secondary" size="sm" className={styles.dialogControl} onClick={() => void submit("Command")}>retry original request</Button>
        : matching && (command.kind === "RefreshRequired" || (command.kind === "Reconciling" && command.feedback)) ?
          <Button variant="secondary" size="sm" className={styles.dialogControl} onClick={() => void submit("Refresh")}>retry refresh</Button>
        : <Button variant="secondary" size="sm" className={styles.dialogControl}
            disabled={command.kind !== "Idle" || reason !== null || draft.kind !== "Selected"} onClick={() => void submit(null)}>{operation}</Button>}
    </div>
  </div>;
}
