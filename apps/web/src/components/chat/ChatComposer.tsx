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
  FeedbackStatus,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import type { ServerValue } from "@/lib/api/serverState";
import { useChatDraft, type SendOutcome } from "@/lib/chat/drafts";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { ChatView } from "@/lib/chat/tree";
import {
  failureDetail,
  type Catalog,
  type Execution,
  type RejectionCode,
} from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import GenerationPicker from "./GenerationPicker";
import QuotedPassage, { type QuoteState } from "./QuotedPassage";
import styles from "./ChatComposer.module.css";

const BLOCKED = {
  HistoryLoading: "Conversation history is loading.",
  HistoryUnavailable: "Conversation history could not be loaded.",
  AssistantRunning:
    "Assistant response in progress. Your draft is still editable.",
  ReplyTargetUnavailable:
    "Choose a complete assistant response before sending.",
};

/** Draft text/choice and controls for the chat's current admission state. */
export default function ChatComposer(props: {
  catalogRead: ServerValue<Catalog>;
  scope: string;
  viewId: string;
  expectedRevision: number | null;
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
  dispatchSend(run: () => Promise<SendOutcome>, intent: OpenIntent, subject: string): Promise<SendOutcome>;
  onRejected(code: RejectionCode): void;
  initialText: string;
  focusKey: string | null;
  isPaneActive: boolean;
}) {
  const { target, branch, activeRun: run, inherited } = props.view;
  const { quote, historyReady, initialText, focusKey, isPaneActive } = props;
  const { draft, sending, command, setText, setSelection, seed, send, retry } =
    useChatDraft(props.scope, props.viewId, props.expectedRevision);
  const { catalogRead } = props;
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const [incomplete, setIncomplete] = useState<Extract<SelectionEditor,
    { kind: "ModelRequired" | "EffortRequired" }> | null>(null);
  const selection: SelectionEditor = draft.pending
    ? { kind: "Selected", selection: draft.pending.request.selection }
    : incomplete ?? draft.selection;
  const isMobile = useIsMobileViewport();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const composing = useRef(false);
  const focused = useRef<string | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [stopping, setStopping] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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

  const existingSend = command.kind !== "Idle" && command.command.kind === "Send" && command.command.viewId === props.viewId;
  const unknown = props.scope === "new"
    ? draft.pending !== null && !sending
    : existingSend && command.kind === "Unconfirmed";
  const refresh = existingSend && (command.kind === "RefreshRequired" ||
    (command.kind === "Reconciling" && command.feedback !== null));
  const recovery = unknown || refresh;
  const locked = draft.pending !== null;
  const reason = catalog ? unavailability(catalog, selection) : null;
  const quoted = quote?.kind === "Ready" ? quote.selection : null;
  const canSend =
    !locked &&
    command.kind === "Idle" &&
    (props.scope === "new" || props.expectedRevision !== null) &&
    target.kind !== "Blocked" &&
    !!catalog &&
    selection.kind === "Selected" &&
    !reason &&
    !!draft.text.trim() &&
    (!quote || !!quoted);

  const finish = (outcome: SendOutcome) => {
    if (!mounted.current) return;
    const failure = outcome.kind === "Failed" ? outcome.failure : null;
    if (failure?.kind === "Defect") return setDefect(failure);
    // an ambiguous failure keeps its command: "Send status unknown"
    if (failure?.kind === "Feedback" && !failure.ambiguous)
      setError(failure.feedback);
    if (outcome.kind === "Rejected") {
      catalogRead.refetch(); // a rejection may mean the catalog changed; rereading is cheap
      setError({
        tone: "Warning",
        title: "This message wasn’t sent.",
        message: failureDetail(outcome.code),
      });
      props.onRejected(outcome.code);
    }
  };
  const submit = (openIntent: OpenIntent = "default") => {
    if (!canSend || !catalog || selection.kind !== "Selected") return;
    const content = draft.text.trim();
    setError(null);
    void props.dispatchSend(() => send({
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
      content,
      selection: selection.selection,
      reader_selection: quoted
        ? { key: quoted.key, revision: quoted.revision }
        : null,
    }, openIntent), openIntent, truncateText(content, 220)).then(finish);
  };
  const activateSend = (event: TargetActivationEvent) => {
    if (run && !recovery) return;
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    const intent = activation.intent === "new_pane" || draft.pending?.openIntent === "new_pane" ? "new_pane" : "default";
    if (!recovery) return submit(intent);
    void props.dispatchSend(() => retry(intent) ?? Promise.resolve({ kind: "Failed", failure: { kind: "Handled" } }), intent,
      truncateText(draft.pending?.request.content ?? draft.text.trim(), 220)).then(finish);
  };
  // cancel intent is monotonic, so saved or live saying so is exact
  const stopRequested = Boolean(
    run?.execution?.cancel_requested || props.liveExecution?.cancel_requested,
  );
  const stop = () => {
    if (!run) return;
    setStopping(true);
    void props.onStop(run.runId).finally(() => { if (mounted.current) setStopping(false); });
  };
  const icon = (label: string, node: ReactNode, onClick: () => void, disabled = false) => (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
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
        {unknown && props.scope === "new" ? (
          <FeedbackNotice content={{ tone: "Warning", title: "send status unknown", message: "the message and its exact model choice are locked for retry." }} announcement="Assertive" />
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
              locked,
            )}
          </section>
        ) : null}
        {quote ? (
          <QuotedPassage
            quote={quote}
            occurrenceKey={`pending-quote:${props.scope}`}
            onRemove={locked ? undefined : props.onRemoveQuote}
            onRetry={props.onRetryQuote}
          />
        ) : null}
        <Textarea
          ref={textarea}
          bare
          autoGrow={{ minRows: 1, maxRows: 6 }}
          className={styles.input}
          value={draft.text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(event) => {
            if (locked || event.key !== "Enter" || composing.current ||
              event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey) return;
            event.preventDefault();
            if (!isMobile) { if (!event.repeat) submit(); return; }
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
          aria-label="ask anything"
          placeholder="ask anything…"
          readOnly={locked}
        />
        <div className={styles.row}>
          <GenerationPicker
            catalogRead={catalogRead}
            value={selection}
            onChange={(next) => {
              if (next.kind === "Selected") {
                setIncomplete(null);
                setSelection(next);
              } else if (next.kind === "ModelRequired" || next.kind === "EffortRequired") {
                setIncomplete(next);
              }
            }}
            disabled={locked}
          />
          <Button
            variant={recovery || run ? "ghost" : "primary"}
            iconOnly
            className={styles.send}
            loading={recovery ? false : run ? stopping : sending}
            disabled={recovery ? false : run ? stopRequested : !canSend}
            onClick={run && !recovery ? stop : activateSend}
            onKeyDown={activateSend}
            aria-label={
              refresh
                ? "Retry refresh"
                : unknown
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
            {recovery ? (
              <RotateCcw size={16} aria-hidden="true" />
            ) : run ? (
              <Square size={16} aria-hidden="true" />
            ) : (
              <ArrowUp size={18} aria-hidden="true" />
            )}
          </Button>
        </div>
        {reason && selection.kind !== "Uninitialized" ? (
          <FeedbackStatus content={{ tone: "Neutral", title: reason }} announcement="Polite"
            actions={selection.kind === "Selected" ? [{ label: "refresh", onClick: catalogRead.refetch, busy: catalogRead.status === "ready" && catalogRead.refreshing }] : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}
