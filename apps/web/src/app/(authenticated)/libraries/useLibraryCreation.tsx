"use client";

import { Plus } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { createLibrary, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import { isReservedName, RESERVED_NAME } from "@/lib/libraries/views";
import type { PanePrimaryAction } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import styles from "./page.module.css";

type Attempt = Readonly<{ id: string; name: string }>;
type Creation =
  | { kind: "Draft"; text: string; feedback: FeedbackContent | null }
  | { kind: "Sending"; attempt: Attempt }
  | { kind: "Unconfirmed"; attempt: Attempt; feedback: FeedbackContent }
  | { kind: "Created"; library: Library };
type Delivery = {
  readonly foreground: number;
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
  const workspace = useLatestWorkspace();
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
  const show = (triggerEl: HTMLButtonElement | null) => {
    trigger.current = triggerEl;
    navigating.current = false;
    if (current.current.kind === "Draft" || current.current.kind === "Created")
      transition({ kind: "Draft", text: "", feedback: null });
    open.current = true;
    setVisible(true);
  };
  const close = () => {
    if (flight.current) flight.current.mayOpen = false;
    if (current.current.kind === "Draft")
      transition({ kind: "Draft", text: "", feedback: null });
    open.current = false;
    setVisible(false);
  };
  const openLibrary = (library: Library) => {
    navigating.current = true;
    open.current = false;
    setVisible(false);
    runtime.router.push(`/libraries/${library.id}`, { labelHint: library.name });
  };
  const deliver = async (attempt: Attempt, wasUnconfirmed: boolean) => {
    if (!mounted.current || flight.current) return;
    const latest = workspace();
    const delivery: Delivery = {
      foreground: latest.foregroundGeneration,
      mayOpen: latest.state.active_primary_pane_id === runtime.paneId,
    };
    flight.current = delivery;
    transition({ kind: "Sending", attempt });
    const signal = AbortSignal.timeout(CREATE_DEADLINE_MS);
    const owns = () => mounted.current && flight.current === delivery;
    try {
      const library = await createLibrary(attempt, signal);
      if (!owns()) return;
      transition({ kind: "Created", library });
      if (delivery.mayOpen && open.current && workspace().foregroundGeneration === delivery.foreground)
        openLibrary(library);
    } catch (error) {
      if (!owns()) return;
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
  const submitCreation = (event: FormEvent) => {
    event.preventDefault();
    if (composing.current || flight.current) return;
    const value = current.current;
    if (value.kind === "Created") return openLibrary(value.library);
    if (value.kind === "Unconfirmed") return void deliver(value.attempt, true);
    if (value.kind !== "Draft") return;
    const error = nameError(value.text);
    if (error) {
      transition({ ...value, feedback: { tone: "Danger", title: error } });
      input.current?.focus({ preventScroll: true });
      return;
    }
    void deliver({ id: crypto.randomUUID(), name: value.text.trim() }, false);
  };

  const primaryAction: PanePrimaryAction = {
    kind: "command",
    id: "Libraries.Create",
    label: "new library",
    icon: <Plus size={16} aria-hidden="true" />,
    onSelect: ({ triggerEl }) => show(triggerEl),
  };
  const draft = creation.kind === "Draft";
  const sending = creation.kind === "Sending";
  const validation = draft && creation.feedback ? nameError(creation.text) : null;
  const feedback: FeedbackContent | null = sending
    ? { tone: "Neutral", title: "creating library…", message: "you can close this dialog. creation will continue." }
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
        <FeedbackNotice content={creation.feedback} announcement="Polite">
          <Button variant="secondary" size="sm" onClick={(event) => show(event.currentTarget)}>review creation</Button>
        </FeedbackNotice>
      ) : !visible && creation.kind === "Created" && feedback ? (
        <FeedbackNotice content={feedback} announcement="Polite" actions={[{ label: "open library", onClick: () => openLibrary(creation.library) }]} />
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
          onSubmit={submitCreation}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
              event.stopPropagation();
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
          {validation ? <p id={errorId} className={styles.nameError} role="alert">{validation}</p> : null}
          {feedback ? <FeedbackNotice content={feedback} announcement="Polite" /> : null}
          <div className={styles.creationActions}>
            <Button variant="ghost" onClick={close}>{draft ? "cancel" : "close"}</Button>
            <Button ref={submit} type="submit" aria-disabled={sending || undefined} aria-busy={sending || undefined}>
              {sending ? "creating…" : creation.kind === "Unconfirmed" ? "retry creation" : creation.kind === "Created" ? "open library" : "create library"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>,
  };
}
