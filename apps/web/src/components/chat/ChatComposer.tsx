"use client";
import * as Icon from "@/lib/ui/icons";

import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { transportVerbs, type CommandVerb, type Line, type Verbs } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { staleBuild, TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { commandKey, heldUnknown, MAY_HAVE, PENDING_CHANGE, recoveryOf, refusalOf, reloadsAlone, unsureFact, type CommandOutcome, type DraftRequest } from "@/lib/chat/commands";
import { useChatDraft } from "@/lib/chat/drafts";
import { isSelectable, unavailability, type SelectionEditor } from "@/lib/chat/selection";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import type { ChatView } from "@/lib/chat/tree";
import type { Execution, Refusal, RejectionCode } from "@/lib/chat/wire";
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
  const waitsId = useId();
  /** A send's refusal, until what it refused changes. */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
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
    setRefusal(refusalOf(outcome));
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
  // an unknown send holds above the composer; its retry resends the frozen request, unless a stale
  // build refused it: the hold then offers reload alone, and send waits
  const unknown = own?.command.kind === "Send" && own.standing?.kind === "Unknown" ? own.standing : null;
  const held = own !== null && unknown !== null ? heldUnknown(unsureFact(own.command), unknown.refused, [
    { label: "retry", commandKey: `retry ${commandKey(own.command)}`, busy: own.kind === "Busy", run: retry },
    { label: "discard send", commandKey: `discard ${commandKey(own.command)}`, run: () => store.discardCommand() },
  ]) : null;
  const reloads = unknown !== null && reloadsAlone(unknown.refused);
  const blocked = target.kind === "Blocked" ? target.reason : null;
  const sendWaits = blocked !== null && blocked !== "ReplyTargetUnavailable" ? BLOCKED[blocked]
    : reloads ? staleBuild()
    : !run && command.kind !== "Idle" && own === null ? PENDING_CHANGE : null;
  // the draft stays: focus on the withdrawn control returns to it
  const discard = (event: MouseEvent<HTMLButtonElement>) => {
    const owned = document.activeElement === event.currentTarget;
    store.discardCommand();
    if (owned && store.getState().command.kind === "Idle") textarea.current?.focus({ preventScroll: true });
  };
  // send is the retry: a refusal's transport adds only what send can't do, a stale build's reload
  const field: { line: Line; verbs?: Verbs } | null = refusal
    ? { line: refusal.line, verbs: refusal.error === null ? undefined : transportVerbs(transportOf(refusal.error), { signIn: null }) ?? undefined }
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
  const recallVerb = recallTransport && transportVerbs(recallTransport, { retry: recallRetry, signIn: null })?.[0];
  const recallVerbs: Verbs | undefined = recallVerb && useRecalled ? [recallVerb, useRecalled]
    : recallVerb ? [recallVerb] : useRecalled ? [useRecalled] : undefined;
  return (
    <div className={styles.composer}>
      {own !== null && held !== null ? <Hold id={commandKey(own.command)} attempt={own.attempt} line={held.line} verbs={held.verbs} /> : null}
      {stopUnknown && run?.runId === stopUnknown.runId && !stopRequested
        ? <Hold id={`stop:${stopUnknown.runId}`} attempt={stopUnknown.attempt} line={{ fact: "not sure the answer stopped.", reason: MAY_HAVE }} /> : null}
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
            quote={quote}
            onRemove={locked ? undefined : (event) => {
              if (document.activeElement === event.currentTarget) textarea.current?.focus({ preventScroll: true });
              setRefusal(null);
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
            onChange={(next) => { setRefusal(null); setSelection(next); }}
            disabled={!inputReady || frozen !== null}
            waiting={recallRequired && recallPending && memoryFailure === null}
          />
          {unknown !== null && !reloads ? <Button disabled={own?.kind === "Busy"} onClick={discard}>discard send</Button> : null}
          <Button
            emphasis={recovery || run ? undefined : "strong"}
            iconOnly
            className={styles.send}
            disabled={sending || (recovery ? reloads : run ? stopRequested : !canSend)}
            onClick={run && !recovery ? () => cancel(run.runId) : activateSend}
            onKeyDown={activateSend}
            aria-label={sendLabel.current}
            aria-describedby={field ? fieldId : sendWaits !== null ? waitsId : undefined}
            aria-busy={sending}
            icon={recovery ? <Icon.Again aria-hidden="true" /> : run ? <Icon.Stop aria-hidden="true" /> : <Icon.Send aria-hidden="true" />} />
        </div>
        {recallTransport ? <Fact speak={isPaneActive} line={TRANSPORT_LINES[recallTransport].command("couldn’t load your last model.")} verbs={recallVerbs} /> : null}
      </div>
    </div>
  );
}
