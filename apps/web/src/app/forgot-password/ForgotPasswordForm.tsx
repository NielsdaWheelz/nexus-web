"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import authStyles from "@/components/auth/AuthForms.module.css";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { decodePasswordRecoveryOutcome } from "@/lib/auth/form-outcomes";
import type { PasswordRecoveryOutcome } from "@/lib/auth/password-flow";

const EMAIL_ERROR_ID = "password-recovery-email-error";

function passwordRecoveryErrorMessage(
  outcome: PasswordRecoveryOutcome,
): FeedbackContent | null {
  switch (outcome.kind) {
    case "Requested":
      return null;
    case "RateLimited":
      return {
        tone: "Danger",
        title: "Too many reset requests.",
        message: "Wait a few minutes, then try again.",
      };
    case "ServiceUnavailable":
      return {
        tone: "Danger",
        title: "Password reset is temporarily unavailable.",
        message: "Try again in a moment.",
      };
  }
  outcome satisfies never;
}

export default function ForgotPasswordForm({ sent }: { sent: boolean }) {
  const [emailError, setEmailError] = useState<FeedbackContent | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;

    const emailControl = event.currentTarget.elements.namedItem("email");
    if (!(emailControl instanceof HTMLInputElement)) {
      setDefect({
        error: new Error("Password-recovery email control is missing"),
      });
      return;
    }
    const emailValue = emailControl.value;
    const nextEmailError = !emailValue.trim()
      ? { tone: "Danger" as const, title: "Enter your email address." }
      : emailControl.validity.typeMismatch
        ? { tone: "Danger" as const, title: "Enter a valid email address." }
        : null;
    setEmailError(nextEmailError);
    if (nextEmailError) {
      emailControl.focus();
      return;
    }

    const body = new FormData(event.currentTarget);
    pendingRef.current = true;
    setPending(true);
    setFeedback(null);
    try {
      let response: Response;
      try {
        response = await fetch(event.currentTarget.action, {
          method: "POST",
          body,
          credentials: "same-origin",
          redirect: "follow",
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof TypeError) {
          setFeedback({
            tone: "Danger",
            title: "Password reset is temporarily unavailable.",
            message: "Try again in a moment.",
          });
          return;
        }
        throw error;
      }
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }
      const rawOutcome: unknown = await response.json();
      const outcome = decodePasswordRecoveryOutcome(rawOutcome);
      const content = passwordRecoveryErrorMessage(outcome);
      if (content === null) {
        throw new Error("Password-recovery success response did not redirect");
      }
      setFeedback(content);
    } catch (error) {
      setDefect({ error });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (defect) throw defect.error;

  if (sent) {
    return (
      <div className={authStyles.stack}>
        <FeedbackNotice
          content={{
            tone: "Info",
            title: "Check your email.",
            message:
              "If this email belongs to a Nexus account, a password-reset link is on its way.",
          }}
          announcement="Polite"
        />
        <p className={authStyles.secondary}>
          <Link className={authStyles.link} href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={authStyles.stack}>
      {feedback ? (
        <FeedbackNotice content={feedback} announcement="Assertive" />
      ) : null}
      <form
        className={authStyles.form}
        method="post"
        action="/auth/password/recovery"
        aria-busy={pending}
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <label className={authStyles.field}>
          <span className={authStyles.label}>Email</span>
          <Input
            name="email"
            type="email"
            size="lg"
            autoComplete="email"
            autoCapitalize="none"
            inputMode="email"
            spellCheck={false}
            required
            onChange={() => setEmailError(null)}
            aria-invalid={emailError === null ? undefined : true}
            aria-describedby={emailError === null ? undefined : EMAIL_ERROR_ID}
          />
          {emailError ? (
            <div role="alert">
              <FieldFeedback id={EMAIL_ERROR_ID} content={emailError} />
            </div>
          ) : null}
        </label>
        <Button variant="primary" size="lg" type="submit" loading={pending}>
          {pending ? "Sending reset link…" : "Send reset link"}
        </Button>
      </form>
      <p className={authStyles.secondary}>
        <Link className={authStyles.link} href="/login">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
