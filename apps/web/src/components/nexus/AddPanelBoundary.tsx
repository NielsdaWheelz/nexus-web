"use client";

import { Component, createRef, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { AddDismissalDialog } from "./AddPanel";
import type { AddContentSessionController } from "./useAddContentSession";
import type { NexusController } from "./useNexusController";
import styles from "./AddPanel.module.css";

interface AddPanelBoundaryProps {
  activeDefect: boolean;
  resetKey: string;
  session: AddContentSessionController;
  controller: Pick<
    NexusController,
    "dismissalConfirmation" | "keepWorking" | "confirmDismissal"
  >;
  onClearDefect(): void;
  onDefect(error: unknown): void;
  children: ReactNode;
}

/**
 * A contract defect inside Add reads "Add needs attention" without losing the
 * session: Continue Add, or stop the active work and review its status.
 */
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
    const { activeDefect, resetKey } = this.props;
    if (
      this.state.hasError &&
      (previous.resetKey !== resetKey ||
        (previous.activeDefect && !activeDefect))
    ) {
      this.setState({ hasError: false });
      return;
    }
    if ((this.state.hasError || activeDefect) && !previous.activeDefect) {
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
    const { controller } = this.props;
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
        <AddDismissalDialog
          confirmation={controller.dismissalConfirmation}
          onKeepWorking={controller.keepWorking}
          onConfirm={controller.confirmDismissal}
        />
      </section>
    );
  }
}
