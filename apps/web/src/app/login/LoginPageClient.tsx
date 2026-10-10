"use client";
// google first, then email and password, then the other provider. in the
// android shell the provider controls are deep links the native owner handles
// (native google, custom-tab github).
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import authStyles from "@/components/auth/AuthForms.module.css";
import AuthSurface from "@/components/auth/AuthSurface";
import {
  FeedbackNotice,
  FieldFeedback,
  type FeedbackAnnouncement,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthForm, WRONG_ADDRESS } from "@/lib/auth/useAuthForm";
import {
  DEFAULT_RETURN_TARGET,
  nativeGoogleDeepLink,
  oauthPath,
  PROVIDER_NAMES,
  startDeepLink,
  type LoginError,
  type OAuthProvider,
  type ReturnTarget,
} from "@/lib/auth/urls";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";

type Feedback = {
  content: FeedbackContent;
  announcement: FeedbackAnnouncement;
};

const INITIAL: Record<LoginError | "session_ended", Feedback> = {
  oauth_start_failed: {
    content: {
      tone: "Danger",
      title: "We couldn't start sign in.",
      message: "Please try again.",
    },
    announcement: "Assertive",
  },
  sign_in_failed: {
    content: {
      tone: "Danger",
      title: "We couldn't complete sign in.",
      message: "Please try again.",
    },
    announcement: "Assertive",
  },
  session_ended: {
    content: {
      tone: "Info",
      title: "Your session ended.",
      message: "Please sign in again.",
    },
    announcement: "Polite",
  },
};

const UNAVAILABLE: FeedbackContent = {
  tone: "Danger",
  title: "Sign in is temporarily unavailable.",
  message: "Try again in a moment.",
};

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

// a provider start is a navigation, not a form submission: /auth/oauth answers
// with a redirect to the provider's origin, and chromium holds a form
// submission's whole redirect chain to the csp's form-action 'self'. in the
// android shell the same intent goes to the native owner as a deep link.
// role="button" keeps the control's accessible role.
function ProviderLink({
  provider,
  nextPath,
  isShell,
  disabled,
}: {
  provider: OAuthProvider;
  nextPath: ReturnTarget;
  isShell: boolean;
  disabled: boolean;
}) {
  const href = !isShell
    ? oauthPath(provider, nextPath)
    : provider === "google"
      ? nativeGoogleDeepLink(nextPath)
      : startDeepLink(provider, nextPath);
  return (
    <Button
      asChild
      variant={provider === "google" ? "primary" : "secondary"}
      size="lg"
      className={disabled ? authStyles.providerDisabled : undefined}
    >
      <a
        href={href}
        role="button"
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={disabled ? (event) => event.preventDefault() : undefined}
      >
        {provider === "google" ? <GoogleMark /> : <GitHubMark />}
        {`Continue with ${PROVIDER_NAMES[provider]}`}
      </a>
    </Button>
  );
}

function Disclosure({
  label,
  className,
  pending,
  children,
}: {
  label: string;
  className: string;
  pending: boolean;
  children: ReactNode;
}) {
  return (
    <details className={authStyles.method}>
      <summary
        className={`${authStyles.disclosure} ${className}${
          pending ? ` ${authStyles.disclosureDisabled}` : ""
        }`}
        role="button"
        aria-disabled={pending || undefined}
        tabIndex={pending ? -1 : undefined}
        onClick={pending ? (event) => event.preventDefault() : undefined}
      >
        {label}
      </summary>
      {children}
    </details>
  );
}

