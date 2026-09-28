// The ONE exhaustive view-model helper (A14/A15): a pure function from the
// controller snapshot to the valid visual states of the Dossier surface. It
// never encodes absence as booleans and never flattens `Presence` — it switches
// over the closed A15 unions and derives an equally-closed presentation model,
// so `DossierSurface` renders without ad-hoc `?.`/truthiness ladders and this
// core is unit-testable in isolation.
import { dossierBuildFailureMessage } from "@/lib/dossiers/dossierErrorMessage";
import type { DurableExecutionPhase } from "@/lib/api/executionAdvisory";
import type { Schema } from "@/lib/api/wire";
import type {
  DossierControllerState,
  DossierPendingAction,
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
      revision: Schema<"DossierRevisionOut">;
      stale: boolean;
    }
  | {
      kind: "Building";
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

/** The build-activity banner (independent of the body). */
export type DossierActivityView =
  | { kind: "Idle" }
  | { kind: "Connecting" }
  | { kind: "Reconnecting" }
  | { kind: "Disconnected" }
  | {
      kind: "Building";
      phase: DurableExecutionPhase;
      regenerating: boolean;
      progress: string | null;
    }
  | { kind: "Suspended" }
  /** Codex quota parked the admission durably (spec 3.4); cancel stays available. */
  | { kind: "CapacityPaused"; pause: Schema<"CapacityPaused"> }
  | { kind: "Failed"; code: Schema<"DossierBuildFailureCode">; message: string }
  | { kind: "Cancelled" };

interface DossierControls {
  canGenerate: boolean;
  canRegenerate: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canReconnect: boolean;
  busy: DossierPendingAction;
}

export interface DossierViewModel {
  body: DossierBodyView;
  activity: DossierActivityView;
  controls: DossierControls;
  mediaAbstract: MediaAbstract | null;
  /** Read-only admitted selection and tool plan of the build the activity
   * concerns (active, else the latest unsuccessful); never a control. */
  generationDetail: Schema<"DossierBuildAdmittedGenerationOut"> | null;
  /** One polite status-region line (progress / suspended / cancellation). */
  statusMessage: string | null;
  /** Terminal build failure → visible alert, WITHOUT moving focus. */
  alert: { message: string } | null;
  /** Synchronous command error attached near the invoked control. */
  actionError: string | null;
}

const NO_CONTROLS: DossierControls = {
  canGenerate: false,
  canRegenerate: false,
  canCancel: false,
  canRetry: false,
  canReconnect: false,
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
        code: outcome.facts.failure_code,
        message: dossierBuildFailureMessage(outcome.facts.failure_code),
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
    generationDetail: null,
    statusMessage: null,
    alert: null,
    actionError: state.actionError ? state.actionError.message : null,
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
  const hasCurrent = ready.current_revision.kind === "Present";
  const hasActive = ready.active_build.kind === "Present";
  const terminalStream = state.stream.kind === "Terminal" ? state.stream : null;
  const terminalOutcome =
    terminalStream && !terminalStream.reconciled
      ? terminalStream.outcome
      : null;
  const hasTerminalOutcome = terminalOutcome !== null;
  const hasEffectiveActive = hasActive && !hasTerminalOutcome;
  const activePhase: DurableExecutionPhase | null =
    ready.active_build.kind === "Present" &&
    ready.active_build.value.execution.kind === "Present"
      ? ready.active_build.value.execution.value.phase
      : hasActive
        ? "Running"
        : null;
  const suspended =
    hasEffectiveActive &&
    (activePhase === "Suspended" || state.stream.kind === "Suspended");
  const capacityPause: Schema<"CapacityPaused"> | null =
    hasEffectiveActive &&
    ready.active_build.kind === "Present" &&
    ready.active_build.value.capacity_pause.kind === "Present"
      ? ready.active_build.value.capacity_pause.value
      : null;
  const lub = ready.latest_unsuccessful_build;
  const failureFacts =
    lub.kind === "Present" && lub.value.failure.kind === "Present"
      ? lub.value.failure.value
      : null;
  const cancelledFacts =
    lub.kind === "Present" && lub.value.cancellation.kind === "Present"
      ? lub.value.cancellation.value
      : null;

  // --- Body ---------------------------------------------------------------
  // The current revision outranks Building: it stays readable while a
  // regenerate runs.
  let body: DossierBodyView;
  if (ready.current_revision.kind === "Present") {
    body = {
      kind: "Revision",
      revision: ready.current_revision.value,
      stale: ready.freshness.kind === "Present" && ready.freshness.value === "Stale",
    };
  } else if (terminalOutcome !== null) {
    body = {
      kind: "TerminalOutcome",
      outcome: terminalBodyOutcome(terminalOutcome),
    };
  } else if (hasEffectiveActive) {
    body = {
      kind: "Building",
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
  } else if (capacityPause !== null) {
    // The durable wait outranks transport liveness: no worker is generating.
    activity = { kind: "CapacityPaused", pause: capacityPause };
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
    };
  } else if (failureFacts) {
    activity = {
      kind: "Failed",
      code: failureFacts.failure_code,
      message: dossierBuildFailureMessage(failureFacts.failure_code),
    };
  } else if (cancelledFacts) {
    activity = { kind: "Cancelled" };
  } else {
    activity = { kind: "Idle" };
  }

  // --- Controls -----------------------------------------------------------
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
    busy: state.pendingAction,
  };

  // --- Polite status + alert ---------------------------------------------
  let statusMessage: string | null = null;
  if (terminalStream?.outcome.kind === "Succeeded") {
    statusMessage = "Dossier generated.";
  } else if (suspended) {
    statusMessage = "Generation stopped; it needs attention.";
  } else if (activity.kind === "CapacityPaused") {
    statusMessage = "Waiting for Codex capacity";
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

  // --- Read-only generation detail (spec 3.4, AC 15) ----------------------
  const detailBuild =
    hasEffectiveActive && ready.active_build.kind === "Present"
      ? ready.active_build.value
      : !hasEffectiveActive &&
          lub.kind === "Present" &&
          (failureFacts !== null || cancelledFacts !== null)
        ? lub.value
        : null;
  const generationDetail =
    detailBuild !== null && detailBuild.admitted_generation.kind === "Present"
      ? detailBuild.admitted_generation.value
      : null;

  return {
    body,
    activity,
    controls,
    mediaAbstract:
      ready.media_abstract.kind === "Present" ? ready.media_abstract.value : null,
    generationDetail,
    statusMessage,
    alert,
    actionError: base.actionError,
  };
}
