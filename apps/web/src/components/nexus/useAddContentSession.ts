"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { assertNever } from "@/lib/assertNever";
import { isAbortError } from "@/lib/errors";
import { extractUrls } from "@/lib/extractUrls";
import type { AddSeed } from "@/lib/nexus/model";
import { createLibrary } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import {
  addMediaFromUrl,
  getFileUploadError,
  getFileUploadKind,
  uploadIngestFile,
  type AcceptedIngestResult,
} from "@/lib/media/ingestionClient";
import {
  addLibraryPlacement,
  libraryPlacementDestinationKey,
  listLibraryPlacements,
  projectLibraryPlacement,
  removeLibraryPlacement,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import {
  ADD_SESSION_MAX_ITEMS,
  acceptanceErrorMessage,
  acceptanceFailureItem,
  acceptedMediaIds,
  createAddSessionState,
  isAddSessionDirty,
  reduceAddSession,
  submitItemIds,
  type AddItem,
  type AddSessionAction,
  type AddSessionState,
  type FrozenAcceptanceIntent,
  type PlacementCommand,
  type PlacementMutationProgress,
  type PlacementState,
  type RestingPlacementState,
  type SessionMutationOperation,
  type StagedAddItem,
} from "./addContentSessionModel";

const EMPTY_SEED: AddSeed = {
  kind: "Content",
  initialFocus: "Url",
  initialDestinations: [],
};
const MUTATION_CONCURRENCY = 2;

type SubmissionItem = Extract<AddItem, { kind: "Draft" }>;

export interface AddContentSessionController {
  readonly state: AddSessionState;
  readonly dirty: boolean;
  start(seed: AddSeed): string;
  setUrlText(text: string): void;
  reviewUrls(): boolean;
  stageFiles(files: readonly File[]): boolean;
  removeItem(itemId: string): void;
  restageItem(itemId: string): void;
  setDefaultDestinations(
    destinations: readonly LibraryDestinationSelection[],
  ): void;
  setItemDestinations(
    itemId: string,
    destinations: readonly LibraryDestinationSelection[],
  ): void;
  submit(): Promise<void>;
  reconcileAcceptance(itemId: string): Promise<void>;
  refreshPlacements(mediaIds: readonly string[]): Promise<void>;
  runPlacement(input: {
    mediaIds: readonly string[];
    command: PlacementCommand;
  }): Promise<void>;
  createDestination(name: string): Promise<LibraryDestinationSelection>;
  stop(): void;
  discard(): void;
}

function sourceSummary(intent: FrozenAcceptanceIntent) {
  return intent.source.kind === "Url"
    ? { kind: "Url" as const, url: intent.source.url }
    : {
        kind: "File" as const,
        name: intent.source.file.name,
        sizeBytes: intent.source.file.size,
        fileKind: intent.source.fileKind,
      };
}

function acceptedItem(
  id: string,
  intent: FrozenAcceptanceIntent,
  result: AcceptedIngestResult,
): AddItem {
  return { kind: "Accepted", id, source: sourceSummary(intent), result };
}


function addContentPlacementErrorMessage(
  error: unknown,
  title = "Libraries couldn’t be updated",
): FeedbackContent {
  return libraryRequestErrorMessage(error, {
    title,
    request: "PlacementMutation",
  });
}

/**
 * A write whose transport never settled: the server may or may not have applied
 * it, so only these justify an authoritative re-read before deciding.
 */
function isPlacementSettlementUnknown(error: unknown): boolean {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    (error.code === "E_NETWORK" || error.code === "E_UPSTREAM_TIMEOUT")
  );
}

function requireIndexedItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error("Bounded task outcome did not match its input item.");
  }
  return item;
}

function restingPlacementSnapshot(
  placement: PlacementState | undefined,
): RestingPlacementState | null {
  if (!placement) return { kind: "Unloaded" };
  switch (placement.kind) {
    case "Unloaded":
    case "Ready":
    case "LoadFailed":
    case "CommandFailed":
      return placement;
    case "Loading":
    case "Updating":
    case "Reconciling":
      return null;
  }
}

