"use client";

import Link from "next/link";
import { useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { buildAuthCallbackUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/client";
import styles from "./page.module.css";

interface LoginPageClientProps {
  initialError?: string | null;
  nextPath: string;
}

type OAuthProvider = "github" | "google";

function GitHubMark() {
  return (
    <svg
      aria-hidden="true"
      className={styles.providerIcon}
      viewBox="0 0 24 24"
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
      className={styles.providerIcon}
      viewBox="0 0 24 24"
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

export default function LoginPageClient({
  initialError = null,
  nextPath,
}: LoginPageClientProps) {
  const [activeProvider, setActiveProvider] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<FeedbackContent | null>(
    initialError ? { severity: "error", title: initialError } : null
  );

  const handleProviderSignIn = async (provider: OAuthProvider) => {
    setError(null);
    setActiveProvider(provider);

    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: buildAuthCallbackUrl(window.location.origin, nextPath),
        },
      });

      if (oauthError) {
        setError({
          severity: "error",
          title: "We couldn't start sign in. Please try again.",
        });
        setActiveProvider(null);
      }
    } catch (signInError) {
      setError(
        toFeedback(signInError, {
          fallback: "We couldn't start sign in. Please try again.",
        })
      );
      setActiveProvider(null);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.shell}>
        <div className={styles.card}>
          <div className={styles.header}>
            <p className={styles.eyebrow}>Nexus</p>
            <h1 className={styles.title}>Sign in or create your account</h1>
            <p className={styles.subtitle}>
              Continue with Google or GitHub. Your first sign-in provisions your
              workspace automatically.
            </p>
          </div>

          <div className={styles.form} aria-live="polite">
            {error ? <FeedbackNotice feedback={error} className={styles.error} /> : null}

            <button
              type="button"
              className={styles.providerButton}
              onClick={() => void handleProviderSignIn("google")}
              disabled={activeProvider !== null}
            >
              <GoogleMark />
              <span>
                {activeProvider === "google"
                  ? "Connecting to Google..."
                  : "Continue with Google"}
              </span>
            </button>

            <button
              type="button"
              className={styles.providerButton}
              onClick={() => void handleProviderSignIn("github")}
              disabled={activeProvider !== null}
            >
              <GitHubMark />
              <span>
                {activeProvider === "github"
                  ? "Connecting to GitHub..."
                  : "Continue with GitHub"}
              </span>
            </button>

            <p className={styles.legalCopy}>
              By continuing, you agree to the{" "}
              <Link className={styles.legalLink} href="/terms">
                Terms of Service
              </Link>{" "}
              and acknowledge the{" "}
              <Link className={styles.legalLink} href="/privacy">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
