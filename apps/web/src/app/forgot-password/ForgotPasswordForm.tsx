"use client";
// the same "Check your email." for every address, known or not.
import Link from "next/link";
import { useRef, useState } from "react";
import authStyles from "@/components/auth/AuthForms.module.css";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthForm, WRONG_ADDRESS } from "@/lib/auth/useAuthForm";

const UNAVAILABLE: FeedbackContent = {
  tone: "Danger",
  title: "Password reset is temporarily unavailable.",
  message: "Try again in a moment.",
};

export default function ForgotPasswordForm({ sent }: { sent: boolean }) {
  const [emailError, setEmailError] = useState<FeedbackContent | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const { pending, submit } = useAuthForm<"RateLimited" | "ServiceUnavailable">(
    (kind) => {
      if (kind === "RateLimited") {
        setFeedback({
          tone: "Danger",
          title: "Too many reset requests.",
          message: "Wait a few minutes, then try again.",
        });
      } else if (kind === "ServiceUnavailable" || kind === "Unreachable") {
        setFeedback(UNAVAILABLE);
      } else if (kind === "Forbidden") {
        setFeedback(WRONG_ADDRESS);
      } else {
        throw new Error(`Unexpected password-recovery outcome ${kind}`);
      }
    },
  );

  function validate(): boolean {
    const email = emailRef.current;
    if (!email) throw new Error("Password-recovery email control is missing");
    const error: FeedbackContent | null = !email.value.trim()
      ? { tone: "Danger", title: "Enter your email address." }
      : email.validity.typeMismatch
        ? { tone: "Danger", title: "Enter a valid email address." }
        : null;
    setEmailError(error);
    setFeedback(null);
    if (error) email.focus();
    return !error;
  }

  const back = (
    <p className={authStyles.secondary}>
      <Link className={authStyles.link} href="/login">
        Back to sign in
      </Link>
    </p>
  );
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
        {back}
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
        onSubmit={(event) =>
          void submit(event, "/forgot-password?sent=1", { validate })
        }
      >
        <label className={authStyles.field}>
          <span className={authStyles.label}>Email</span>
          <Input
            ref={emailRef}
            name="email"
            type="email"
            size="lg"
            autoComplete="email"
            autoCapitalize="none"
            inputMode="email"
            spellCheck={false}
            required
            onChange={() => setEmailError(null)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={
              emailError ? "password-recovery-email-error" : undefined
            }
          />
          {emailError ? (
            <div role="alert">
              <FieldFeedback
                id="password-recovery-email-error"
                content={emailError}
              />
            </div>
          ) : null}
        </label>
        <Button variant="primary" size="lg" type="submit" loading={pending}>
          {pending ? "Sending reset link…" : "Send reset link"}
        </Button>
      </form>
      {back}
    </div>
  );
}
