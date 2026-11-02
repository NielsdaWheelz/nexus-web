"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, GitBranch, LocateFixed, RotateCcw, Square, X } from "lucide-react";
import { Fact, Field } from "@/components/feedback/Fact";
import { Hold, useOutcome, type FeedbackContent } from "@/components/feedback/Feedback";
import { transportVerbs, type CommandVerb, type Line, type Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { commandKey, MAY_HAVE, recoveryOf, refusalOf, unsureFact, type CommandOutcome, type DraftRequest } from "@/lib/chat/commands";
import { useChatDraft } from "@/lib/chat/drafts";
import { isSelectable, unavailability, type SelectionEditor } from "@/lib/chat/selection";
import { useChatSelection } from "@/lib/chat/selectionMemory";
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

/** Why send waits, read with it; a reply target that can't take one is said beneath the input. */
const BLOCKED = {
  HistoryLoading: "messages are still loading.",
  HistoryUnavailable: "messages didn’t load.",
  AssistantRunning: "an answer is still running.",
} as const;

/** Draft text and model, and the one control for the chat's current admission state. A refused
 * send is said beneath the input, where send is the retry; one whose answer never came is held
 * above the composer until it resolves. */
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
  const { quote, focusKey, isPaneActive } = props;
  const { store, command, catalog: catalogRead, scroll } = useChatPane();
  const { draft, setDraft, setText, setSelection, spend } = useChatDraft(props.scope, props.viewId);
  const { read: memoryRead, enter: enterMemory, fresh: freshMemory } = useChatSelection();
  const { fail } = useOutcome();
  const { delivery, claim } = usePaneEntryDelivery();
  const readerEntry = delivery?.entry.kind === "ComposeReaderQuestion" ? delivery : null;
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
  const blockedId = useId();
  /** A send's refusal, until the input changes. */
  const [refusal, setRefusal] = useState<FeedbackContent | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopUnknown, setStopUnknown] = useState<{ runId: string; attempt: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    setReady(true);
    return () => void (mounted.current = false);
  }, []);
  useLayoutEffect(() => {
    if (!readerEntry || readerEntry.entry.kind !== "ComposeReaderQuestion") return;
    // no await: the exact visit's delivery and both draft fields transfer together.
    enterMemory();
    setDraft({ text: readerEntry.entry.text, selection: readerEntry.entry.selection });
    claim(readerEntry);
  }, [readerEntry, claim, setDraft, enterMemory]);
  useEffect(() => {
    if (!inputReady || !focusKey || focused.current === focusKey) return;
    focused.current = focusKey; // spent even when the pane is inactive
    if (isPaneActive) textarea.current?.focus({ preventScroll: true });
  }, [inputReady, focusKey, isPaneActive]);

  const reason = catalog && selection.kind !== "Uninitialized" ? unavailability(catalog, selection) : null;
  const quoted = quote?.kind === "Ready" ? quote.selection : null;
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
      reader_selection: quoted ? { key: quoted.key, revision: quoted.revision } : null,
    };
    // the pane lands the accepted answer (Conversation)
    present(await store.send(request, selection.route, openIntent, () => { if (spend(submitted)) enterMemory(); }));
  };
  const present = (outcome: CommandOutcome) => {
    if (!mounted.current || outcome.kind !== "Failed") return;
    setRefusal(outcome.feedback);
    if (outcome.rejection === null) return;
    catalogRead.refetch(); // a rejection may mean the catalog changed; rereading is cheap
    props.onRejected(outcome.rejection);
  };
  // cancel intent is monotonic, so saved or live saying so is exact
  const stopRequested = Boolean(run?.execution?.cancel_requested || props.liveExecution?.cancel_requested);
  // stop intent is idempotent: a press after any failure is safe
  const cancel = (runId: string) => {
    setStopping(true);
    void store.cancel(runId).then((failure) => {
      if (!mounted.current) return;
      setStopping(false);
      setStopUnknown((current) => failure?.kind === "Unknown" ? { runId, attempt: current?.runId === runId ? current.attempt + 1 : 1 } : null);
      if (failure?.kind === "Refused" || failure?.kind === "Defect")
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
  // an unknown send holds above the composer; its retry resends the frozen request
  const held = own?.command.kind === "Send" && own.standing?.kind === "Unknown" ? own : null;
  const blocked = target.kind === "Blocked" ? target.reason : null;
  const field: { line: Line; verbs?: Verbs } | null = refusal ? refusalOf(refusal)
    : blocked === "ReplyTargetUnavailable" ? { line: { fact: "you can reply only to a complete answer." } }
    : reason && (!recallRequired || !recallPending) ? { line: { fact: reason } }
    : null;
  const recallTransport = recallRequired && memoryFailure !== null ? transportOf(memoryFailure) : null;
  const recallRetry: CommandVerb = {
    label: "retry", commandKey: "retry last model", run: enterMemory,
    busy: memoryRead.status === "failed" ? memoryRead.retrying : memoryRead.status === "ready" && memoryRead.refreshing,
  };
  const useRecalled: CommandVerb | null = shownMemory?.kind === "Selected" && catalog && isSelectable(catalog, shownMemory.selection, shownMemory.route)
    ? { label: "use this model", commandKey: "use last model", run: () => { setSelection(shownMemory); textarea.current?.focus({ preventScroll: true }); } }
    : null;
  const recallVerb = recallTransport && transportVerbs(recallTransport, { retry: recallRetry, signIn: null })?.[0];
  const recallVerbs: Verbs | undefined = recallVerb && useRecalled ? [recallVerb, useRecalled]
    : recallVerb ? [recallVerb] : useRecalled ? [useRecalled] : undefined;
  return (
    <div className={styles.composer}>
      {held ? <Hold id={commandKey(held.command)} attempt={held.attempt} line={{ fact: unsureFact(held.command), reason: MAY_HAVE }} verbs={[
        { label: "retry", commandKey: `retry ${commandKey(held.command)}`, busy: held.kind === "Busy", run: retry },
        { label: "discard send", commandKey: `discard ${commandKey(held.command)}`, run: () => store.discardCommand() },
      ]} /> : null}
      {stopUnknown && run?.runId === stopUnknown.runId && !stopRequested
        ? <Hold id={`stop:${stopUnknown.runId}`} attempt={stopUnknown.attempt} line={{ fact: "not sure the answer stopped.", reason: MAY_HAVE }} /> : null}
      <div className={styles.shell}>
        {blocked !== null && blocked !== "ReplyTargetUnavailable" ? <span id={blockedId} className="sr-only">{BLOCKED[blocked]}</span> : null}
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
            onRemove={locked ? undefined : (event) => {
              if (document.activeElement === event.currentTarget) textarea.current?.focus({ preventScroll: true });
              props.onRemoveQuote();
            }}
            onRetry={props.onRetryQuote}
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
            if (draft.selection.kind === "Uninitialized" && fresh) setDraft({ text, selection: fresh });
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
            onChange={setSelection}
            disabled={!inputReady || frozen !== null}
            waiting={recallRequired && recallPending && memoryFailure === null}
          />
          {held ? <Button disabled={held.kind === "Busy"} onClick={() => store.discardCommand()}>discard send</Button> : null}
          <Button
            emphasis={recovery || run ? undefined : "strong"}
            iconOnly
            className={styles.send}
            disabled={sending || (recovery ? false : run ? stopRequested : !canSend)}
            onClick={run && !recovery ? () => cancel(run.runId) : activateSend}
            onKeyDown={activateSend}
            aria-label={sendLabel.current}
            aria-describedby={field ? fieldId : blocked !== null ? blockedId : undefined}
            aria-busy={sending}
            icon={recovery ? <RotateCcw size={16} aria-hidden="true" /> : run ? <Square size={16} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />} />
        </div>
        {recallTransport ? <Fact line={TRANSPORT_LINES[recallTransport].command("couldn’t load your last model.")} verbs={recallVerbs} /> : null}
      </div>
    </div>
  );
}
