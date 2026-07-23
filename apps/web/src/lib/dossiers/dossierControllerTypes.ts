// The decoded, owned Dossier controller value types (CONTRACTS.md A15). These
// mirror the backend read models in `python/nexus/schemas/artifact.py`
// (DossierHeadOut / DossierRevisionOut / DossierBuildSummary / MediaAbstractOut)
// as owned frontend values: absence is the repository-wide `Presence<T>`
// encoding (never `null`/boolean-flattened), and every multi-state axis is a
// closed discriminated union so the view-model can switch exhaustively.
//
// A15 controller unions (implemented EXACTLY):
//   head = Idle | Loading | Failed{error} | Ready{ current_revision, freshness,
//     active_build{execution}, latest_unsuccessful_build, history }
//   revision_selection = Current | Historical{revision_ref}
//   historical_revision = Idle | Loading | Ready{revision} | Failed{error}
//   stream = Disconnected | Connecting | Live | Reconnecting | Suspended | Terminal
import type { CitationOut } from "@/lib/conversations/citationOut";
import type { Presence } from "@/lib/api/presence";

/** A9/A15 head-read freshness label (binding `manifests_equal` summary). */
export type DossierFreshness = "Current" | "Stale";

/** A8 advisory-only execution liveness for an active build. */
export type DossierExecutionPhase =
  | "Queued"
  | "Running"
  | "Recovering"
  | "Suspended";

/** A7 closed failure codes (mirrors `DossierBuildFailureCode` StrEnum). */
export type DossierBuildFailureCode =
  | "NoSourceMaterial"
  | "InputsChanged"
  | "DependencyProjectionFailed"
  | "EntitlementDenied"
  | "BudgetExceeded"
  | "ContextTooLarge"
  | "ProviderRefused"
  | "ProviderIncomplete"
  | "SchemaRepairExhausted"
  | "CitationValidationFailed"
  | "MigratedFailure"
  | "MigratedIncomplete";

export const DOSSIER_BUILD_FAILURE_CODES: readonly DossierBuildFailureCode[] = [
  "NoSourceMaterial",
  "InputsChanged",
  "DependencyProjectionFailed",
  "EntitlementDenied",
  "BudgetExceeded",
  "ContextTooLarge",
  "ProviderRefused",
  "ProviderIncomplete",
  "SchemaRepairExhausted",
  "CitationValidationFailed",
  "MigratedFailure",
  "MigratedIncomplete",
];

/** A decoded same-system API/transport error, kept near the screen boundary
 * for `dossierErrorMessage`. `code` is the `ApiError.code`; `message` the
 * backend-authored human message (used as the exhaustive-map fallback). */
export interface DossierErrorInfo {
  code: string;
  message: string;
}

/** The typed, binding-owned input manifest (A21). Kept intentionally loose on
 * the frontend — only the discriminant + version are load-bearing here; full
 * per-binding coverage rendering is deferred to the domain surfaces. */
export interface DossierInputManifest {
  version: string;
  kind: string;
  [field: string]: unknown;
}

/** One immutable, citation-bearing revision (DossierRevisionOut). */
export interface DossierRevision {
  artifactId: string;
  artifactRef: string;
  revisionId: string;
  revisionRef: string;
  isCurrent: boolean;
  contentMd: string;
  citations: readonly CitationOut[];
  inputManifest: DossierInputManifest;
  instruction: Presence<string>;
  createdAt: string;
  promotedAt: Presence<string>;
}

/** One `GET /artifacts/{ref}/revisions` list item (DossierRevisionSummaryOut).
 * Carries NO body — the head-read boundary keeps historical bodies out of the
 * list; the single-revision fetch supplies `content_md`. */
export interface DossierRevisionSummary {
  revisionId: string;
  revisionRef: string;
  isCurrent: boolean;
  citationCount: number;
  instruction: Presence<string>;
  createdAt: string;
  promotedAt: Presence<string>;
}

