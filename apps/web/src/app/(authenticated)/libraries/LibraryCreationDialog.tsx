"use client";

import { useId, useRef } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import type { Library } from "@/lib/libraries/api";
import styles from "./page.module.css";

export type Attempt = Readonly<{ libraryId: string; name: string }>;
export type DraftFeedback = FeedbackContent & { nameInvalid: boolean };
export type Creation =
  | { kind: "Draft"; text: string; feedback: DraftFeedback | null }
  | { kind: "Sending"; attempt: Attempt; wasUnconfirmed: boolean }
  | { kind: "Unconfirmed"; attempt: Attempt; feedback: FeedbackContent }
  | { kind: "Created"; library: Library };

/** Presentation only: the pane retains the command when this dialog closes. */
export default function LibraryCreationDialog({
  open,
  creation,
  onChangeName,
  onSubmit,
  onClose,
  returnFocusTo,
  returnFocusFallback,
  skipReturnFocus,
}: {
  open: boolean;
  creation: Creation;
  onChangeName: (text: string) => void;
  onSubmit: (focusName: () => void) => void;
  onClose: () => void;
  returnFocusTo: () => HTMLElement | null;
  returnFocusFallback: () => HTMLElement | null;
  skipReturnFocus: () => boolean;
}) {
  const nameId = useId();
  const feedbackId = useId();
  const nameInput = useRef<HTMLInputElement | null>(null);
  const submitButton = useRef<HTMLButtonElement | null>(null);
  const composing = useRef(false);
  const view = (() => {
    switch (creation.kind) {
      case "Draft":
        return {
          title: "new library",
          name: creation.text,
          submit: "create library",
          message: null,
        };
      case "Sending":
        return {
          title: "creating library…",
          name: creation.attempt.name,
          submit: "creating…",
          message: "you can close this dialog. creation will continue.",
        };
      case "Unconfirmed":
        return {
          title: "creation not confirmed",
          name: creation.attempt.name,
          submit: "retry creation",
          message: creation.feedback.message ?? null,
        };
      case "Created":
        return {
          title: "library created",
          name: creation.library.name,
          submit: "open library",
          message: `“${creation.library.name}” is ready.`,
        };
    }
  })();
  const feedback = creation.kind === "Draft" ? creation.feedback : null;
  const nameInvalid = feedback?.nameInvalid === true;
  const close = () => {
    composing.current = false;
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="new library"
      className={styles.creationDialog}
      onClose={close}
      initialFocus={(panel) => {
        switch (creation.kind) {
          case "Draft":
            return nameInput.current;
          case "Sending":
            return panel;
          case "Unconfirmed":
          case "Created":
            return submitButton.current;
        }
      }}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
      skipReturnFocus={skipReturnFocus}
    >
      <form
        className={styles.creationForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!composing.current) onSubmit(() => nameInput.current?.focus());
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          ) {
            // Keep composition keys away from native submit and overlay Escape.
            if (event.key === "Enter") event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <label className={styles.creationField} htmlFor={nameId}>
          <span>name</span>
          <Input
            ref={nameInput}
            id={nameId}
            value={view.name}
            readOnly={creation.kind !== "Draft"}
            aria-invalid={nameInvalid || undefined}
            aria-describedby={feedback ? feedbackId : undefined}
            onChange={(event) => onChangeName(event.currentTarget.value)}
          />
        </label>
        {feedback ? (
          <div id={feedbackId}>
            {nameInvalid && feedback.message === undefined ? (
              <p className={styles.creationError} role="alert">{feedback.title}</p>
            ) : (
              <FeedbackNotice content={feedback} announcement="Assertive" />
            )}
          </div>
        ) : null}
        <div className={styles.creationStatus} role="status" aria-live="polite">
          {creation.kind !== "Draft" ? (
            <>
              <p className={styles.creationStatusTitle}>{view.title}</p>
              <p>{view.message}</p>
            </>
          ) : null}
        </div>
        <div className={styles.creationActions}>
          <Button variant="ghost" onClick={close}>
            {creation.kind === "Draft" ? "cancel" : "close"}
          </Button>
          <Button
            ref={submitButton}
            type="submit"
            variant="primary"
            aria-disabled={creation.kind === "Sending" || undefined}
          >
            {view.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
