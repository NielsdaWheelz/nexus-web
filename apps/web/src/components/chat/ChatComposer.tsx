"use client";
import * as Icon from "@/lib/ui/icons";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import { Hold, useResendFeedback, useOutcome } from "@/components/feedback/Feedback";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { admissionReason, TRANSPORT_LINES, transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { commandKey, pendingReason, recoveryOf, refusalOf, unsureFact, type CommandOutcome, type DraftRequest } from "@/lib/chat/commands";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useWorkGuard } from "@/lib/unsavedWork";
import { copyText } from "@/lib/ui/copyText";
import { launchChatDraft, assumeReaderSelectionKey, prepareDraftQuote } from "@/lib/chat/readerIntent";
import { useChatDraft } from "@/lib/chat/drafts";
import { isSelectable, unavailability, type SelectionEditor } from "@/lib/chat/selection";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import type { ChatView } from "@/lib/chat/tree";
import type { Execution, RejectionCode } from "@/lib/chat/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { truncateText } from "@/lib/display/format";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useChatPane } from "./ChatSurface";
import GenerationPicker from "./GenerationPicker";
import QuotedPassage, { useQuotePreview, type QuoteState } from "./QuotedPassage";
import styles from "./ChatComposer.module.css";

/** Why send waits, read with it; a reply target that can't take one is said beneath the input. */
const BLOCKED = {
  HistoryLoading: "messages are still loading.",
  HistoryUnavailable: "messages didn’t load.",
  AssistantRunning: "an answer is still running.",
} as const;

/** Draft text and model, and the one control for the chat's current admission state. A refused
 * send is said beneath the input until text, model or quote changes, and send is the retry; one
 * whose answer never came is held above the composer until it resolves, with exact retry and
 * copying its question. Any other pending command of the chat
 * is the pane's to hold; send says it waits on it. */
