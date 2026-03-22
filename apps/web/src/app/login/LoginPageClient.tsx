"use client";

import { Github } from "lucide-react";
import { useState } from "react";
import { buildAuthCallbackUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/client";
import styles from "./page.module.css";

interface LoginPageClientProps {
  initialError?: string | null;
  nextPath: string;
}

type OAuthProvider = "github" | "google";

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
  const [error, setError] = useState<string | null>(initialError);

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
        setError(oauthError.message);
        setActiveProvider(null);
      }
    } catch {
      setError("We couldn't start sign in. Please try again.");
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
            {error && <div className={styles.error}>{error}</div>}

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
              <Github aria-hidden="true" className={styles.providerIcon} />
              <span>
                {activeProvider === "github"
                  ? "Connecting to GitHub..."
                  : "Continue with GitHub"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
