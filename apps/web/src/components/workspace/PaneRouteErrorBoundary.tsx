"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import styles from "./WorkspaceHost.module.css";

interface Props {
  paneId: string;
  visitId: string;
  resetKey: string;
  slotMinWidth: string;
  isActive: boolean;
  children: ReactNode;
}
interface State {
  failed: boolean;
  resetKey: string;
}

/** A pane that fails to render (or to load its chunk) fails alone. A class:
 *  React error boundaries need its lifecycle. */
export class PaneRouteErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };
  private region: HTMLElement | null = null;

  // A new route or visit clears the failure.
  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportClientDefect(error, {
      paneId: this.props.paneId,
      visitId: this.props.visitId,
      componentStack: info.componentStack ?? "",
    });
  }

  componentDidMount(): void {
    if (this.state.failed && this.props.isActive) this.region?.focus();
  }

  componentDidUpdate(_: Props, previous: State): void {
    if (!previous.failed && this.state.failed && this.props.isActive) {
      this.region?.focus();
    }
  }

  render() {
    const headingId = `pane-failure-heading-${this.props.paneId}`;
    return (
      <div
        className={styles.paneErrorBoundaryShell}
        data-pane-error-boundary-shell="true"
        style={{ minWidth: this.props.slotMinWidth }}
      >
        {this.state.failed ? (
          <section
            ref={(element) => {
              this.region = element;
            }}
            className={styles.paneFailure}
            role="alert"
            aria-labelledby={headingId}
            tabIndex={-1}
          >
            <h2 id={headingId}>This pane couldn’t load</h2>
            <p>Retry this pane. Your other panes are still available.</p>
            {/* the failed subtree is gone, so clearing the failure mounts it fresh */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => this.setState({ failed: false })}
            >
              Retry pane
            </Button>
          </section>
        ) : (
          <div className={styles.paneFailureRetryRoot}>{this.props.children}</div>
        )}
      </div>
    );
  }
}
