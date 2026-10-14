"use client";

import { Component, type ReactNode } from "react";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects. Expected bootstrap transport failures are handled before this boundary.
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

  private focusDisplaced = (element: HTMLElement | null) => {
    if (element && (document.activeElement === null || document.activeElement === document.body)) {
      element.focus({ preventScroll: true });
    }
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main
        ref={this.focusDisplaced}
        role="alert"
        aria-labelledby="workspace-error-heading"
        tabIndex={-1}
        className={styles.error}
      >
        <h1 id="workspace-error-heading">something went wrong in the workspace</h1>
        <p>nexus needs a fix before this can continue.</p>
      </main>
    );
  }
}
