// The ONE exhaustive view-model helper (A14/A15): a pure function from the
// controller snapshot to the valid visual states of the Dossier surface. It
// never encodes absence as booleans and never flattens `Presence` — it switches
// over the closed A15 unions and derives an equally-closed presentation model,
// so `DossierSurface` renders without ad-hoc `?.`/truthiness ladders and this
// core is unit-testable in isolation.
import { dossierBuildFailureMessage } from "@/lib/dossiers/dossierErrorMessage";
import type {
  DossierBuildFailureCode,
  DossierControllerState,
  DossierExecutionPhase,
  DossierFreshness,
  DossierHistoryStatus,
  DossierPendingAction,
  DossierRevision,
  DossierRevisionSummary,
  DossierTerminalOutcome,
  MediaAbstract,
} from "@/lib/dossiers/dossierControllerTypes";

/** What occupies the reading area. */
export type DossierBodyView =
  | { kind: "HeadLoading" }
  | { kind: "HeadFailed"; message: string }
  | { kind: "NeverGenerated" }
  | {
      kind: "Revision";
      revision: DossierRevision;
      provenance: "current" | "historical";
      freshness: DossierFreshness | null;
    }
  | { kind: "HistoricalLoading" }
  | { kind: "HistoricalFailed"; message: string }
  | {
      kind: "StreamingDraft";
      text: string;
      liveness:
        | "connecting"
        | "reconnecting"
        | "disconnected"
        | "suspended"
        | "live";
    }
  | {
      kind: "TerminalOutcome";
      outcome: "succeeded" | "failed" | "cancelled";
    };

/** The build-activity banner (independent of which revision the body shows). */
export type DossierActivityView =
  | { kind: "Idle" }
  | { kind: "Connecting" }
  | { kind: "Reconnecting" }
  | { kind: "Disconnected" }
  | {
      kind: "Building";
      phase: DossierExecutionPhase;
      regenerating: boolean;
      progress: string | null;
      draft: string | null;
    }
  | { kind: "Suspended" }
  | { kind: "Failed"; code: DossierBuildFailureCode; message: string }
  | { kind: "Cancelled" };

export interface DossierControls {
  canGenerate: boolean;
  canRegenerate: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canReconnect: boolean;
  canMakeCurrent: boolean;
  /** History arrows / list are VIEW-ONLY (A15). */
  historyAvailable: boolean;
  busy: DossierPendingAction;
}

export interface DossierViewModel {
  body: DossierBodyView;
  activity: DossierActivityView;
  controls: DossierControls;
  mediaAbstract: MediaAbstract | null;
  /** One polite status-region line (progress / suspended / cancellation). */
  statusMessage: string | null;
  /** Terminal build failure → visible alert, WITHOUT moving focus. */
  alert: { message: string } | null;
  /** Synchronous command error attached near the invoked control. */
  actionError: string | null;
  history: readonly DossierRevisionSummary[];
  historyStatus: DossierHistoryStatus;
  revisionCount: number;
  viewingHistorical: boolean;
  /** The revision the Make-current control acts on, when viewing a historical. */
  makeCurrentTargetRef: string | null;
  /** The revision the body currently shows (historical selection, else the
   * current revision) — anchors the view-only history arrows. */
  selectedRevisionRef: string | null;
}

const NO_CONTROLS: DossierControls = {
  canGenerate: false,
  canRegenerate: false,
  canCancel: false,
  canRetry: false,
  canReconnect: false,
  canMakeCurrent: false,
  historyAvailable: false,
  busy: null,
};

