"use client";

import { Component, type ReactNode } from "react";
import { FeedbackState } from "@/components/feedback/Feedback";
import { ActivityControl } from "@/components/feedback/Activity";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
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
        aria-label="workspace stopped"
        tabIndex={-1}
        className={styles.error}
      >
        <div role="alert">
          <FeedbackState
            content={this.state.stale ? STALE_BUILD_FEEDBACK : {
              tone: "Danger",
              title: "the workspace stopped unexpectedly",
              message: "nexus needs a fix before this can continue.",
            }}
            announcement="None"
          />
        </div>
        <ActivityControl iconOnly={false} />
      </main>
    );
  }
}
