"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FeedbackNotice, FeedbackStatus, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import type { ServerValue } from "@/lib/api/serverState";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { Catalog, Message } from "@/lib/chat/wire";
import { formatDisplayDate } from "@/lib/display/format";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import type { ChatStore } from "./conversationStore";
import GenerationPicker from "./GenerationPicker";
import styles from "./MessageFooter.module.css";

export type MessageDialogRequest = {
  readonly messageId: string;
  readonly opener: HTMLButtonElement | null;
} & (
  | { readonly kind: "Information" }
  | { readonly kind: "Repeat"; readonly operation: "rerun" | "regenerate"; readonly openIntent: OpenIntent }
);

/** Requested information keeps its message identity even when the active path changes. */
export default function MessageDialogs({ request, messages, command, catalog, store, region, onClose }: {
  request: MessageDialogRequest | null;
  messages: ReadonlyMap<string, Message>;
  command: CommandState;
  catalog: ServerValue<Catalog>;
  store: ChatStore;
  region: RefObject<HTMLDivElement | null>;
  onClose(request: MessageDialogRequest): void;
}) {
  const feedback = useFeedback();
  const { paneId } = requirePaneRuntime(usePaneRuntime(), "MessageDialogs");
  const workspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const lastRequest = useRef(request);
  const skipReturn = useRef(false);
  if (request && lastRequest.current !== request) {
    lastRequest.current = request;
    skipReturn.current = false;
  }
  const message = request ? messages.get(request.messageId) : null;
  useLayoutEffect(() => {
    if (!request) return;
    const opened = workspace();
    const visit = opened.state.panes.find((pane) => pane.id === paneId)?.current_visit;
    const activation = opened.pendingPaneEntryDeliveryByPaneId.get(paneId)?.activationId;
    return subscribeWorkspace(() => {
      const current = workspace();
      const next = current.state.panes.find((pane) => pane.id === paneId)?.current_visit;
      const delivery = current.pendingPaneEntryDeliveryByPaneId.get(paneId);
      if (current.state.active_primary_pane_id === opened.state.active_primary_pane_id &&
        next?.id === visit?.id && next?.href === visit?.href &&
        (!delivery || delivery.activationId === activation)) return;
      skipReturn.current = true;
      onClose(request);
    });
  }, [request, paneId, workspace, subscribeWorkspace, onClose]);
  useLayoutEffect(() => {
    if (!request || message) return;
    skipReturn.current = true;
    onClose(request);
    feedback.receipt({ tone: "Neutral", title: "message no longer available" });
    region.current?.focus({ preventScroll: true });
  }, [request, message, onClose, feedback, region]);
  const close = () => { if (request) onClose(request); };
  const title = request?.kind === "Repeat" ? `${request.operation} with…` : "message information";
  return <Dialog open={request !== null} title={title} onClose={close}
    initialFocus={(panel) => request?.kind === "Information" ? panel
      : panel.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled):not([aria-label="Close dialog"])') ?? panel}
    returnFocusTo={() => lastRequest.current?.opener?.isConnected ? { element: lastRequest.current.opener, preventScroll: true } : null}
    returnFocusFallback={() => region.current ? { element: region.current, preventScroll: true } : null}
    skipReturnFocus={() => skipReturn.current}>
    {message && request ? request.kind === "Information" ? <Information message={message} />
      : <Repeat key={`${message.id}:${request.operation}`} message={message} operation={request.operation}
          command={command} catalog={catalog} store={store} openIntent={request.openIntent} onClose={() => onClose(request)} /> : null}
  </Dialog>;
}

function Information({ message }: { message: Message }) {
  const display = useRenderEnvironment();
  return <div className={styles.dialogBody}>
    <p className={styles.muted}>created <time dateTime={message.created_at}>{formatDisplayDate(message.created_at, display, {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "long",
    }) ?? message.created_at}</time></p>
  </div>;
}

function Repeat({ message, operation, command, catalog, store, openIntent, onClose }: {
  message: Message;
  operation: "rerun" | "regenerate";
  command: CommandState;
  catalog: ServerValue<Catalog>;
  store: ChatStore;
  openIntent: OpenIntent;
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
  const [recovering, setRecovering] = useState<"Command" | "Refresh" | null>(null);
  const frozen = matching && command.kind !== "RefreshRequired";
  const reason = catalog.status === "ready" ? unavailability(catalog.data, draft) : "model availability is not loaded";
  const submit = async (retry: "Command" | "Refresh" | null, intent: OpenIntent) => {
    const finalIntent = openIntent === "new_pane" || repeated?.openIntent === "new_pane" ? "new_pane" : intent;
    if (retry === null) setFailure(null);
    else if (matching && command.kind !== "Idle" && command.feedback) setFailure(command.feedback);
    setRecovering(retry);
    try {
      let outcome: CommandOutcome;
      if (retry === "Command") outcome = await store.retryCommand(finalIntent);
      else if (retry === "Refresh") outcome = await store.refreshCommand(finalIntent);
      else {
        if (draft.kind !== "Selected") return;
        outcome = await store.repeat(operation, message.id, draft.selection, finalIntent);
      }
      if (outcome.kind === "Gone" || (outcome.kind === "Settled" && (retry !== "Refresh" || command.kind === "Reconciling"))) onClose();
      else if ("feedback" in outcome) setFailure(outcome.feedback);
    } finally {
      setRecovering(null);
    }
  };
  const recovery = recovering ?? (matching && command.kind === "Unconfirmed" ? "Command"
    : matching && (command.kind === "RefreshRequired" || (command.kind === "Reconciling" && command.feedback)) ? "Refresh" : null);
  const shownFailure = matching && command.kind !== "Idle" ? command.feedback ?? failure : failure;
  const activate = (event: TargetActivationEvent, retry: "Command" | "Refresh" | null) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Open") void submit(retry, activation.intent);
  };
  if (!source) return <p>model not recorded</p>;
  return <div className={styles.dialogBody}>
    <GenerationPicker catalogRead={catalog} value={draft} onChange={setDraft} disabled={frozen} />
    {reason ? <FeedbackStatus content={{ tone: "Neutral", title: reason }} announcement="Polite" /> : null}
    {shownFailure ? <FeedbackNotice content={shownFailure} announcement="Polite" /> : null}
    {!shownFailure && matching && (command.kind === "Sending" || command.kind === "Reconciling") ? <FeedbackStatus content={{ tone: "Neutral", title: operation === "rerun" ? "rerunning…" : "regenerating…" }} announcement="Polite" /> : null}
    <div className={styles.dialogActions}>
      <Button variant="ghost" size="sm" className={styles.dialogControl} onClick={onClose}>cancel</Button>
      {recovery !== null ? <Button variant="secondary" size="sm" className={styles.dialogControl} disabled={recovering !== null} loading={recovering !== null}
          onClick={event => activate(event, recovery)} onKeyDown={event => activate(event, recovery)}>{recovery === "Command" ? "retry original request" : "retry refresh"}</Button>
        : <Button variant="secondary" size="sm" className={styles.dialogControl}
            disabled={command.kind !== "Idle" || reason !== null || draft.kind !== "Selected"}
            onClick={event => activate(event, null)} onKeyDown={event => activate(event, null)}>{operation}</Button>}
    </div>
  </div>;
}
