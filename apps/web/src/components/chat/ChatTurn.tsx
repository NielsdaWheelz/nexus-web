"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Line } from "@/components/feedback/stage";
import { Announcement } from "@/components/feedback/Announcement";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import * as Icon from "@/lib/ui/icons";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { MarkdownMessage, TextPreview } from "./MarkdownMessage";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { cancelTurn, readTurn } from "@/lib/chat/commands";
import { emptyLive, foldLive, messageActions, openRunTail, type Live } from "@/lib/chat/runTail";
import { readFailureOf, type Turn } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import AssistantTrust from "./AssistantTrust";
import MessageDetails from "./MessageDetails";
import ReferenceFigure from "./ReferenceFigure";
import styles from "./ChatSurface.module.css";
import inspection from "./messageInspection.module.css";

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
export default function ChatTurn({ turn, passage, refresh, onInspect, onRetry, retryBlocked, day, time, inlineAttachments, onReadTurn, onRevealReferences, onContentLayout }: {
  turn: Turn;
  passage: { messageId: string; start: number; end: number } | null;
  day: { label: string; full: string } | null;
  time: string;
  retryBlocked: string | null;
  inlineAttachments: boolean;
  refresh(): void;
  onRetry(): void;
  onReadTurn(turn: Turn): void;
  onInspect(trigger: HTMLElement): void;
  onRevealReferences(messageId: string, trigger: HTMLElement, keyboard: boolean): void;
  onContentLayout(): void;
}) {
  const saved = turn;
  const [live, setLive] = useState<Live | null>(null);
  const [reconnect, setReconnect] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
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
          onReadTurn(current);
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
  }, [saved.run_id, pending, reconnect, refresh, onReadTurn]);
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
  const status = !pending ? null : phase === "Suspended" ? "this turn needs a repair." : stopped ? "stopping this turn." : phase === "Queued" ? "queued" : phase === "Recovering" ? "recovering this turn." : "answering";
  const text = pending ? live?.text || message.content : message.content;
  useLayoutEffect(onContentLayout, [text, message, onContentLayout]);
  const run = message.trust_trail?.run;
  const reason = run?.failure ? FAILURE_REASON[run.failure.code] : null;
  const failedLine: Line = { fact: text.trim() ? "this answer is incomplete." : message.status === "cancelled" ? "cancelled." : "couldn’t answer.",
    reason: [reason, run?.support_id ? `support id ${run.support_id}.` : null].filter(Boolean).join(" ") || undefined };
  const runningAction = actions.findLast(action => action.status === "running");
  const activity = status === "answering" && runningAction
    ? [runningAction.activity.verb, runningAction.activity.subject === null ? null : truncateText(runningAction.activity.subject, 80)].filter(Boolean).join(" · ") : status;
  const shown = run?.run_selection.display_at_dispatch;
  const longQuestion = saved.user_message.content.length > 280 || /\r?\n[ \t]*\r?\n/.test(saved.user_message.content);
  const Question = longQuestion ? "p" : "h2";
  if (defect) throw defect.error;
  return <article className={styles.leaf}>
    <div className={styles.message} data-message-id={saved.user_message.id} data-role="user" role="group" aria-label="your message">
      {day ? <div className={styles.day}>
        <time className={styles.dayTime} dateTime={saved.user_message.created_at} aria-label={day.full}>{day.label}</time>
        <span className={styles.dayLine} aria-hidden="true" />
      </div> : null}
      {saved.retry_of_run_id ? <p className={styles.retry}>retry of an earlier question</p> : null}
      {longQuestion ? <h2 className="sr-only"><TextPreview content={saved.user_message.content} /></h2> : null}
      <Question className={longQuestion ? styles.longQuestion : styles.question} data-message-content="true">{passage?.messageId === saved.user_message.id
        ? <>{saved.user_message.content.slice(0, passage.start)}<mark className={inspection.literal} data-message-passage="true"
            data-message-source-start={passage.start} data-message-source-end={passage.end}>{saved.user_message.content.slice(passage.start, passage.end)}</mark>{saved.user_message.content.slice(passage.end)}</>
        : saved.user_message.content}</Question>
      {saved.user_message.attachments.length > 0 ? inlineAttachments ? <div className={styles.inlineReferences} data-type-role="margin">
        {saved.user_message.attachments.map((value, index) => <div className={styles.attachment} key={index} data-reference-key={`${saved.user_message.id}:attachment:${index}`}>
          <ReferenceFigure value={value} />
        </div>)}
      </div> : <div className={styles.attachmentReveal}>
        <Button aria-label={`references · ${saved.user_message.attachments.length} for your message`} onClick={event => onRevealReferences(saved.user_message.id, event.currentTarget, event.detail === 0)}>references · {saved.user_message.attachments.length}</Button>
      </div> : null}
    </div>
    <div className={styles.message} data-message-id={message.id} data-role="assistant" role="group" aria-label="librarian answer">
      {text || pending ? <div className={styles.answer} data-message-content="true"><MarkdownMessage content={text} citations={message.citations} live={pending} citationPreview={inlineAttachments}
        passage={passage?.messageId === message.id ? passage : null} /></div> : null}
      {message.status === "cancelled" || message.status === "error" ? <Fact line={failedLine} verbs={saved.can_retry ? [{ label: "retry", commandKey: `retry ${saved.run_id}`, disabledReason: retryBlocked ?? undefined, run: onRetry }] : undefined} /> : null}
      {run?.publication_warning ? <Fact line={{ fact: "couldn’t attach citations.", reason: "the answer is complete." }} /> : null}
      {live?.link.kind === "Failed" ? <Failed error={live.link.error} noun="live updates" retry={{ run: check, busy: false }} /> : live?.link.kind === "Lost" ? <Fact line={{ fact: "live updates stopped." }} verbs={[{ label: "check", commandKey: `check ${saved.run_id}`, run: check }]} /> : null}
      <AssistantTrust messageId={message.id} actions={actions} undone={undone} onUndone={markUndone} />
      <div className={styles.foot} role="group" aria-label="answer actions">
        <div className={styles.footLeft}>
          {message.citations.length > 0 ? <Button className={styles.referenceButton} aria-label={`references · ${message.citations.length} for this answer`} onClick={event => onRevealReferences(message.id, event.currentTarget, event.detail === 0)}>references · {message.citations.length}</Button> : null}
          {message.trust_trail ? <Button ref={trigger} className={styles.trailDisclosure} icon={<Icon.Disclose open={details} />} aria-expanded={details} aria-controls={detailsId}
            onClick={event => { onInspect(event.currentTarget); setDetails(!details); }}>
            {pending ? <><span className={styles.live} aria-hidden="true"><span className={styles.dot} data-running={phase === "Running" && !stopped || undefined} /><span className={styles.liveAct}>{activity}</span></span><span className="sr-only">{status}</span></>
              : <span className={styles.signature}><time className={styles.signatureTime} dateTime={saved.user_message.created_at}>{time}</time>{shown ? ` · ${shown.model_label} · ${shown.reasoning_label}` : null}</span>}
          </Button> : <time className={styles.signature} dateTime={saved.user_message.created_at}>{time}</time>}
        </div>
        <div className={styles.footRight}>
          {saved.can_cancel ? <Button disabled={stopping || !!stopped} onClick={() => void stop()}>cancel</Button> : null}
          <div className={styles.quiet}><MessageMenu messageId={message.id} content={text} question={saved.user_message} /></div>
        </div>
      </div>
      {message.trust_trail ? <MessageDetails id={detailsId} message={message} actions={actions} open={details} undone={undone} trigger={trigger} onInspect={onInspect} /> : null}
    </div>
  </article>;
}