export default function ChatComposer(props: {
  scope: string;
  /** This pane: its draft, and the sends whose recovery it shows. */
  viewId: string;
  view: ChatView;
  /** The pending leaf's live advisory, when its stream is tailed. */
  liveExecution: Execution | null;
  onClearBranch(): void;
  quote: QuoteState | null;
  onRemoveQuote(): void;
  onRetryQuote(): void;
  onRejected(code: RejectionCode): void;
  focusKey: string | null;
  isPaneActive: boolean;
}) {
  const { target, branch, activeRun: run } = props.view;
  const { ctx } = useActionRuntime();
  const guard = useWorkGuard();
  const { focusKey, isPaneActive } = props;
  const { store, command, catalog: catalogRead, scroll } = useChatPane();
  const { draft, setDraft, setText, setSelection, setQuote, spend, refusal, refuse, getCaret, setCaret, entry } = useChatDraft(props.scope, props.viewId);
  const draftPreview = useQuotePreview(draft.quote?.kind === "Highlight" && draft.quote.presentation === null ? draft.quote.key : null);
  const quote: QuoteState | null = draft.quote?.kind === "Passage" ? { kind: "Captured", presentation: draft.quote }
    : draft.quote?.kind === "Highlight" ? draft.quote.presentation ? { kind: "Captured", presentation: draft.quote.presentation } : draftPreview.quote
    : props.quote;
  const { read: memoryRead, enter: enterMemory, fresh: freshMemory } = useChatSelection();
  const { fail } = useOutcome();
  const transportVerbs = useTransportVerbs();
  const resendFeedback = useResendFeedback();
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const own = recoveryOf(command, (pending) => pending.kind === "Send" && pending.viewId === props.viewId);
  // A pending command owns frozen input; the retained draft stays editable.
  const recalled = freshMemory(catalog);
  const shownMemory: SelectionEditor | null = memoryRead.status === "ready" && memoryRead.data.last_used
    ? { kind: "Selected", route: memoryRead.data.last_used.route, selection: memoryRead.data.last_used.selection } : null;
  const frozen = own?.command.kind === "Send" && own.kind === "Busy"
    ? { kind: "Selected" as const, selection: own.command.request.selection, route: own.command.selectionRoute } : null;
  const recallRequired = draft.selection.kind === "Uninitialized" && !frozen;
  const recallPending = memoryRead.status !== "ready" || !memoryRead.fresh || memoryRead.refreshing || memoryRead.error !== null;
  const memoryFailure = memoryRead.status === "loading" ? null : memoryRead.error;
  const selection = frozen ?? (draft.selection.kind === "Uninitialized" ? recalled ?? shownMemory ?? draft.selection : draft.selection);
  const catalogRef = useRef(catalogRead);
  catalogRef.current = catalogRead;
  useLayoutEffect(() => {
    if (!isPaneActive) return;
    enterMemory();
    const current = catalogRef.current;
    if (current.status === "ready" && !current.error) current.revalidate();
    else if (current.status === "failed") void current.refetch();
  }, [isPaneActive, enterMemory]);
  useLayoutEffect(() => {
    const fresh = freshMemory(catalog);
    if (draft.text && draft.selection.kind === "Uninitialized" && fresh) setSelection(fresh);
  }, [draft, catalog, freshMemory, setSelection]);
  const isMobile = useIsMobileViewport();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [ready, setReady] = useState(false);
  const inputReady = ready;
  const mounted = useRef(false);
  const composing = useRef(false);
  const transferring = useRef(false);
  const focused = useRef<string | null>(null);
  const fieldId = useId();
  const waitsId = useId();
  /** A send's refusal, until what it refused changes. */
  const setRefusal = refuse;
  const stopRequested = Boolean(run?.execution?.cancel_requested || props.liveExecution?.cancel_requested);
  const stopped = useResourceDraft<{ runId: string; attempt: number; busy: boolean } | null>("Chat.Stop", () => null,
    value => ({ changed: false, unconfirmed: value !== null, stopsBrowserWork: false }));
  const { set: setStopped } = stopped;
  const stopAttempt = stopped.value;
  const stopping = stopAttempt?.busy ?? false;
  const stopUnknown = stopAttempt !== null && stopAttempt.attempt > 0 ? stopAttempt : null;
  useEffect(() => {
    if (stopAttempt === null) return;
    const answer = [...store.getState().messages.values()].find(message => message.trust_trail?.run.run_id === stopAttempt.runId);
    if ((run?.runId === stopAttempt.runId && stopRequested) || (answer && (answer.status !== "pending" || answer.trust_trail?.run.execution?.cancel_requested))) setStopped(null);
  }, [props.view, run, stopRequested, stopAttempt, store, setStopped]);
  useEffect(() => {
    mounted.current = true;
    setReady(true);
    const caret = getCaret();
    if (caret) textarea.current?.setSelectionRange(caret.start, caret.end, caret.direction);
    return () => void (mounted.current = false);
  }, [getCaret]);
  useEffect(() => {
    if (!inputReady || !focusKey || focused.current === focusKey) return;
    focused.current = focusKey; // spent even when the pane is inactive
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  }, [inputReady, focusKey, isPaneActive]);

  const reason = catalog && selection.kind !== "Uninitialized" ? unavailability(catalog, selection) : null;
  const quoted = props.quote?.kind === "Ready" ? props.quote.selection : null;
  const canSend = inputReady && command.kind === "Idle" && target.kind !== "Blocked" && !!catalog
    && selection.kind === "Selected" && (draft.selection.kind !== "Uninitialized" || recalled !== null) && !reason && !!draft.text.trim() && (draft.quote !== null || !quote || !!quoted);

  const submit = async (openIntent: OpenIntent = "default") => {
    if (!canSend || selection.kind !== "Selected" || transferring.current || entry.getSnapshot().draft !== draft) return;
    setRefusal(null);
    const submitted = draft;
    const request: DraftRequest = {
      destination: target.kind === "New" ? { kind: "New" } : {
        kind: "Existing",
        conversation_id: target.conversationId,
        insertion: target.kind === "Empty" ? { kind: "Empty" }
          : { kind: "Reply", parent_message_id: target.parentId, branch_anchor: target.anchor },
      },
      content: submitted.text,
      selection: selection.selection,
      reader_selection: draft.quote !== null ? null : quoted ? { kind: "highlight", key: quoted.key, revision: quoted.revision } : null,
    };
    if (openIntent === "new_pane") {
      transferring.current = true;
      try {
        const existing = request.destination.kind === "Existing" ? request.destination : null;
        const observed = store.getState().conversation;
        const result = launchChatDraft({ ctx, guard, originPaneId: props.viewId,
          draft: { ...submitted, selection, quote: submitted.quote ?? (quoted ? { kind: "Highlight", key: assumeReaderSelectionKey({
            mediaId: quoted.key.media_id, captureId: quoted.key.capture_id, highlightId: quoted.key.highlight_id,
          }), presentation: null } : null) }, catalog,
          destination: existing ? { kind: "Existing", conversationId: existing.conversation_id,
            write: observed ? { expected_revision: observed.branch_revision, insertion: existing.insertion } : null } : { kind: "New" },
        });
        if (result.kind === "Opened") spend(submitted);
      } finally { transferring.current = false; }
      return;
    }
    present(await store.send(request, selection.route, openIntent, () => { if (spend(submitted)) enterMemory(); }, draft.quote !== null ? prepareDraftQuote(draft.quote) : null));
  };
  const present = (outcome: CommandOutcome) => {
    if (!mounted.current || outcome.kind !== "Failed") return;
    setRefusal(refusalOf(outcome));
    if (outcome.rejection === null) return;
    catalogRead.refetch(); // a rejection may mean the catalog changed; rereading is cheap
    props.onRejected(outcome.rejection);
  };
  // cancel intent is monotonic, so saved or live saying so is exact
  // stop intent is idempotent: a press after any failure is safe
  const cancel = (runId: string) => {
    const previous = stopped.read();
    if (previous !== null && (previous.busy || previous.runId !== runId)) return;
    stopped.set({ runId, attempt: previous?.attempt ?? 0, busy: true });
    void store.cancel(runId).then((failure) => {
      if (stopped.read()?.runId !== runId) return;
      const unsettled = failure?.kind === "Unknown" || (failure?.kind === "Refused" && (previous?.attempt ?? 0) > 0);
      stopped.set(unsettled ? { runId, attempt: (previous?.attempt ?? 0) + 1, busy: false } : failure?.kind === "Defect" ? { runId, attempt: previous?.attempt ?? 0, busy: false } : null);
      if (mounted.current && ((!unsettled && failure?.kind === "Refused") || failure?.kind === "Defect"))
        fail(failure.error, "couldn’t stop this answer.", { label: "retry", commandKey: `stop ${runId}`, run: () => cancel(runId) });
    });
  };
  const recovery = own?.kind === "Unconfirmed" || own?.kind === "RefreshRequired";
  const retry = (openIntent: OpenIntent) => void store.retryCommand(openIntent).then(present);
  // shift sends (or retries) into a new pane
  const sending = recovery ? false : run ? stopping : own?.kind === "Busy";
  const sendLabel = useRef("send");
  if (own?.kind !== "Busy") sendLabel.current = own?.kind === "RefreshRequired" ? "check"
    : own?.kind === "Unconfirmed" ? "retry"
    : run ? (stopRequested ? "stopping" : "stop") : "send";
  const activateSend = (event: TargetActivationEvent) => {
    if (run && !recovery) return;
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind === "Consume") return;
    if (recovery) retry(activation.intent);
    else void submit(activation.intent);
  };
  // an unknown send holds above the composer; its retry resends the frozen request, unless a stale
  // build refused it: the hold then offers reload alone, and send waits
  const unknown = own?.command.kind === "Send" && own.standing?.kind === "Unknown" ? own.standing : null;
  const retryKey = own ? `retry ${commandKey(own.command)}` : "";
  const held = own !== null && unknown !== null ? resendFeedback({
    line: { fact: unsureFact(own.command), reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: retryKey, busy: own.kind === "Busy", run: retry },
    secondary: { label: "copy question", commandKey: `copy ${commandKey(own.command)}`, run: () => {
      if (own.command.kind === "Send") void copyText(own.command.request.content).catch(error => fail(error, "couldn’t copy the question."));
    } },
  }) : null;
  const primary = held?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === retryKey ? primary : null;
  const replayBlocked = held !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const stopKey = stopUnknown ? `stop ${stopUnknown.runId}` : "";
  const stopRecovery = stopUnknown ? resendFeedback({
    line: { fact: "not sure the answer stopped.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: stopKey, busy: stopping, run: () => cancel(stopUnknown.runId) },
  }) : null;
  const stopPrimary = stopRecovery?.verbs?.[0];
  const stopReplay = stopPrimary && "commandKey" in stopPrimary && stopPrimary.commandKey === stopKey ? stopPrimary : null;
  const stopWaits = stopRecovery !== null && (stopReplay === null || stopReplay.busy || stopReplay.disabledReason !== undefined);
  const blocked = target.kind === "Blocked" ? target.reason : null;
  const otherStop = run !== null && stopAttempt !== null && stopAttempt.runId !== run.runId;
  const sendWaits = otherStop ? "another stop isn’t finished."
    : stopWaits ? stopReplay?.disabledReason ?? admissionReason() ?? stopRecovery?.line.reason ?? null
    : blocked !== null && blocked !== "ReplyTargetUnavailable" ? BLOCKED[blocked]
    : replayBlocked ? replay?.disabledReason ?? admissionReason() ?? held?.line.reason ?? null
    : quote?.kind === "Loading" || (quote?.kind === "Failed" && quote.retrying) ? "the quote is still loading."
    : quote?.kind === "Failed" ? "the quote didn’t load."
    : !run && command.kind !== "Idle" && own === null ? pendingReason(command) : null;
  // send is the retry: a refusal's transport adds only what send can't do, a stale build's reload
  const field: { line: Line; verbs?: Verbs } | null = refusal
    ? { line: refusal.line, verbs: refusal.error === null ? undefined : transportVerbs(transportOf(refusal.error)) ?? undefined }
    : blocked === "ReplyTargetUnavailable" ? { line: { fact: "you can reply only to a complete answer." } }
    : reason && (!recallRequired || !recallPending) ? { line: { fact: reason } }
    : null;
  const recallTransport = recallRequired && memoryFailure !== null ? transportOf(memoryFailure) : null;
  const recallRetry: CommandVerb = {
    label: "retry", commandKey: "retry last model", run: enterMemory,
    busy: memoryRead.status === "failed" ? memoryRead.retrying : memoryRead.status === "ready" && memoryRead.refreshing,
  };
  // a stale build offers reload alone
  const useRecalled: CommandVerb | null = recallTransport !== "Update" && shownMemory?.kind === "Selected" && catalog
    && isSelectable(catalog, shownMemory.selection, shownMemory.route)
    ? { label: "use this model", commandKey: "use last model", run: () => { setSelection(shownMemory); textarea.current?.focus({ preventScroll: true }); } }
    : null;
  const recallVerb = recallTransport && transportVerbs(recallTransport, { retry: recallRetry })?.[0];
  const recallVerbs: Verbs | undefined = recallVerb && useRecalled ? [recallVerb, useRecalled]
    : recallVerb ? [recallVerb] : useRecalled ? [useRecalled] : undefined;
  return (
    <div className={styles.composer}>
      {own !== null && held !== null && !store.getState().gone ? <Hold id={commandKey(own.command)} attempt={own.attempt} line={held.line} verbs={held.verbs} /> : null}
      {stopUnknown && stopRecovery
        ? <Hold id={`stop:${stopUnknown.runId}`} attempt={stopUnknown.attempt} {...stopRecovery} /> : null}
      {own?.command.kind === "Send" && (own.standing?.kind === "Unknown" || own.standing?.kind === "Changed" && own.standing.uncertain) && own.command.request.content !== draft.text
        ? <blockquote>{own.command.request.content}</blockquote> : null}
      <div className={styles.shell}>
        {sendWaits !== null ? <span id={waitsId} className="sr-only">{sendWaits}</span> : null}
        {branch ? (
          <section className={styles.fork} aria-label="Fork reply">
            <Icon.Forks size={16} aria-hidden="true" />
            <div>
              <strong>Fork reply</strong>
              {branch.quote ? <blockquote>{truncateText(branch.quote, 220)}</blockquote> : null}
            </div>
            <Button iconOnly icon={<Icon.Locate />} aria-label="Jump to parent message" onClick={() => scroll.scrollToMessage(branch.parentId)} />
            <Button iconOnly icon={<Icon.Dismiss />} aria-label="Cancel branch reply" onClick={props.onClearBranch} />
          </section>
        ) : null}
        {quote ? (
          <QuotedPassage
            quote={quote}
            onRemove={(event) => {
              if (document.activeElement === event.currentTarget) textarea.current?.focus({ preventScroll: true });
              setRefusal(null);
              if (draft.quote !== null) setQuote(null); else props.onRemoveQuote();
            }}
            onRetry={draft.quote?.kind === "Highlight" ? draftPreview.retry : props.onRetryQuote}
          />
        ) : null}
        <Textarea
          ref={textarea}
          bare
          autoGrow={{ minRows: 1, maxRows: 6 }}
          className={styles.input}
          value={inputReady ? draft.text : ""}
          onChange={(event) => {
            const text = event.target.value;
            setRefusal(null);
            const fresh = freshMemory(catalog);
            if (draft.selection.kind === "Uninitialized" && fresh) setDraft({ ...draft, text, selection: fresh });
            else setText(text);
          }}
          onSelect={event => { const field = event.currentTarget; setCaret({ start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }); }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(event) => {
            // shift+Enter, composition and a held key are text, never a send
            if (event.key !== "Enter" || composing.current || event.nativeEvent.isComposing
              || event.keyCode === 229 || event.shiftKey) return;
            event.preventDefault();
            if (!isMobile) return void (event.repeat || submit());
            // on a phone every Enter is a newline
            const field = event.currentTarget;
            field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
            setText(field.value);
          }}
          {...(inputReady ? { "aria-label": "ask anything" } : { "aria-hidden": true, disabled: true })}
          aria-describedby={field ? fieldId : undefined}
          placeholder="ask anything…"
        />
        {field ? <Field id={fieldId} line={field.line} verbs={field.verbs} /> : null}
        <div className={styles.row}>
          <GenerationPicker
            catalogRead={catalogRead}
            value={selection}
            onChange={(next) => { setRefusal(null); setSelection(next); }}
            disabled={!inputReady || frozen !== null}
            waiting={recallRequired && recallPending && memoryFailure === null}
          />
          <Button
            emphasis={recovery || run ? undefined : "strong"}
            iconOnly
            className={styles.send}
            disabled={sending || (recovery ? replayBlocked : run ? stopRequested || stopWaits || otherStop : !canSend)}
            onClick={run && !recovery ? () => cancel(run.runId) : activateSend}
            onKeyDown={activateSend}
            aria-label={sendLabel.current}
            aria-describedby={field ? fieldId : sendWaits !== null ? waitsId : undefined}
            aria-busy={sending || replay?.busy || stopReplay?.busy}
            icon={recovery ? <Icon.Again aria-hidden="true" /> : run ? <Icon.Stop aria-hidden="true" /> : <Icon.Send aria-hidden="true" />} />
        </div>
        {recallTransport ? <Fact speak={isPaneActive} line={TRANSPORT_LINES[recallTransport].command("couldn’t load your last model.")} verbs={recallVerbs} /> : null}
      </div>
    </div>
  );
}
