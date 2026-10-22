"use client";

import { useState, type ReactNode } from "react";
import { Copy, Info, RotateCcw } from "lucide-react";
import { FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import ResourceComposer from "@/components/resources/ResourceComposer";
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import Button from "@/components/ui/Button";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { useThrowLater } from "@/lib/api/serverState";
import type { Message } from "@/lib/chat/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useChatPane } from "./ChatSurface";
import styles from "./MessageFooter.module.css";

const BUSY = "finish the current chat action first";

/** One stable action band. Command and dialog owners retain the actual operations. */
export default function MessageFooter({ message, latest, engaged, details = null, detailsOpen = false, currentAction = null, status = null, alternatives }: {
  message: Message;
  latest: boolean;
  engaged: boolean;
  details?: ReactNode;
  detailsOpen?: boolean;
  currentAction?: string | null;
  status?: string | null;
  alternatives: ReactNode;
}) {
  const { store, command } = useChatPane();
  const feedback = useFeedback();
  const fail = useThrowLater();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const run = message.trust_trail?.run;
  const pending = message.role === "assistant" && message.status === "pending";
  const copy = async () => {
    try {
      await copyText(message.content);
      feedback.receipt({ tone: "Success", title: "message copied" });
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) return fail({ error });
      feedback.offer({ key: `message-copy:${message.id}`, announcement: "Polite", content: { tone: "Warning", title: "couldn’t copy message" } });
    }
  };
  const regenerate = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Open") void store.repeat("regenerate", message.id, null, activation.intent);
  };
  return (
    <>
    <div className={styles.footer} role="group" aria-label="Message actions" data-latest={latest} data-engaged={engaged || menuOpen}>
      <div className={styles.left}>
        {details}
        {currentAction || status ? (
          <div className={detailsOpen && currentAction ? "sr-only" : styles.currentAction}>
            <FeedbackStatus content={{ tone: "Neutral", title: currentAction ?? status ?? "" }} announcement="Polite" />
          </div>
        ) : null}
        {pending ? null : alternatives}
      </div>
      {pending ? null : (
        <div className={styles.right}>
          {message.content.trim() && run?.failure?.code !== "invalid_output" ? (
            <Button iconOnly icon={<Copy />} aria-label="copy message" className={styles.secondary} onClick={() => void copy()} />
          ) : null}
          {message.role === "assistant" && message.status === "complete" && run ? (
            <Button iconOnly icon={<RotateCcw />} aria-label="regenerate response" className={styles.secondary}
              disabled={command.kind !== "Idle"} onClick={regenerate} onKeyDown={regenerate} />
          ) : null}
          <MessageMenu message={message} onOpenChange={setMenuOpen} onAdd={() => setAdding(true)} />
        </div>
      )}
    </div>
    {adding ? (
      <ResourceComposer source={{ kind: "resource", ref: `message:${message.id}` }} occurrenceKey={`message:${message.id}`} label="add item" />
    ) : null}
    </>
  );
}

/** Resource facts determine applicability; live availability keeps eligible repeats present. */
function MessageMenu({ message, onOpenChange, onAdd }: { message: Message; onOpenChange(open: boolean): void; onAdd(): void }) {
  const { command, openDialog } = useChatPane();
  const pane = usePaneRuntime();
  const resource = useResourceActions(canonicalResourceRef({ scheme: "message", id: message.id }));
  const busy = command.kind !== "Idle";
  const local: ActionDescriptor[] = [{ kind: "command", id: "Resource.AddItem", label: "add item", onSelect: onAdd }, {
    kind: "command",
    id: "MessageInformation",
    label: "message information…",
    icon: <Info size={16} aria-hidden="true" />,
    onSelect: ({ triggerEl }) => openDialog({ kind: "Information", messageId: message.id, opener: triggerEl }),
  }];
  const state = resource.state;
  const options: ActionDescriptor[] = [];
  for (const option of state?.kind === "Ready" ? state.options : []) {
    const repeat = option.id === "RegenerateMessage" || option.id === "RerunMessage";
    if (option.id === "ForkMessage" && busy && command.command.kind === "Send")
      options.push({ ...option, disabled: true, disabledReason: "finish sending this message first" });
    else if ((repeat || option.id === "DeleteMessage") && busy) options.push({ ...option, disabled: true, disabledReason: BUSY });
    else options.push(option);
    if (!repeat) continue;
    const operation = option.id === "RerunMessage" ? "rerun" : "regenerate";
    options.push({
      kind: "command",
      id: "RepeatWithModel",
      label: `${operation} with…`,
      disabled: busy || option.disabled,
      disabledReason: busy ? BUSY : option.disabledReason,
      onSelect: ({ triggerEl, openIntent }) => openDialog({ kind: "Repeat", messageId: message.id, operation, opener: triggerEl, openIntent }),
    });
  }
  const content: MenuContent = { sections: [
    { id: "Message", label: options.length ? "this occurrence" : null, options: local },
    ...(options.length ? [{ id: "Resource", label: "item", options }] : []),
  ] };
  const source: MenuSource = {
    kind: "Prepared", subjectKey: `${pane?.visitId ?? "workspace"}:message:${message.id}`, title: "message actions",
    prepare: resource.prepare,
    state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content } : state,
  };
  return <ActionMenu label="more message actions" source={source} onOpenChange={onOpenChange}
    renderTrigger={(binding) => <OverflowMenuButton {...binding} />} />;
}
