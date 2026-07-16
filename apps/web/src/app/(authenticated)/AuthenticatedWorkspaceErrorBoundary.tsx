"use client";

import { Component, useEffect, useRef, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import styles from "./AuthenticatedWorkspaceErrorBoundary.module.css";

/**
 * The error boundary for the whole authenticated workspace. A same-segment
 * `error.tsx` cannot catch its own layout, so the authenticated layout wraps
 * its Suspense/bootstrap subtree in this client class boundary. The required
 * bootstrap profile read surfaces here: failure replaces the skeleton with an
 * accessible error and Retry — never a fabricated default.
 */

function WorkspaceBootstrapError({ onReset }: { onReset: () => void }) {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  // Recovery requires a new Server Component request: `reset()` alone would
  // re-render the same rejected tree. Both run in one transition so this
  // error UI (with its pending state) holds until the refreshed tree is ready.
  const retry = () => {
    startTransition(() => {
      router.refresh();
      onReset();
    });
  };

  return (
    <div
      ref={regionRef}
      role="alert"
      aria-labelledby="workspace-bootstrap-error-heading"
      tabIndex={-1}
      className={styles.region}
    >
      <h2 id="workspace-bootstrap-error-heading" className={styles.heading}>
        The workspace couldn’t load
      </h2>
      <p className={styles.body}>
        Something went wrong while loading your workspace. Your data is safe.
      </p>
      <Button onClick={retry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

interface AuthenticatedWorkspaceErrorBoundaryState {
  hasError: boolean;
}

export class AuthenticatedWorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  AuthenticatedWorkspaceErrorBoundaryState
> {
  state: AuthenticatedWorkspaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AuthenticatedWorkspaceErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Authenticated workspace bootstrap failed:", error);
  }

  render() {
    if (this.state.hasError) {
      return <WorkspaceBootstrapError onReset={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}
