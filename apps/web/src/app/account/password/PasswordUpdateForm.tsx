"use client";
import * as Icon from "@/lib/ui/icons";
// at least 15 characters (the provider's own minimum). an answer that never
// arrived asks for the same password again.
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useRef, useState } from "react";
import authStyles from "@/components/auth/AuthForms.module.css";
import { Fact, Field } from "@/components/feedback/Fact";
import type { Line } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthForm, WRONG_ADDRESS_LINE } from "@/lib/auth/useAuthForm";
import {
  DEFAULT_RETURN_TARGET,
  expectedAccountPath,
  switchBrowserAccountPath,
  parseReturnTarget,
  savedPasswordPath,
  type ReturnTarget,
} from "@/lib/auth/urls";

const TOO_SHORT: Line = { fact: "passwords need at least 15 characters." };

export default function PasswordUpdateForm({
  nextPath,
  saved,
  expectedAccountId,
}: {
  nextPath: ReturnTarget;
  saved: boolean;
  expectedAccountId: string | null;
}) {
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<Line | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function fail(line: Line) {
    if (passwordRef.current) passwordRef.current.value = "";
    setRevealed(false);
    setError(line);
    passwordRef.current?.focus();
  }

  const { pending, submit } = useAuthForm<
    "PolicyRejected" | "SessionEnded" | "RateLimited" | "ServiceUnavailable" | "DifferentAccount"
  >((kind) => {
    // an ended session was cleared with feedback /login renders.
    if (kind === "DifferentAccount") window.location.replace(expectedAccountPath("/account/password", expectedAccountId));
    else if (kind === "SessionEnded") window.location.replace(switchBrowserAccountPath(parseReturnTarget(expectedAccountPath("/account/password", expectedAccountId))));
    else if (kind === "PolicyRejected") fail(TOO_SHORT);
    else if (kind === "RateLimited") fail({ fact: "too many attempts.", reason: "wait a while, then try again." });
    // Send is the retry.
    else if (kind === "ServiceUnavailable" || kind === "Unreachable") fail({ fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON });
    else if (kind === "Forbidden") fail(WRONG_ADDRESS_LINE);
    else throw new Error(`Unexpected password-update outcome ${kind}`);
  });

  function validate(): boolean {
    if ((passwordRef.current?.value.length ?? 0) < 15) {
      fail(TOO_SHORT);
      return false;
    }
    setError(null);
    return true;
  }

  if (saved) {
    return (
      <div className={authStyles.stack}>
        <Fact line={{ fact: "password saved.", reason: "you can sign in with your email and this password." }}
          verbs={[{ label: "continue", href: nextPath }]} speak />
      </div>
    );
  }

  return (
    <div className={authStyles.stack}>
      <form
        className={authStyles.form}
        method="post"
        action="/auth/password/update"
        aria-busy={pending}
        noValidate
        onSubmit={(event) =>
          void submit(event, savedPasswordPath(nextPath, expectedAccountId), { validate })
        }
      >
        {nextPath === DEFAULT_RETURN_TARGET ? null : (
          <input type="hidden" name="next" value={nextPath} />
        )}
        {expectedAccountId ? <input type="hidden" name="expected_account_id" value={expectedAccountId} /> : null}
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
              onChange={() => setError(null)}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                error
                  ? "password-update-help password-update-error"
                  : "password-update-help"
              }
            />
            <Button
              className={authStyles.reveal}
              size="comfortable"
              iconOnly
              icon={revealed ? <Icon.Hide /> : <Icon.Show />}
              aria-label={revealed ? "Hide password" : "Show password"}
              aria-controls="password-update-password"
              onClick={() => setRevealed((value) => !value)}
            />
          </span>
          <p id="password-update-help" className={authStyles.help}>
            Use at least 15 characters.
          </p>
          {error ? <Field id="password-update-error" line={error} /> : null}
        </div>
        <Button emphasis="strong" size="comfortable" type="submit" aria-busy={pending || undefined} disabled={pending}>
          Save password
        </Button>
      </form>
    </div>
  );
}
