"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Line } from "@/components/feedback/stage";
import { Announcement } from "@/components/feedback/Announcement";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import * as Icon from "@/lib/ui/icons";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { cancelTurn, readTurn } from "@/lib/chat/commands";
import { emptyLive, foldLive, messageActions, openRunTail, type Live } from "@/lib/chat/runTail";
import { readFailureOf, type Turn } from "@/lib/chat/wire";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import AssistantTrust from "./AssistantTrust";
import MessageDetails from "./MessageDetails";
import LiveReference from "./LiveReference";
import styles from "./ChatSurface.module.css";

const FAILURE_REASON = {
  cancelled: "the turn was cancelled.",
  incomplete: "the model stopped before finishing.",
  assistant_unavailable: "the model wasn’t available.",
  context_too_large: "this turn exceeds the model’s context limit.",
  invalid_output: "the model’s reply was malformed.",
  operator_defect: "nexus hit a fault.",
} as const;

/** Tailing paints one pending turn. A terminal read alone adopts its final text,
 * citations, trust trail and capabilities; stream loss never implies failure. */
export default function ChatTurn({ turn, passage, ordinal, refresh, onInspect, onRetry, retryAvailable }: { onRetry(): void; retryAvailable: boolean; turn: Turn; passage: { messageId: string; start: number; end: number } | null; ordinal: number; refresh(): void; onInspect(trigger: HTMLElement): void }) {
  const [saved, setSaved] = useState(turn);
  const [live, setLive] = useState<Live | null>(null);
  const [reconnect, setReconnect] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => setSaved(previous => previous.assistant_message.status !== "pending" && turn.assistant_message.status === "pending" ? previous : turn), [turn]);
  const message = saved.assistant_message;
  const pending = message.status === "pending";
  useEffect(() => {
    if (!pending) { setLive(null); return; }
    let active = true;
    setLive(emptyLive(saved.run_id));
    const close = openRunTail(saved.run_id, 0, { event: event => { if (active) setLive(previous => foldLive(previous ?? emptyLive(saved.run_id), event)); },
      end: () => {
        void readTurn(saved.run_id).then(current => {
          if (!active) return;
          setSaved(current);
          if (current.assistant_message.status !== "pending") refresh();
          else setLive(previous => previous && ({ ...previous, link: { kind: "Lost" } }));
        }).catch(error => {
          if (!active) return;
          const failure = readFailureOf(error);
          if (failure.kind === "Defect") setDefect({ error });
          else if (failure.kind === "Failed") setLive(previous => previous && ({ ...previous, link: { kind: "Failed", error: failure.error } }));
        });
      } });
    return () => { active = false; close(); };
  }, [saved.run_id, pending, reconnect, refresh]);
  const check = useCallback(() => setReconnect(value => value + 1), []);
  useFailedReadRepair(live?.link.kind === "Failed" || live?.link.kind === "Lost", false, check);
  const actions = useMemo(() => messageActions(message, live), [message, live]);
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const markUndone = useCallback((id: string) => setUndone(previous => new Set(previous).add(id)), []);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const slips = useOutcome();
  const [stopping, setStopping] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const stopped = stopRequested || saved.execution?.cancel_requested || live?.execution?.cancel_requested;
  const stop = async () => {
    setStopping(true);
    try { await cancelTurn(saved.run_id); setStopRequested(true); }
    catch (error) { slips.fail(error, "couldn’t cancel this turn.", { label: "retry", commandKey: `cancel ${saved.run_id}`, run: stop }); }
    finally { setStopping(false); }
  };
  const phase = live?.execution?.phase ?? saved.execution?.phase;
  const status = !pending ? null : stopped ? "cancelling" : phase === "Queued" ? "queued" : phase === "Suspended" ? "waiting for the model" : phase === "Recovering" ? "recovering" : "answering";
  const text = pending ? live?.text || message.content : message.content;
  const run = message.trust_trail?.run;
  const reason = run?.failure ? FAILURE_REASON[run.failure.code] : null;
  const failedLine: Line = { fact: text.trim() ? "this answer is incomplete." : message.status === "cancelled" ? "cancelled." : "couldn’t answer.",
    reason: [reason, run?.support_id ? `support id ${run.support_id}.` : null].filter(Boolean).join(" ") || undefined };
  const selectedMessage = passage?.messageId === saved.user_message.id ? saved.user_message : passage?.messageId === message.id ? message : null;
  const selectedPassage = passage && selectedMessage ? <blockquote aria-label="selected passage"><p>selected passage</p>
    <span>{Array.from(selectedMessage.content).slice(passage.start, passage.end).join("")}</span></blockquote> : null;
  if (defect) throw defect.error;
  return <>
    <div className={styles.message} data-message-id={saved.user_message.id} data-role="user" role="group" aria-label="your message">
      <div className={styles.userPrompt}>
        {saved.retry_of_run_id ? <p>retry of an earlier question</p> : null}
        {saved.user_message.attachments.map((attachment, index) => <div key={index}><LiveReference reference={attachment.reference} item={attachment.item} locationAvailable={attachment.location_available} /></div>)}
        <span className={styles.userBody} data-message-content="true" data-pane-find-block="true" data-pane-find-message-ordinal={ordinal} data-pane-find-role="user">{saved.user_message.content}</span>
      </div>
      {passage?.messageId === saved.user_message.id ? selectedPassage : null}
      <MessageMenu messageId={saved.user_message.id} content={saved.user_message.content} />
    </div>
    <div className={styles.message} data-message-id={message.id} data-role="assistant" role="group" aria-label="librarian answer">
      {text ? <div className={styles.answer} data-message-content="true" data-pane-find-block={pending ? undefined : "true"} data-pane-find-message-ordinal={ordinal + 1} data-pane-find-role="assistant"><MarkdownMessage presentation="chat" content={text} citations={message.citations} /></div> : null}
      {passage?.messageId === message.id ? selectedPassage : null}
      {status ? <p>{status}</p> : null}
      {message.status === "cancelled" || message.status === "error" ? <Fact line={failedLine} /> : null}
      {run?.publication_warning ? <Fact line={{ fact: "couldn’t attach citations.", reason: "the answer is complete." }} /> : null}
      {live?.link.kind === "Failed" ? <Failed error={live.link.error} noun="live updates" retry={{ run: check, busy: false }} /> : live?.link.kind === "Lost" ? <Fact line={{ fact: "live updates stopped." }} verbs={[{ label: "check", commandKey: `check ${saved.run_id}`, run: check }]} /> : null}
      <AssistantTrust messageId={message.id} actions={actions} undone={undone} onUndone={markUndone} />
      <div role="group" aria-label="answer actions">
        {saved.can_retry ? <Button disabled={!retryAvailable} onClick={onRetry}>retry answer</Button> : null}
        {saved.can_cancel ? <Button disabled={stopping || !!stopped} onClick={() => void stop()}>cancel</Button> : null}
        <Button ref={trigger} aria-expanded={details} aria-controls={detailsId} onClick={event => { onInspect(event.currentTarget); setDetails(!details); }}>{details ? "show less" : "show more"}</Button>
        <MessageMenu messageId={message.id} content={text} />
      </div>
      {message.trust_trail ? <MessageDetails id={detailsId} message={message} actions={actions} open={details} undone={undone} trigger={trigger} onInspect={onInspect} /> : null}
    </div>
  </>;
}

