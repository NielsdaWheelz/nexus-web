import {
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { AddSeed } from "@/lib/launcher/model";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";
import type {
  AcceptedUploadIdentity,
  SourceIngestResult,
  UploadFileKind,
} from "@/lib/media/ingestionClient";
import {
  patchLibraryMembership,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";
import type { PodcastOpmlImportResult } from "@/lib/podcasts/opmlImport";

export const ADD_SESSION_MAX_ITEMS = 20;

export type AddSource =
  | { kind: "Url"; url: string }
  | { kind: "File"; file: File; fileKind: UploadFileKind };

export type FileSummary<K extends UploadFileKind | "Opml" | "Unsupported"> = {
  kind: "File";
  name: string;
  sizeBytes: number;
  fileKind: K;
};

export type SourceSummary =
  | { kind: "Url"; url: string }
  | FileSummary<UploadFileKind>;

export type FrozenAcceptanceIntent = Readonly<{
  source: AddSource;
  destinations: readonly LibraryDestinationSelection[];
  idempotencyKey: string;
}>;

export type AddItem =
  | {
      kind: "Invalid";
      id: string;
      source: FileSummary<UploadFileKind | "Unsupported">;
      feedback: FeedbackContent;
    }
  | ({ kind: "Draft"; id: string } & FrozenAcceptanceIntent)
  | { kind: "Submitting"; id: string; intent: FrozenAcceptanceIntent }
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
      feedback: FeedbackContent;
    }
  | {
      kind: "AcceptedUncertain";
      id: string;
      intent: FrozenAcceptanceIntent & {
        source: Extract<AddSource, { kind: "File" }>;
      };
      mediaId: string;
      sourceAttemptId: string;
      feedback: FeedbackContent;
    }
  | {
      kind: "Accepted";
      id: string;
      source: SourceSummary;
      result: SourceIngestResult;
    };

export type MembershipCommand =
  | { kind: "Add"; libraryId: string }
  | { kind: "Remove"; libraryId: string };

export type MembershipWork = {
  libraries: readonly LibraryTargetPickerItem[];
  command: MembershipCommand;
};

export type MembershipMutationProgress = MembershipWork & {
  phase: "Queued" | "Started" | "Succeeded";
};

export type RestingMembershipState =
  | { kind: "Unloaded" }
  | { kind: "Ready"; libraries: readonly LibraryTargetPickerItem[] }
  | { kind: "LoadFailed"; feedback: FeedbackContent }
  | ({ kind: "CommandFailed"; feedback: FeedbackContent } & MembershipWork);

export type MembershipState =
  | RestingMembershipState
  | { kind: "Loading"; previous: RestingMembershipState }
  | ({ kind: "Updating" } & MembershipWork)
  | ({ kind: "Reconciling" } & MembershipWork);

export type SessionMutationOperation =
  | { kind: "Submit"; itemIds: readonly string[] }
  | { kind: "ReconcileAcceptance"; itemId: string }
  | { kind: "CreateDestination" }
  | { kind: "ImportOpml" }
  | {
      kind: "Membership";
      command: MembershipCommand;
      mediaIds: readonly string[];
    };

export type SessionMutationState =
  | { kind: "Idle" }
  | { kind: "Running"; operation: SessionMutationOperation };

export type OpmlImportState =
  | { kind: "Empty" }
  | {
      kind: "Invalid";
      input: { kind: "NoFile" } | { kind: "File"; file: File };
      feedback: FeedbackContent;
    }
  | { kind: "Ready"; file: File }
  | { kind: "Importing"; file: File }
  | { kind: "Failed"; file: File; feedback: FeedbackContent }
  | {
      kind: "Complete";
      file: FileSummary<"Opml">;
      result: PodcastOpmlImportResult;
    };

export type AddSessionState = Readonly<{
  sessionId: string;
  branch: "Content" | "Opml";
  initialFocus: "Url" | "File" | "Opml";
  urlInput: { text: string; feedback?: FeedbackContent };
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  defaultDestinations: readonly LibraryDestinationSelection[];
  opmlDestinations: readonly LibraryDestinationSelection[];
  opml: OpmlImportState;
  membershipByMediaId: ReadonlyMap<string, MembershipState>;
  mutation: SessionMutationState;
}>;

export type StagedAddItem = Extract<AddItem, { kind: "Invalid" | "Draft" }>;

export type AcceptanceFailure =
  | { kind: "Rejected"; feedback: FeedbackContent }
  | { kind: "Unresolved"; feedback: FeedbackContent }
  | { kind: "Defect"; error: unknown };

export function acceptanceErrorMessage(error: unknown): AcceptanceFailure {
  if (isApiError(error)) {
    if (isSameSystemApiDefect(error)) {
      // justify-defect: same-system contract failures are not product outcomes.
      return { kind: "Defect", error };
    }
    const feedback = toFeedback(error, {
      fallback: "This item could not be added.",
    });
    if (
      error.status >= 500 ||
      error.code === "E_UPSTREAM" ||
      error.code === "E_UPSTREAM_TIMEOUT"
    ) {
      return {
        kind: "Unresolved",
        feedback: { ...feedback, severity: "warning" },
      };
    }
    return { kind: "Rejected", feedback };
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && !isAbortError(error))
  ) {
    return {
      kind: "Unresolved",
      feedback: {
        severity: "warning",
        title:
          "Nexus may have accepted this item. Check its status before restaging.",
      },
    };
  }
  return { kind: "Defect", error };
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
  | { kind: "OpenOpml" }
  | { kind: "BackToContent" }
  | { kind: "SetOpml"; opml: OpmlImportState }
  | {
      kind: "SetOpmlDestinations";
      destinations: readonly LibraryDestinationSelection[];
    }
  | { kind: "StartMutation"; operation: SessionMutationOperation }
  | { kind: "StartSubmission"; itemIds: readonly string[] }
  | { kind: "ResolveItem"; item: AddItem }
  | { kind: "FinishMutation" }
  | {
      kind: "StopMutation";
      acceptedUploadIdentityByItemId: ReadonlyMap<
        string,
        AcceptedUploadIdentity
      >;
      startedSubmissionItemIds: ReadonlySet<string>;
      membershipProgressByMediaId: ReadonlyMap<
        string,
        MembershipMutationProgress
      >;
      acceptanceFeedback: FeedbackContent;
      operationFeedback: FeedbackContent;
    }
  | {
      kind: "SetMembership";
      mediaId: string;
      membership: MembershipState;
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
    branch: seed.kind === "Opml" ? "Opml" : "Content",
    initialFocus: seed.kind === "Opml" ? "Opml" : seed.initialFocus,
    urlInput: { text: "" },
    items: [],
    defaultDestinations: [...seed.initialDestinations],
    opmlDestinations: [...seed.initialDestinations],
    opml: { kind: "Empty" },
    membershipByMediaId: new Map(),
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
          severity: "error",
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
      const membershipByMediaId = new Map(state.membershipByMediaId);
      for (const mediaId of membershipByMediaId.keys()) {
        if (!retainedMediaIds.has(mediaId)) membershipByMediaId.delete(mediaId);
      }
      return { ...state, items, membershipByMediaId };
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
    case "OpenOpml":
      return {
        ...state,
        branch: "Opml",
        opmlDestinations: [...state.defaultDestinations],
        opml: { kind: "Empty" },
      };
    case "BackToContent":
      return {
        ...state,
        branch: "Content",
        opmlDestinations: [...state.defaultDestinations],
        opml: { kind: "Empty" },
      };
    case "SetOpml":
      return { ...state, opml: action.opml };
    case "SetOpmlDestinations":
      return { ...state, opmlDestinations: [...action.destinations] };
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
          (item): AddItem =>
            item.kind === "Draft" && itemIds.has(item.id)
              ? {
                  kind: "Submitting",
                  id: item.id,
                  intent: {
                    source: item.source,
                    destinations: [...item.destinations],
                    idempotencyKey: item.idempotencyKey,
                  },
                }
              : item,
        ),
        mutation: {
          kind: "Running",
          operation: { kind: "Submit", itemIds: [...action.itemIds] },
        },
      };
    }
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
          const identity = action.acceptedUploadIdentityByItemId.get(item.id);
          if (identity && item.intent.source.kind === "File") {
            return {
              kind: "AcceptedUncertain",
              id: item.id,
              intent: { ...item.intent, source: item.intent.source },
              mediaId: identity.mediaId,
              sourceAttemptId: identity.sourceAttemptId,
              feedback: action.acceptanceFeedback,
            };
          }
          if (
            item.kind === "Submitting" &&
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
          return {
            kind: "AcceptanceUnresolved",
            id: item.id,
            intent: item.intent,
            feedback: action.acceptanceFeedback,
          };
        }),
        opml:
          state.opml.kind === "Importing"
            ? {
                kind: "Failed",
                file: state.opml.file,
                feedback: action.operationFeedback,
              }
            : state.opml,
        membershipByMediaId: new Map(
          [...state.membershipByMediaId].map(([mediaId, membership]) => {
            if (membership.kind === "Loading") {
              return [mediaId, membership.previous];
            }
            if (
              membership.kind !== "Updating" &&
              membership.kind !== "Reconciling"
            ) {
              return [mediaId, membership];
            }
            const progress = action.membershipProgressByMediaId.get(mediaId);
            if (!progress) {
              // justify-defect: an in-flight membership projection must have a
              // frozen request-boundary lifecycle entry owned by the mutation.
              throw new Error("Missing membership mutation progress.");
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
                    libraries: patchLibraryMembership(
                      [...progress.libraries],
                      progress.command.libraryId,
                      progress.command.kind === "Add",
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
    case "SetMembership": {
      const membershipByMediaId = new Map(state.membershipByMediaId);
      membershipByMediaId.set(action.mediaId, action.membership);
      return { ...state, membershipByMediaId };
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
  if (
    state.opml.kind === "Ready" ||
    state.opml.kind === "Importing" ||
    state.opml.kind === "Failed" ||
    (state.opml.kind === "Invalid" && state.opml.input.kind === "File")
  ) {
    return true;
  }
  return state.items.some((item) => item.kind !== "Accepted");
}

export function couldNotSubscribeCount(
  result: PodcastOpmlImportResult,
): number {
  return (
    result.total -
    result.imported -
    result.skipped_already_subscribed -
    result.skipped_invalid
  );
}
