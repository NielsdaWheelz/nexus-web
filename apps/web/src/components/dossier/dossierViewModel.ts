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
  DossierPendingAction,
  DossierRevision,
  DossierRevisionSummary,
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
  | { kind: "StreamingDraft"; text: string };

/** The build-activity banner (independent of which revision the body shows). */
export type DossierActivityView =
  | { kind: "Idle" }
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
  /** Terminal build failure → visible alert + Retry, WITHOUT moving focus. */
  alert: { message: string; retry: boolean } | null;
  /** Synchronous command error attached near the invoked control. */
  actionError: string | null;
  history: readonly DossierRevisionSummary[];
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
  canMakeCurrent: false,
  historyAvailable: false,
  busy: null,
};

export function deriveDossierViewModel(
  state: DossierControllerState,
): DossierViewModel {
  const base = {
    mediaAbstract: null,
    statusMessage: null,
    alert: null,
    actionError: state.actionError ? state.actionError.message : null,
    history: [] as readonly DossierRevisionSummary[],
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
  const activePhase: DossierExecutionPhase | null =
    ready.activeBuild.kind === "Present" &&
    ready.activeBuild.value.execution.kind === "Present"
      ? ready.activeBuild.value.execution.value.phase
      : hasActive
        ? "Running"
        : null;
  const suspended = activePhase === "Suspended" || state.stream === "Suspended";
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
  } else if (hasActive) {
    body = { kind: "StreamingDraft", text: state.streamingDraft ?? "" };
  } else {
    body = { kind: "NeverGenerated" };
  }

  // --- Activity banner ----------------------------------------------------
  let activity: DossierActivityView;
  if (suspended) {
    activity = { kind: "Suspended" };
  } else if (hasActive) {
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
  const controls: DossierControls = {
    // Exactly one of Generate/Retry offered when there is no current revision;
    // Regenerate when a current revision exists. All unavailable while a build
    // is active or suspended (only Cancel then).
    canGenerate: !hasActive && !suspended && !hasCurrent && lub.kind === "Absent",
    canRetry: !hasActive && !suspended && !hasCurrent && lub.kind === "Present",
    canRegenerate: !hasActive && !suspended && hasCurrent,
    canCancel: hasActive,
    canMakeCurrent: makeCurrentTarget !== null,
    historyAvailable: ready.revisionCount > 1 || ready.history.length > 1,
    busy: state.pendingAction,
  };

  // --- Polite status + alert ---------------------------------------------
  let statusMessage: string | null = null;
  if (suspended) {
    statusMessage = "Generation stopped; it needs attention.";
  } else if (activity.kind === "Building") {
    statusMessage = activity.progress ?? "Generating the dossier…";
  } else if (activity.kind === "Cancelled") {
    statusMessage = "The last generation was canceled.";
  }

  const alert =
    activity.kind === "Failed"
      ? { message: activity.message, retry: true }
      : null;

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
