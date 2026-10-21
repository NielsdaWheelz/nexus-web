"use client";

import { Component, createRef, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import type { AddContentSessionController } from "./useAddContentSession";
import type { NexusController } from "./useNexusController";
import styles from "./AddPanel.module.css";

interface AddPanelBoundaryProps {
  activeDefect: boolean;
  resetKey: string;
  session: AddContentSessionController;
  controller: Pick<
    NexusController,
    "stopAddForReview"
  >;
  onClearDefect(): void;
  onDefect(error: unknown): void;
  children: ReactNode;
}

/**
 * A rendering defect leaves the session available for review and guarded exit.
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
    if (this.props.session.state.mutation.kind === "Running" && !this.props.controller.stopAddForReview()) return;
    this.props.onClearDefect();
  };

  render() {
    if (!this.state.hasError && !this.props.activeDefect) {
      return this.props.children;
    }
    const running = this.props.session.state.mutation.kind === "Running";
    return (
      <section
        className={styles.addDefectBody}
        aria-labelledby="add-defect-title"
      >
        <h2 id="add-defect-title" data-add-heading="true" tabIndex={-1}>
          add needs attention
        </h2>
        <p>
          {running
            ? "your items are still in this add session. stop the active work to review its status."
            : "your add session is still available. try returning to review it."}
        </p>
        <div className={styles.addDefectActions}>
          <Button
            ref={this.actionRef}
            variant={running ? "danger" : "primary"}
            size="sm"
            onClick={this.recover}
          >
            {running ? "stop and review status" : "continue add"}
          </Button>
        </div>
      </section>
    );
  }
}
