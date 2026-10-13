"use client";

import { Component, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { isStaleBuild, STALE_BUILD_COPY } from "@/lib/api/client";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects, and a stale build's 426 (the update copy and a reload; not a
 * defect). Expected bootstrap transport failures are handled before this
 * boundary. #entry-failure is the notice return-focus target, shared with root
 * containment.
 */
export class AuthenticatedWorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; stale: boolean }
> {
  state = { failed: false, stale: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, stale: isStaleBuild(error) };
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
        id="entry-failure"
        ref={this.focusDisplaced}
        role="alert"
        aria-labelledby="workspace-error-heading"
        tabIndex={-1}
        className={styles.error}
      >
        <h1 id="workspace-error-heading">something went wrong in the workspace</h1>
        {this.state.stale ? (
          <>
            <p>{STALE_BUILD_COPY}</p>
            <Button onClick={() => window.location.reload()}>reload</Button>
          </>
        ) : (
          <p>nexus needs a fix before this can continue.</p>
        )}
      </main>
    );
  }
}
