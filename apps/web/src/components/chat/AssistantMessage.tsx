"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { GitBranch } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { Schema } from "@/lib/api/wire";
import type { CommandState } from "@/lib/chat/commands";
import { messageActions, type Link, type Live } from "@/lib/chat/runTail";
import type { Message } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { truncateText } from "@/lib/display/format";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import AssistantTrust from "./AssistantTrust";
import MessageDetails from "./MessageDetails";
import type { RowActions } from "./ChatSurface";
import styles from "./ChatSurface.module.css";

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
  invalid_output: [
    "Invalid response",
    "The assistant returned an invalid response. Please try again.",
  ],
  incomplete: [
    "Response incomplete",
    "The response ended before it was finished.",
  ],
  assistant_unavailable: [
    "Assistant unavailable",
    "The assistant is temporarily unavailable. Please try again shortly.",
  ],
  operator_defect: DEFECT,
};
const PHASE: Record<string, string> = {
  Queued: "Response queued.",
  Running: "Response running.",
  Recovering: "Recovering response.",
};

type Passage = {
  exact: string;
  prefix: string;
  suffix: string;
  rect: DOMRect;
  lines: DOMRect[];
};
type Card = {
  title: string;
  body: string;
  code?: string;
  requestId?: string;
  action?: [string, () => void];
};

