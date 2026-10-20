"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { recoveryOf } from "@/lib/chat/commands";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { Message } from "@/lib/chat/wire";
import { formatDisplayDate } from "@/lib/display/format";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import { useChatPane } from "./ChatSurface";
import GenerationPicker from "./GenerationPicker";
import styles from "./MessageFooter.module.css";

export type MessageDialogRequest = {
  readonly messageId: string;
  readonly opener: HTMLButtonElement | null;
} & (
  | { readonly kind: "Information" }
  | { readonly kind: "Repeat"; readonly operation: "rerun" | "regenerate"; readonly openIntent: OpenIntent }
);

/** A requested dialog keeps its message identity even when the active path changes. */
export default function MessageDialogs({ request, messages, onClose }: {
  request: MessageDialogRequest | null;
  messages: ReadonlyMap<string, Message>;
  onClose(request: MessageDialogRequest): void;
}) {
  const { region } = useChatPane();
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
  // Leaving the pane's visit (navigation, another pane, a delivered entry) closes it.
  useLayoutEffect(() => {
    if (!request) return;
    const visitOf = (snapshot: ReturnType<typeof workspace>) => {
      const visit = snapshot.state.panes.find((pane) => pane.id === paneId)?.current_visit;
      return [snapshot.state.active_primary_pane_id, visit?.id, visit?.href, snapshot.pendingPaneEntryDeliveryByPaneId.get(paneId)?.activationId];
    };
    const opened = visitOf(workspace());
    return subscribeWorkspace(() => {
      const now = visitOf(workspace());
      if (now.every((value, index) => value === opened[index] || (index === 3 && value === undefined))) return;
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
  const close = () => request && onClose(request);
  return (
    <Dialog
      open={request !== null}
      title={request?.kind === "Repeat" ? `${request.operation} with…` : "message information"}
      onClose={close}
      initialFocus={(panel) => request?.kind === "Information" ? panel
        : panel.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled):not([aria-label="Close dialog"])') ?? panel}
      returnFocusTo={() => lastRequest.current?.opener?.isConnected ? { element: lastRequest.current.opener, preventScroll: true } : null}
      returnFocusFallback={() => (region.current ? { element: region.current, preventScroll: true } : null)}
      skipReturnFocus={() => skipReturn.current}
    >
      {message && request ? (
        request.kind === "Information" ? (
          <Information message={message} />
        ) : (
          <Repeat
            key={`${message.id}:${request.operation}`}
            message={message}
            operation={request.operation}
            openIntent={request.openIntent}
            onClose={close}
          />
        )
      ) : null}
    </Dialog>
  );
}

function Information({ message }: { message: Message }) {
  const display = useRenderEnvironment();
  const created = formatDisplayDate(message.created_at, display, {
    year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "long",
  });
  return (
    <div className={styles.dialogBody}>
      <p className={styles.muted}>created <time dateTime={message.created_at}>{created ?? message.created_at}</time></p>
    </div>
  );
}

/**
 * "rerun with…" / "regenerate with…": an explicit model, frozen while its command is pending.
 * A shifted menu choice or button lands the answer in a new pane; nothing downgrades that.
 */
function Repeat({ message, operation, openIntent, onClose }: {
  message: Message;
  operation: "rerun" | "regenerate";
  openIntent: OpenIntent;
  onClose(): void;
}) {
  const { store, command, catalog } = useChatPane();
  const own = recoveryOf(command, (pending) => pending.kind === "Repeat" && pending.messageId === message.id && pending.operation === operation);
  const [draft, setDraft] = useState<SelectionEditor>(() => ({
    kind: "Selected",
    // an answer's trail always carries its run
    selection: own?.command.kind === "Repeat" ? own.command.selection : message.trust_trail!.run.run_selection.selection,
  }));
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const reason = catalog.status === "ready" ? unavailability(catalog.data, draft) : "model availability is not loaded";
  const submit = async (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind !== "Open") return;
    const intent = openIntent === "new_pane" ? openIntent : activation.intent;
    setFailure(null);
    // a refresh after a refusal settles and leaves the dialog open: the chat changed, decide again
    const outcome = own !== null ? await store.retryCommand(intent)
      : draft.kind === "Selected" ? await store.repeat(operation, message.id, draft.selection, intent) : null;
    if (outcome?.kind === "Gone" || outcome?.kind === "Accepted") onClose();
    else if (outcome?.kind === "Failed") setFailure(outcome.feedback);
  };
  const shown = own?.feedback ?? failure;
  return (
    <div className={styles.dialogBody}>
      <GenerationPicker catalogRead={catalog} value={draft} onChange={setDraft} disabled={own !== null && own.kind !== "RefreshRequired"} />
      {reason ? <FeedbackStatus content={{ tone: "Neutral", title: reason }} announcement="Polite" /> : null}
      {shown ? <FeedbackNotice content={shown} announcement="Polite" /> : null}
      {!shown && own?.kind === "Busy" ? (
        <FeedbackStatus content={{ tone: "Neutral", title: operation === "rerun" ? "rerunning…" : "regenerating…" }} announcement="Polite" />
      ) : null}
      <div className={styles.dialogActions}>
        <Button variant="ghost" size="sm" className={styles.dialogControl} onClick={onClose}>cancel</Button>
        <Button
          variant="secondary"
          size="sm"
          className={styles.dialogControl}
          loading={own?.kind === "Busy"}
          disabled={own ? own.kind === "Busy" : command.kind !== "Idle" || reason !== null || draft.kind !== "Selected"}
          onClick={(event) => void submit(event)}
          onKeyDown={(event) => void submit(event)}
        >
          {own?.kind === "Unconfirmed" ? "retry original request" : own ? "retry refresh" : operation}
        </Button>
      </div>
    </div>
  );
}
