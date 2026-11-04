"use client";

import { Component, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { Fact } from "@/components/feedback/Fact";
import type { Verb, Verbs } from "@/components/feedback/stage";
import { isStaleBuild } from "@/lib/api/client";
import { staleBuild } from "@/lib/api/failure";
import { subscribeAdmission, updateRemedy } from "@/lib/native/admission";
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
  resetKey: string;
}

const RELOAD: Verb = { label: "reload", commandKey: "Reload", run: () => window.location.reload() };

/** A failed pane's one fact. A stale build's follows the remedy as it changes: reload is offered
 * only while reload can replace the build. */
function PaneFailure({ failure, onBack, speak, bindRegion }: {
  failure: NonNullable<State["failure"]>;
  onBack: Props["onBack"];
  speak: boolean;
  bindRegion: (element: HTMLElement | null) => void;
}) {
  const remedy = useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const back: Verb | null = onBack ? { label: "go back", commandKey: "GoBack", run: onBack } : null;
  const fact = failure === "StaleBuild" ? staleBuild() : failure === "ModuleLoad" ? "couldn’t open this pane." : "this pane stopped unexpectedly.";
  const verbs: Verbs | undefined = failure === "StaleBuild" ? remedy === "Reload" ? [RELOAD] : undefined
    : failure === "ModuleLoad" ? back ? [RELOAD, back] : [RELOAD]
    : back ? [back, RELOAD] : [RELOAD];
  return <section ref={bindRegion} className={styles.paneFailure} aria-label={fact} tabIndex={-1}>
    <Fact line={{ fact }} verbs={verbs} speak={speak} />
  </section>;
}

/** Expected read failures stay with their owners. This boundary contains defects; a new visit
 * resets it. A stale build offers reload alone, and only where reload can replace it. */
export class PaneRouteErrorBoundary extends Component<Props, State, boolean> {
  state: State = { failure: null, resetKey: this.props.resetKey };
  private region: HTMLElement | null = null;
  private shell: HTMLDivElement | null = null;

  static getDerivedStateFromProps(props: Props, state: State) {
    return props.resetKey === state.resetKey
      ? null
      : { failure: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown) {
    return { failure: isStaleBuild(error) ? "StaleBuild" : error instanceof PaneModuleLoadError ? "ModuleLoad" : "Defect" };
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
    return <div
      ref={element => { this.shell = element; }}
      className={styles.paneErrorBoundaryShell}
      data-pane-error-boundary-shell="true"
      style={{ minWidth: this.props.slotMinWidth }}
    >
      {failure ? <PaneFailure failure={failure} onBack={this.props.onBack} speak={this.props.isActive}
        bindRegion={element => { this.region = element; }} /> : <div className={styles.paneContent}>{this.props.children}</div>}
    </div>;
  }
}
