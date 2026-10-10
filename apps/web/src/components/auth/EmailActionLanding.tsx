"use client";
// the invite and recovery landings. the GET is inert; Continue spends the
// token and goes on to /account/password, replacing the token url in history.
import Link from "next/link";
import { useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useAuthForm, WRONG_ADDRESS } from "@/lib/auth/useAuthForm";
import authStyles from "./AuthForms.module.css";
import AuthSurface from "./AuthSurface";

const COPY = {
  invite: {
    title: "You’re invited to Nexus",
    description: "Accept this invitation to continue and choose a password.",
    action: "Accept invitation",
    pending: "Accepting invitation…",
    invalidTitle: "This invitation link can’t be used",
    invalidMessage: "Ask the Nexus owner to send a new invitation.",
    unavailable: {
      tone: "Danger",
      title: "We couldn’t confirm the invitation.",
      message:
        "Try again. If the link can’t be used, ask the Nexus owner for a new invitation.",
    },
  },
  recovery: {
    title: "Reset your password",
    description: "Continue to verify this link and choose a new password.",
    action: "Continue password reset",
    pending: "Continuing…",
    invalidTitle: "This password-reset link can’t be used",
    invalidMessage: "Request a new password-reset link.",
    unavailable: {
      tone: "Danger",
      title: "We couldn’t confirm the password-reset link.",
      message: "Try again. If the link can’t be used, request a new one.",
    },
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
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const { pending, submit } = useAuthForm<
    "InvalidOrExpired" | "RateLimited" | "ServiceUnavailable"
  >((kind) => {
    if (kind === "InvalidOrExpired") setInvalid(true);
    else if (kind === "RateLimited") {
      setFailure({
        tone: "Danger",
        title: "Too many attempts.",
        message: "Wait a few minutes, then try again.",
      });
    } else if (kind === "ServiceUnavailable" || kind === "Unreachable") {
      setFailure(copy.unavailable);
    } else if (kind === "Forbidden") setFailure(WRONG_ADDRESS);
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
          <FeedbackNotice
            content={{
              tone: "Danger",
              title: "It may be invalid, expired, or already used.",
              message: copy.invalidMessage,
            }}
            announcement="Assertive"
          />
          {purpose === "recovery" ? (
            <Button asChild variant="primary" size="lg">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          ) : null}
          {back}
        </div>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface title={copy.title} description={copy.description}>
      <div className={authStyles.stack}>
        {failure ? (
          <FeedbackNotice content={failure} announcement="Assertive" />
        ) : null}
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
          <Button variant="primary" size="lg" type="submit" loading={pending}>
            {pending ? copy.pending : failure ? "Try again" : copy.action}
          </Button>
        </form>
        {back}
      </div>
    </AuthSurface>
  );
}