/** One answer: the saved message, or a pending one painted from its live overlay. */
export default function AssistantMessage({
  message,
  ordinal,
  live,
  command,
  actions,
  footer,
  detailsId,
  detailsOpen,
  detailsTrigger,
  onInspect,
}: {
  message: Message;
  ordinal: number;
  live: Live | null;
  command: CommandState;
  actions: RowActions;
  footer(currentAction: string | null, status: string | null): ReactNode;
  detailsId: string;
  detailsOpen: boolean;
  detailsTrigger: RefObject<HTMLButtonElement | null>;
  onInspect(trigger: HTMLElement): void;
}) {
  const { store } = actions;
  const id = message.id;
  const run = message.trust_trail?.run ?? null;
  const pending = message.status === "pending";
  const failed = message.status === "error" || message.status === "cancelled";
  const forkDisabled = command.kind !== "Idle" && command.command.kind === "Send";
  const repeating = (command.kind === "Sending" || (command.kind === "Reconciling" && command.feedback === null))
    && command.command.kind === "Repeat" && command.command.messageId === id;
  const saved = run?.execution != null ? run.execution : null;
  const phase = (live?.execution ?? saved)?.phase ?? null;
  // cancel intent is monotonic, so either source saying so is exact
  const stopped = Boolean(
    saved?.cancel_requested || live?.execution?.cancel_requested,
  );
  const link: Link = (pending && live?.link) || { kind: "Live" };
  const text = pending ? (live?.text ?? "") : message.content;
  const citations = useMemo(
    () => message.citations.map(toReaderCitationData),
    [message.citations],
  );
  const liveRunId = live?.runId ?? null;
  const liveTools = live?.tools ?? null;
  const toolActions = useMemo(() => messageActions(message, liveRunId && liveTools
    ? { runId: liveRunId, tools: liveTools } : null), [message, liveRunId, liveTools]);
  const tool = pending && link.kind === "Live" && !stopped && phase !== "Suspended"
    ? toolActions.findLast((action) => action.status === "running") : null;
  const currentAction = tool ? [tool.activity.verb, tool.activity.subject === null ? null : truncateText(tool.activity.subject, 80)].filter(Boolean).join(" · ") : null;
  const status = pending && phase !== "Suspended" ? stopped ? "Stop requested." : PHASE[phase ?? ""] ?? null : null;
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const markUndone = useCallback((toolId: string) => setUndone((previous) => new Set(previous).add(toolId)), []);
  const supportId =
    run?.support_id != null
      ? `Support ID: ${run.support_id}`
      : undefined;
  const reconnect = () => store.reconnect(id);

  const answer = useRef<HTMLDivElement>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  useEffect(() => {
    if (!passage) return;
    const dismiss = () =>
      window.getSelection()?.isCollapsed !== false && setPassage(null);
    document.addEventListener("selectionchange", dismiss);
    return () => document.removeEventListener("selectionchange", dismiss);
  }, [passage]);
  const capture = () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const box = answer.current;
    const exact = selection?.toString().trim();
    const inside =
      range &&
      box?.contains(range.startContainer) &&
      box.contains(range.endContainer);
    if (message.status !== "complete" || !range || !box || !exact || !inside)
      return setPassage(null);
    const around = (before: boolean) => {
      const part = range.cloneRange();
      part.selectNodeContents(box);
      if (before) part.setEnd(range.startContainer, range.startOffset);
      else part.setStart(range.endContainer, range.endOffset);
      return part.toString();
    };
    const lines = Array.from(range.getClientRects()).filter(
      (r) => r.width && r.height,
    );
    const rect = range.getBoundingClientRect();
    setPassage({
      exact,
      prefix: around(true).slice(-80),
      suffix: around(false).slice(0, 80),
      rect,
      lines,
    });
  };
  const forkPassage = ({ exact, prefix, suffix }: Passage) => {
    actions.fork({
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

  const [title, body] = run?.failure ? FAILURE[run.failure.code] : DEFECT;
  const card: Card | null = failed
    ? {
        title,
        body,
        code: supportId,
        action: message.can_rerun
          ? ["Rerun", () => void store.repeat("rerun", id)]
          : undefined,
      }
    : !pending
      ? null
      : phase === "Suspended"
        ? {
            title: stopped ? "Stop requested" : "Response paused",
            body: stopped
              ? "The outcome is unconfirmed."
              : "This response is paused. Its outcome is unconfirmed.",
            action:
              link.kind === "Lost" || (link.kind === "Failed" && link.retryable)
                ? ["Check saved status", reconnect]
                : undefined,
          }
        : link.kind === "Failed"
          ? {
              title: "Couldn’t reconnect",
              body: link.feedback.message ?? link.feedback.title,
              requestId: link.feedback.requestId,
              action: link.retryable
                ? ["Try reconnecting", reconnect]
                : undefined,
            }
          : link.kind === "Live"
            ? null
            : {
                title:
                  link.kind === "Lost" ? "Connection lost" : "Reconnecting",
                body: "Reconnect to check this run’s saved status and listen for later updates.",
                action: ["Reconnect", reconnect],
              };
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
      {pending &&
      link.kind === "Live" &&
      !stopped &&
      (phase === "Queued" || phase === "Running") ? (
        <div className={styles.cue} aria-hidden="true" />
      ) : null}
      {run?.failure?.code !== "invalid_output" && (!failed || text.trim()) ? (
        <div
          ref={answer}
          className={styles.answer}
          data-pane-find-block={pending ? undefined : "true"}
          data-pane-find-message-ordinal={ordinal}
          data-pane-find-role="assistant"
        >
          <MarkdownMessage
            presentation="chat"
            content={text}
            citations={citations}
          />
        </div>
      ) : null}
      {run?.publication_warning != null ? (
        <FeedbackNotice content={{ tone: "Warning", title: "references unavailable", message: `the answer completed, but its references could not be attached reliably.${supportId ? ` ${supportId}` : ""}` }} announcement="Polite" />
      ) : null}
      <AssistantTrust actions={toolActions} undone={undone} onUndone={markUndone} />
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
            disabled={forkDisabled}
            onClick={() => forkPassage(passage)}
          >
            Fork from selection
          </Button>
        </FloatingActionSurface>
      ) : null}
      {card ? (
        <FeedbackNotice content={{
          tone: message.status === "cancelled" || link.kind === "Reconnecting" ? "Neutral" : failed ? "Danger" : "Warning",
          title: card.title,
          message: `${card.body}${card.code ? ` ${card.code}` : ""}`,
          requestId: card.requestId,
        }} announcement={pending && phase === "Suspended" ? "Polite" : "Assertive"}
          actions={card.action ? [{ label: card.action[0], onClick: card.action[1],
            busy: failed ? repeating : link.kind === "Reconnecting",
            disabledReason: failed && command.kind !== "Idle" && !repeating ? "finish the current chat action first" : undefined,
          }] : undefined}
        />
      ) : null}
      {footer(currentAction, status)}
      <MessageDetails id={detailsId} message={message} actions={toolActions} open={detailsOpen}
        undone={undone} trigger={detailsTrigger} onInspect={onInspect} />
    </div>
  );
}
