"use client";

import { Plus } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { FeedbackNotice, FeedbackStatus, FieldFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import type { Library } from "@/lib/libraries/api";
import { sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import type { PanePrimaryAction } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
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
const UNCERTAIN: FeedbackContent = {
  tone: "Warning",
  title: "creation not confirmed",
  message: "this library may already exist. retry before creating another library.",
};

/** One pane-owned creation attempt; closing its dialog never cancels the write. */
export function useLibraryCreation() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "library creation");
  const { ctx } = useActionRuntime();
  const fail = useThrowLater();
  const guard = useWorkGuard();
  const owner = useResourceDraft<{ creation: Creation; flight: Delivery | null }>("Libraries.Creation", () => ({
    creation: { kind: "Draft", text: "", feedback: null }, flight: null,
  }), value => ({
    changed: value.creation.kind === "Draft" && value.creation.text.trim() !== "",
    unconfirmed: value.creation.kind === "Sending" || value.creation.kind === "Unconfirmed",
    stopsBrowserWork: false,
  }));
  const creation = owner.value.creation;
  const readCreation = owner.read;
  const [visible, setVisible] = useState(false);
  const open = useRef(false);
  const mounted = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
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
      const flight = readCreation().flight;
      if (flight) flight.mayOpen = false;
    };
  }, [readCreation]);

  const transition = (creation: Creation) => owner.set(value => ({ ...value, creation }));
  const show = (triggerEl: HTMLElement | null, intent: OpenIntent) => {
    trigger.current = triggerEl;
    navigating.current = false;
    flowIntent.current = intent;
    if (owner.read().creation.kind === "Created")
      transition({ kind: "Draft", text: "", feedback: null });
    open.current = true;
    setVisible(true);
  };
  const requestDismiss = () => owner.read().creation.kind !== "Draft" || guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] }) ? "accepted" as const : "blocked" as const;
  const close = () => {
    composing.current = false;
    if (owner.read().flight) owner.read().flight!.mayOpen = false;
    if (owner.read().creation.kind === "Draft")
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
    const target = { href: `/libraries/${library.id}`, labelHint: library.name };
    const result = runtime.activateTarget({ target, disposition: { kind: intent === "new_pane" ? "Fork" : "Follow" } });
    if (result.kind !== "Cancelled") release();
  };
  const deliver = async (attempt: Attempt, wasUnconfirmed: boolean) => {
    if (!mounted.current || owner.read().flight) return;
    const delivery: Delivery = { mayOpen: true };
    owner.set(value => ({ ...value, flight: delivery }));
    transition({ kind: "Sending", attempt, wasUnconfirmed });
    // The answer is classified where it lands: openAsyncResult opens only a created library.
    await openAsyncResult({
      ctx, originPaneId: runtime.paneId, intent: attempt.openIntent,
      mayOpen: () => delivery.mayOpen && open.current,
      onOpened: release,
      create: async () => {
        const outcome = await sendCreation({ ...attempt, initial_items: [], expected_removal_revision: null });
        const owns = !ctx.sessionSignal().aborted && owner.read().flight === delivery;
        if (owns) owner.set(value => ({ ...value, flight: null }));
        if (outcome.kind === "Created") {
          if (owns) transition({ kind: "Created", library: outcome.library });
          return { target: { href: `/libraries/${outcome.library.id}`, labelHint: outcome.library.name }, title: "library created", openLabel: "open library" };
        }
        if (!owns || ctx.sessionSignal().aborted) return null;
        if (outcome.kind === "Refused" && !wasUnconfirmed) {
          transition({ kind: "Draft", text: attempt.name, feedback: libraryErrorFeedback(outcome.error, "library wasn’t created", fail) });
        } else {
          // Record uncertainty, then hand a sign-out or a defect to its owner.
          transition({ kind: "Unconfirmed", attempt, feedback: UNCERTAIN });
          modeledApiError(outcome.error, fail);
        }
        return null;
      },
    }).catch((error: unknown) => fail({ error }));
  };
  const submitCreation = (intent: OpenIntent) => {
    if (composing.current || owner.read().flight) return;
    const value = owner.read().creation;
    if (value.kind === "Created") return openLibrary(value.library, intent);
    const openIntent = intent === "new_pane" ? intent : flowIntent.current;
    if (value.kind === "Unconfirmed") return void deliver({ ...value.attempt, openIntent: openIntent === "new_pane" ? openIntent : value.attempt.openIntent }, true);
    if (value.kind !== "Draft") return;
    const error = libraryNameError(value.text);
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
    icon: <Plus size={20} aria-hidden="true" />,
    onSelect: ({ triggerEl, openIntent }) => show(triggerEl, openIntent),
  };
  const draft = creation.kind === "Draft";
  const sending = creation.kind === "Sending";
  const validation = draft && creation.feedback ? libraryNameError(creation.text) : null;
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
          }),
        }]} />
      ) : null}
      <Dialog
        open={visible}
        title="new library"
        className={styles.creationDialog}
        onClose={close}
        onDismissRequest={requestDismiss}
        initialFocus={(panel) => owner.read().creation.kind === "Draft" ? input.current : owner.read().creation.kind === "Unconfirmed" ? submit.current : panel}
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
              const value = owner.read().creation;
              if (value.kind !== "Draft") return;
              const text = event.currentTarget.value;
              const error = value.feedback ? libraryNameError(text) : null;
              transition({ kind: "Draft", text, feedback: error ? { tone: "Danger", title: error } : null });
            }}
          />
          {validation ? <div role="alert"><FieldFeedback id={errorId} content={{ tone: "Danger", title: validation }} /></div> : null}
          {feedback ? (sending && !creation.wasUnconfirmed) || creation.kind === "Created" ? (
            <FeedbackStatus content={feedback} announcement="Polite" />
          ) : <FeedbackNotice content={feedback} announcement="Polite" /> : null}
          <div className={styles.creationActions}>
            <Button variant="ghost" onClick={() => { if (requestDismiss() === "accepted") close(); }}>{draft ? "cancel" : "close"}</Button>
            <Button ref={submit} type="submit" aria-disabled={sending || undefined} aria-busy={sending || undefined} onClick={submitGesture}>
              {creation.kind === "Unconfirmed" || (sending && creation.wasUnconfirmed) ? "retry creation" : creation.kind === "Created" ? "open library" : "create library"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>,
  };
}
