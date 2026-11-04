"use client";

import * as Icon from "@/lib/ui/icons";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { Library } from "@/lib/libraries/api";
import { sendCreation } from "@/lib/libraries/create";
import { libraryNameError } from "@/lib/libraries/views";
import { NAME_REFUSED, refuseLibrary } from "@/lib/libraries/errors";
import type { PanePrimaryAction } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import styles from "./page.module.css";

type Attempt = Readonly<{ id: string; name: string; openIntent: OpenIntent }>;
/** `field` is what stands beneath the name: the name rule once a submit checked it, or the
 * server's refusal. `unconfirmed` counts the attempts that left the outcome unknown. */
type Creation =
  | { kind: "Draft"; text: string; field: string | null }
  | { kind: "Sending"; attempt: Attempt; unconfirmed: number }
  | { kind: "Unconfirmed"; attempt: Attempt; unconfirmed: number }
  | { kind: "Created"; library: Library };
type Delivery = {
  mayOpen: boolean;
};

/** One pane-owned creation attempt; closing its dialog never cancels the write. An unknown
 * outcome holds until it lands or is refused: in the dialog while it shows, where its submit is
 * the resend of the same id, else in the pane with that resend. A refusal speaks once and returns
 * the draft; a first press admission refuses is said and sends nothing. A resend it refuses holds
 * again, since the first send may have landed. */
export function useLibraryCreation() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "library creation");
  const { ctx } = useActionRuntime();
  const fail = useThrowLater();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const guard = useWorkGuard();
  const owner = useResourceDraft<{ creation: Creation; flight: Delivery | null }>("Libraries.Creation", () => ({
    creation: { kind: "Draft", text: "", field: null }, flight: null,
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
      transition({ kind: "Draft", text: "", field: null });
    open.current = true;
    setVisible(true);
  };
  const requestDismiss = () => owner.read().creation.kind !== "Draft" || guard.confirmLoss({ scopes: [], ownerIds: [owner.owner] }) ? "accepted" as const : "blocked" as const;
  const close = () => {
    composing.current = false;
    if (owner.read().flight) owner.read().flight!.mayOpen = false;
    if (owner.read().creation.kind === "Draft")
      transition({ kind: "Draft", text: "", field: null });
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
  const deliver = async (attempt: Attempt, unconfirmed: number) => {
    if (!mounted.current || owner.read().flight) return;
    const delivery: Delivery = { mayOpen: true };
    owner.set(value => ({ ...value, flight: delivery }));
    transition({ kind: "Sending", attempt, unconfirmed });
    // The answer is classified where it lands: openAsyncResult opens only a created library.
    await openAsyncResult({
      ctx, originPaneId: runtime.paneId, intent: attempt.openIntent,
      mayOpen: () => delivery.mayOpen && open.current,
      onOpened: release,
      create: async () => {
        const result = await sendCreation({ ...attempt, initial_items: [], expected_removal_revision: null });
        const owns = !ctx.sessionSignal().aborted && owner.read().flight === delivery;
        if (owns) owner.set(value => ({ ...value, flight: null }));
        if (result.kind === "Created") {
          if (owns) transition({ kind: "Created", library: result.library });
          return { target: { href: `/libraries/${result.library.id}`, labelHint: result.library.name }, title: "library created", openLabel: "open library" };
        }
        if (!owns || ctx.sessionSignal().aborted) return null;
        if (result.kind === "Refused" && unconfirmed === 0) {
          handleUnauthenticatedApiError(result.error);
          const invalid = result.error.code === "E_NAME_INVALID";
          transition({ kind: "Draft", text: attempt.name, field: invalid ? NAME_REFUSED : null });
          if (!invalid) refuseLibrary(outcome, result.error, `couldn’t create “${attempt.name}”.`);
        } else {
          // Record uncertainty, then hand a sign-out or a defect to its owner.
          transition({ kind: "Unconfirmed", attempt, unconfirmed: unconfirmed + 1 });
          modeledApiError(result.error, fail);
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
    if (value.kind === "Unconfirmed") return void deliver({ ...value.attempt, openIntent: openIntent === "new_pane" ? openIntent : value.attempt.openIntent }, value.unconfirmed);
    if (value.kind !== "Draft") return;
    const error = libraryNameError(value.text);
    if (error) {
      transition({ ...value, field: error });
      input.current?.focus({ preventScroll: true });
      return;
    }
    void deliver({ id: crypto.randomUUID(), name: value.text.trim(), openIntent }, 0);
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
    label: "New library",
    icon: <Icon.Add aria-hidden="true" />,
    onSelect: ({ triggerEl, openIntent }) => show(triggerEl, openIntent),
  };
  const draft = creation.kind === "Draft";
  const sending = creation.kind === "Sending";
  const validation = draft ? creation.field : null;
  const text = draft ? creation.text : creation.kind === "Created" ? creation.library.name : creation.attempt.name;
  const held = creation.kind === "Unconfirmed" || sending && creation.unconfirmed > 0 ? creation : null;
  const hold = held === null ? null : { id: `library-creation:${held.attempt.id}`, attempt: held.unconfirmed - 1,
    line: { fact: `not sure creating “${held.attempt.name}” saved.`, reason: UNKNOWN_OUTCOME_REASON } };
  const presentation = hold === null ? null : resendFeedback({ line: hold.line,
    resend: { label: "retry", commandKey: hold.id, busy: sending, run: intent => submitCreation(intent) },
  });
  return {
    primaryAction,
    content: <>
      {hold !== null && presentation !== null && !visible ? <Hold {...hold} {...presentation} /> : null}
      <Dialog
        open={visible}
        title="new library"
        className={styles.creationDialog}
        onClose={close}
        onDismissRequest={requestDismiss}
        initialFocus={(panel) => owner.read().creation.kind === "Draft" ? input.current : panel}
        returnFocusTo={() => trigger.current}
        returnFocusFallback={() => findPaneLandmarkFocusTarget(runtime.paneId)}
        skipReturnFocus={() => navigating.current || !mounted.current}
      >
        <form
          className={styles.creationForm}
          onSubmit={(event: FormEvent) => { event.preventDefault(); if (hold === null) submitCreation("default"); }}
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
              transition({ kind: "Draft", text, field: value.field === null ? null : libraryNameError(text) });
            }}
          />
          {validation ? <Field id={errorId} line={{ fact: validation }} /> : null}
          {hold !== null && presentation !== null ? <>
            <Hold {...hold} {...presentation} />
            <Fact line={presentation.line} verbs={presentation.verbs ?? undefined} />
          </> : null}
          <div className={styles.creationActions}>
            <Button onClick={() => { if (requestDismiss() === "accepted") close(); }}>{draft ? "cancel" : "close"}</Button>
            {hold === null ? <Button ref={submit} emphasis="strong" type="submit" aria-disabled={sending || undefined} aria-busy={sending || undefined} onClick={submitGesture}>
              {creation.kind === "Created" ? "open library" : "create library"}
            </Button> : null}
          </div>
        </form>
      </Dialog>
    </>,
  };
}
