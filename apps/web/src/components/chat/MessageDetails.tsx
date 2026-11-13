"use client";

import { memo, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import * as Icon from "@/lib/ui/icons";
import { RetrievalReference } from "./LiveReference";
import ResourceLink from "@/components/resources/ResourceLink";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import type { MessageAction } from "@/lib/chat/runTail";
import type { Message } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import styles from "./MessageDetails.module.css";

/** The run's recorded identity, attached references and observed actions. */
const MessageDetails = memo(function MessageDetails({ id, message, actions, open, undone, trigger, onInspect }: {
  id: string;
  message: Message;
  actions: readonly MessageAction[];
  open: boolean;
  undone: ReadonlySet<string>;
  trigger: RefObject<HTMLButtonElement | null>;
  onInspect(trigger: HTMLElement): void;
}) {
  const { run } = message.trust_trail!; // an answer's trail always carries its run
  const shown = run.run_selection.display_at_dispatch;
  const panel = useRef<HTMLElement>(null);
  const focused = useRef<{ element: HTMLElement; actionTrigger: HTMLButtonElement | null } | null>(null);
  const [inspected, setInspected] = useState(open);
  // A saved read can remove a context link, result link or its action disclosure.
  useLayoutEffect(() => {
    const previous = focused.current;
    if (previous && document.activeElement === document.body && !panel.current?.contains(previous.element)) {
      focused.current = null;
      (previous.actionTrigger?.isConnected ? previous.actionTrigger : trigger.current)?.focus({ preventScroll: true });
    }
  });
  if (open && !inspected) setInspected(true);
  return <section ref={panel} id={id} className={styles.panel} hidden={!open} aria-label="message details" aria-live="off"
    onFocusCapture={(event) => {
      focused.current = {
        element: event.target,
        actionTrigger: event.target.closest("[data-message-action]")?.querySelector<HTMLButtonElement>("[data-action-disclosure]") ?? null,
      };
    }}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && event.target.isConnected) focused.current = null;
    }}>
    {inspected ? <MachineText className={styles.details} origin={{ label: shown.route_label }}>
      {actions.length ? <>
        <h3 className={styles.heading}>actions</h3>
        <ol className={styles.list} role="list" aria-label="actions">
          {actions.map((action) => <Action key={`${message.id}:${action.tool_call_index}`}
            action={action} undone={action.id !== null && undone.has(action.id)} onInspect={onInspect} />)}
        </ol>
      </> : null}
    </MachineText> : null}
  </section>;
});
export default MessageDetails;

function Action({ action, undone, onInspect }: {
  action: MessageAction;
  undone: boolean;
  onInspect(trigger: HTMLElement): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const { activity } = action;
  const expandable = Boolean(activity.detail) || action.retrievals.length > 0;
  const state = undone || action.reverted_at !== null ? "undone"
    : action.status === "error" ? "didn’t work" : action.status === "complete" ? null : action.status;
  const label = [activity.verb, activity.subject === null ? null : truncateText(activity.subject, 80)].filter(Boolean).join(" · ");
  return <li className={styles.action} data-message-action={action.tool_call_index}>
    <div className={styles.actionLine}>
      <span className={styles.operation}>{activity.verb}{activity.subject !== null ? <> · {activity.target?.kind === "resource"
        ? <ResourceLink item={activity.target.item} label={activity.subject} />
        : activity.target?.kind === "external"
          ? <a className={styles.link} href={activity.target.href}>{activity.subject}</a>
          : activity.subject}</> : null}</span>
      {state ? <span className={styles.state}>{state}</span> : null}
      {activity.outcome ? <span className={styles.outcome}>· {activity.outcome}</span> : null}
      {expandable ? <Button iconOnly icon={<Icon.Disclose open={open} />} data-action-disclosure="true"
        aria-label={`details for ${label}`} aria-expanded={open} aria-controls={id}
        onClick={(event) => {
          onInspect(event.currentTarget);
          if (open && content.current?.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
          setOpen(!open);
        }} /> : null}
    </div>
    <div ref={content} className={styles.actionPanel} id={id} hidden={!open || !expandable}>
      <div className={styles.actionContent}>
        {activity.detail ? <p className={styles.parameters}>{activity.detail}</p> : null}
        {action.retrievals.length ? <ul className={styles.list} role="list" aria-label={`results for ${label}`}>
          {action.retrievals.map((result) => <li className={styles.result} key={result.id}><RetrievalReference retrieval={result} /></li>)}
        </ul> : null}
      </div>
    </div>
  </li>;
}
