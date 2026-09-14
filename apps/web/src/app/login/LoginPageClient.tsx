"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import AuthSurface from "@/components/auth/AuthSurface";
import authStyles from "@/components/auth/AuthForms.module.css";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackAnnouncement,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { decodePasswordSignInOutcome } from "@/lib/auth/form-outcomes";
import { type OAuthProvider } from "@/lib/auth/identities";
import type { PasswordSignInOutcome } from "@/lib/auth/password-flow";
import {
  buildAuthNativeGoogleDeepLink,
  buildAuthStartDeepLink,
  isDefaultAuthReturnTarget,
  type AuthReturnTarget,
} from "@/lib/auth/redirects";

interface LoginPageClientProps {
  initialFeedback?: {
    content: FeedbackContent;
    announcement: "Polite" | "Assertive";
  } | null;
  nextPath: AuthReturnTarget;
  isShell: boolean;
}

const EMAIL_ERROR_ID = "password-sign-in-email-error";
const PASSWORD_ERROR_ID = "password-sign-in-password-error";

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="currentColor"
      focusable="false"
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.607.069-.607 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10Z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      focusable="false"
    >
      <path
        d="M21.81 12.23c0-.72-.06-1.4-.2-2.04H12v3.87h5.5a4.7 4.7 0 0 1-2.04 3.09v2.56h3.29c1.93-1.78 3.06-4.4 3.06-7.48Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.76 0 5.08-.92 6.78-2.49l-3.29-2.56c-.91.61-2.08.98-3.49.98-2.68 0-4.95-1.81-5.76-4.24H2.84v2.64A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.24 13.69A5.98 5.98 0 0 1 5.91 12c0-.58.1-1.14.27-1.69V7.67H2.84A10 10 0 0 0 2 12c0 1.61.39 3.14 1.08 4.33l3.16-2.64Z"
        fill="#FBBC04"
      />
      <path
        d="M12 6.07c1.5 0 2.84.52 3.89 1.54l2.92-2.92C17.08 3.08 14.76 2 12 2A10 10 0 0 0 2.84 7.67l3.34 2.64C7.01 7.88 9.29 6.07 12 6.07Z"
        fill="#EA4335"
      />
    </svg>
  );
}

// Browser OAuth stays server-initiated. In the Android shell, these anchors
// hand the same fixed provider/return-target intent to the native owner.
function ProviderForm({
  provider,
  nextPath,
  label,
  mark,
  isShell,
}: {
  provider: OAuthProvider;
  nextPath: AuthReturnTarget;
  label: string;
  mark: ReactNode;
  isShell: boolean;
}) {
  if (isShell) {
    const href =
      provider === "google"
        ? buildAuthNativeGoogleDeepLink(nextPath)
        : buildAuthStartDeepLink(provider, "signin", nextPath);
    return (
      <Button asChild variant="secondary" size="lg">
        <a href={href}>
          {mark}
          {label}
        </a>
      </Button>
    );
  }
  return (
    <form className={authStyles.providerForm} action="/auth/oauth" method="get">
      <input type="hidden" name="provider" value={provider} />
      {isDefaultAuthReturnTarget(nextPath) ? null : (
        <input type="hidden" name="next" value={nextPath} />
      )}
      <Button variant="secondary" size="lg" type="submit" leadingIcon={mark}>
        {label}
      </Button>
    </form>
  );
}

function passwordSignInErrorMessage(
  outcome: PasswordSignInOutcome,
): FeedbackContent | null {
  switch (outcome.kind) {
    case "SignedIn":
      return null;
    case "InvalidCredentials":
      return { tone: "Danger", title: "Email or password is incorrect." };
    case "RateLimited":
      return {
        tone: "Danger",
        title: "Too many sign-in attempts.",
        message: "Wait a few minutes, then try again.",
      };
    case "ServiceUnavailable":
      return {
        tone: "Danger",
        title: "Sign in is temporarily unavailable.",
        message: "Try again in a moment.",
      };
  }
  outcome satisfies never;
}