function MessageMenu({ messageId, content, question }: { messageId: string; content: string; question: { id: string; content: string } }) {
  const answerCopy = useCopyFeedback(content);
  const questionCopy = useCopyFeedback(question.content);
  const copyTrigger = useRef<HTMLButtonElement>(null);
  const { say } = useOutcome();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const copyText = (message: { id: string; content: string }, copy: (text: string) => Promise<void>) => copy(message.content).catch((error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) say({ fact: message.id === question.id ? "couldn’t copy the question." : "couldn’t copy the answer.", reason: "copying isn’t available here." }, [{ label: "select text", commandKey: `select ${message.id}`, run: () => {
      const body = copyTrigger.current?.closest("article")?.querySelector(`[data-message-id="${CSS.escape(message.id)}"] [data-message-content]`);
      if (!body) return;
      const range = document.createRange(); range.selectNodeContents(body);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    } }]);
    else setDefect({ error });
  });
  const resource = useResourceActions(canonicalResourceRef({ scheme: "message", id: messageId }));
  const runtime = usePaneRuntime();
  const state = resource.state;
  if (defect) throw defect.error;
  return <><Button ref={copyTrigger} iconOnly icon={answerCopy.copied ? <Icon.Check /> : <Icon.Copy />} aria-label="copy answer" disabled={!content} onClick={() => void copyText({ id: messageId, content }, answerCopy.copy)} />
    {answerCopy.occurrence ? <Announcement text="copied" level="Polite" occurrence={answerCopy.occurrence} /> : null}
    {questionCopy.occurrence ? <Announcement text="copied" level="Polite" occurrence={questionCopy.occurrence} /> : null}
    <ActionMenu label="turn actions" source={{
      kind: "Prepared", subjectKey: `${runtime?.visitId}:message:${messageId}`, title: "turn actions",
      initial: { sections: [{ id: "question", label: null, options: [{
        kind: "command", id: "CopyQuestion", label: "copy question", icon: null,
        onSelect: () => void copyText(question, questionCopy.copy),
      }] }] },
      prepare: resource.prepare,
      state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content: { sections: [{
        id: "message", label: null, options: state.options.filter(option => option.id !== "RetryTurn"),
      }] } } : state,
    }} renderTrigger={binding => <OverflowMenuButton {...binding} />} /></>;
}
