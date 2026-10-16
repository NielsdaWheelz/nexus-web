"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitBranch, Search, TriangleAlert } from "lucide-react";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { Schema } from "@/lib/api/wire";
import type { CommandState } from "@/lib/chat/commands";
import type { Link, Live } from "@/lib/chat/runTail";
import type { Message } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import AssistantTrust from "./AssistantTrust";
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
}: {
  message: Message;
  ordinal: number;
  live: Live | null;
  command: CommandState;
  actions: RowActions;
  footer: ReactNode;
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
  const tools = Object.values(pending ? (live?.tools ?? {}) : {});
  const tool = tools.findLast((t) => t.running)?.label;
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
              code:
                link.feedback.requestId &&
                `Request ID: ${link.feedback.requestId}`,
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
      {pending &&
      phase !== "Suspended" &&
      (stopped || (phase && PHASE[phase])) ? (
        <p className={styles.runStatus}>
          {stopped ? "Stop requested." : PHASE[phase ?? ""]}
        </p>
      ) : null}
      {tool ? (
        <div className={styles.tool} role="status" aria-live="polite">
          <Search size={14} aria-hidden="true" />
          <span>{tool}</span>
        </div>
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
            onCitationActivate={actions.activate}
          />
        </div>
      ) : null}
      {run?.publication_warning != null ? (
        <div className={styles.notice} role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <p>
            <strong>References unavailable</strong> — the answer completed, but
            its references could not be attached reliably.
          </p>
          {supportId ? <p className={styles.code}>{supportId}</p> : null}
        </div>
      ) : null}
      {pending ? null : (
        <AssistantTrust message={message} />
      )}
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
        <div
          className={failed ? styles.card : `${styles.card} ${styles.quiet}`}
          role={pending && phase === "Suspended" ? "status" : "alert"}
        >
          <p className={styles.cardTitle}>{card.title}</p>
          <p>{card.body}</p>
          {card.code ? <p className={styles.code}>{card.code}</p> : null}
          {card.action ? (
            <Button
              className={styles.actionControl}
              variant="secondary"
              size="sm"
              disabled={failed && command.kind !== "Idle"}
              loading={failed ? repeating : link.kind === "Reconnecting"}
              onClick={card.action[1]}
            >
              {card.action[0]}
            </Button>
          ) : null}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
