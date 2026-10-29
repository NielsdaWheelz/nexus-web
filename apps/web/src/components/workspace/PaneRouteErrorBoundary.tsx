"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { FeedbackState } from "@/components/feedback/Feedback";
import { isApiError, isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { PaneModuleLoadError } from "@/lib/panes/PaneModuleLoadError";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import styles from "./WorkspaceHost.module.css";

interface Props {
  paneId: string;
  visitId: string;
  resetKey: string;
  slotMinWidth: string;
  isActive: boolean;
  /** The pane's own Back, while it has history: a failed pane can still leave. */
  onBack: ((intent: OpenIntent) => void) | null;
  children: ReactNode;
}
interface State {
  failure: "StaleBuild" | "ModuleLoad" | "Defect" | null;
  requestId?: string;
  resetKey: string;
}

/** Expected read failures stay with their owners. This boundary contains defects; a new visit resets it. */
export class PaneRouteErrorBoundary extends Component<Props, State, boolean> {
  state: State = { failure: null, resetKey: this.props.resetKey };
  private region: HTMLElement | null = null;
  private shell: HTMLDivElement | null = null;

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { failure: null, requestId: undefined, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      failure: isStaleBuild(error) ? "StaleBuild" : error instanceof PaneModuleLoadError ? "ModuleLoad" : "Defect",
      requestId: isApiError(error) ? error.requestId : undefined,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isStaleBuild(error)) return;
    const original = error instanceof PaneModuleLoadError ? error.cause : error;
    console.error("pane failed:", original);
    reportClientDefect(original, {
      paneId: this.props.paneId,
      visitId: this.props.visitId,
      componentStack: info.componentStack ?? "",
    });
  }

  getSnapshotBeforeUpdate(_props: Props, previous: State): boolean {
    return !previous.failure && this.state.failure !== null && this.props.isActive
      && document.activeElement !== document.body && Boolean(this.shell?.contains(document.activeElement));
  }

  componentDidUpdate(_props: Props, _previous: State, removedOwnedFocus: boolean): void {
    if (!removedOwnedFocus || !this.props.isActive || hasActiveInteractionOwner()) return;
    const current = document.activeElement;
    if (current !== document.body && current?.isConnected) return;
    this.region?.focus({ preventScroll: true });
  }

  render() {
    const { failure } = this.state;
    const content = failure === "StaleBuild" ? STALE_BUILD_FEEDBACK : {
      tone: "Danger" as const,
      title: failure === "ModuleLoad" ? "this pane couldn’t open" : "this pane stopped unexpectedly",
      message: failure === "ModuleLoad"
        ? "reload the app to open it again. tab-only edits may be lost."
        : "this pane needs a fix before it can continue.",
      requestId: this.state.requestId,
    };
    const back = this.props.onBack ? { label: "go back", onClick: this.props.onBack } : undefined;
    const reload = { label: "reload app", onClick: () => window.location.reload() };
    return <div
      ref={element => { this.shell = element; }}
      className={styles.paneErrorBoundaryShell}
      data-pane-error-boundary-shell="true"
      style={{ minWidth: this.props.slotMinWidth }}
    >
      {failure ? <section
        ref={(element) => { this.region = element; }}
        className={styles.paneFailure}
        role={this.props.isActive ? "alert" : undefined}
        aria-label={content.title}
        tabIndex={-1}
      >
        <FeedbackState
          content={content}
          announcement="None"
          actions={failure !== "ModuleLoad" ? back && [back] : back ? [reload, back] : [reload]}
        />
      </section> : <div className={styles.paneContent}>{this.props.children}</div>}
    </div>;
  }
}
