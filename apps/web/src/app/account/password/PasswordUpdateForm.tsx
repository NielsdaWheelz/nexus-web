"use client";
// at least 15 characters (the provider's own minimum). an answer that never
// arrived asks for the same password again.
import { Eye, EyeOff } from "lucide-react";
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
import {
  DEFAULT_RETURN_TARGET,
  loginPath,
  savedPasswordPath,
  type ReturnTarget,
} from "@/lib/auth/urls";

const TOO_SHORT: FeedbackContent = {
  tone: "Danger",
  title: "Password must be at least 15 characters.",
};
const UNCONFIRMED: FeedbackContent = {
  tone: "Danger",
  title: "We couldn’t confirm whether your password was saved.",
  message: "Enter the same password and save again.",
};

export default function PasswordUpdateForm({
  nextPath,
  saved,
}: {
  nextPath: ReturnTarget;
  saved: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [fieldError, setFieldError] = useState<FeedbackContent | null>(null);
  const [pageError, setPageError] = useState<FeedbackContent | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function fail(field: FeedbackContent | null, page: FeedbackContent | null) {
    if (passwordRef.current) passwordRef.current.value = "";
    setRevealed(false);
    setFieldError(field);
    setPageError(page);
    passwordRef.current?.focus();
  }

  const { pending, submit } = useAuthForm<
    "PolicyRejected" | "SessionEnded" | "RateLimited" | "ServiceUnavailable"
  >((kind) => {
    // an ended session was cleared with feedback /login renders.
    if (kind === "SessionEnded") window.location.replace(loginPath(nextPath));
    else if (kind === "PolicyRejected") fail(TOO_SHORT, null);
    else if (kind === "RateLimited") {
      fail(null, {
        tone: "Danger",
        title: "Too many attempts.",
        message: "Wait a few minutes, then try again.",
      });
    } else if (kind === "ServiceUnavailable" || kind === "Unreachable") {
      fail(null, UNCONFIRMED);
    } else if (kind === "Forbidden") fail(null, WRONG_ADDRESS);
    else throw new Error(`Unexpected password-update outcome ${kind}`);
  });

  function validate(): boolean {
    if ((passwordRef.current?.value.length ?? 0) < 15) {
      fail(TOO_SHORT, null);
      return false;
    }
    setFieldError(null);
    setPageError(null);
    return true;
  }

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
          <Link href={nextPath}>Continue</Link>
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
        onSubmit={(event) =>
          void submit(event, savedPasswordPath(nextPath), { validate })
        }
      >
        {nextPath === DEFAULT_RETURN_TARGET ? null : (
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
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={
                fieldError
                  ? "password-update-help password-update-error"
                  : "password-update-help"
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
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? (
                <EyeOff size={18} aria-hidden="true" />
              ) : (
                <Eye size={18} aria-hidden="true" />
              )}
            </Button>
          </span>
          <p id="password-update-help" className={authStyles.help}>
            Use at least 15 characters.
          </p>
          {fieldError ? (
            <div role="alert">
              <FieldFeedback id="password-update-error" content={fieldError} />
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