export default function LoginPageClient({
  feedback: initial,
  nextPath,
  isShell,
}: {
  feedback: LoginError | "session_ended" | null;
  nextPath: ReturnTarget;
  isShell: boolean;
}) {
  const connectivity = useConnectivity();
  const [revealed, setRevealed] = useState(false);
  const [emailError, setEmailError] = useState<FeedbackContent | null>(null);
  const [passwordError, setPasswordError] = useState<FeedbackContent | null>(
    null,
  );
  const [feedback, setFeedback] = useState<Feedback | null>(
    initial ? INITIAL[initial] : null,
  );
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // every failure clears the password and returns focus to it.
  const { pending, submit } = useAuthForm<
    "InvalidCredentials" | "RateLimited" | "ServiceUnavailable"
  >((kind) => {
    let content: FeedbackContent;
    if (kind === "InvalidCredentials") {
      content = { tone: "Danger", title: "Email or password is incorrect." };
    } else if (kind === "RateLimited") {
      content = {
        tone: "Danger",
        title: "Too many sign-in attempts.",
        message: "Wait a few minutes, then try again.",
      };
    } else if (kind === "Unreachable" && connectivity === "Offline") {
      content = {
        tone: "Danger",
        title: "You’re offline.",
        message: "Reconnect to sign in.",
      };
    } else if (kind === "ServiceUnavailable" || kind === "Unreachable") {
      content = UNAVAILABLE;
    } else if (kind === "Forbidden") {
      content = WRONG_ADDRESS;
    } else {
      throw new Error(`Unexpected sign-in outcome ${kind}`);
    }
    setFeedback({ content, announcement: "Assertive" });
    if (passwordRef.current) passwordRef.current.value = "";
    setRevealed(false);
    passwordRef.current?.focus();
  });

  function validate(): boolean {
    const email = emailRef.current;
    const password = passwordRef.current;
    if (!email || !password) throw new Error("Sign-in controls are missing");
    const nextEmailError: FeedbackContent | null = !email.value.trim()
      ? { tone: "Danger", title: "Enter your email address." }
      : email.validity.typeMismatch
        ? { tone: "Danger", title: "Enter a valid email address." }
        : null;
    const nextPasswordError: FeedbackContent | null = password.value
      ? null
      : { tone: "Danger", title: "Enter your password." };
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError) email.focus();
    else if (nextPasswordError) password.focus();
    return !nextEmailError && !nextPasswordError;
  }

  return (
    <AuthSurface
      title="Sign in"
      description={
        isShell
          ? "Use the account connected to this Nexus."
          : "Private workspace. No public registration."
      }
    >
      <div className={authStyles.stack}>
        {feedback ? (
          <div
            className={pending ? authStyles.feedbackPending : undefined}
            aria-hidden={pending || undefined}
          >
            <FeedbackNotice
              content={feedback.content}
              announcement={feedback.announcement}
            />
          </div>
        ) : null}

        <ProviderLink
          provider="google"
          nextPath={nextPath}
          isShell={isShell}
          disabled={pending}
        />

        <Disclosure
          label="Use email and password"
          className={authStyles.passwordDisclosure}
          pending={pending}
        >
          <form
            aria-label="Sign in with email and password"
            aria-busy={pending}
            className={authStyles.form}
            method="post"
            action="/auth/password/sign-in"
            noValidate
            onSubmit={(event) => void submit(event, nextPath, { validate })}
          >
            {nextPath === DEFAULT_RETURN_TARGET ? null : (
              <input type="hidden" name="next" value={nextPath} />
            )}
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
                  emailError ? "password-sign-in-email-error" : undefined
                }
              />
              {emailError ? (
                <div role="alert">
                  <FieldFeedback
                    id="password-sign-in-email-error"
                    content={emailError}
                  />
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
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby={
                    passwordError
                      ? "password-sign-in-password-error"
                      : undefined
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
                  <FieldFeedback
                    id="password-sign-in-password-error"
                    content={passwordError}
                  />
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
        </Disclosure>

        <Disclosure
          label="Other ways to sign in"
          className={authStyles.otherDisclosure}
          pending={pending}
        >
          <div className={authStyles.methodBody}>
            <ProviderLink
              provider="github"
              nextPath={nextPath}
              isShell={isShell}
              disabled={pending}
            />
          </div>
        </Disclosure>

        <nav className={authStyles.footer} aria-label="Login links">
          {isShell ? null : <Link href="/android">Android</Link>}
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </div>
    </AuthSurface>
  );
}
