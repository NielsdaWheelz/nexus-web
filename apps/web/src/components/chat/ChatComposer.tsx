"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, GitBranch, LocateFixed, RotateCcw, Square, X } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { recoveryOf, type CommandOutcome, type DraftRequest } from "@/lib/chat/commands";
import { useChatDraft } from "@/lib/chat/drafts";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { ChatView } from "@/lib/chat/tree";
import type { Execution, RejectionCode } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { usePaneEntryDelivery } from "@/lib/panes/paneRuntime";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useChatPane } from "./ChatSurface";
import GenerationPicker from "./GenerationPicker";
import QuotedPassage, { type QuoteState } from "./QuotedPassage";
import styles from "./ChatComposer.module.css";

const BLOCKED = {
  HistoryLoading: "Conversation history is loading.",
  HistoryUnavailable: "Conversation history could not be loaded.",
  AssistantRunning: "Assistant response in progress. Your draft is still editable.",
  ReplyTargetUnavailable: "Choose a complete assistant response before sending.",
};

/** Draft text and model, and the one control for the chat's current admission state. */
export default function ChatComposer(props: {
  scope: string;
  /** This pane: its draft, and the sends whose recovery it shows. */
  viewId: string;
  view: ChatView;
  /** The pending leaf's live advisory, when its stream is tailed. */
  liveExecution: Execution | null;
  historyReady: boolean;
  onClearBranch(): void;
  quote: QuoteState | null;
  onRemoveQuote(): void;
  onRetryQuote(): void;
  onRejected(code: RejectionCode): void;
  focusKey: string | null;
  isPaneActive: boolean;
}) {
  const { target, branch, activeRun: run, inherited } = props.view;
  const { quote, historyReady, focusKey, isPaneActive } = props;
  const { store, command, catalog: catalogRead, scroll } = useChatPane();
  const { draft, setDraft, setText, setSelection, spend } = useChatDraft(props.scope, props.viewId);
  const { delivery, claim } = usePaneEntryDelivery();
  const readerEntry = delivery?.entry.kind === "ComposeReaderQuestion" ? delivery : null;
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const own = recoveryOf(command, (pending) => pending.kind === "Send" && pending.viewId === props.viewId);
  // A new chat's unresolved first send holds its text and model; an existing chat's
  // command retries its frozen request, so the draft stays editable.
  const locked = own?.command.kind === "Send" && own.command.request.destination.kind === "New";
  const [incomplete, setIncomplete] = useState<Extract<SelectionEditor, { kind: "ModelRequired" | "EffortRequired" }> | null>(null);
  // An untouched draft follows the answer it replies to, else the catalog seed.
  const followed = draft.selection ?? (props.scope === "new" || historyReady ? (inherited ?? catalog?.chat_seed.selection) : null) ?? null;
  // the model controls show the request in flight (and a held new-chat send) as sent
  const frozen = own?.command.kind === "Send" && (locked || own.kind === "Busy") ? own.command.request.selection : null;
  const selection: SelectionEditor = frozen
    ? { kind: "Selected", selection: frozen }
    : (incomplete ?? (followed ? { kind: "Selected", selection: followed } : { kind: "Uninitialized" }));
  const isMobile = useIsMobileViewport();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [ready, setReady] = useState(false);
  const inputReady = ready && readerEntry === null;
  const mounted = useRef(false);
  const composing = useRef(false);
  const focused = useRef<string | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    mounted.current = true;
    setReady(true);
    return () => void (mounted.current = false);
  }, []);
  useLayoutEffect(() => {
    if (!readerEntry || readerEntry.entry.kind !== "ComposeReaderQuestion") return;
    // no await: the exact visit's delivery and both draft fields transfer together.
    setDraft({ text: readerEntry.entry.text, selection: readerEntry.entry.selection });
    claim(readerEntry);
  }, [readerEntry, claim, setDraft]);
  useEffect(() => {
    if (!inputReady || !focusKey || focused.current === focusKey) return;
    focused.current = focusKey; // spent even when the pane is inactive
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  }, [inputReady, focusKey, isPaneActive]);

  const reason = catalog ? unavailability(catalog, selection) : null;
  const quoted = quote?.kind === "Ready" ? quote.selection : null;
  const canSend = inputReady && command.kind === "Idle" && target.kind !== "Blocked" && !!catalog
    && selection.kind === "Selected" && !reason && !!draft.text.trim() && (!quote || !!quoted);

  const submit = async (openIntent: OpenIntent = "default") => {
    if (!canSend || selection.kind !== "Selected") return;
    setError(null);
    const submitted = draft.text;
    const request: DraftRequest = {
      destination: target.kind === "New" ? { kind: "New" } : {
        kind: "Existing",
        conversation_id: target.conversationId,
        insertion: target.kind === "Empty" ? { kind: "Empty" }
          : { kind: "Reply", parent_message_id: target.parentId, branch_anchor: target.anchor },
      },
      content: submitted,
      selection: selection.selection,
      reader_selection: quoted ? { key: quoted.key, revision: quoted.revision } : null,
    };
    // the pane lands the accepted answer (Conversation)
    present(await store.send(request, openIntent, () => spend(submitted)));
  };
  const present = (outcome: CommandOutcome) => {
    if (!mounted.current || outcome.kind !== "Failed") return;
    setError(outcome.feedback);
    if (outcome.rejection === null) return;
    catalogRead.refetch(); // a rejection may mean the catalog changed; rereading is cheap
    props.onRejected(outcome.rejection);
  };
  // cancel intent is monotonic, so saved or live saying so is exact
  const stopRequested = Boolean(run?.execution?.cancel_requested || props.liveExecution?.cancel_requested);
  const stop = () => {
    if (!run) return;
    setStopping(true);
    void store.cancel(run.runId).finally(() => mounted.current && setStopping(false));
  };
  const recovery = own?.kind === "Unconfirmed" || own?.kind === "RefreshRequired";
  // shift sends (or retries) into a new pane
  const sending = recovery ? false : run ? stopping : own?.kind === "Busy";
  const activateSend = (event: TargetActivationEvent) => {
    if (run && !recovery) return;
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    if (recovery) void store.retryCommand(activation.intent).then(present);
    else void submit(activation.intent);
  };
  return (
    <div className={styles.composer}>
      <div className={styles.shell}>
        <span className="sr-only" aria-live="polite">{target.kind === "Blocked" ? BLOCKED[target.reason] : ""}</span>
        {error ? <FeedbackNotice content={error} announcement="Assertive" /> : null}
        {branch ? (
          <section className={styles.fork} aria-label="Fork reply">
            <GitBranch size={16} aria-hidden="true" />
            <div>
              <strong>Fork reply</strong>
              {branch.quote ? <blockquote>{truncateText(branch.quote, 220)}</blockquote> : null}
            </div>
            <Button iconOnly icon={<LocateFixed />} aria-label="Jump to parent message" onClick={() => scroll.scrollToMessage(branch.parentId)} />
            <Button iconOnly icon={<X />} aria-label="Cancel branch reply" onClick={props.onClearBranch} disabled={locked} />
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
          value={inputReady ? draft.text : ""}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(event) => {
            // shift+Enter, composition and a held key are text, never a send
            if (locked || event.key !== "Enter" || composing.current || event.nativeEvent.isComposing
              || event.keyCode === 229 || event.shiftKey) return;
            event.preventDefault();
            if (!isMobile) return void (event.repeat || submit());
            // on a phone every Enter is a newline
            const field = event.currentTarget;
            field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
            setText(field.value);
          }}
          {...(inputReady ? { "aria-label": "ask anything" } : { "aria-hidden": true, disabled: true })}
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
                setSelection(next.selection);
              } else if (next.kind !== "Uninitialized") setIncomplete(next);
            }}
            disabled={!inputReady || frozen !== null}
          />
          <Button
            emphasis={recovery || run ? undefined : "strong"}
            iconOnly
            className={styles.send}
            disabled={sending || (recovery ? false : run ? stopRequested : !canSend)}
            onClick={run && !recovery ? stop : activateSend}
            onKeyDown={activateSend}
            aria-label={
              own?.kind === "RefreshRequired" ? "Retry refresh"
              : own?.kind === "Unconfirmed" ? "Retry send"
              : run ? (stopRequested ? "Stop requested" : "Stop response")
              : own ? "Sending message" : "Send message"
            }
            aria-busy={sending}
            icon={recovery ? <RotateCcw size={16} aria-hidden="true" /> : run ? <Square size={16} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />} />
        </div>
        {reason && selection.kind !== "Uninitialized" ? (
          <FeedbackStatus
            content={{ tone: "Neutral", title: reason }}
            announcement="Polite"
            actions={selection.kind === "Selected"
              ? [{ label: "refresh", onClick: catalogRead.refetch, busy: catalogRead.status === "ready" && catalogRead.refreshing }]
              : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}
