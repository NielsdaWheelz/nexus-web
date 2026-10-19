"use client";

import { Plus } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { FeedbackNotice, FeedbackStatus, FieldFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { createLibrary, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { isReservedName, RESERVED_NAME } from "@/lib/libraries/views";
import type { PanePrimaryAction } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

type Attempt = Readonly<{ id: string; name: string; openIntent: OpenIntent }>;
type Creation =
  | { kind: "Draft"; text: string; feedback: FeedbackContent | null }
  | { kind: "Sending"; attempt: Attempt; wasUnconfirmed: boolean }
  | { kind: "Unconfirmed"; attempt: Attempt; feedback: FeedbackContent }
  | { kind: "Created"; library: Library };
type Delivery = {
  mayOpen: boolean;
};
const CREATION = definePaneVisitDataKey<Attempt>("Libraries.Creation");
const CREATE_DEADLINE_MS = 30_000;
const UNCERTAIN: FeedbackContent = {
  tone: "Warning",
  title: "creation not confirmed",
  message: "this library may already exist. retry before creating another library.",
};

function nameError(text: string): string | null {
  const name = text.trim();
  if (!name) return "enter a library name.";
  if (Array.from(name).length > 100) return "use 100 characters or fewer.";
  return isReservedName(name) ? RESERVED_NAME : null;
}

/** One pane-owned creation attempt; closing its dialog never cancels the write. */
export function useLibraryCreation() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "library creation");
  const { ctx } = useActionRuntime();
  const fail = useThrowLater();
  const current = useRef<Creation>({ kind: "Draft", text: "", feedback: null });
  const retained = usePaneVisitData(CREATION, () => {
    const value = current.current;
    return value.kind === "Sending" || value.kind === "Unconfirmed" ? value.attempt : null;
  });
  const writeAttempt = usePaneVisitDataWriter(CREATION);
  const [creation, setCreation] = useState<Creation>(() => {
    if (retained) current.current = { kind: "Unconfirmed", attempt: retained, feedback: UNCERTAIN };
    return current.current;
  });
  const [visible, setVisible] = useState(false);
  const open = useRef(false);
  const mounted = useRef(false);
  const flight = useRef<Delivery | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const navigating = useRef(false);
  const composing = useRef(false);
  const flowIntent = useRef<OpenIntent>("default");
  const input = useRef<HTMLInputElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const errorId = useId();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flight.current) flight.current.mayOpen = false;
    };
  }, []);

  const transition = (next: Creation) => {
    current.current = next;
    writeAttempt(next.kind === "Sending" || next.kind === "Unconfirmed" ? next.attempt : null);
    setCreation(next);
  };
  const show = (triggerEl: HTMLButtonElement | null, intent: OpenIntent) => {
    trigger.current = triggerEl;
    navigating.current = false;
    flowIntent.current = intent;
    if (current.current.kind === "Draft" || current.current.kind === "Created")
      transition({ kind: "Draft", text: "", feedback: null });
    open.current = true;
    setVisible(true);
  };
  const close = () => {
    composing.current = false;
    if (flight.current) flight.current.mayOpen = false;
    if (current.current.kind === "Draft")
      transition({ kind: "Draft", text: "", feedback: null });
    open.current = false;
    setVisible(false);
  };
  const release = () => {
    navigating.current = true;
    open.current = false;
    setVisible(false);
  };
  const openLibrary = (library: Library, intent: OpenIntent) => {
    release();
    const target = { href: `/libraries/${library.id}`, labelHint: library.name };
    if (intent === "new_pane") runtime.activateTarget({ target, disposition: { kind: "Fork" } });
    else runtime.router.push(target.href, { labelHint: library.name });
  };
  const deliver = async (attempt: Attempt, wasUnconfirmed: boolean) => {
    if (!mounted.current || flight.current) return;
    const delivery: Delivery = { mayOpen: true };
    flight.current = delivery;
    transition({ kind: "Sending", attempt, wasUnconfirmed });
    const signal = AbortSignal.timeout(CREATE_DEADLINE_MS);
    const owns = () => mounted.current && flight.current === delivery;
    try {
      await openAsyncResult({
        ctx, originPaneId: runtime.paneId, intent: attempt.openIntent, disposition: "Follow",
        mayOpen: () => delivery.mayOpen && open.current,
        beforeOpen: release,
        onDefault: result => runtime.router.push(result.target.href, { labelHint: result.target.labelHint }),
        create: async () => {
          const library = await createLibrary({ id: attempt.id, name: attempt.name }, signal);
          if (owns()) transition({ kind: "Created", library });
          return { target: { href: `/libraries/${library.id}`, labelHint: library.name }, title: "library created", openLabel: "open library" };
        },
      });
    } catch (error) {
      if (!owns() || ctx.sessionSignal().aborted) return;
      const refusal = isApiError(error) && (
        error.code === "E_NAME_INVALID" || error.code === "E_INVALID_REQUEST" || error.code === "E_FORBIDDEN"
      );
      if (refusal && !wasUnconfirmed) {
        transition({ kind: "Draft", text: attempt.name, feedback: libraryErrorFeedback(error, "library wasn’t created", fail) });
        return;
      }
      // Record uncertainty before handing auth/defects to their existing owners.
      transition({ kind: "Unconfirmed", attempt, feedback: UNCERTAIN });
      if (handleUnauthenticatedApiError(error)) return;
      if (isSameSystemApiDefect(error)) {
        fail({ error });
        return;
      }
      const transport = isApiError(error) && (
        error.code === "E_NETWORK" || error.code === "E_UPSTREAM" ||
        error.code === "E_UPSTREAM_TIMEOUT" || error.code === "E_RATE_LIMITED"
      );
      const deadline = signal.aborted && (isAbortError(error) || error === signal.reason || transport);
      if (!refusal && !transport && !deadline) fail({ error });
    } finally {
      if (owns()) flight.current = null;
    }
  };
  const submitCreation = (intent: OpenIntent) => {
    if (composing.current || flight.current) return;
    const value = current.current;
    if (value.kind === "Created") return openLibrary(value.library, intent);
    const openIntent = intent === "new_pane" ? intent : flowIntent.current;
    if (value.kind === "Unconfirmed") return void deliver({ ...value.attempt, openIntent: openIntent === "new_pane" ? openIntent : value.attempt.openIntent }, true);
    if (value.kind !== "Draft") return;
    const error = nameError(value.text);
    if (error) {
      transition({ ...value, feedback: { tone: "Danger", title: error } });
      input.current?.focus({ preventScroll: true });
      return;
    }
    void deliver({ id: crypto.randomUUID(), name: value.text.trim(), openIntent }, false);
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      if (submit.current?.form?.reportValidity()) submitCreation(activation.intent);
    }
  };

  const primaryAction: PanePrimaryAction = {
    kind: "command",
    id: "Libraries.Create",
    label: "new library",
    icon: <Plus size={16} aria-hidden="true" />,
    onSelect: ({ triggerEl, openIntent }) => show(triggerEl, openIntent),
  };
  const draft = creation.kind === "Draft";
  const sending = creation.kind === "Sending";
  const validation = draft && creation.feedback ? nameError(creation.text) : null;
  const feedback: FeedbackContent | null = sending
    ? creation.wasUnconfirmed
      ? UNCERTAIN
      : { tone: "Neutral", title: "creating library…", message: "you can close this dialog. creation will continue." }
    : creation.kind === "Created"
      ? { tone: "Success", title: "library created", message: `“${creation.library.name}” is ready.` }
      : creation.kind === "Unconfirmed" ? creation.feedback : validation ? null : creation.feedback;
  const text = draft ? creation.text : creation.kind === "Created" ? creation.library.name : creation.attempt.name;

  return {
    primaryAction,
    content: <>
      {!visible && creation.kind === "Draft" && creation.feedback ? (
        <FeedbackNotice content={creation.feedback} announcement="Polite" />
      ) : !visible && creation.kind === "Unconfirmed" ? (
        // This review action leaves the tree on open; closing returns to the pane.
        <FeedbackNotice content={creation.feedback} announcement="Polite"
          actions={[{ label: "review creation", onClick: intent => show(null, intent) }]} />
      ) : !visible && creation.kind === "Created" && feedback ? (
        <FeedbackNotice content={feedback} announcement="Polite" actions={[{
          label: "open library", href: `/libraries/${creation.library.id}`,
          onActivate: event => activateTargetLink({
            event, runtime, target: { href: `/libraries/${creation.library.id}`, labelHint: creation.library.name },
            onDefault: () => openLibrary(creation.library, "default"),
          }),
        }]} />
      ) : null}
      <Dialog
        open={visible}
        title="new library"
        className={styles.creationDialog}
        onClose={close}
        initialFocus={(panel) => current.current.kind === "Draft" ? input.current : current.current.kind === "Unconfirmed" ? submit.current : panel}
        returnFocusTo={() => trigger.current}
        returnFocusFallback={() => findPaneLandmarkFocusTarget(runtime.paneId)}
        skipReturnFocus={() => navigating.current || !mounted.current}
      >
        <form
          className={styles.creationForm}
          onSubmit={(event: FormEvent) => { event.preventDefault(); submitCreation("default"); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Enter") event.preventDefault();
              event.stopPropagation();
            } else submitGesture(event);
          }}
        >
          <label htmlFor={nameId}>name</label>
          <Input
            ref={input}
            id={nameId}
            value={text}
            readOnly={!draft}
            autoComplete="off"
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? errorId : undefined}
            onChange={(event) => {
              if (current.current.kind !== "Draft") return;
              const text = event.currentTarget.value;
              const error = current.current.feedback ? nameError(text) : null;
              transition({ kind: "Draft", text, feedback: error ? { tone: "Danger", title: error } : null });
            }}
          />
          {validation ? <div role="alert"><FieldFeedback id={errorId} content={{ tone: "Danger", title: validation }} /></div> : null}
          {feedback ? (sending && !creation.wasUnconfirmed) || creation.kind === "Created" ? (
            <FeedbackStatus content={feedback} announcement="Polite" />
          ) : <FeedbackNotice content={feedback} announcement="Polite" /> : null}
          <div className={styles.creationActions}>
            <Button variant="ghost" onClick={close}>{draft ? "cancel" : "close"}</Button>
            <Button ref={submit} type="submit" aria-disabled={sending || undefined} aria-busy={sending || undefined} onClick={submitGesture}>
              {creation.kind === "Unconfirmed" || (sending && creation.wasUnconfirmed) ? "retry creation" : creation.kind === "Created" ? "open library" : "create library"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>,
  };
}
