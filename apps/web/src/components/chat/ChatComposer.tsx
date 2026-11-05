"use client";
import * as Icon from "@/lib/ui/icons";

import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import { Hold, useResendFeedback, useOutcome } from "@/components/feedback/Feedback";
import { useTransportVerbs } from "@/components/feedback/stage";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { admissionReason, TRANSPORT_LINES, transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { commandKey, PENDING_CHANGE, recoveryOf, refusalOf, unsureFact, type CommandOutcome, type DraftRequest } from "@/lib/chat/commands";
import { useChatDraft } from "@/lib/chat/drafts";
import { prepareReaderQuote } from "@/lib/chat/readerIntent";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { isSelectable, unavailability, type SelectionEditor } from "@/lib/chat/selection";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import type { ChatView } from "@/lib/chat/tree";
import type { Execution, Refusal, RejectionCode } from "@/lib/chat/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { truncateText } from "@/lib/display/format";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useChatPane } from "./ChatSurface";
import GenerationPicker from "./GenerationPicker";
import QuotedPassage from "./QuotedPassage";
import styles from "./ChatComposer.module.css";

/** Why send waits, read with it; a reply target that can't take one is said beneath the input. */
const BLOCKED = {
  HistoryLoading: "messages are still loading.",
  HistoryUnavailable: "messages didn’t load.",
  AssistantRunning: "an answer is still running.",
} as const;

/** Draft text and model, and the one control for the chat's current admission state. A refused
 * send is said beneath the input until text, model or quote changes, and send is the retry; one
 * whose answer never came is held above the composer until it resolves, and send and `discard send`
 * stay its verbs here, unless a stale build refused its retry. Any other pending command of the chat
 * is the pane's to hold; send says it waits on it. */
export default function ChatComposer(props: {
  scope: string;
  /** This pane: its draft, and the sends whose recovery it shows. */
  viewId: string;
  view: ChatView;
  /** The pending leaf's live advisory, when its stream is tailed. */
  liveExecution: Execution | null;
  onClearBranch(): void;
  onRejected(code: RejectionCode): void;
  focusKey: string | null;
  isPaneActive: boolean;
}) {
  const { target, branch, activeRun: run } = props.view;
  const { isPaneActive } = props;
  const { store, command, catalog: catalogRead, scroll } = useChatPane();
  const { draft, owner: draftOwner, setDraft, setText, setSelection, setQuote, updateQuote, spend } = useChatDraft(props.scope, props.viewId);
  const quote = draft.quote;
  const [entryFocus, setEntryFocus] = useState<string | null>(null);
  const focusKey = props.focusKey ?? entryFocus ?? quote?.id ?? null;
  const runtime = requirePaneRuntime(usePaneRuntime(), "ChatComposer");
  const { ctx } = useActionRuntime();
  const writing = useWritingRuntime();
  const { read: memoryRead, enter: enterMemory, fresh: freshMemory } = useChatSelection();
  const { fail, say } = useOutcome();
  const transportVerbs = useTransportVerbs();
  const resendFeedback = useResendFeedback();
  const { delivery, claim } = usePaneEntryDelivery();
  const readerEntry = delivery?.entry.kind === "ComposeReaderQuestion" || delivery?.entry.kind === "ReplaceReaderQuote" ? delivery : null;
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const own = recoveryOf(command, (pending) => pending.kind === "Send" && pending.viewId === props.viewId);
  // A new chat's unresolved first send holds its text and model; an existing chat's
  // command retries its frozen request, so the draft stays editable.
  const locked = own?.command.kind === "Send" && own.command.request.destination.kind === "New";
  const recalled = freshMemory(catalog);
  const shownMemory: SelectionEditor | null = memoryRead.status === "ready" && memoryRead.data.last_used
    ? { kind: "Selected", route: memoryRead.data.last_used.route, selection: memoryRead.data.last_used.selection } : null;
  const frozen = own?.command.kind === "Send" && (locked || own.kind === "Busy")
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
  const inputReady = ready && readerEntry === null;
  const mounted = useRef(false);
  const composing = useRef(false);
  const focused = useRef<string | null>(null);
  const fieldId = useId();
  const waitsId = useId();
  /** A send's refusal, until what it refused changes. */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
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
    return () => void (mounted.current = false);
  }, []);
  useLayoutEffect(() => {
    if (!readerEntry) return;
    const entry = readerEntry.entry;
    if (entry.kind === "ReplaceReaderQuote") {
      if (!claim(readerEntry)) return;
      if (entry.target.draft_owner_id === draftOwner && entry.target.attachment_id === quote?.id && entry.target.visit_id === runtime.visitId) {
        setQuote(entry.quote); setRefusal(null); setEntryFocus(readerEntry.activationId);
      } else say({ fact: "the original quote is no longer in this draft." });
    } else if (entry.kind === "ComposeReaderQuestion" && claim(readerEntry)) {
      // no await: claim and the complete draft install share one turn.
      enterMemory();
      setDraft({ text: entry.text, selection: entry.selection, quote: entry.quote });
      setEntryFocus(readerEntry.activationId);
    }
  }, [readerEntry, claim, setDraft, setQuote, enterMemory, draftOwner, quote?.id, runtime.visitId, say]);
  useEffect(() => {
    if (quote?.state.kind !== "Unprepared") return;
    const signal = ctx.sessionSignal();
    if (!updateQuote(quote.id, value => value.state.kind === "Unprepared" ? { ...value, state: { kind: "Loading" } } : value)) return;
    void prepareReaderQuote(quote, writing, signal).then(preview => {
      if (!signal.aborted) updateQuote(quote.id, value => ({ ...value, state: { kind: "Ready", preview } }));
    }, error => {
      if (!signal.aborted) updateQuote(quote.id, value => ({ ...value, state: { kind: "Failed", failure: { kind: "Read", error }, preview: null } }));
    });
  }, [quote, ctx, writing, updateQuote]);
  useEffect(() => {
    if (!inputReady || !focusKey || focused.current === focusKey) return;
    focused.current = focusKey; // spent even when the pane is inactive
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  }, [inputReady, focusKey, isPaneActive]);

  const reason = catalog && selection.kind !== "Uninitialized" ? unavailability(catalog, selection) : null;
  const quoted = quote?.state.kind === "Ready" ? quote.state.preview : null;
  const canSend = inputReady && command.kind === "Idle" && target.kind !== "Blocked" && !!catalog
    && selection.kind === "Selected" && (draft.selection.kind !== "Uninitialized" || recalled !== null) && !reason && !!draft.text.trim() && (!quote || !!quoted);

  const submit = async (openIntent: OpenIntent = "default") => {
    if (!canSend || selection.kind !== "Selected") return;
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
      reader_selection: quoted ? { selection: quoted.selection, revision: quoted.revision } : null,
    };
    // the pane lands the accepted answer (Conversation)
    present(await store.send(request, selection.route, openIntent, () => { if (spend(submitted)) enterMemory(); }));
  };
  const present = (outcome: CommandOutcome) => {
    if (!mounted.current || outcome.kind !== "Failed") return;
    setRefusal(outcome.rejection === "E_READER_SELECTION_STALE" ? null : refusalOf(outcome));
    if (outcome.rejection === null) return;
    if (outcome.rejection === "E_READER_SELECTION_STALE" && quote) updateQuote(quote.id, value => ({ ...value,
      state: { kind: "Failed", failure: { kind: "Stale" }, preview: value.state.kind === "Ready" ? value.state.preview : null } }));
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
    secondary: { label: "discard send", commandKey: `discard ${commandKey(own.command)}`, run: () => store.discardCommand() },
  }) : null;
  const primary = held?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === retryKey ? primary : null;
  const replayBlocked = held !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const discardOffered = held?.verbs?.some(verb => "commandKey" in verb && verb.commandKey === `discard ${own ? commandKey(own.command) : ""}`) ?? false;
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
    : quote?.state.kind === "Loading" || quote?.state.kind === "Unprepared" ? "the quote is still loading."
    : quote?.state.kind === "Failed" ? "the quote needs attention."
    : !run && command.kind !== "Idle" && own === null ? PENDING_CHANGE : null;
  // the draft stays: focus on the withdrawn control returns to it
  const discard = (event: MouseEvent<HTMLButtonElement>) => {
    const owned = document.activeElement === event.currentTarget;
    store.discardCommand();
    if (owned && store.getState().command.kind === "Idle") textarea.current?.focus({ preventScroll: true });
  };
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
      {own !== null && held !== null ? <Hold id={commandKey(own.command)} attempt={own.attempt} line={held.line} verbs={held.verbs} /> : null}
      {stopUnknown && stopRecovery
        ? <Hold id={`stop:${stopUnknown.runId}`} attempt={stopUnknown.attempt} {...stopRecovery} /> : null}
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
            <Button iconOnly icon={<Icon.Dismiss />} aria-label="Cancel branch reply" onClick={props.onClearBranch} disabled={locked} />
          </section>
        ) : null}
        {quote ? (
          <QuotedPassage
            quote={quote.state}
            inspection={quote.inspection}
            onRemove={locked ? undefined : (event) => {
              if (document.activeElement === event.currentTarget) textarea.current?.focus({ preventScroll: true });
              setRefusal(null);
              setQuote(null);
            }}
            onRetry={() => updateQuote(quote.id, value => ({ ...value, state: { kind: "Unprepared" } }))}
            onReview={() => runtime.activateTarget({ target: { href: quote.inspection.href }, disposition: { kind: "Fork" },
              entry: { kind: "ReviewReaderQuote", quote, target: { pane_id: runtime.paneId, visit_id: runtime.visitId, draft_owner_id: draftOwner, attachment_id: quote.id } } })}
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
          aria-describedby={field ? fieldId : undefined}
          placeholder="ask anything…"
          readOnly={locked}
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
          {discardOffered ? <Button disabled={own?.kind === "Busy"} onClick={discard}>discard send</Button> : null}
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
