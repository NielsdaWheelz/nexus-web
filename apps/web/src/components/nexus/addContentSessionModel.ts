import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import type { AddSeed } from "@/lib/nexus/model";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import {
  UploadSessionError,
  type AcceptedIngestResult,
  type UploadFileKind,
  type UploadPhase,
  type UploadSessionOutcome,
} from "@/lib/media/ingestionClient";
import {
  IMPORTS_CONFLICT_MESSAGE,
  UPLOAD_REJECTED_LABEL,
  uploadVerificationFailureCopy,
} from "@/lib/status/imports";
import { assertNever } from "@/lib/assertNever";
import {
  projectLibraryPlacement,
  type LibraryPlacementDestination,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";

export const ADD_SESSION_MAX_ITEMS = 20;

type AddSource =
  | { kind: "Url"; url: string }
  | { kind: "File"; file: File; fileKind: UploadFileKind };

type FileSummary<K extends UploadFileKind | "Unsupported"> = {
  kind: "File";
  name: string;
  sizeBytes: number;
  fileKind: K;
};

type SourceSummary =
  | { kind: "Url"; url: string }
  | FileSummary<UploadFileKind>;

export type FrozenAcceptanceIntent = Readonly<{
  source: AddSource;
  destinations: readonly LibraryDestinationSelection[];
  idempotencyKey: string;
}>;

type FrozenFileAcceptanceIntent = FrozenAcceptanceIntent & {
  readonly source: Extract<AddSource, { kind: "File" }>;
};

type FrozenUrlAcceptanceIntent = FrozenAcceptanceIntent & {
  readonly source: Extract<AddSource, { kind: "Url" }>;
};

type SubmittingAddItem =
  | {
      kind: "Submitting";
      id: string;
      intent: FrozenFileAcceptanceIntent;
      uploadPhase: UploadPhase;
    }
  | {
      kind: "Submitting";
      id: string;
      intent: FrozenUrlAcceptanceIntent;
      uploadPhase: null;
    };

export type AddItem =
  | {
      kind: "Invalid";
      id: string;
      source: FileSummary<UploadFileKind | "Unsupported">;
      feedback: FeedbackContent;
    }
  | ({ kind: "Draft"; id: string } & FrozenAcceptanceIntent)
  | SubmittingAddItem
  | {
      kind: "Rejected";
      id: string;
      intent: FrozenAcceptanceIntent;
      feedback: FeedbackContent;
    }
  | {
      kind: "AcceptanceUnresolved";
      id: string;
      intent: FrozenAcceptanceIntent;
      reason: UnresolvedAcceptanceReason;
      feedback: FeedbackContent;
    }
  | {
      kind: "Accepted";
      id: string;
      source: SourceSummary;
      result: AcceptedIngestResult;
    };

export type PlacementCommand =
  | { kind: "Add"; destination: LibraryPlacementDestination }
  | { kind: "Remove"; destination: LibraryPlacementDestination };

type PlacementWork = {
  libraries: readonly LibraryPlacementOption[];
  command: PlacementCommand;
};

export type PlacementMutationProgress = PlacementWork & {
  phase: "Queued" | "Started" | "Succeeded";
};

export type RestingPlacementState =
  | { kind: "Unloaded" }
  | { kind: "Ready"; libraries: readonly LibraryPlacementOption[] }
  | { kind: "LoadFailed"; feedback: FeedbackContent }
  | ({ kind: "CommandFailed"; feedback: FeedbackContent } & PlacementWork);

export type PlacementState =
  | RestingPlacementState
  | { kind: "Loading"; previous: RestingPlacementState }
  | ({ kind: "Updating" } & PlacementWork)
  | ({ kind: "Reconciling" } & PlacementWork);

export type SessionMutationOperation =
  | { kind: "Submit"; itemIds: readonly string[] }
  | { kind: "ReconcileAcceptance"; itemId: string }
  | { kind: "CreateDestination" }
  | {
      kind: "Placement";
      command: PlacementCommand;
      mediaIds: readonly string[];
    };

type SessionMutationState =
  | { kind: "Idle" }
  | { kind: "Running"; operation: SessionMutationOperation };

export type AddSessionState = Readonly<{
  sessionId: string;
  initialFocus: "Url" | "File";
  urlInput: { text: string; feedback?: FeedbackContent };
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  defaultDestinations: readonly LibraryDestinationSelection[];
  placementByMediaId: ReadonlyMap<string, PlacementState>;
  mutation: SessionMutationState;
}>;

export type StagedAddItem = Extract<AddItem, { kind: "Invalid" | "Draft" }>;

/**
 * Why an item is still unresolved. `StatusUnknown` means acceptance itself is
 * ambiguous; `UploadIncomplete` means the server proved the bytes never landed,
 * so the repair is a fresh transfer of the same file rather than a status check.
 */
export type UnresolvedAcceptanceReason = "StatusUnknown" | "UploadIncomplete";

type AcceptanceFailure =
  | { kind: "Rejected"; feedback: FeedbackContent }
  | {
      kind: "Unresolved";
      reason: UnresolvedAcceptanceReason;
      feedback: FeedbackContent;
    }
  /** The foreground attempt lost the session; Imports owns it now. */
  | { kind: "Superseded" }
  | { kind: "Defect"; error: unknown };

function terminalAcceptance(message: string): AcceptanceFailure {
  return {
    kind: "Rejected",
    feedback: { tone: "Danger", title: "Couldn’t save", message },
  };
}

function unresolvedAcceptance(requestId?: string): AcceptanceFailure {
  return {
    kind: "Unresolved",
    reason: "StatusUnknown",
    feedback: {
      tone: "Warning",
      title: "Couldn’t confirm",
      message:
        "Nexus could not confirm whether this was saved. Check status to find out.",
      requestId,
    },
  };
}

function uploadAcceptanceFailure(
  outcome: UploadSessionOutcome,
  error: unknown,
): AcceptanceFailure {
  switch (outcome.kind) {
    case "NeedsAttention":
      return {
        kind: "Rejected",
        feedback: {
          tone: "Warning",
          title: "Upload needs attention",
          message:
            "Use Imports for the available next step, or restage this file as a new import.",
        },
      };
    case "VerificationRejected":
      return {
        kind: "Rejected",
        feedback: {
          tone: "Danger",
          title: UPLOAD_REJECTED_LABEL,
          message: uploadVerificationFailureCopy(outcome.code),
        },
      };
    case "BytesMissing":
      return {
        kind: "Unresolved",
        reason: "UploadIncomplete",
        feedback: {
          tone: "Warning",
          title: "Upload didn’t complete",
          message:
            "Nexus never received this file. Retry the upload, or remove it and start a new import.",
        },
      };
    case "Superseded":
      return { kind: "Superseded" };
    case "Conflicted":
      return terminalAcceptance(IMPORTS_CONFLICT_MESSAGE);
    case "Unresolved":
      return unresolvedAcceptance();
    case "UnsupportedFileType":
      return terminalAcceptance(
        "This file type isn’t supported. Start a new import with a PDF or EPUB.",
      );
    case "FileTooLarge":
      return terminalAcceptance(
        "This file exceeds the import limit. Start a new import with a smaller file.",
      );
    case "LibraryForbidden":
      return terminalAcceptance(
        "You no longer have access to a destination library. Choose different libraries and start a new import.",
      );
    case "IntentChanged":
      return terminalAcceptance("This import changed. Start a new import.");
    case "FileMismatch":
      return terminalAcceptance(
        "That file doesn’t match this import. Choose the same file, or start a new import.",
      );
    case "IntentMalformed":
      return { kind: "Defect", error };
    default:
      return assertNever(outcome, "Unreachable upload session outcome");
  }
}

export function acceptanceErrorMessage(error: unknown): AcceptanceFailure {
  if (error instanceof UploadSessionError) {
    return uploadAcceptanceFailure(error.outcome, error);
  }
  if (!isApiError(error) || isSameSystemApiDefect(error)) {
    return { kind: "Defect", error };
  }
  // Ordering matters: an unresolved acceptance is decided by the transport
  // class first, so a server outage the product-copy adapter does not model
  // stays an honest "check status" instead of becoming an internal defect.
  if (
    error.status >= 500 ||
    error.code === "E_NETWORK" ||
    error.code === "E_UPSTREAM" ||
    error.code === "E_UPSTREAM_TIMEOUT"
  ) {
    return unresolvedAcceptance(error.requestId);
  }
  try {
    return {
      kind: "Rejected",
      feedback: mediaCaptureErrorMessage(error, "SaveSource"),
    };
  } catch (caughtDefect: unknown) {
    return { kind: "Defect", error: caughtDefect };
  }
}

/** The one projection of a settled acceptance failure onto its session item. */
export function acceptanceFailureItem(
  id: string,
  intent: FrozenAcceptanceIntent,
  failure: Extract<AcceptanceFailure, { kind: "Rejected" | "Unresolved" }>,
): AddItem {
  return failure.kind === "Rejected"
    ? { kind: "Rejected", id, intent, feedback: failure.feedback }
    : {
        kind: "AcceptanceUnresolved",
        id,
        intent,
        reason: failure.reason,
        feedback: failure.feedback,
      };
}

export type AddSessionAction =
  | { kind: "Reset"; state: AddSessionState }
  | { kind: "SetUrlText"; text: string }
  | { kind: "SetUrlFeedback"; feedback: FeedbackContent }
  | { kind: "SetIntakeFeedback"; feedback: FeedbackContent }
  | {
      kind: "StageItems";
      items: readonly StagedAddItem[];
      source: "Url" | "File";
    }
  | { kind: "RemoveItem"; itemId: string }
  | { kind: "RestageItem"; itemId: string; idempotencyKey: string }
  | {
      kind: "SetDefaultDestinations";
      destinations: readonly LibraryDestinationSelection[];
    }
  | {
      kind: "SetItemDestinations";
      itemId: string;
      destinations: readonly LibraryDestinationSelection[];
    }
  | { kind: "StartMutation"; operation: SessionMutationOperation }
  | { kind: "StartSubmission"; itemIds: readonly string[] }
  | { kind: "StartFileReconciliation"; itemId: string }
  | { kind: "SetUploadPhase"; itemId: string; phase: UploadPhase }
  | { kind: "ResolveItem"; item: AddItem }
  | { kind: "FinishMutation" }
  | {
      kind: "StopMutation";
      startedSubmissionItemIds: ReadonlySet<string>;
      placementProgressByMediaId: ReadonlyMap<
        string,
        PlacementMutationProgress
      >;
      acceptanceFeedback: FeedbackContent;
      uploadFeedback: FeedbackContent;
      operationFeedback: FeedbackContent;
    }
  | {
      kind: "SetPlacement";
      mediaId: string;
      placement: PlacementState;
    };

export function createAddSessionState({
  seed,
  sessionId,
}: {
  seed: AddSeed;
  sessionId: string;
}): AddSessionState {
  return {
    sessionId,
    initialFocus: seed.initialFocus,
    urlInput: { text: seed.initialUrlDraft ?? "" },
    items: [],
    defaultDestinations: [...seed.initialDestinations],
    placementByMediaId: new Map(),
    mutation: { kind: "Idle" },
  };
}

export function reduceAddSession(
  state: AddSessionState,
  action: AddSessionAction,
): AddSessionState {
  switch (action.kind) {
    case "Reset":
      return action.state;
    case "SetUrlText":
      return { ...state, urlInput: { text: action.text } };
    case "SetUrlFeedback":
      return {
        ...state,
        urlInput: { ...state.urlInput, feedback: action.feedback },
      };
    case "SetIntakeFeedback":
      return { ...state, intakeFeedback: action.feedback };
    case "StageItems": {
      if (state.items.length + action.items.length > ADD_SESSION_MAX_ITEMS) {
        const feedback: FeedbackContent = {
          tone: "Danger",
          title: `Add up to ${ADD_SESSION_MAX_ITEMS} items at a time.`,
        };
        return action.source === "Url"
          ? { ...state, urlInput: { ...state.urlInput, feedback } }
          : { ...state, intakeFeedback: feedback };
      }
      return {
        ...state,
        urlInput: action.source === "Url" ? { text: "" } : state.urlInput,
        intakeFeedback: undefined,
        items: [...state.items, ...action.items],
      };
    }
    case "RemoveItem": {
      const items = state.items.filter((item) => item.id !== action.itemId);
      const retainedMediaIds = new Set(
        items.flatMap((item) =>
          item.kind === "Accepted" ? [item.result.mediaId] : [],
        ),
      );
      const placementByMediaId = new Map(state.placementByMediaId);
      for (const mediaId of placementByMediaId.keys()) {
        if (!retainedMediaIds.has(mediaId)) placementByMediaId.delete(mediaId);
      }
      return { ...state, items, placementByMediaId };
    }
    case "RestageItem":
      return {
        ...state,
        items: state.items.map((item): AddItem => {
          if (
            item.id !== action.itemId ||
            (item.kind !== "Rejected" && item.kind !== "AcceptanceUnresolved")
          ) {
            return item;
          }
          return {
            kind: "Draft",
            id: item.id,
            ...item.intent,
            idempotencyKey: action.idempotencyKey,
          };
        }),
      };
    case "SetDefaultDestinations":
      return {
        ...state,
        defaultDestinations: [...action.destinations],
        items: state.items.map(
          (item): AddItem =>
            item.kind === "Draft"
              ? { ...item, destinations: [...action.destinations] }
              : item,
        ),
      };
    case "SetItemDestinations":
      return {
        ...state,
        items: state.items.map(
          (item): AddItem =>
            item.kind === "Draft" && item.id === action.itemId
              ? { ...item, destinations: [...action.destinations] }
              : item,
        ),
      };
    case "StartMutation":
      return {
        ...state,
        mutation: { kind: "Running", operation: action.operation },
      };
    case "StartSubmission": {
      const itemIds = new Set(action.itemIds);
      return {
        ...state,
        items: state.items.map(
          (item): AddItem => {
            if (item.kind !== "Draft" || !itemIds.has(item.id)) return item;
            const intent = {
              destinations: [...item.destinations],
              idempotencyKey: item.idempotencyKey,
            };
            return item.source.kind === "File"
              ? {
                  kind: "Submitting",
                  id: item.id,
                  intent: { ...intent, source: item.source },
                  uploadPhase: "Preparing",
                }
              : {
                  kind: "Submitting",
                  id: item.id,
                  intent: { ...intent, source: item.source },
                  uploadPhase: null,
                };
          },
        ),
        mutation: {
          kind: "Running",
          operation: { kind: "Submit", itemIds: [...action.itemIds] },
        },
      };
    }
    case "StartFileReconciliation":
      return {
        ...state,
        items: state.items.map((item): AddItem => {
          if (
            item.id !== action.itemId ||
            item.kind !== "AcceptanceUnresolved" ||
            item.intent.source.kind !== "File"
          ) {
            return item;
          }
          return {
            kind: "Submitting",
            id: item.id,
            intent: {
              source: item.intent.source,
              destinations: item.intent.destinations,
              idempotencyKey: item.intent.idempotencyKey,
            },
            uploadPhase: "Preparing",
          };
        }),
        mutation: {
          kind: "Running",
          operation: { kind: "ReconcileAcceptance", itemId: action.itemId },
        },
      };
    case "SetUploadPhase":
      return {
        ...state,
        items: state.items.map((item): AddItem => {
          if (
            item.id !== action.itemId ||
            item.kind !== "Submitting" ||
            item.intent.source.kind !== "File"
          ) {
            return item;
          }
          return {
            kind: "Submitting",
            id: item.id,
            intent: {
              source: item.intent.source,
              destinations: item.intent.destinations,
              idempotencyKey: item.intent.idempotencyKey,
            },
            uploadPhase: action.phase,
          };
        }),
      };
    case "ResolveItem":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.item.id ? action.item : item,
        ),
      };
    case "FinishMutation":
      return { ...state, mutation: { kind: "Idle" } };
    case "StopMutation":
      return {
        ...state,
        items: state.items.map((item): AddItem => {
          const isActiveReconciliation =
            state.mutation.kind === "Running" &&
            state.mutation.operation.kind === "ReconcileAcceptance" &&
            state.mutation.operation.itemId === item.id;
          if (
            item.kind !== "Submitting" &&
            !(item.kind === "AcceptanceUnresolved" && isActiveReconciliation)
          ) {
            return item;
          }
          if (
            item.kind === "Submitting" &&
            !isActiveReconciliation &&
            !action.startedSubmissionItemIds.has(item.id)
          ) {
            return {
              kind: "Draft",
              id: item.id,
              source: item.intent.source,
              destinations: item.intent.destinations,
              idempotencyKey: item.intent.idempotencyKey,
            };
          }
          return item.intent.source.kind === "File"
            ? {
                kind: "Rejected",
                id: item.id,
                intent: item.intent,
                feedback: action.uploadFeedback,
              }
            : {
                kind: "AcceptanceUnresolved",
                id: item.id,
                intent: item.intent,
                reason: "StatusUnknown",
                feedback: action.acceptanceFeedback,
              };
        }),
        placementByMediaId: new Map(
          [...state.placementByMediaId].map(([mediaId, placement]) => {
            if (placement.kind === "Loading") {
              return [mediaId, placement.previous];
            }
            if (
              placement.kind !== "Updating" &&
              placement.kind !== "Reconciling"
            ) {
              return [mediaId, placement];
            }
            const progress = action.placementProgressByMediaId.get(mediaId);
            if (!progress) {
              // justify-defect: an in-flight placement projection must have a
              // frozen request-boundary lifecycle entry owned by the mutation.
              throw new Error("Missing placement mutation progress.");
            }
            switch (progress.phase) {
              case "Queued":
                return [
                  mediaId,
                  { kind: "Ready" as const, libraries: progress.libraries },
                ];
              case "Succeeded":
                return [
                  mediaId,
                  {
                    kind: "Ready" as const,
                    libraries: projectLibraryPlacement(
                      [...progress.libraries],
                      progress.command.destination,
                      progress.command.kind === "Add"
                        ? { kind: "Direct" }
                        : { kind: "Absent" },
                    ),
                  },
                ];
              case "Started":
                return [
                  mediaId,
                  {
                    kind: "CommandFailed" as const,
                    libraries: progress.libraries,
                    command: progress.command,
                    feedback: action.operationFeedback,
                  },
                ];
            }
          }),
        ),
        mutation: { kind: "Idle" },
      };
    case "SetPlacement": {
      const placementByMediaId = new Map(state.placementByMediaId);
      placementByMediaId.set(action.mediaId, action.placement);
      return { ...state, placementByMediaId };
    }
  }
}

export function draftItems(state: AddSessionState) {
  return state.items.filter(
    (item): item is Extract<AddItem, { kind: "Draft" }> =>
      item.kind === "Draft",
  );
}

export function settledAcceptedItems(state: AddSessionState) {
  return state.items.filter(
    (item): item is Extract<AddItem, { kind: "Accepted" }> =>
      item.kind === "Accepted",
  );
}

export function submitItemIds(state: AddSessionState): readonly string[] {
  return draftItems(state).map((item) => item.id);
}

export function acceptedMediaIds(state: AddSessionState): readonly string[] {
  return [
    ...new Set(settledAcceptedItems(state).map((item) => item.result.mediaId)),
  ];
}

export function isAddSessionDirty(state: AddSessionState): boolean {
  if (state.urlInput.text.trim() !== "") return true;
  return state.items.some((item) => item.kind !== "Accepted");
}
