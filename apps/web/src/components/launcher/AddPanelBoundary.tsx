"use client";

import { Component, createRef, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import type { AddContentSessionController } from "./useAddContentSession";
import type { LauncherController } from "./useLauncherController";
import styles from "./launcher.module.css";

interface AddPanelBoundaryProps {
  activeDefect: boolean;
  resetKey: string;
  session: AddContentSessionController;
  controller: Pick<
    LauncherController,
    "dismissalConfirmation" | "keepWorking" | "confirmDismissal"
  >;
  onClearDefect(): void;
  onDefect(error: unknown): void;
  children: ReactNode;
}

export default class AddPanelBoundary extends Component<
  AddPanelBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };
  private readonly actionRef = createRef<HTMLButtonElement>();

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  componentDidUpdate(previous: AddPanelBoundaryProps) {
    if (
      this.state.hasError &&
      (previous.resetKey !== this.props.resetKey ||
        (previous.activeDefect && !this.props.activeDefect))
    ) {
      this.setState({ hasError: false });
      return;
    }
    if (
      (this.state.hasError || this.props.activeDefect) &&
      !previous.activeDefect
    ) {
      this.actionRef.current?.focus();
    }
  }

  private recover = () => {
    this.props.controller.keepWorking();
    if (this.props.session.state.mutation.kind === "Running") {
      this.props.session.stop();
    }
    this.props.onClearDefect();
  };

  render() {
    if (!this.state.hasError && !this.props.activeDefect) {
      return this.props.children;
    }
    const running = this.props.session.state.mutation.kind === "Running";
    const confirmation = this.props.controller.dismissalConfirmation;
    return (
      <section
        className={styles.addDefectBody}
        aria-labelledby="add-defect-title"
      >
        <h2 id="add-defect-title" data-add-heading="true" tabIndex={-1}>
          Add needs attention
        </h2>
        <p>
          {running
            ? "Nexus preserved the accepted source identity. Stop the active work to review its status."
            : "Nexus preserved your Add work after an internal contract error."}
        </p>
        <div className={styles.addDefectActions}>
          <Button
            ref={this.actionRef}
            variant={running ? "danger" : "primary"}
            size="sm"
            onClick={this.recover}
          >
            {running ? "Stop and review status" : "Continue Add"}
          </Button>
        </div>

        <Dialog
          open={confirmation !== null}
          title={
            confirmation?.kind === "Stop"
              ? "Stop active work?"
              : "Discard unfinished work?"
          }
          onClose={this.props.controller.keepWorking}
        >
          {confirmation ? (
            <div className={styles.addDefectBody}>
              <p>
                {confirmation.kind === "Stop"
                  ? "Server changes that already committed may remain; unfinished upload bytes may not."
                  : "Unsubmitted sources and unresolved outcomes will be lost."}
              </p>
              <div className={styles.addDefectActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={this.props.controller.keepWorking}
                >
                  Keep working
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={this.props.controller.confirmDismissal}
                >
                  {confirmation.actionLabel}
                </Button>
              </div>
            </div>
          ) : null}
        </Dialog>
      </section>
    );
  }
}
