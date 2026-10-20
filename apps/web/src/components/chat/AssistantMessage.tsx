"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { Schema } from "@/lib/api/wire";
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
import footerStyles from "./MessageFooter.module.css";

type FailureCode = NonNullable<Schema<"TrustRunOut">["failure"]>["code"];
const DEFECT = [
  "Something went wrong",
  "This response could not complete. Keep any support reference shown below for repair.",
];
// Quiet product copy: never a provider name, status text or raw code.
const FAILURE: Record<FailureCode, string[]> = {
  cancelled: ["Cancelled", "This response was cancelled."],
  context_too_large: [
    "Conversation too large",
    "This conversation has grown too large to process. Start a new conversation or branch from an earlier point.",
  ],
  invalid_output: ["Invalid response", "The assistant returned an invalid response. Please try again."],
  incomplete: ["Response incomplete", "The response ended before it was finished."],
  assistant_unavailable: ["Assistant unavailable", "The assistant is temporarily unavailable. Please try again shortly."],
  operator_defect: DEFECT,
};
const PHASE: Record<string, string> = {
  Queued: "Response queued.",
  Running: "Response running.",
  Recovering: "Recovering response.",
};
type Passage = { exact: string; prefix: string; suffix: string; rect: DOMRect; lines: DOMRect[] };
type Card = { content: FeedbackContent; action: [string, (intent: OpenIntent) => void] | null };

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
  const status = pending && phase !== "Suspended" ? (stopped ? "Stop requested." : (PHASE[phase ?? ""] ?? null)) : null;
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const markUndone = useCallback((toolId: string) => setUndone((previous) => new Set(previous).add(toolId)), []);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const supportId = run.support_id != null ? `Support ID: ${run.support_id}` : null;
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

  const [title, body] = run.failure ? FAILURE[run.failure.code] : DEFECT;
  const card: Card | null = failed
    ? {
        content: { tone: message.status === "cancelled" ? "Neutral" : "Danger", title, message: [body, supportId].filter(Boolean).join(" ") },
        action: message.can_rerun ? ["Rerun", (intent) => void store.repeat("rerun", id, null, intent)] : null,
      }
    : !pending
      ? null
      : phase === "Suspended"
        ? {
            content: {
              tone: "Warning",
              title: stopped ? "Stop requested" : "Response paused",
              message: stopped ? "The outcome is unconfirmed." : "This response is paused. Its outcome is unconfirmed.",
            },
            action: link.kind === "Lost" || (link.kind === "Failed" && link.retryable) ? ["Check saved status", reconnect] : null,
          }
        : link.kind === "Failed"
          ? {
              content: { tone: "Warning", title: "Couldn’t reconnect", message: link.feedback.message ?? link.feedback.title, requestId: link.feedback.requestId },
              action: link.retryable ? ["Try reconnecting", reconnect] : null,
            }
          : link.kind === "Live"
            ? null
            : {
                content: {
                  tone: link.kind === "Reconnecting" ? "Neutral" : "Warning",
                  title: link.kind === "Lost" ? "Connection lost" : "Reconnecting",
                  message: "Reconnect to check this run’s saved status and listen for later updates.",
                },
                action: ["Reconnect", reconnect],
              };
  const details = (
    <button
      ref={detailsTrigger}
      type="button"
      className={footerStyles.control}
      aria-expanded={detailsOpen}
      aria-controls={detailsId}
      onClick={(event) => {
        scroll.inspectDisclosure(event.currentTarget);
        if (detailsOpen && document.getElementById(detailsId)?.contains(document.activeElement))
          event.currentTarget.focus({ preventScroll: true });
        setDetailsOpen(!detailsOpen);
      }}
    >
      details{detailsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
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
      {run.publication_warning != null ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "references unavailable",
            message: ["the answer completed, but its references could not be attached reliably.", supportId].filter(Boolean).join(" "),
          }}
          announcement="Polite"
        />
      ) : null}
      <AssistantTrust actions={actions} undone={undone} onUndone={markUndone} />
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
            className={styles.actionControl}
            variant="secondary"
            size="sm"
            leadingIcon={<GitBranch size={14} aria-hidden="true" />}
            disabled={sending}
            onClick={() => forkPassage(passage)}
          >
            Fork from selection
          </Button>
        </FloatingActionSurface>
      ) : null}
      {card ? (
        <FeedbackNotice
          content={card.content}
          announcement={pending && phase === "Suspended" ? "Polite" : "Assertive"}
          actions={card.action ? [{
            label: card.action[0],
            onClick: card.action[1],
            busy: failed ? repeating : link.kind === "Reconnecting",
            disabledReason: failed && command.kind !== "Idle" && !repeating ? "finish the current chat action first" : undefined,
          }] : undefined}
        />
      ) : null}
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
