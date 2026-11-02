"use client";
// the same "Check your email." for every address, known or not.
import Link from "next/link";
import { useRef, useState } from "react";
import authStyles from "@/components/auth/AuthForms.module.css";
import { Fact, Field } from "@/components/feedback/Fact";
import type { Line } from "@/components/feedback/stage";
import { TRANSPORT_LINES } from "@/lib/api/failure";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthForm, WRONG_ADDRESS } from "@/lib/auth/useAuthForm";

const NOT_SENT = "couldn’t send a reset link.";

export default function ForgotPasswordForm({ sent }: { sent: boolean }) {
  const [emailError, setEmailError] = useState<Line | null>(null);
  const [outcome, setOutcome] = useState<Line | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const { pending, submit } = useAuthForm<"RateLimited" | "ServiceUnavailable">(
    (kind) => {
      if (kind === "RateLimited") setOutcome({ fact: "too many reset requests.", reason: "wait a while, then try again." });
      else if (kind === "ServiceUnavailable") setOutcome(TRANSPORT_LINES.Busy.command(NOT_SENT));
      else if (kind === "Unreachable") setOutcome(TRANSPORT_LINES.Unavailable.command(NOT_SENT));
      // L1 owns this copy; until it is a `Line`, its title and message are one.
      else if (kind === "Forbidden") setOutcome({ fact: WRONG_ADDRESS.title, reason: WRONG_ADDRESS.message });
      else {
        throw new Error(`Unexpected password-recovery outcome ${kind}`);
      }
    },
  );

  function validate(): boolean {
    const email = emailRef.current;
    if (!email) throw new Error("Password-recovery email control is missing");
    const error: Line | null = !email.value.trim()
      ? { fact: "enter your email address." }
      : email.validity.typeMismatch
        ? { fact: "enter a valid email address." }
        : null;
    setEmailError(error);
    setOutcome(null);
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
        <Fact line={{ fact: "check your email.", reason: "a reset link was sent if it has an account." }}
          verbs={[{ label: "back to sign in", href: "/login" }]} speak />
      </div>
    );
  }
  return (
    <div className={authStyles.stack}>
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
              [emailError ? "password-recovery-email-error" : null, outcome ? "password-recovery-outcome" : null]
                .filter(Boolean).join(" ") || undefined
            }
          />
          {emailError ? <Field id="password-recovery-email-error" line={emailError} /> : null}
          {outcome ? <Field id="password-recovery-outcome" line={outcome} /> : null}
        </label>
        <Button emphasis="strong" size="comfortable" type="submit" aria-busy={pending || undefined} disabled={pending}>
          Send reset link
        </Button>
      </form>
      {back}
    </div>
  );
}
