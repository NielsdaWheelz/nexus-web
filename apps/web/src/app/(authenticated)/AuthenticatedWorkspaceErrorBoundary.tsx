"use client";

import { Component, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects. Retry reloads the document, so every client cache and the server
 * data root start over.
 */
export class AuthenticatedWorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("Authenticated workspace failed:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        ref={(element) => element?.focus()}
        role="alert"
        aria-labelledby="workspace-error-heading"
        tabIndex={-1}
        className={styles.error}
      >
        <h2 id="workspace-error-heading">Something went wrong in your workspace</h2>
        <p>Retry to reopen your saved workspace. Unsaved changes may be lost.</p>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }
}