export function useAddContentSession(): AddContentSessionController {
  const [state, dispatch] = useReducer(
    reduceAddSession,
    createAddSessionState({
      seed: EMPTY_SEED,
      sessionId: createRandomId("add-session"),
    }),
  );
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const sessionAbortRef = useRef(new AbortController());
  const startedSubmissionItemIdsRef = useRef(new Set<string>());
  const placementProgressByMediaIdRef = useRef(
    new Map<string, PlacementMutationProgress>(),
  );
  const destinationCreateIdByNameRef = useRef(new Map<string, string>());

  const apply = useCallback((action: AddSessionAction) => {
    stateRef.current = reduceAddSession(stateRef.current, action);
    dispatch(action);
  }, []);

  useEffect(() => () => sessionAbortRef.current.abort(), []);

  useEffect(() => {
    if (state.mutation.kind !== "Running") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state.mutation.kind]);

  const start = useCallback(
    (seed: AddSeed) => {
      sessionAbortRef.current.abort();
      sessionAbortRef.current = new AbortController();
      generationRef.current += 1;
      startedSubmissionItemIdsRef.current.clear();
      placementProgressByMediaIdRef.current.clear();
      destinationCreateIdByNameRef.current.clear();
      const next = createAddSessionState({
        seed,
        sessionId: createRandomId("add-session"),
      });
      apply({ kind: "Reset", state: next });
      return next.sessionId;
    },
    [apply],
  );

  const discard = useCallback(() => {
    start(EMPTY_SEED);
  }, [start]);

  const stop = useCallback(() => {
    sessionAbortRef.current.abort();
    sessionAbortRef.current = new AbortController();
    generationRef.current += 1;
    apply({
      kind: "StopMutation",
      startedSubmissionItemIds: new Set(startedSubmissionItemIdsRef.current),
      placementProgressByMediaId: new Map(
        placementProgressByMediaIdRef.current,
      ),
      acceptanceFeedback: {
        tone: "Warning",
        title: "Stopped · acceptance status unknown",
        message: "Server changes that already committed may remain.",
      },
      uploadFeedback: {
        tone: "Warning",
        title: "Upload stopped",
        message:
          "Use Imports to retry or remove any accepted upload, or restage this file as a new import.",
      },
      operationFeedback: {
        tone: "Warning",
        title: "Stopped before completion",
        message: "Server changes that already committed may remain.",
      },
    });
    startedSubmissionItemIdsRef.current.clear();
    placementProgressByMediaIdRef.current.clear();
  }, [apply]);

  const setUrlText = useCallback(
    (text: string) => {
      if (stateRef.current.mutation.kind === "Idle")
        apply({ kind: "SetUrlText", text });
    },
    [apply],
  );

  const reviewUrls = useCallback(() => {
    const current = stateRef.current;
    if (current.mutation.kind !== "Idle") return false;
    const urls = extractUrls(current.urlInput.text);
    if (urls.length === 0) {
      apply({
        kind: "SetUrlFeedback",
        feedback: {
          tone: "Danger",
          title: "Paste one or more http:// or https:// URLs.",
        },
      });
      return false;
    }
    const items = urls.map(
      (url): StagedAddItem => ({
        kind: "Draft",
        id: createRandomId("add-item"),
        source: { kind: "Url", url },
        destinations: [...current.defaultDestinations],
        idempotencyKey: createRandomId("media-url"),
      }),
    );
    apply({ kind: "StageItems", source: "Url", items });
    return current.items.length + items.length <= ADD_SESSION_MAX_ITEMS;
  }, [apply]);

  const stageFiles = useCallback(
    (files: readonly File[]) => {
      const current = stateRef.current;
      if (current.mutation.kind !== "Idle" || files.length === 0) return false;
      const items = files.map((file): StagedAddItem => {
        const fileKind = getFileUploadKind(file);
        const error = getFileUploadError(file);
        if (error || fileKind === null) {
          return {
            kind: "Invalid",
            id: createRandomId("add-item"),
            source: {
              kind: "File",
              name: file.name,
              sizeBytes: file.size,
              fileKind: fileKind ?? "Unsupported",
            },
            feedback: {
              tone: "Danger",
              title: error ?? "Only PDF and EPUB files are supported.",
            },
          };
        }
        return {
          kind: "Draft",
          id: createRandomId("add-item"),
          source: { kind: "File", file, fileKind },
          destinations: [...current.defaultDestinations],
          idempotencyKey: createRandomId("media-upload"),
        };
      });
      apply({ kind: "StageItems", source: "File", items });
      return current.items.length + items.length <= ADD_SESSION_MAX_ITEMS;
    },
    [apply],
  );

  const removeItem = useCallback(
    (itemId: string) => {
      if (stateRef.current.mutation.kind === "Idle") {
        apply({ kind: "RemoveItem", itemId });
      }
    },
    [apply],
  );

  const restageItem = useCallback(
    (itemId: string) => {
      if (stateRef.current.mutation.kind === "Idle") {
        apply({
          kind: "RestageItem",
          itemId,
          idempotencyKey: createRandomId("media-restage"),
        });
      }
    },
    [apply],
  );

  const setDefaultDestinations = useCallback(
    (destinations: readonly LibraryDestinationSelection[]) => {
      if (stateRef.current.mutation.kind === "Idle") {
        apply({ kind: "SetDefaultDestinations", destinations });
      }
    },
    [apply],
  );

  const setItemDestinations = useCallback(
    (itemId: string, destinations: readonly LibraryDestinationSelection[]) => {
      if (stateRef.current.mutation.kind === "Idle") {
        apply({ kind: "SetItemDestinations", itemId, destinations });
      }
    },
    [apply],
  );

  const submit = useCallback(async () => {
    const current = stateRef.current;
    if (current.mutation.kind !== "Idle") return;
    const itemIds = submitItemIds(current);
    if (itemIds.length === 0) return;
    const selected = new Set(itemIds);
    const items = current.items.filter(
      (item): item is SubmissionItem =>
        item.kind === "Draft" && selected.has(item.id),
    );
    const generation = generationRef.current;
    const signal = sessionAbortRef.current.signal;
    startedSubmissionItemIdsRef.current.clear();
    apply({ kind: "StartSubmission", itemIds });

    const outcomes = await runBoundedTasks({
      items,
      concurrency: MUTATION_CONCURRENCY,
      run: async (item) => {
        signal.throwIfAborted();
        if (generation === generationRef.current) {
          startedSubmissionItemIdsRef.current.add(item.id);
        }
        const libraryIds = item.destinations.map(
          (destination) => destination.id,
        );
        if (item.source.kind === "Url") {
          const result = await addMediaFromUrl({
            url: item.source.url,
            libraryIds,
            idempotencyKey: item.idempotencyKey,
            signal,
          });
          if (generation === generationRef.current) {
            apply({
              kind: "ResolveItem",
              item: acceptedItem(item.id, item, result),
            });
          }
          return;
        }
        const result = await uploadIngestFile({
          file: item.source.file,
          libraryIds,
          idempotencyKey: item.idempotencyKey,
          signal,
          onPhaseChange: (phase) => {
            if (generation === generationRef.current) {
              apply({ kind: "SetUploadPhase", itemId: item.id, phase });
            }
          },
        });
        if (generation !== generationRef.current) return;
        apply({
          kind: "ResolveItem",
          item: acceptedItem(item.id, item, result),
        });
      },
    });
    if (generation !== generationRef.current) return;

    const defects: unknown[] = [];
    outcomes.forEach((outcome, index) => {
      const item = requireIndexedItem(items, index);
      if (outcome.kind === "Fulfilled") {
        // The create-with-placement publish lives in the ingestionClient
        // creation helper, which fires once per acknowledged create.
        return;
      }
      if (signal.aborted || isAbortError(outcome.error)) return;
      if (handleUnauthenticatedApiError(outcome.error)) {
        apply({
          kind: "ResolveItem",
          item,
        });
        return;
      }
      const failure = acceptanceErrorMessage(outcome.error);
      switch (failure.kind) {
        case "Defect":
          apply({ kind: "ResolveItem", item });
          defects.push(failure.error);
          return;
        case "Superseded":
          // The session moved on without this attempt. Imports owns
          // the truth, so the foreground stops claiming this item at all.
          apply({ kind: "RemoveItem", itemId: item.id });
          return;
        case "Rejected":
        case "Unresolved":
          apply({
            kind: "ResolveItem",
            item: acceptanceFailureItem(item.id, item, failure),
          });
          return;
        default:
          return assertNever(failure, "Unreachable acceptance failure");
      }
    });
    startedSubmissionItemIdsRef.current.clear();
    apply({ kind: "FinishMutation" });
    if (defects.length > 0) throw defects[0];
  }, [apply]);

  const reconcileAcceptance = useCallback(
    async (itemId: string) => {
      const current = stateRef.current;
      if (current.mutation.kind !== "Idle") return;
      const item = current.items.find((candidate) => candidate.id === itemId);
      if (!item || item.kind !== "AcceptanceUnresolved") {
        return;
      }
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      const operation: SessionMutationOperation = {
        kind: "ReconcileAcceptance",
        itemId,
      };
      if (item.intent.source.kind === "File") {
        apply({ kind: "StartFileReconciliation", itemId });
      } else {
        apply({ kind: "StartMutation", operation });
      }
      let defectState: { error: unknown } | null = null;
      try {
        const libraryIds = item.intent.destinations.map(
          (destination) => destination.id,
        );
        if (item.intent.source.kind === "Url") {
          const result = await addMediaFromUrl({
            url: item.intent.source.url,
            libraryIds,
            idempotencyKey: item.intent.idempotencyKey,
            signal,
          });
          if (generation === generationRef.current) {
            apply({
              kind: "ResolveItem",
              item: acceptedItem(item.id, item.intent, result),
            });
          }
        } else {
          const result = await uploadIngestFile({
            file: item.intent.source.file,
            libraryIds,
            idempotencyKey: item.intent.idempotencyKey,
            signal,
            onPhaseChange: (phase) => {
              if (generation === generationRef.current) {
                apply({ kind: "SetUploadPhase", itemId: item.id, phase });
              }
            },
          });
          if (generation !== generationRef.current) return;
          apply({
            kind: "ResolveItem",
            item: acceptedItem(item.id, item.intent, result),
          });
        }
      } catch (error) {
        if (
          generation !== generationRef.current ||
          signal.aborted ||
          isAbortError(error)
        )
          return;
        if (handleUnauthenticatedApiError(error)) {
          return;
        } else {
          const failure = acceptanceErrorMessage(error);
          switch (failure.kind) {
            case "Defect":
              defectState = { error: failure.error };
              break;
            case "Superseded":
              apply({ kind: "RemoveItem", itemId: item.id });
              break;
            case "Rejected":
            case "Unresolved":
              apply({
                kind: "ResolveItem",
                item: acceptanceFailureItem(item.id, item.intent, failure),
              });
              break;
            default:
              assertNever(failure, "Unreachable acceptance failure");
          }
        }
      } finally {
        if (generation === generationRef.current) {
          apply({ kind: "FinishMutation" });
        }
      }
      if (defectState !== null) throw defectState.error;
    },
    [apply],
  );

  const runPlacement = useCallback(
    async ({
      mediaIds,
      command,
    }: {
      mediaIds: readonly string[];
      command: PlacementCommand;
    }) => {
      const current = stateRef.current;
      if (current.mutation.kind !== "Idle") return;
      const accepted = new Set(acceptedMediaIds(current));
      const uniqueMediaIds = [...new Set(mediaIds)].filter((mediaId) =>
        accepted.has(mediaId),
      );
      if (uniqueMediaIds.length === 0) return;
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      placementProgressByMediaIdRef.current.clear();
      apply({
        kind: "StartMutation",
        operation: { kind: "Placement", command, mediaIds: uniqueMediaIds },
      });
      const defects: unknown[] = [];
      const loaded = await runBoundedTasks({
        items: uniqueMediaIds,
        concurrency: MUTATION_CONCURRENCY,
        run: (mediaId) => {
          signal.throwIfAborted();
          return listLibraryPlacements(
            { kind: "Media", id: mediaId },
            { signal },
          );
        },
      });
      if (generation !== generationRef.current) return;

      const eligible: {
        mediaId: string;
        libraries: readonly LibraryPlacementOption[];
      }[] = [];
      loaded.forEach((outcome, index) => {
        const mediaId = requireIndexedItem(uniqueMediaIds, index);
        if (outcome.kind === "Rejected") {
          if (!signal.aborted && !isAbortError(outcome.error)) {
            if (handleUnauthenticatedApiError(outcome.error)) return;
            try {
              const feedback = addContentPlacementErrorMessage(
                outcome.error,
                "Libraries couldn’t be loaded",
              );
              apply({
                kind: "SetPlacement",
                mediaId,
                placement: { kind: "LoadFailed", feedback },
              });
            } catch (caughtDefect: unknown) {
              defects.push(caughtDefect);
            }
          }
          return;
        }
        const libraries = outcome.value;
        apply({
          kind: "SetPlacement",
          mediaId,
          placement: { kind: "Ready", libraries },
        });
        const commandKey = libraryPlacementDestinationKey(command.destination);
        const target = libraries.find(
          (placement) =>
            libraryPlacementDestinationKey(placement.destination) === commandKey,
        );
        const canRun =
          command.kind === "Add"
            ? target?.availability.kind === "Available" &&
              target.relation.kind === "Absent"
            : target?.availability.kind === "Available" &&
              target.relation.kind === "Direct";
        if (canRun) eligible.push({ mediaId, libraries });
      });

      for (const work of eligible) {
        placementProgressByMediaIdRef.current.set(work.mediaId, {
          phase: "Queued",
          libraries: work.libraries,
          command,
        });
        apply({
          kind: "SetPlacement",
          mediaId: work.mediaId,
          placement: { kind: "Updating", libraries: work.libraries, command },
        });
      }
      const mutated = await runBoundedTasks({
        items: eligible,
        concurrency: MUTATION_CONCURRENCY,
        run: async ({ mediaId }) => {
          signal.throwIfAborted();
          const progress = placementProgressByMediaIdRef.current.get(mediaId);
          if (generation === generationRef.current && progress) {
            placementProgressByMediaIdRef.current.set(mediaId, {
              ...progress,
              phase: "Started",
            });
          }
          if (command.kind === "Add") {
            await addLibraryPlacement({
              target: { kind: "Media", id: mediaId },
              destination: command.destination,
              signal,
            });
          } else {
            await removeLibraryPlacement({
              target: { kind: "Media", id: mediaId },
              destination: command.destination,
              signal,
            });
          }
          const started = placementProgressByMediaIdRef.current.get(mediaId);
          if (generation === generationRef.current && started) {
            placementProgressByMediaIdRef.current.set(mediaId, {
              ...started,
              phase: "Succeeded",
            });
          }
        },
      });
      if (generation !== generationRef.current) return;

      // A rejected write leaves the placement UNKNOWN only when the transport
      // itself is ambiguous; every other rejection is an authoritative refusal
      // and fails the command directly, as the canonical placement controller
      // does (lib/libraries/useLibraryPlacement.ts isMutationSettlementUnknown).
      const failPlacement = (
        mediaId: string,
        libraries: readonly LibraryPlacementOption[],
        error: unknown,
      ) => {
        if (handleUnauthenticatedApiError(error)) {
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: { kind: "Ready", libraries },
          });
          return;
        }
        try {
          const feedback = addContentPlacementErrorMessage(error);
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: {
              kind: "CommandFailed",
              libraries,
              command,
              feedback,
            },
          });
        } catch (caughtDefect: unknown) {
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: { kind: "Ready", libraries },
          });
          defects.push(caughtDefect);
        }
      };

      const uncertain: {
        mediaId: string;
        libraries: readonly LibraryPlacementOption[];
        error: unknown;
      }[] = [];
      mutated.forEach((outcome, index) => {
        const work = requireIndexedItem(eligible, index);
        if (outcome.kind === "Fulfilled") {
          apply({
            kind: "SetPlacement",
            mediaId: work.mediaId,
            placement: {
              kind: "Ready",
              libraries: projectLibraryPlacement(
                [...work.libraries],
                command.destination,
                command.kind === "Add"
                  ? { kind: "Direct" }
                  : { kind: "Absent" },
              ),
            },
          });
        } else if (!signal.aborted && !isAbortError(outcome.error)) {
          if (!isPlacementSettlementUnknown(outcome.error)) {
            failPlacement(work.mediaId, work.libraries, outcome.error);
            return;
          }
          uncertain.push({ ...work, error: outcome.error });
          apply({
            kind: "SetPlacement",
            mediaId: work.mediaId,
            placement: {
              kind: "Reconciling",
              libraries: work.libraries,
              command,
            },
          });
        }
      });

      const reconciled = await runBoundedTasks({
        items: uncertain,
        concurrency: MUTATION_CONCURRENCY,
        run: ({ mediaId }) =>
          listLibraryPlacements({ kind: "Media", id: mediaId }, { signal }),
      });
      if (generation !== generationRef.current) return;
      reconciled.forEach((outcome, index) => {
        const work = requireIndexedItem(uncertain, index);
        if (outcome.kind === "Rejected") {
          if (!signal.aborted && !isAbortError(outcome.error)) {
            failPlacement(work.mediaId, work.libraries, outcome.error);
          }
          return;
        }
        const commandKey = libraryPlacementDestinationKey(command.destination);
        const target = outcome.value.find(
          (placement) =>
            libraryPlacementDestinationKey(placement.destination) === commandKey,
        );
        const desired =
          command.kind === "Add"
            ? target?.relation.kind === "Direct"
            : target?.relation.kind === "Absent";
        if (desired) {
          // The command failed ambiguously but the authoritative re-read confirms
          // the intended placement was applied; publish so panes reconcile (the
          // failed command helper never reached its own success publish).
          apply({
            kind: "SetPlacement",
            mediaId: work.mediaId,
            placement: { kind: "Ready", libraries: outcome.value },
          });
          if (command.destination.kind === "Library") {
            publishLibraryPlacementChange([command.destination.library.id]);
          }
          try {
            addContentPlacementErrorMessage(work.error);
          } catch (caughtDefect: unknown) {
            defects.push(caughtDefect);
          }
        } else {
          try {
            const feedback = addContentPlacementErrorMessage(work.error);
            apply({
              kind: "SetPlacement",
              mediaId: work.mediaId,
              placement: {
                kind: "CommandFailed",
                libraries: outcome.value,
                command,
                feedback,
              },
            });
          } catch (caughtDefect: unknown) {
            apply({
              kind: "SetPlacement",
              mediaId: work.mediaId,
              placement: { kind: "Ready", libraries: outcome.value },
            });
            defects.push(caughtDefect);
          }
        }
      });
      placementProgressByMediaIdRef.current.clear();
      apply({ kind: "FinishMutation" });
      if (defects.length > 0) throw defects[0];
    },
    [apply],
  );

  const refreshPlacements = useCallback(
    async (mediaIds: readonly string[]) => {
      const current = stateRef.current;
      const accepted = new Set(acceptedMediaIds(current));
      const refreshWork: Array<{
        mediaId: string;
        previous: RestingPlacementState;
      }> = [];
      for (const mediaId of new Set(mediaIds)) {
        if (!accepted.has(mediaId)) continue;
        const previous = restingPlacementSnapshot(
          current.placementByMediaId.get(mediaId),
        );
        if (previous) refreshWork.push({ mediaId, previous });
      }
      if (refreshWork.length === 0) return;
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      for (const { mediaId, previous } of refreshWork) {
        apply({
          kind: "SetPlacement",
          mediaId,
          placement: { kind: "Loading", previous },
        });
      }
      const outcomes = await runBoundedTasks({
        items: refreshWork,
        concurrency: MUTATION_CONCURRENCY,
        run: ({ mediaId }) => {
          signal.throwIfAborted();
          return listLibraryPlacements(
            { kind: "Media", id: mediaId },
            { signal },
          );
        },
      });
      if (generation !== generationRef.current) return;

      const defects: unknown[] = [];
      outcomes.forEach((outcome, index) => {
        const { mediaId, previous } = requireIndexedItem(refreshWork, index);
        if (outcome.kind === "Fulfilled") {
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: { kind: "Ready", libraries: outcome.value },
          });
          return;
        }
        if (signal.aborted || isAbortError(outcome.error)) return;
        if (handleUnauthenticatedApiError(outcome.error)) {
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: previous,
          });
          return;
        }
        try {
          const feedback = addContentPlacementErrorMessage(
            outcome.error,
            "Libraries couldn’t be loaded",
          );
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: { kind: "LoadFailed", feedback },
          });
        } catch (caughtDefect: unknown) {
          apply({
            kind: "SetPlacement",
            mediaId,
            placement: previous,
          });
          defects.push(caughtDefect);
        }
      });
      if (defects.length > 0) throw defects[0];
    },
    [apply],
  );

  const createDestination = useCallback(
    async (name: string): Promise<LibraryDestinationSelection> => {
      const current = stateRef.current;
      if (current.mutation.kind !== "Idle") {
        throw new Error("Another Add operation is already running.");
      }
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      const normalizedName = name.trim();
      const libraryId =
        destinationCreateIdByNameRef.current.get(normalizedName) ??
        crypto.randomUUID();
      destinationCreateIdByNameRef.current.set(normalizedName, libraryId);
      apply({
        kind: "StartMutation",
        operation: { kind: "CreateDestination" },
      });
      try {
        const destination = await createLibrary({
          libraryId,
          name: normalizedName,
          signal,
        });
        if (generation !== generationRef.current || signal.aborted) {
          throw new DOMException(
            "Destination creation no longer belongs to the active Add session.",
            "AbortError",
          );
        }
        destinationCreateIdByNameRef.current.delete(normalizedName);
        return {
          id: destination.id,
          name: destination.name,
        };
      } finally {
        if (generation === generationRef.current)
          apply({ kind: "FinishMutation" });
      }
    },
    [apply],
  );

  return {
    state,
    dirty: isAddSessionDirty(state),
    start,
    setUrlText,
    reviewUrls,
    stageFiles,
    removeItem,
    restageItem,
    setDefaultDestinations,
    setItemDestinations,
    submit,
    reconcileAcceptance,
    refreshPlacements,
    runPlacement,
    createDestination,
    stop,
    discard,
  };
}
