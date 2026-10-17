"use client";

import { memo, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import ResourceLink from "@/components/resources/ResourceLink";
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
  const trail = message.trust_trail;
  const runSelection = trail?.run?.run_selection;
  const shown = runSelection?.display_at_dispatch;
  const context = trail?.context ?? null;
  const panel = useRef<HTMLElement>(null);
  const focused = useRef<{ element: HTMLElement; actionTrigger: HTMLButtonElement | null } | null>(null);
  // A saved read can remove a context link, result link or its action disclosure.
  useLayoutEffect(() => {
    const previous = focused.current;
    if (previous && document.activeElement === document.body && !panel.current?.contains(previous.element)) {
      focused.current = null;
      (previous.actionTrigger?.isConnected ? previous.actionTrigger : trigger.current)?.focus({ preventScroll: true });
    }
  });
  return <section ref={panel} id={id} hidden={!open} aria-label="Message details" aria-live="off"
    onFocusCapture={(event) => {
      focused.current = {
        element: event.target,
        actionTrigger: event.target.closest("[data-message-action]")?.querySelector<HTMLButtonElement>("[data-action-disclosure]") ?? null,
      };
    }}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget) && event.target.isConnected) focused.current = null;
    }}>
    <div className={styles.details}>
      <p className={styles.identity}>{shown
        ? [shown.route_label, shown.model_label, runSelection?.selection.reasoning].filter(Boolean).join(" · ")
        : "model not recorded"}</p>
      {context === null ? <p className={styles.muted}>context not recorded</p>
        : context.length ? <div>
          <h3 className={styles.heading}>context</h3>
          <ul className={styles.list} role="list" aria-label="resource references attached to this run">
            {context.map((item) => <li key={item.ref}><ResourceLink item={item} /></li>)}
          </ul>
        </div> : null}
      {actions.length ? <div>
        <h3 className={styles.heading}>actions</h3>
        <ol className={styles.list} role="list" aria-label="actions">
          {actions.map((action) => <Action key={`${message.id}:${action.tool_call_index}`}
            action={action} undone={action.id !== null && undone.has(action.id)} onInspect={onInspect} />)}
        </ol>
      </div> : null}
    </div>
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
    : action.status === "error" ? "failed" : action.status === "complete" ? null : action.status;
  const label = [activity.verb, activity.subject === null ? null : truncateText(activity.subject, 80)].filter(Boolean).join(" · ");
  return <li data-message-action={action.tool_call_index}>
    <div className={styles.actionLine}>
      <span className={styles.operation}>{activity.verb}{activity.subject !== null ? <> · {activity.target?.kind === "resource"
        ? <ResourceLink item={activity.target.item} label={activity.subject} />
        : activity.target?.kind === "external"
          ? <a className={styles.link} href={activity.target.href}>{activity.subject}</a>
          : <span>{activity.subject}</span>}</> : null}</span>
      {state ? <span className={styles.state}>{state}</span> : null}
      {activity.outcome ? <span className={styles.outcome}>· {activity.outcome}</span> : null}
      {expandable ? <button type="button" className={styles.disclosure} data-action-disclosure="true"
        aria-label={`details for ${label}`} aria-expanded={open} aria-controls={id}
        onClick={(event) => {
          onInspect(event.currentTarget);
          if (open && content.current?.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
          setOpen(!open);
        }}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button> : null}
    </div>
    <div ref={content} id={id} hidden={!open || !expandable}>
      <div className={styles.actionContent}>
        {activity.detail ? <p className={styles.parameters}>{activity.detail}</p> : null}
        {action.retrievals.length ? <ul className={styles.list} role="list" aria-label={`results for ${label}`}>
          {action.retrievals.map((result) => <li key={result.id}><ResourceLink item={result.item} /></li>)}
        </ul> : null}
      </div>
    </div>
  </li>;
}
