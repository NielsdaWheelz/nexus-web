"use client";
import * as Icon from "@/lib/ui/icons";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import type { Line, Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { useFailedReadRepair } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { pendingReason, sayRefusal } from "@/lib/chat/commands";
import { messageActions, type Link, type Live } from "@/lib/chat/runTail";
import type { Message } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { truncateText } from "@/lib/display/format";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import AssistantTrust from "./AssistantTrust";
import { useChatPane } from "./ChatSurface";
import MessageDetails from "./MessageDetails";
import MessageFooter from "./MessageFooter";
import styles from "./ChatSurface.module.css";

type FailureCode = NonNullable<Schema<"TrustRunOut">["failure"]>["code"];
const COULDNT = "couldn’t answer.";
const CAUSES: Readonly<Record<FailureCode, Line>> = {
  cancelled: { fact: "stopped." },
  incomplete: { fact: "this answer ended early." },
  assistant_unavailable: { fact: COULDNT, reason: "the model wasn’t available." },
  context_too_large: { fact: COULDNT, reason: "this chat is too long for this model." },
  invalid_output: { fact: COULDNT, reason: "the model’s reply was malformed." },
  operator_defect: { fact: COULDNT, reason: "nexus hit a fault." },
};
/** A failed turn's line, by the server's failure card. Only what its owner classifies: never a
 * provider, a status or a code. An errored run with no card is a fault. An errored run's support
 * id follows its cause. */
function failureLine(code: FailureCode | null, supportId: string | null): Line {
  const { fact, reason } = CAUSES[code ?? "operator_defect"];
  return supportId === null ? { fact, reason }
    : { fact, reason: reason === undefined ? `support id ${supportId}.` : `${reason} support id ${supportId}.` };
}
const PHASE: Record<string, string> = {
  Queued: "queued",
  Running: "answering",
  Recovering: "retrying",
};
type Passage = { exact: string; prefix: string; suffix: string; rect: DOMRect; lines: DOMRect[] };

/** One answer: the saved message, or a pending one painted from its live overlay. */
export default function AssistantMessage({ message, ordinal, live, latest, engaged, alternatives }: {
  message: Message;
  ordinal: number;
  live: Live | null;
  latest: boolean;
  engaged: boolean;
  alternatives: ReactNode;
}) {
  const { store, command, scroll, fork } = useChatPane();
  const id = message.id;
  const { run } = message.trust_trail!; // an answer's trail always carries its run
  const pending = message.status === "pending";
  const failed = message.status === "error" || message.status === "cancelled";
  const sending = command.kind !== "Idle" && command.command.kind === "Send";
  const repeating = command.kind === "Busy" && command.command.kind === "Repeat" && command.command.messageId === id;
  const saved = run.execution;
  const phase = (live?.execution ?? saved)?.phase ?? null;
  // cancel intent is monotonic, so either source saying so is exact
  const stopped = Boolean(saved?.cancel_requested || live?.execution?.cancel_requested);
  const link: Link = (pending && live?.link) || { kind: "Live" };
  const text = pending ? (live?.text ?? "") : message.content;
  const citations = useMemo(() => message.citations.map(toReaderCitationData), [message.citations]);
  const liveRunId = live?.runId ?? null;
  const liveTools = live?.tools ?? null;
  const actions = useMemo(
    () => messageActions(message, liveRunId && liveTools ? { runId: liveRunId, tools: liveTools } : null),
    [message, liveRunId, liveTools],
  );
  const tool = pending && link.kind === "Live" && !stopped && phase !== "Suspended"
    ? actions.findLast((action) => action.status === "running") : null;
  const currentAction = tool
    ? [tool.activity.verb, tool.activity.subject === null ? null : truncateText(tool.activity.subject, 80)].filter(Boolean).join(" · ")
    : null;
  const status = pending && phase !== "Suspended" ? (stopped ? "stopping" : (PHASE[phase ?? ""] ?? null)) : null;
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const markUndone = useCallback((toolId: string) => setUndone((previous) => new Set(previous).add(toolId)), []);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const slips = useOutcome();
  const reconnect = () => store.reconnect(id);

  const answer = useRef<HTMLDivElement>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  useEffect(() => {
    if (!passage) return;
    const dismiss = () => window.getSelection()?.isCollapsed !== false && setPassage(null);
    document.addEventListener("selectionchange", dismiss);
    return () => document.removeEventListener("selectionchange", dismiss);
  }, [passage]);
  const capture = () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const box = answer.current;
    const exact = selection?.toString().trim();
    if (message.status !== "complete" || !range || !box || !exact || !box.contains(range.startContainer) || !box.contains(range.endContainer))
      return setPassage(null);
    const around = (before: boolean) => {
      const part = range.cloneRange();
      part.selectNodeContents(box);
      if (before) part.setEnd(range.startContainer, range.startOffset);
      else part.setStart(range.endContainer, range.endOffset);
      return part.toString();
    };
    setPassage({
      exact,
      prefix: around(true).slice(-80),
      suffix: around(false).slice(0, 80),
      rect: range.getBoundingClientRect(),
      lines: Array.from(range.getClientRects()).filter((r) => r.width && r.height),
    });
  };
  const forkPassage = ({ exact, prefix, suffix }: Passage) => {
    fork({
      parentId: id,
      quote: exact,
      anchor: {
        kind: "assistant_selection",
        message_id: id,
        exact,
        prefix: prefix || null,
        suffix: suffix || null,
        offset_status: "unmapped",
        client_selection_id: createRandomId(),
      },
    });
    setPassage(null);
    window.getSelection()?.removeAllRanges();
  };

  // the rerun policy is the server's (`can_rerun`); only the latest turn offers it
  const rerun: Verbs | undefined = message.can_rerun && latest ? [{
    label: "rerun",
    commandKey: `rerun ${id}`,
    busy: repeating,
    disabledReason: command.kind !== "Idle" && !repeating ? pendingReason(command) ?? undefined : undefined,
    run: (intent: OpenIntent) => void store.repeat("rerun", id, null, intent).then((outcome) => sayRefusal(slips, outcome)),
  }] : undefined;
  // `check` reads the same run and tails it again; it never reruns
  const check: Verbs = [{ label: "check", commandKey: `check ${id}`, busy: link.kind === "Reconnecting", run: reconnect }];
  // the transcript is a log, which speaks what lands in it. a stop is the viewer's own act, so it
  // stays silent; a failed link is `Failed`, which speaks for itself from the active region alone
  const linkError = link.kind === "Failed" || link.kind === "Reconnecting" ? link.error : null;
  const linkFailed = pending && phase !== "Suspended" && linkError !== null;
  // reads wake: a failed read of the run reads again on focus and reconnection
  useFailedReadRepair(linkFailed, link.kind === "Reconnecting", reconnect);
  const turn = failed ? <Fact line={failureLine(run.failure?.code ?? null, message.status === "error" ? run.support_id ?? null : null)} verbs={rerun} />
    : !pending ? null
    : phase === "Suspended" ? <Fact line={{ fact: "this answer stalled." }} verbs={link.kind === "Live" ? undefined : check} />
    : linkError !== null ? <Failed error={linkError} noun="live updates" retry={{ run: reconnect, busy: link.kind === "Reconnecting" }} />
    : link.kind === "Live" ? null
    : <Fact line={{ fact: "live updates stopped." }} verbs={check} />;
  const details = (
    <Button
      ref={detailsTrigger}
      aria-expanded={detailsOpen}
      aria-controls={detailsId}
      onClick={(event) => {
        scroll.inspectDisclosure(event.currentTarget);
        if (detailsOpen && document.getElementById(detailsId)?.contains(document.activeElement))
          event.currentTarget.focus({ preventScroll: true });
        setDetailsOpen(!detailsOpen);
      }}
    >
      <span className={styles.detailsLabel}>details<Icon.Disclose open={detailsOpen} size={14} aria-hidden="true" /></span>
    </Button>
  );
  return (
    <div
      className={styles.message}
      data-message-id={id}
      data-role="assistant"
      role="group"
      aria-label="Assistant response"
      onMouseUp={capture}
      onKeyUp={capture}
    >
      {pending && link.kind === "Live" && !stopped && (phase === "Queued" || phase === "Running") ? (
        <div className={styles.cue} aria-hidden="true" />
      ) : null}
      {run.failure?.code !== "invalid_output" && (!failed || text.trim()) ? (
        <div
          ref={answer}
          className={styles.answer}
          data-pane-find-block={pending ? undefined : "true"}
          data-pane-find-message-ordinal={ordinal}
          data-pane-find-role="assistant"
        >
          <MarkdownMessage presentation="chat" content={text} citations={citations} />
        </div>
      ) : null}
      {run.publication_warning != null ? <Fact line={{
        fact: "couldn’t attach citations.",
        reason: run.support_id == null ? "the answer is complete." : `the answer is complete. support id ${run.support_id}.`,
      }} /> : null}
      <AssistantTrust messageId={id} actions={actions} undone={undone} onUndone={markUndone} />
      {passage ? (
        <FloatingActionSurface
          open
          anchor={passage.rect}
          strategy="text-selection"
          lineRects={passage.lines.length ? passage.lines : [passage.rect]}
          role="group"
          label="Assistant answer selection"
          preservePointerSelection
          onDismiss={() => setPassage(null)}
        >
          <Button
            icon={<Icon.Forks aria-hidden="true" />}
            disabled={sending}
            onClick={() => forkPassage(passage)}
          >
            Fork from selection
          </Button>
        </FloatingActionSurface>
      ) : null}
      {turn ? <div aria-live={message.status === "cancelled" || linkFailed ? "off" : undefined}>{turn}</div> : null}
      <MessageFooter
        message={message}
        latest={latest}
        engaged={engaged}
        details={details}
        detailsOpen={detailsOpen}
        currentAction={currentAction}
        status={status}
        alternatives={pending ? null : alternatives}
      />
      <MessageDetails id={detailsId} message={message} actions={actions} open={detailsOpen} undone={undone} trigger={detailsTrigger} />
    </div>
  );
}