/** Failed{code, detail/support} facts, shared by the head snapshot and the SSE
 * `Failed` event (one shape for one fact). */
export interface DossierFailedFacts {
  failureCode: DossierBuildFailureCode;
  detail: Presence<string>;
  support: Presence<Record<string, unknown>>;
}

/** Cancelled{actor, time} facts. */
export interface DossierCancelledFacts {
  actor: Presence<string>;
  at: string;
}

/** One build attempt's identity (DossierBuildSummary). Serves both
 * `active_build` (only `execution` Present) and `latest_unsuccessful_build`
 * (exactly one of `failure`/`cancellation` Present). */
export interface DossierBuildSummary {
  handle: string;
  requesterUserId: Presence<string>;
  instruction: Presence<string>;
  createdAt: string;
  execution: Presence<{ phase: DossierExecutionPhase }>;
  failure: Presence<DossierFailedFacts>;
  cancellation: Presence<DossierCancelledFacts>;
}

/** A11 Media Abstract (Media Dossier only): compact, read-only, current-only. */
export type MediaAbstract =
  | { kind: "Building" }
  | { kind: "Ready"; summaryMd: string }
  | { kind: "Stale"; summaryMd: string }
  | { kind: "Failed" }
  | { kind: "NotAvailable" };

export type DossierHistoryStatus = "idle" | "loading" | "ready" | "failed";

/** The `Ready` head fields (A9 shape) plus the separately-fetched `history`
 * list (A15 folds `history` into Ready even though the head read omits bodies;
 * the controller fills it from `GET /artifacts/{ref}/revisions`). Absent
 * `artifact_id`/`current_revision` is the legitimate "never generated" state. */
export interface DossierHeadReady {
  artifactId: Presence<string>;
  artifactRef: Presence<string>;
  currentRevision: Presence<DossierRevision>;
  freshness: Presence<DossierFreshness>;
  activeBuild: Presence<DossierBuildSummary>;
  latestUnsuccessfulBuild: Presence<DossierBuildSummary>;
  revisionCount: number;
  mediaAbstract: Presence<MediaAbstract>;
  history: readonly DossierRevisionSummary[];
  historyStatus: DossierHistoryStatus;
}

export type DossierHead =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Failed"; error: DossierErrorInfo }
  | { kind: "Ready"; ready: DossierHeadReady };

export type DossierRevisionSelection =
  | { kind: "Current" }
  | { kind: "Historical"; revisionRef: string };

export type DossierHistoricalRevision =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Ready"; revision: DossierRevision }
  | { kind: "Failed"; error: DossierErrorInfo };

export type DossierStream =
  | "Disconnected"
  | "Connecting"
  | "Live"
  | "Reconnecting"
  | "Suspended"
  | "Terminal";

/** In-flight manual command (drives control busy state + near-control error). */
export type DossierPendingAction = "generate" | "cancel" | "makeCurrent" | null;

/** The whole controller snapshot. `useSyncExternalStore` returns this by
 * reference; the store replaces it immutably on every change and never mutates
 * in place, so snapshot identity is a valid change signal. */
export interface DossierControllerState {
  head: DossierHead;
  revisionSelection: DossierRevisionSelection;
  historicalRevision: DossierHistoricalRevision;
  stream: DossierStream;
  /** Accumulated `Delta` text for the active build (a live regeneration draft,
   * shown subordinate to the preserved current revision). */
  streamingDraft: string | null;
  /** Last `Progress` user message from the active build (polite status region). */
  progressMessage: string | null;
  pendingAction: DossierPendingAction;
  actionError: DossierErrorInfo | null;
}

export function initialDossierControllerState(): DossierControllerState {
  return {
    head: { kind: "Idle" },
    revisionSelection: { kind: "Current" },
    historicalRevision: { kind: "Idle" },
    stream: "Disconnected",
    streamingDraft: null,
    progressMessage: null,
    pendingAction: null,
    actionError: null,
  };
}