export default function LoginPageClient({
  initialFeedback = null,
  nextPath,
  isShell,
}: LoginPageClientProps) {
  const [revealed, setRevealed] = useState(false);
  const [emailError, setEmailError] = useState<FeedbackContent | null>(null);
  const [passwordError, setPasswordError] = useState<FeedbackContent | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    content: FeedbackContent;
    announcement: FeedbackAnnouncement;
  } | null>(initialFeedback);
  const [pending, setPending] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const pendingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  function finishFailure(content: FeedbackContent) {
    setFeedback({ content, announcement: "Assertive" });
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
    setRevealed(false);
    passwordRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;

    const emailControl = event.currentTarget.elements.namedItem("email");
    if (!(emailControl instanceof HTMLInputElement)) {
      setDefect({ error: new Error("Sign-in email control is missing") });
      return;
    }
    const passwordControl = event.currentTarget.elements.namedItem("password");
    if (!(passwordControl instanceof HTMLInputElement)) {
      setDefect({ error: new Error("Sign-in password control is missing") });
      return;
    }
    const emailValue = emailControl.value;
    const passwordValue = passwordControl.value;
    const nextEmailError = !emailValue.trim()
      ? { tone: "Danger" as const, title: "Enter your email address." }
      : emailControl.validity.typeMismatch
        ? { tone: "Danger" as const, title: "Enter a valid email address." }
        : null;
    const nextPasswordError = passwordValue
      ? null
      : { tone: "Danger" as const, title: "Enter your password." };
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError || nextPasswordError) {
      (nextEmailError ? emailControl : passwordRef.current)?.focus();
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
          finishFailure({
            tone: "Danger",
            title: "Sign in is temporarily unavailable.",
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
      const outcome = decodePasswordSignInOutcome(rawOutcome);
      const content = passwordSignInErrorMessage(outcome);
      if (content === null) {
        throw new Error("Sign-in success response did not redirect");
      }
      finishFailure(content);
    } catch (error) {
      setDefect({ error });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (defect) throw defect.error;

  return (
    <AuthSurface title="Sign in to Nexus">
      <div className={authStyles.stack}>
        {feedback ? (
          <FeedbackNotice
            content={feedback.content}
            announcement={feedback.announcement}
          />
        ) : null}

        <form
          aria-label="Sign in with email and password"
          aria-busy={pending}
          className={authStyles.form}
          method="post"
          action="/auth/password/sign-in"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          {isDefaultAuthReturnTarget(nextPath) ? null : (
            <input type="hidden" name="next" value={nextPath} />
          )}
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
              aria-describedby={
                emailError === null ? undefined : EMAIL_ERROR_ID
              }
            />
            {emailError ? (
              <div role="alert">
                <FieldFeedback id={EMAIL_ERROR_ID} content={emailError} />
              </div>
            ) : null}
          </label>

          <div className={authStyles.field}>
            <label
              className={authStyles.label}
              htmlFor="password-sign-in-password"
            >
              Password
            </label>
            <span className={authStyles.passwordControl}>
              <Input
                ref={passwordRef}
                id="password-sign-in-password"
                className={authStyles.passwordInput}
                name="password"
                type={revealed ? "text" : "password"}
                size="lg"
                autoComplete="current-password"
                required
                onChange={() => setPasswordError(null)}
                aria-invalid={passwordError === null ? undefined : true}
                aria-describedby={
                  passwordError === null ? undefined : PASSWORD_ERROR_ID
                }
              />
              <Button
                className={authStyles.reveal}
                variant="ghost"
                size="lg"
                iconOnly
                type="button"
                aria-label={revealed ? "Hide password" : "Show password"}
                aria-controls="password-sign-in-password"
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? (
                  <EyeOff size={18} aria-hidden="true" />
                ) : (
                  <Eye size={18} aria-hidden="true" />
                )}
              </Button>
            </span>
            {passwordError ? (
              <div role="alert">
                <FieldFeedback id={PASSWORD_ERROR_ID} content={passwordError} />
              </div>
            ) : null}
          </div>

          <Link className={authStyles.forgot} href="/forgot-password">
            Forgot password?
          </Link>
          <Button variant="primary" size="lg" type="submit" loading={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className={authStyles.divider}>
          <span>or</span>
        </div>
        <div className={authStyles.providers}>
          <ProviderForm
            provider="google"
            nextPath={nextPath}
            label="Continue with Google"
            mark={<GoogleMark />}
            isShell={isShell}
          />
          <ProviderForm
            provider="github"
            nextPath={nextPath}
            label="Continue with GitHub"
            mark={<GitHubMark />}
            isShell={isShell}
          />
        </div>

        <p className={authStyles.legal}>
          By continuing, you agree to the{" "}
          <Link href="/terms">Terms of Service</Link> and{" "}
          <Link href="/privacy">Privacy Policy</Link>.
        </p>
      </div>
    </AuthSurface>
  );
}
