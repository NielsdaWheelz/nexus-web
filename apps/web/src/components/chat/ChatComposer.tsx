"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  GitBranch,
  LocateFixed,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type { Schema } from "@/lib/api/wire";
import { useChatDraft, type SendOutcome } from "@/lib/chat/drafts";
import { unavailability } from "@/lib/chat/selection";
import type { ChatView } from "@/lib/chat/tree";
import {
  failureDetail,
  type AcceptedReceipt,
  type Execution,
  type RejectionCode,
} from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import GenerationPicker, { useCatalog } from "./GenerationPicker";
import QuotedPassageCard, { type QuoteState } from "./QuotedPassageCard";
import styles from "./ChatComposer.module.css";

const BLOCKED = {
  HistoryLoading: "Conversation history is loading.",
  HistoryUnavailable: "Conversation history could not be loaded.",
  AssistantRunning:
    "Assistant response in progress. Your draft is still editable.",
  ReplyTargetUnavailable:
    "Choose a complete assistant response before sending.",
};

/** The draft, its exact generation choice, and the one durable send per draft. */
export default function ChatComposer(props: {
  scope: string;
  view: ChatView;
  /** The pending leaf's live advisory, when its stream is tailed. */
  liveExecution: Execution | null;
  historyReady: boolean;
  onClearBranch(): void;
  onJumpToParent(id: string): void;
  onStop(runId: string): Promise<unknown>;
  quote: QuoteState | null;
  onRemoveQuote(): void;
  onRetryQuote(): void;
  onOpenQuote(selection: Schema<"ReaderSelectionOut">): void;
  onAccepted(receipt: AcceptedReceipt): void;
  onRejected(code: RejectionCode): void;
  reloadRequestId: string | null;
  initialText: string;
  focusKey: string | null;
  isPaneActive: boolean;
}) {
  const { target, branch, activeRun: run, inherited } = props.view;
  const { quote, historyReady, initialText, focusKey, isPaneActive } = props;
  const { draft, sending, setText, setSelection, seed, send, retry } =
    useChatDraft(props.scope);
  const { catalog, failed, refresh } = useCatalog();
  const isMobile = useIsMobileViewport();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const focused = useRef<string | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [reload, setReload] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const reloadId = reload ?? props.reloadRequestId;

  // An uninitialized draft inherits the answer it replies to, else the seed.
  const fresh = draft.selection.kind === "Uninitialized" && !draft.pending;
  useEffect(() => {
    if (catalog && historyReady && fresh)
      setSelection({
        kind: "Selected",
        selection: inherited ?? catalog.chat_seed.selection,
      });
  }, [catalog, historyReady, fresh, inherited, setSelection]);
  useEffect(() => {
    if (initialText) seed(initialText);
  }, [initialText, seed]);
  useEffect(() => {
    if (!focusKey || focused.current === focusKey) return;
    focused.current = focusKey; // spent even when the pane is inactive
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  }, [focusKey, isPaneActive]);

  const unknown = draft.pending !== null && !sending;
  const locked = draft.pending !== null || reloadId !== null;
  const reason = catalog ? unavailability(catalog, draft.selection) : null;
  const quoted = quote?.kind === "Ready" ? quote.selection : null;
  const canSend =
    !locked &&
    target.kind !== "Blocked" &&
    !!catalog &&
    !reason &&
    !!draft.text.trim() &&
    (!quote || !!quoted);

  const finish = (outcome: SendOutcome) => {
    const failure = outcome.kind === "Failed" ? outcome.failure : null;
    if (failure?.kind === "Reload") return setReload(failure.requestId);
    if (failure?.kind === "Defect") return setDefect(failure);
    // an ambiguous failure keeps its command: "Send status unknown"
    if (failure?.kind === "Feedback" && !failure.ambiguous)
      setError(failure.feedback);
    if (outcome.kind === "Accepted") props.onAccepted(outcome.receipt);
    if (outcome.kind === "Rejected") {
      refresh(); // a rejection may mean the catalog changed; rereading is cheap
      setError({
        tone: "Warning",
        title: "This message wasn’t sent.",
        message: failureDetail(outcome.code),
      });
      props.onRejected(outcome.code);
    }
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  };
  const submit = () => {
    if (!canSend || !catalog || draft.selection.kind !== "Selected") return;
    setError(null);
    void send({
      destination:
        target.kind === "New"
          ? { kind: "New" }
          : {
              kind: "Existing",
              conversation_id: target.conversationId,
              insertion:
                target.kind === "Empty"
                  ? { kind: "Empty" }
                  : {
                      kind: "Reply",
                      parent_message_id: target.parentId,
                      branch_anchor: target.anchor,
                    },
            },
      content: draft.text.trim(),
      catalog_definition_revision: catalog.definition_revision,
      selection: draft.selection.selection,
      reader_selection: quoted
        ? {
            kind: "Present",
            value: { key: quoted.key, revision: quoted.revision },
          }
        : { kind: "Absent" },
    }).then(finish);
  };
  // cancel intent is monotonic, so saved or live saying so is exact
  const stopRequested = Boolean(
    run?.execution?.cancel_requested || props.liveExecution?.cancel_requested,
  );
  const stop = () => {
    if (!run) return;
    setStopping(true);
    void props.onStop(run.runId).finally(() => setStopping(false));
  };
  const icon = (label: string, node: ReactNode, onClick: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {node}
    </Button>
  );

  if (defect) throw defect.error;
  return (
    <div className={styles.composer}>
      <div className={styles.shell}>
        <span className="sr-only" aria-live="polite">
          {target.kind === "Blocked" ? BLOCKED[target.reason] : ""}
        </span>
        {error ? (
          <FeedbackNotice content={error} announcement="Assertive" />
        ) : null}
        {reloadId !== null ? (
          <FeedbackNotice
            announcement="Assertive"
            content={{
              tone: "Warning",
              title: "Reload Nexus to continue",
              message:
                "This tab speaks an older chat contract. Your draft and sent messages are saved.",
              requestId: reloadId || undefined,
            }}
            actions={[
              {
                label: "Reload Nexus",
                onClick: () => window.location.reload(),
              },
            ]}
          />
        ) : unknown ? (
          <p className={styles.alert} role="alert">
            Send status unknown. The message and its exact model choice are
            locked for retry.
          </p>
        ) : null}
        {branch ? (
          <section className={styles.fork} aria-label="Fork reply">
            <GitBranch size={16} aria-hidden="true" />
            <div>
              <strong>Fork reply</strong>
              {branch.quote ? (
                <blockquote>{truncateText(branch.quote, 220)}</blockquote>
              ) : null}
            </div>
            {icon(
              "Jump to parent message",
              <LocateFixed size={15} aria-hidden="true" />,
              () => props.onJumpToParent(branch.parentId),
            )}
            {icon(
              "Cancel branch reply",
              <X size={16} aria-hidden="true" />,
              props.onClearBranch,
            )}
          </section>
        ) : null}
        {quote ? (
          <QuotedPassageCard
            quote={quote}
            onOpen={props.onOpenQuote}
            onRemove={locked ? undefined : props.onRemoveQuote}
            onRetry={props.onRetryQuote}
          />
        ) : null}
        <Textarea
          ref={textarea}
          variant="bare"
          autoGrow
          minRows={2}
          maxRows={6}
          className={styles.input}
          value={draft.text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || composing.current) return;
            if (event.nativeEvent.isComposing || (!isMobile && event.shiftKey))
              return;
            event.preventDefault();
            if (!isMobile) return submit();
            // on a phone every Enter is a newline
            const field = event.currentTarget;
            field.setRangeText(
              "\n",
              field.selectionStart,
              field.selectionEnd,
              "end",
            );
            setText(field.value);
          }}
          aria-label="Ask anything"
          placeholder="Ask anything..."
          disabled={locked}
        />
        <div className={styles.row}>
          {catalog ? (
            <GenerationPicker
              catalog={catalog}
              value={draft.selection}
              onChange={setSelection}
              disabled={locked}
            />
          ) : (
            <span className={styles.status} role="status">
              {failed
                ? "Model availability could not be loaded. Your draft is still editable."
                : "Loading model availability…"}
              {failed ? (
                <Button variant="ghost" size="sm" onClick={refresh}>
                  Retry
                </Button>
              ) : null}
            </span>
          )}
          <Button
            variant={unknown || run ? "ghost" : "primary"}
            iconOnly
            className={styles.send}
            loading={unknown ? false : run ? stopping : sending}
            disabled={unknown ? false : run ? stopRequested : !canSend}
            onClick={
              unknown ? () => void retry()?.then(finish) : run ? stop : submit
            }
            aria-label={
              unknown
                ? "Retry send"
                : run
                  ? stopRequested
                    ? "Stop requested"
                    : "Stop response"
                  : sending
                    ? "Sending message"
                    : "Send message"
            }
          >
            {unknown ? (
              <RotateCcw size={16} aria-hidden="true" />
            ) : run ? (
              <Square size={16} aria-hidden="true" />
            ) : (
              <ArrowUp size={18} aria-hidden="true" />
            )}
          </Button>
        </div>
        {reason && draft.selection.kind !== "Uninitialized" ? (
          <p className={styles.warning} role="status">
            {reason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
