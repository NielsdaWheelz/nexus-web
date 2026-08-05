"use client";

import { Eye, EyeOff } from "lucide-react";
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
import { decodePasswordUpdateOutcome } from "@/lib/auth/form-outcomes";
import type { PasswordUpdateOutcome } from "@/lib/auth/password-flow";
import {
  authReturnTargetToHref,
  isDefaultAuthReturnTarget,
  type AuthReturnTarget,
} from "@/lib/auth/redirects";

const PASSWORD_HELP_ID = "password-update-help";
const PASSWORD_ERROR_ID = "password-update-error";

type PasswordUpdatePresentation =
  | { kind: "RedirectExpected" }
  | { kind: "FieldError"; content: FeedbackContent }
  | { kind: "PageError"; content: FeedbackContent };

function passwordUpdateErrorMessage(
  outcome: PasswordUpdateOutcome,
): PasswordUpdatePresentation {
  switch (outcome.kind) {
    case "Saved":
    case "SessionEnded":
      return { kind: "RedirectExpected" };
    case "PolicyRejected":
      return {
        kind: "FieldError",
        content: {
          tone: "Danger",
          title: "Password must be at least 15 characters.",
        },
      };
    case "RateLimited":
      return {
        kind: "PageError",
        content: {
          tone: "Danger",
          title: "Too many attempts.",
          message: "Wait a few minutes, then try again.",
        },
      };
    case "ServiceUnavailable":
      return {
        kind: "PageError",
        content: {
          tone: "Danger",
          title: "We couldn’t confirm whether your password was saved.",
          message: "Enter the same password and save again.",
        },
      };
  }
  outcome satisfies never;
}

export default function PasswordUpdateForm({
  nextPath,
  saved,
}: {
  nextPath: AuthReturnTarget;
  saved: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [fieldError, setFieldError] = useState<FeedbackContent | null>(null);
  const [pageError, setPageError] = useState<FeedbackContent | null>(null);
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const pendingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  function finishFailure(
    presentation: Exclude<
      PasswordUpdatePresentation,
      {
        kind: "RedirectExpected";
      }
    >,
  ) {
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
    setRevealed(false);
    if (presentation.kind === "FieldError") {
      setFieldError(presentation.content);
      setPageError(null);
    } else {
      setFieldError(null);
      setPageError(presentation.content);
    }
    passwordRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;

    const passwordControl = event.currentTarget.elements.namedItem("password");
    if (!(passwordControl instanceof HTMLInputElement)) {
      setDefect({ error: new Error("Password-update control is missing") });
      return;
    }
    const passwordValue = passwordControl.value;
    if (passwordValue.length < 15) {
      finishFailure({
        kind: "FieldError",
        content: {
          tone: "Danger",
          title: "Password must be at least 15 characters.",
        },
      });
      return;
    }

    const body = new FormData(event.currentTarget);
    pendingRef.current = true;
    setPending(true);
    setFieldError(null);
    setPageError(null);
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
          finishFailure({
            kind: "PageError",
            content: {
              tone: "Danger",
              title: "We couldn’t confirm whether your password was saved.",
              message: "Enter the same password and save again.",
            },
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
      const outcome = decodePasswordUpdateOutcome(rawOutcome);
      const presentation = passwordUpdateErrorMessage(outcome);
      if (presentation.kind === "RedirectExpected") {
        throw new Error("Password-update terminal response did not redirect");
      }
      finishFailure(presentation);
    } catch (error) {
      setDefect({ error });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (defect) throw defect.error;

  if (saved) {
    return (
      <div className={authStyles.stack}>
        <FeedbackNotice
          content={{
            tone: "Success",
            title: "Password saved.",
            message: "You can now sign in with your email and password.",
          }}
          announcement="Polite"
        />
        <Button asChild variant="primary" size="lg">
          <Link href={authReturnTargetToHref(nextPath)}>Continue</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className={authStyles.stack}>
      {pageError ? (
        <FeedbackNotice content={pageError} announcement="Assertive" />
      ) : null}
      <form
        className={authStyles.form}
        method="post"
        action="/auth/password/update"
        aria-busy={pending}
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        {isDefaultAuthReturnTarget(nextPath) ? null : (
          <input type="hidden" name="next" value={nextPath} />
        )}
        <div className={authStyles.field}>
          <label
            className={authStyles.label}
            htmlFor="password-update-password"
          >
            New password
          </label>
          <span className={authStyles.passwordControl}>
            <Input
              ref={passwordRef}
              id="password-update-password"
              className={authStyles.passwordInput}
              name="password"
              type={revealed ? "text" : "password"}
              size="lg"
              autoComplete="new-password"
              minLength={15}
              required
              onChange={() => setFieldError(null)}
              aria-invalid={fieldError === null ? undefined : true}
              aria-describedby={
                fieldError === null
                  ? PASSWORD_HELP_ID
                  : `${PASSWORD_HELP_ID} ${PASSWORD_ERROR_ID}`
              }
            />
            <Button
              className={authStyles.reveal}
              variant="ghost"
              size="lg"
              iconOnly
              type="button"
              aria-label={revealed ? "Hide password" : "Show password"}
              aria-controls="password-update-password"
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? (
                <EyeOff size={18} aria-hidden="true" />
              ) : (
                <Eye size={18} aria-hidden="true" />
              )}
            </Button>
          </span>
          <p id={PASSWORD_HELP_ID} className={authStyles.help}>
            Use at least 15 characters.
          </p>
          {fieldError ? (
            <div role="alert">
              <FieldFeedback id={PASSWORD_ERROR_ID} content={fieldError} />
            </div>
          ) : null}
        </div>
        <Button variant="primary" size="lg" type="submit" loading={pending}>
          {pending ? "Saving password…" : "Save password"}
        </Button>
      </form>
    </div>
  );
}
