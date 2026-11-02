"use client";
// the invite and recovery landings. the GET is inert; Continue spends the
// token and goes on to /account/password, replacing the token url in history.
import Link from "next/link";
import { useId, useState } from "react";
import { Fact, Field } from "@/components/feedback/Fact";
import type { Line } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import { useAuthForm, WRONG_ADDRESS_LINE } from "@/lib/auth/useAuthForm";
import authStyles from "./AuthForms.module.css";
import AuthSurface from "./AuthSurface";

const COPY = {
  invite: {
    title: "You’re invited to Nexus",
    description: "Accept this invitation to continue and choose a password.",
    action: "Accept invitation",
    invalidTitle: "This invitation link can’t be used",
    invalid: { fact: "it may have expired or been used.", reason: "ask the nexus owner for a new invitation." },
    unavailable: "couldn’t accept the invitation.",
  },
  recovery: {
    title: "Reset your password",
    description: "Continue to verify this link and choose a new password.",
    action: "Continue password reset",
    invalidTitle: "This password-reset link can’t be used",
    invalid: { fact: "it may have expired or been used." },
    unavailable: "couldn’t continue the reset.",
  },
} as const;

export default function EmailActionLanding({
  purpose,
  tokenHash,
}: {
  purpose: "invite" | "recovery";
  tokenHash: string | null;
}) {
  const copy = COPY[purpose];
  const [invalid, setInvalid] = useState(tokenHash === null);
  // A refusal stands under the submit, which is its retry.
  const [failure, setFailure] = useState<Line | null>(null);
  const failureId = useId();
  const { pending, submit } = useAuthForm<
    "InvalidOrExpired" | "RateLimited" | "ServiceUnavailable"
  >((kind) => {
    if (kind === "InvalidOrExpired") setInvalid(true);
    else if (kind === "RateLimited") setFailure({ fact: "too many attempts.", reason: "wait a while before continuing." });
    else if (kind === "ServiceUnavailable" || kind === "Unreachable")
      setFailure({ fact: copy.unavailable, reason: kind === "Unreachable" && !navigator.onLine ? "you’re offline." : "nexus isn’t answering." });
    else if (kind === "Forbidden") setFailure(WRONG_ADDRESS_LINE);
    else throw new Error(`Unexpected email-confirmation outcome ${kind}`);
  });
  const back = (
    <p className={authStyles.secondary}>
      <Link className={authStyles.link} href="/login">
        Back to sign in
      </Link>
    </p>
  );

  if (invalid || tokenHash === null) {
    return (
      <AuthSurface title={copy.invalidTitle}>
        <div className={authStyles.stack}>
          <Fact line={copy.invalid} verbs={purpose === "recovery" ? [{ label: "request a new link", href: "/forgot-password" }] : undefined} speak />
          {back}
        </div>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface title={copy.title} description={copy.description}>
      <div className={authStyles.stack}>
        <form
          className={authStyles.form}
          method="post"
          action={`/auth/confirm/${purpose}`}
          aria-busy={pending}
          onSubmit={(event) => {
            setFailure(null);
            void submit(event, "/account/password", { replace: true });
          }}
        >
          <input type="hidden" name="token_hash" value={tokenHash} />
          <Button emphasis="strong" size="comfortable" type="submit" aria-busy={pending || undefined} disabled={pending}
            aria-describedby={failure ? failureId : undefined}>
            {copy.action}
          </Button>
          {failure ? <Field id={failureId} line={failure} /> : null}
        </form>
        {back}
      </div>
    </AuthSurface>
  );
}
