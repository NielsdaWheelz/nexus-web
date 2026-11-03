"use client";
import * as Icon from "@/lib/ui/icons";

import { useState, type ReactNode } from "react";
import { Announcement, useOutcome } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import Button from "@/components/ui/Button";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import { useThrowLater } from "@/lib/api/serverState";
import { PENDING_CHANGE } from "@/lib/chat/commands";
import type { Message } from "@/lib/chat/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { useChatPane } from "./ChatSurface";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import styles from "./MessageFooter.module.css";

/** One stable action band. Command and dialog owners retain the actual operations. Tool activity
 * is plain text: the transcript is a log, and speaks what lands in it. */
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
  const copied = useCopyFeedback(`${message.id}:${message.content}`);
  const { say } = useOutcome();
  const fail = useThrowLater();
  const [menuOpen, setMenuOpen] = useState(false);
  const run = message.trust_trail?.run;
  const pending = message.role === "assistant" && message.status === "pending";
  const copy = async () => {
    try {
      await copied.copy(message.content);
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) return fail({ error });
      say({ fact: "couldn’t copy.", reason: "the clipboard isn’t available here." });
    }
  };
  return (
    <div className={styles.footer} role="group" aria-label="Message actions" data-latest={latest} data-engaged={engaged || menuOpen}>
      {copied.occurrence ? <Announcement text="copied" level="Polite" occurrence={copied.occurrence} /> : null}
      <div className={styles.left}>
        {details}
        {currentAction || status ? (
          // the log speaks a phase as it changes; `stopping` answers the viewer's own press, so it stays silent
          <div className={detailsOpen && currentAction ? "sr-only" : styles.currentAction} aria-live={status === "stopping" ? "off" : undefined}>{currentAction ?? status}</div>
        ) : null}
        {pending ? null : alternatives}
      </div>
      {pending ? null : (
        <div className={styles.right}>
          {message.content.trim() && run?.failure?.code !== "invalid_output" ? (
            <Button iconOnly icon={copied.copied ? <Icon.Check /> : <Icon.Copy />} aria-label="Copy message" className={styles.secondary} onClick={() => void copy()} />
          ) : null}
          <MessageMenu message={message} onOpenChange={setMenuOpen} />
        </div>
      )}
    </div>
  );
}

/** Resource facts determine applicability; live availability keeps eligible repeats present. */
function MessageMenu({ message, onOpenChange }: { message: Message; onOpenChange(open: boolean): void }) {
  const { command, openDialog } = useChatPane();
  const pane = usePaneRuntime();
  const resource = useResourceActions(canonicalResourceRef({ scheme: "message", id: message.id }));
  const busy = command.kind !== "Idle";
  const local: ActionDescriptor[] = [{
    kind: "command",
    id: "MessageInformation",
    label: "Message information…",
    icon: null,
    onSelect: ({ triggerEl }) => openDialog({ kind: "Information", messageId: message.id, opener: triggerEl }),
  }];
  const state = resource.state;
  const options: ActionDescriptor[] = [];
  for (const option of state?.kind === "Ready" ? state.options : []) {
    const repeat = option.id === "RegenerateMessage" || option.id === "RerunMessage";
    if ((option.id === "ForkMessage" && busy && command.command.kind === "Send") || ((repeat || option.id === "DeleteMessage") && busy))
      options.push({ ...option, disabled: true, disabledReason: PENDING_CHANGE });
    else options.push(option);
    if (!repeat || option.kind === "custom") continue;
    const operation = option.id === "RerunMessage" ? "rerun" : "regenerate";
    options.push({
      kind: "command",
      id: "RepeatWithModel",
      label: option.id === "RerunMessage" ? "Rerun with…" : "Regenerate with…",
      icon: option.icon,
      disabled: busy || option.disabled,
      disabledReason: busy ? PENDING_CHANGE : option.disabledReason,
      onSelect: ({ triggerEl, openIntent }) => openDialog({ kind: "Repeat", messageId: message.id, operation, opener: triggerEl, openIntent }),
    });
  }
  const content: MenuContent = { sections: [
    { id: "Message", label: null, options: local },
    ...(options.length ? [{ id: "Resource", label: null, options }] : []),
  ] };
  const source: MenuSource = {
    kind: "Prepared", initial: { sections: [] }, subjectKey: `${pane?.visitId ?? "workspace"}:message:${message.id}`, title: "message actions",
    prepare: resource.prepare,
    state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content } : state,
  };
  return <ActionMenu label="more message actions" source={source} onOpenChange={onOpenChange}
    renderTrigger={(binding) => <OverflowMenuButton {...binding} />} />;
}