function terminalBodyOutcome(
  outcome: DossierTerminalOutcome,
): Extract<DossierBodyView, { kind: "TerminalOutcome" }>["outcome"] {
  switch (outcome.kind) {
    case "Succeeded":
      return "succeeded";
    case "Failed":
      return "failed";
    case "Cancelled":
      return "cancelled";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled terminal outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function terminalActivity(
  outcome: DossierTerminalOutcome,
): DossierActivityView {
  switch (outcome.kind) {
    case "Succeeded":
      return { kind: "Idle" };
    case "Failed":
      return {
        kind: "Failed",
        code: outcome.facts.failureCode,
        message: dossierBuildFailureMessage(outcome.facts.failureCode),
      };
    case "Cancelled":
      return { kind: "Cancelled" };
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled terminal outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function deriveDossierViewModel(
  state: DossierControllerState,
): DossierViewModel {
  const base = {
    mediaAbstract: null,
    statusMessage: null,
    alert: null,
    actionError: state.actionError ? state.actionError.message : null,
    history: [] as readonly DossierRevisionSummary[],
    historyStatus: "idle" as const,
    revisionCount: 0,
    viewingHistorical: state.revisionSelection.kind === "Historical",
    makeCurrentTargetRef: null,
    selectedRevisionRef:
      state.revisionSelection.kind === "Historical"
        ? state.revisionSelection.revisionRef
        : null,
  } satisfies Omit<DossierViewModel, "body" | "activity" | "controls">;

  if (state.head.kind === "Idle" || state.head.kind === "Loading") {
    return {
      ...base,
      body: { kind: "HeadLoading" },
      activity: { kind: "Idle" },
      controls: NO_CONTROLS,
    };
  }
  if (state.head.kind === "Failed") {
    return {
      ...base,
      body: { kind: "HeadFailed", message: state.head.error.message },
      activity: { kind: "Idle" },
      controls: NO_CONTROLS,
    };
  }

  const ready = state.head.ready;
  const hasCurrent = ready.currentRevision.kind === "Present";
  const hasActive = ready.activeBuild.kind === "Present";
  const terminalStream = state.stream.kind === "Terminal" ? state.stream : null;
  const terminalOutcome =
    terminalStream && !terminalStream.reconciled
      ? terminalStream.outcome
      : null;
  const hasTerminalOutcome = terminalOutcome !== null;
  const hasEffectiveActive = hasActive && !hasTerminalOutcome;
  const activePhase: DossierExecutionPhase | null =
    ready.activeBuild.kind === "Present" &&
    ready.activeBuild.value.execution.kind === "Present"
      ? ready.activeBuild.value.execution.value.phase
      : hasActive
        ? "Running"
        : null;
  const suspended =
    hasEffectiveActive &&
    (activePhase === "Suspended" || state.stream.kind === "Suspended");
  const lub = ready.latestUnsuccessfulBuild;
  const failureFacts =
    lub.kind === "Present" && lub.value.failure.kind === "Present"
      ? lub.value.failure.value
      : null;
  const cancelledFacts =
    lub.kind === "Present" && lub.value.cancellation.kind === "Present"
      ? lub.value.cancellation.value
      : null;

  // --- Body ---------------------------------------------------------------
  let body: DossierBodyView;
  if (state.revisionSelection.kind === "Historical") {
    switch (state.historicalRevision.kind) {
      case "Ready":
        body = {
          kind: "Revision",
          revision: state.historicalRevision.revision,
          provenance: "historical",
          freshness: null,
        };
        break;
      case "Failed":
        body = { kind: "HistoricalFailed", message: state.historicalRevision.error.message };
        break;
      case "Loading":
      case "Idle":
        body = { kind: "HistoricalLoading" };
        break;
    }
  } else if (ready.currentRevision.kind === "Present") {
    body = {
      kind: "Revision",
      revision: ready.currentRevision.value,
      provenance: "current",
      freshness: ready.freshness.kind === "Present" ? ready.freshness.value : null,
    };
  } else if (terminalOutcome !== null) {
    body = {
      kind: "TerminalOutcome",
      outcome: terminalBodyOutcome(terminalOutcome),
    };
  } else if (hasEffectiveActive) {
    body = {
      kind: "StreamingDraft",
      text: state.streamingDraft ?? "",
      liveness:
        suspended
          ? "suspended"
          : state.stream.kind === "Connecting"
            ? "connecting"
            : state.stream.kind === "Reconnecting"
              ? "reconnecting"
              : state.stream.kind === "Disconnected"
                ? "disconnected"
                : "live",
    };
  } else {
    body = { kind: "NeverGenerated" };
  }

  // --- Activity banner ----------------------------------------------------
  let activity: DossierActivityView;
  if (terminalOutcome !== null) {
    activity = terminalActivity(terminalOutcome);
  } else if (suspended) {
    activity = { kind: "Suspended" };
  } else if (hasEffectiveActive && state.stream.kind === "Connecting") {
    activity = { kind: "Connecting" };
  } else if (hasEffectiveActive && state.stream.kind === "Reconnecting") {
    activity = { kind: "Reconnecting" };
  } else if (hasEffectiveActive && state.stream.kind === "Disconnected") {
    activity = { kind: "Disconnected" };
  } else if (hasEffectiveActive) {
    activity = {
      kind: "Building",
      phase: activePhase ?? "Running",
      regenerating: hasCurrent,
      progress: state.progressMessage,
      draft: state.streamingDraft,
    };
  } else if (failureFacts) {
    activity = {
      kind: "Failed",
      code: failureFacts.failureCode,
      message: dossierBuildFailureMessage(failureFacts.failureCode),
    };
  } else if (cancelledFacts) {
    activity = { kind: "Cancelled" };
  } else {
    activity = { kind: "Idle" };
  }

  // --- Controls -----------------------------------------------------------
  const viewingHistorical = state.revisionSelection.kind === "Historical";
  const makeCurrentTarget =
    viewingHistorical &&
    state.historicalRevision.kind === "Ready" &&
    !state.historicalRevision.revision.isCurrent
      ? state.historicalRevision.revision.revisionRef
      : null;
  const hasRetryableOutcome =
    terminalOutcome?.kind === "Failed" ||
    terminalOutcome?.kind === "Cancelled" ||
    lub.kind === "Present";
  const controls: DossierControls = {
    // Exactly one generation action is offered. An observed terminal always
    // outranks a stale active-build head while its reconciliation read runs.
    canGenerate:
      !hasEffectiveActive &&
      !suspended &&
      !hasCurrent &&
      !hasRetryableOutcome &&
      terminalOutcome === null,
    canRetry: !hasEffectiveActive && !suspended && hasRetryableOutcome,
    canReconnect:
      (hasEffectiveActive && state.stream.kind === "Disconnected") ||
      terminalOutcome?.kind === "Succeeded",
    canRegenerate:
      !hasEffectiveActive &&
      !suspended &&
      hasCurrent &&
      !hasRetryableOutcome &&
      terminalOutcome === null,
    canCancel: hasEffectiveActive,
    canMakeCurrent: makeCurrentTarget !== null,
    historyAvailable: ready.revisionCount > 1 || ready.history.length > 1,
    busy: state.pendingAction,
  };

  // --- Polite status + alert ---------------------------------------------
  let statusMessage: string | null = null;
  if (terminalStream?.outcome.kind === "Succeeded") {
    statusMessage = "Dossier generated.";
  } else if (suspended) {
    statusMessage = "Generation stopped; it needs attention.";
  } else if (activity.kind === "Connecting") {
    statusMessage = "Connecting to dossier generation…";
  } else if (activity.kind === "Reconnecting") {
    statusMessage = "Reconnecting to dossier generation…";
  } else if (activity.kind === "Disconnected") {
    statusMessage =
      "Live updates disconnected; generation may still be running.";
  } else if (activity.kind === "Building") {
    statusMessage = activity.progress ?? "Generating the dossier…";
  } else if (activity.kind === "Cancelled") {
    statusMessage = "The last generation was canceled.";
  } else if (state.stream.kind === "Terminal" && state.progressMessage) {
    statusMessage = state.progressMessage;
  }

  const alert = activity.kind === "Failed" ? { message: activity.message } : null;

  return {
    body,
    activity,
    controls,
    mediaAbstract:
      ready.mediaAbstract.kind === "Present" ? ready.mediaAbstract.value : null,
    statusMessage,
    alert,
    actionError: base.actionError,
    history: ready.history,
    historyStatus: ready.historyStatus,
    revisionCount: ready.revisionCount,
    viewingHistorical,
    makeCurrentTargetRef: makeCurrentTarget,
    selectedRevisionRef: viewingHistorical
      ? base.selectedRevisionRef
      : ready.currentRevision.kind === "Present"
        ? ready.currentRevision.value.revisionRef
        : null,
  };
}
