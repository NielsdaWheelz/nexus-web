"use client";

import { useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { Copy, Ellipsis, Info, RotateCcw } from "lucide-react";
import { FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import { ResourceComposer } from "@/components/resources/ResourceDisclosure";
import ActionMenu from "@/components/ui/ActionMenu";
import Tooltip from "@/components/ui/Tooltip";
import { useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import { useThrowLater } from "@/lib/api/serverState";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import type { Message } from "@/lib/chat/wire";
import { useMobileChromeHold } from "@/lib/mobileShell/chrome";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import type { MessageDialogRequest } from "./MessageDialogs";
import styles from "./MessageFooter.module.css";

type Trigger = Parameters<NonNullable<ComponentProps<typeof ActionMenu>["renderTrigger"]>>[0];

/** One stable action band. Command and dialog owners retain the actual operations. */
export default function MessageFooter({ message, latest, command, engaged, details, detailsOpen, currentAction, status, alternatives, onDialog, onRegenerate }: {
  message: Message;
  latest: boolean;
  command: CommandState;
  engaged: boolean;
  details?: ReactNode;
  detailsOpen?: boolean;
  currentAction: string | null;
  status: string | null;
  alternatives?: ReactNode;
  onDialog(request: MessageDialogRequest): void;
  onRegenerate(id: string): Promise<CommandOutcome>;
}) {
  const feedback = useFeedback();
  const fail = useThrowLater();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding,setAdding] = useState(false);
  useMobileChromeHold(menuOpen);
  const run = message.trust_trail?.run;
  const pending = message.role === "assistant" && message.status === "pending";
  const copyable = message.content.trim().length > 0 && run?.failure?.code !== "invalid_output";
  const copy = async () => {
    try {
      await copyText(message.content);
      feedback.receipt({ tone: "Success", title: "message copied" });
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) return fail({ error });
      feedback.offer({ key: `message-copy:${message.id}`, announcement: "Polite", content: { tone: "Warning", title: "couldn’t copy message" } });
    }
  };
  return (
    <> <div className={styles.footer} role="group" aria-label="Message actions" data-latest={latest} data-engaged={engaged || menuOpen}>
      <div className={styles.left}>
        {details}
        {message.role === "assistant" && (currentAction || status) ? <div className={detailsOpen && currentAction ? "sr-only" : styles.currentAction}>
          <FeedbackStatus content={{ tone: "Neutral", title: currentAction ?? status ?? "" }} announcement="Polite" />
        </div> : null}
        {pending ? null : alternatives}
      </div>
      {pending ? null : <div className={`${styles.right} ${styles.secondary}`}>
        {copyable ? <IconAction label="copy message" onClick={() => void copy()}><Copy size={16} aria-hidden="true" /></IconAction> : null}
        {message.role === "assistant" && message.status === "complete" && run ?
          <IconAction label="regenerate response" disabled={command.kind !== "Idle"} onClick={() => void onRegenerate(message.id)}><RotateCcw size={16} aria-hidden="true" /></IconAction> : null}
        <MessageMenu message={message} command={command} onDialog={onDialog} onOpenChange={setMenuOpen} onAdd={()=>setAdding(true)} />
      </div>}
    </div>{adding ? <ResourceComposer source={{kind:"resource",ref:`message:${message.id}`}} occurrenceKey={`message:${message.id}`} label="add item" /> : null}</>
  );
}

function IconAction({ label, children, ...props }: Omit<ComponentProps<"button">, "type" | "aria-label"> & { label: string }) {
  return <Tooltip text={label} renderTrigger={(hint) => <button {...props} {...hint} type="button" aria-label={label} className={styles.control}>{children}</button>} />;
}

/** Fetch/eligibility remain with the resource action producer, including its retry rows. */
function MessageMenu({ message, command, onDialog, onOpenChange, onAdd }: {
  message: Message;
  command: CommandState;
  onDialog(request: MessageDialogRequest): void;
  onOpenChange(open: boolean): void;
  onAdd(): void;
}) {
  const resource = useResourceActionMenu(canonicalResourceRef({ scheme: "message", id: message.id }));
  const options: ActionDescriptor[] = [{kind:"command",id:"Resource.AddItem",label:"add item",onSelect:onAdd},{
    kind: "command", id: "MessageInformation", label: "message information…", icon: <Info size={16} aria-hidden="true" />,
    onSelect: ({ triggerEl }) => onDialog({ kind: "Information", messageId: message.id, opener: triggerEl }),
  }];
  for (const option of resource.options) {
    const mutation = option.id === "RegenerateMessage" || option.id === "RerunMessage" || option.id === "DeleteMessage";
    const frozenFork = option.id === "ForkMessage" && command.kind !== "Idle" && command.command.kind === "Send";
    options.push(frozenFork ? { ...option, disabled: true, disabledReason: "finish sending this message first" }
      : mutation && command.kind !== "Idle" ? { ...option, disabled: true, disabledReason: "finish the current chat action first" } : option);
    if ((option.id === "RegenerateMessage" || option.id === "RerunMessage") && !option.disabled) {
      const operation = option.id === "RerunMessage" ? "rerun" : "regenerate";
      options.push({
        kind: "command", id: "RepeatWithModel", label: `${operation} with…`,
        disabled: command.kind !== "Idle", disabledReason: command.kind !== "Idle" ? "finish the current chat action first" : undefined,
        onSelect: ({ triggerEl }) => onDialog({ kind: "Repeat", messageId: message.id, operation, opener: triggerEl }),
      });
    }
  }
  return <ActionMenu label="more message actions" options={options}
    onOpenChange={(next) => { resource.onOpenChange(next); onOpenChange(next); }}
    renderTrigger={(binding) => <MenuTrigger binding={binding} />} />;
}

function MenuTrigger({ binding }: { binding: Trigger }) {
  return <Tooltip text="more message actions" renderTrigger={(hint) => <button {...binding} {...hint}
    ref={(node) => { assignRef(binding.ref, node); assignRef(hint.ref, node); }}
    aria-describedby={[binding["aria-describedby"], hint["aria-describedby"]].filter(Boolean).join(" ") || undefined}
    className={styles.control}><Ellipsis size={16} aria-hidden="true" /></button>} />;
}

function assignRef(ref: Ref<HTMLButtonElement>, node: HTMLButtonElement | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}