function MessageMenu({ messageId, content }: { messageId: string; content: string }) {
  const copy = useCopyFeedback(content);
  const copyTrigger = useRef<HTMLButtonElement>(null);
  const { say } = useOutcome();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const selectText = () => {
    const body = copyTrigger.current?.closest("[data-message-id]")?.querySelector("[data-message-content]");
    if (!body) return;
    const range = document.createRange(); range.selectNodeContents(body);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  };
  const copyText = () => copy.copy(content).catch((error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) say({ fact: "couldn’t copy the message.", reason: "copying isn’t available here." }, [{ label: "select text", commandKey: `select ${messageId}`, run: selectText }]);
    else setDefect({ error });
  });
  const resource = useResourceActions(canonicalResourceRef({ scheme: "message", id: messageId }));
  const runtime = usePaneRuntime();
  const state = resource.state;
  if (defect) throw defect.error;
  return <><Button ref={copyTrigger} iconOnly icon={copy.copied ? <Icon.Check /> : <Icon.Copy />} aria-label="copy message" disabled={!content} onClick={() => void copyText()} />
    {copy.occurrence ? <Announcement text="copied" level="Polite" occurrence={copy.occurrence} /> : null}
    <ActionMenu label="message actions" source={{ kind: "Prepared", subjectKey: `${runtime?.visitId}:message:${messageId}`, title: "message actions", initial: { sections: [] }, prepare: resource.prepare,
    state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content: { sections: [{ id: "message", label: null, options: state.options.filter(option => option.id !== "RetryTurn") }] } } : state }} renderTrigger={binding => <OverflowMenuButton {...binding} />} /></>;
}
