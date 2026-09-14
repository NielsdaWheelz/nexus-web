"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import styles from "./WorkspaceHost.module.css";

interface PaneRouteErrorBoundaryProps {
  children: ReactNode;
  paneId: string;
  visitId: string;
  resetKey: string;
  slotMinWidth: string;
  isActive: boolean;
}

/** Contains a routed-pane render failure without disturbing sibling panes.
 *  This remains a class because React error boundaries require its lifecycle. */
export class PaneRouteErrorBoundary extends Component<
  PaneRouteErrorBoundaryProps,
  { hasError: boolean; resetKey: string; retryKey: number }
> {
  private failureRegion: HTMLElement | null = null;

  constructor(props: PaneRouteErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, resetKey: props.resetKey, retryKey: 0 };
  }

  static getDerivedStateFromProps(
    props: PaneRouteErrorBoundaryProps,
    state: { hasError: boolean; resetKey: string; retryKey: number },
  ): { hasError: false; resetKey: string; retryKey: number } | null {
    // A route/visit change clears the error latch but preserves the retry key:
    // only an explicit retry remounts the routed pane subtree.
    return props.resetKey === state.resetKey
      ? null
      : { hasError: false, resetKey: props.resetKey, retryKey: state.retryKey };
  }

  static getDerivedStateFromError(): { hasError: true } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    reportClientDefect(error, {
      scope: "Pane",
      paneId: this.props.paneId,
      visitId: this.props.visitId,
      componentStack: errorInfo.componentStack ?? "",
    });
  }

  componentDidMount(): void {
    if (this.state.hasError && this.props.isActive) this.failureRegion?.focus();
  }

  componentDidUpdate(
    _previousProps: PaneRouteErrorBoundaryProps,
    previousState: { hasError: boolean; resetKey: string; retryKey: number },
  ): void {
    if (!previousState.hasError && this.state.hasError && this.props.isActive) {
      this.failureRegion?.focus();
    }
  }

  private retry = (): void => {
    this.setState((state) => ({
      hasError: false,
      resetKey: state.resetKey,
      retryKey: state.retryKey + 1,
    }));
  };

  render() {
    return (
      <div
        className={styles.paneErrorBoundaryShell}
        data-pane-error-boundary-shell="true"
        data-testid={`pane-error-boundary-${this.props.paneId}`}
        style={{ minWidth: this.props.slotMinWidth }}
      >
        {this.state.hasError ? (
          <section
            ref={(element) => {
              this.failureRegion = element;
            }}
            className={styles.paneFailure}
            role="alert"
            aria-labelledby={`pane-failure-heading-${this.props.paneId}`}
            tabIndex={-1}
          >
            <h2 id={`pane-failure-heading-${this.props.paneId}`}>
              This pane couldn’t load
            </h2>
            <p>Retry this pane. Your other panes are still available.</p>
            <Button variant="secondary" size="sm" onClick={this.retry}>
              Retry pane
            </Button>
          </section>
        ) : (
          <div
            key={this.state.retryKey}
            className={styles.paneFailureRetryRoot}
          >
            {this.props.children}
          </div>
        )}
      </div>
    );
  }
}
