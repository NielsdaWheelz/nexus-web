"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import type { EmailLinkKind } from "@/lib/auth/email-confirmation";
import { decodeEmailConfirmationOutcome } from "@/lib/auth/form-outcomes";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import authStyles from "./AuthForms.module.css";
import AuthSurface from "./AuthSurface";

type LandingState =
  | { kind: "Ready" }
  | { kind: "Failure"; content: FeedbackContent }
  | { kind: "Invalid" };

function serviceUnavailableMessage(purpose: EmailLinkKind): FeedbackContent {
  switch (purpose) {
    case "invite":
      return {
        tone: "Danger",
        title: "We couldn’t confirm the invitation.",
        message:
          "Try again. If the link can’t be used, ask the Nexus owner for a new invitation.",
      };
    case "recovery":
      return {
        tone: "Danger",
        title: "We couldn’t confirm the password-reset link.",
        message: "Try again. If the link can’t be used, request a new one.",
      };
  }
  purpose satisfies never;
}

export default function EmailActionLanding({
  purpose,
  tokenHash: initialTokenHash,
}: {
  purpose: EmailLinkKind;
  tokenHash: string | null;
}) {
  const [tokenHash, setTokenHash] = useState(initialTokenHash);
  const [state, setState] = useState<LandingState>(
    initialTokenHash === null ? { kind: "Invalid" } : { kind: "Ready" },
  );
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    if (tokenHash === null) {
      setDefect({ error: new Error("Email confirmation token is missing") });
      return;
    }

    const body = new FormData(event.currentTarget);
    pendingRef.current = true;
    setPending(true);
    setState({ kind: "Ready" });
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
          setState({
            kind: "Failure",
            content: serviceUnavailableMessage(purpose),
          });
          return;
        }
        throw error;
      }
      if (response.redirected) {
        // Replace the token-bearing landing in browser history after the
        // one-time credential is spent; Back must not resurrect its URL.
        window.location.replace(response.url);
        return;
      }
      const rawOutcome: unknown = await response.json();
      const outcome = decodeEmailConfirmationOutcome(rawOutcome, purpose);
      switch (outcome.kind) {
        case "Confirmed":
          throw new Error(
            "Email-confirmation success response did not redirect",
          );
        case "InvalidOrExpired":
          setTokenHash(null);
          setState({ kind: "Invalid" });
          break;
        case "RateLimited":
          setState({
            kind: "Failure",
            content: {
              tone: "Danger",
              title: "Too many attempts.",
              message: "Wait a few minutes, then try again.",
            },
          });
          break;
        case "ServiceUnavailable":
          setState({
            kind: "Failure",
            content: serviceUnavailableMessage(purpose),
          });
          break;
        default:
          outcome satisfies never;
      }
    } catch (error) {
      setDefect({ error });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (defect) throw defect.error;

  if (state.kind === "Invalid" || tokenHash === null) {
    const recovery = purpose === "recovery";
    const invalidGuidance = recovery
      ? {
          tone: "Danger" as const,
          title: "It may be invalid, expired, or already used.",
          message: "Request a new password-reset link.",
        }
      : {
          tone: "Danger" as const,
          title: "It may be invalid, expired, or already used.",
          message: "Ask the Nexus owner to send a new invitation.",
        };
    return (
      <AuthSurface
        title={
          recovery
            ? "This password-reset link can’t be used"
            : "This invitation link can’t be used"
        }
      >
        <div className={authStyles.stack}>
          <FeedbackNotice content={invalidGuidance} announcement="Assertive" />
          {recovery ? (
            <Button asChild variant="primary" size="lg">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          ) : null}
          <p className={authStyles.secondary}>
            <Link className={authStyles.link} href="/login">
              Back to sign in
            </Link>
          </p>
        </div>
      </AuthSurface>
    );
  }

  const invitation = purpose === "invite";
  return (
    <AuthSurface
      title={invitation ? "You’re invited to Nexus" : "Reset your password"}
      description={
        invitation
          ? "Accept this invitation to continue and choose a password."
          : "Continue to verify this link and choose a new password."
      }
    >
      <div className={authStyles.stack}>
        {state.kind === "Failure" ? (
          <FeedbackNotice content={state.content} announcement="Assertive" />
        ) : null}
        <form
          className={authStyles.form}
          method="post"
          action={
            invitation ? "/auth/confirm/invite" : "/auth/confirm/recovery"
          }
          aria-busy={pending}
          onSubmit={(event) => void submit(event)}
        >
          <input type="hidden" name="token_hash" value={tokenHash} />
          <Button variant="primary" size="lg" type="submit" loading={pending}>
            {pending
              ? invitation
                ? "Accepting invitation…"
                : "Continuing…"
              : state.kind === "Failure"
                ? "Try again"
                : invitation
                  ? "Accept invitation"
                  : "Continue password reset"}
          </Button>
        </form>
        <p className={authStyles.secondary}>
          <Link className={authStyles.link} href="/login">
            Back to sign in
          </Link>
        </p>
      </div>
    </AuthSurface>
  );
}
