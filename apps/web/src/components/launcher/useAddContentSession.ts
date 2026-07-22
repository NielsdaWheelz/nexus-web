"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { extractUrls } from "@/lib/extractUrls";
import type { AddSeed } from "@/lib/launcher/model";
import {
  createLibrary,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import {
  addMediaFromUrl,
  getFileUploadError,
  getFileUploadKind,
  matchesAcceptedUploadIdentity,
  uploadIngestFile,
  type AcceptedUploadIdentity,
  type SourceIngestResult,
  type UploadIngestResult,
} from "@/lib/media/ingestionClient";
import {
  ensureMediaAbsentFromLibrary,
  ensureMediaInLibraries,
  fetchMediaLibraryMemberships,
  patchLibraryMembership,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";
import {
  getPodcastOpmlFileError,
  importPodcastOpml,
  PodcastOpmlEncodingError,
} from "@/lib/podcasts/opmlImport";
import {
  ADD_SESSION_MAX_ITEMS,
  acceptanceErrorMessage,
  acceptedMediaIds,
  createAddSessionState,
  isAddSessionDirty,
  reduceAddSession,
  submitItemIds,
  type AddItem,
  type AddSessionAction,
  type AddSessionState,
  type FrozenAcceptanceIntent,
  type MembershipCommand,
  type MembershipMutationProgress,
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
  start(seed: AddSeed): void;
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
  openOpml(): void;
  backToContent(): void;
  setOpmlFile(file: File | null): void;
  setOpmlDestinations(
    destinations: readonly LibraryDestinationSelection[],
  ): void;
  submit(): Promise<void>;
  reconcileAcceptance(itemId: string): Promise<void>;
  importOpml(): Promise<void>;
  refreshMemberships(mediaIds: readonly string[]): Promise<void>;
  runMembership(input: {
    mediaIds: readonly string[];
    command: MembershipCommand;
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
  result: SourceIngestResult,
): AddItem {
  return { kind: "Accepted", id, source: sourceSummary(intent), result };
}

function acceptedUncertainItem(
  id: string,
  intent: FrozenAcceptanceIntent & {
    source: Extract<FrozenAcceptanceIntent["source"], { kind: "File" }>;
  },
  result: Extract<UploadIngestResult, { kind: "AcceptedUncertain" }>,
): AddItem {
  return {
    kind: "AcceptedUncertain",
    id,
    intent,
    mediaId: result.mediaId,
    sourceAttemptId: result.sourceAttemptId,
    feedback: result.feedback,
  };
}

function membershipErrorMessage(
  error: unknown,
  fallback = "Libraries could not be updated.",
): FeedbackContent | null {
  if (isSameSystemApiDefect(error)) return null;
  if (
    isApiError(error) ||
    error instanceof TypeError ||
    error instanceof DOMException
  ) {
    return toFeedback(error, { fallback });
  }
  return null;
}

function requireIndexedItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error("Bounded task outcome did not match its input item.");
  }
  return item;
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
  const acceptedUploadIdentityByItemIdRef = useRef(
    new Map<string, AcceptedUploadIdentity>(),
  );
  const startedSubmissionItemIdsRef = useRef(new Set<string>());
  const membershipProgressByMediaIdRef = useRef(
    new Map<string, MembershipMutationProgress>(),
  );

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
      acceptedUploadIdentityByItemIdRef.current.clear();
      startedSubmissionItemIdsRef.current.clear();
      membershipProgressByMediaIdRef.current.clear();
      apply({
        kind: "Reset",
        state: createAddSessionState({
          seed,
          sessionId: createRandomId("add-session"),
        }),
      });
    },
    [apply],
  );

  const discard = useCallback(() => {
    sessionAbortRef.current.abort();
    sessionAbortRef.current = new AbortController();
    generationRef.current += 1;
    acceptedUploadIdentityByItemIdRef.current.clear();
    startedSubmissionItemIdsRef.current.clear();
    membershipProgressByMediaIdRef.current.clear();
    apply({
      kind: "Reset",
      state: createAddSessionState({
        seed: EMPTY_SEED,
        sessionId: createRandomId("add-session"),
      }),
    });
  }, [apply]);

  const stop = useCallback(() => {
    sessionAbortRef.current.abort();
    sessionAbortRef.current = new AbortController();
    generationRef.current += 1;
    apply({
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(
        acceptedUploadIdentityByItemIdRef.current,
      ),
      startedSubmissionItemIds: new Set(startedSubmissionItemIdsRef.current),
      membershipProgressByMediaId: new Map(
        membershipProgressByMediaIdRef.current,
      ),
      acceptanceFeedback: {
        severity: "warning",
        title: "Stopped · acceptance status unknown",
        message: "Server changes that already committed may remain.",
      },
      operationFeedback: {
        severity: "warning",
        title: "Stopped before completion",
        message: "Server changes that already committed may remain.",
      },
    });
    acceptedUploadIdentityByItemIdRef.current.clear();
    startedSubmissionItemIdsRef.current.clear();
    membershipProgressByMediaIdRef.current.clear();
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
          severity: "error",
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
              severity: "error",
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

  const openOpml = useCallback(() => {
    if (stateRef.current.mutation.kind === "Idle") apply({ kind: "OpenOpml" });
  }, [apply]);

  const backToContent = useCallback(() => {
    if (stateRef.current.mutation.kind === "Idle")
      apply({ kind: "BackToContent" });
  }, [apply]);

  const setOpmlFile = useCallback(
    (file: File | null) => {
      if (stateRef.current.mutation.kind !== "Idle") return;
      if (file === null) {
        apply({ kind: "SetOpml", opml: { kind: "Empty" } });
        return;
      }
      const error = getPodcastOpmlFileError(file);
      apply({
        kind: "SetOpml",
        opml: error
          ? {
              kind: "Invalid",
              input: { kind: "File", file },
              feedback: { severity: "error", title: error },
            }
          : { kind: "Ready", file },
      });
    },
    [apply],
  );

  const setOpmlDestinations = useCallback(
    (destinations: readonly LibraryDestinationSelection[]) => {
      if (stateRef.current.mutation.kind === "Idle") {
        apply({ kind: "SetOpmlDestinations", destinations });
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
    acceptedUploadIdentityByItemIdRef.current.clear();
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
          onAcceptedIdentity: (identity) => {
            if (generation === generationRef.current) {
              acceptedUploadIdentityByItemIdRef.current.set(item.id, identity);
            }
          },
        });
        if (generation !== generationRef.current) return;
        apply({
          kind: "ResolveItem",
          item:
            result.kind === "Accepted"
              ? acceptedItem(item.id, item, result.result)
              : acceptedUncertainItem(
                  item.id,
                  { ...item, source: item.source },
                  result,
                ),
        });
      },
    });
    if (generation !== generationRef.current) return;

    const defects: unknown[] = [];
    let acceptedIdentityBlocked = false;
    outcomes.forEach((outcome, index) => {
      const item = requireIndexedItem(items, index);
      if (outcome.kind === "Fulfilled") {
        return;
      }
      if (signal.aborted || isAbortError(outcome.error)) return;
      const identity = acceptedUploadIdentityByItemIdRef.current.get(item.id);
      if (identity && item.source.kind === "File") {
        if (handleUnauthenticatedApiError(outcome.error)) {
          acceptedIdentityBlocked = true;
          return;
        }
        const failure = acceptanceErrorMessage(outcome.error);
        if (failure.kind === "Defect") {
          // Keep the gate fail-closed and preserve the accepted identity for the
          // explicit Stop path. A same-system defect is not an uncertainty outcome.
          acceptedIdentityBlocked = true;
          defects.push(failure.error);
        } else {
          apply({
            kind: "ResolveItem",
            item: acceptedUncertainItem(
              item.id,
              { ...item, source: item.source },
              {
                kind: "AcceptedUncertain",
                ...identity,
                feedback: { ...failure.feedback, severity: "warning" },
              },
            ),
          });
        }
        return;
      }
      if (handleUnauthenticatedApiError(outcome.error)) {
        apply({
          kind: "ResolveItem",
          item: {
            kind: "Rejected",
            id: item.id,
            intent: item,
            feedback: toFeedback(outcome.error, {
              fallback: "Authentication required.",
            }),
          },
        });
        return;
      }
      const failure = acceptanceErrorMessage(outcome.error);
      if (failure.kind === "Defect") {
        apply({ kind: "ResolveItem", item });
        defects.push(failure.error);
      } else {
        apply({
          kind: "ResolveItem",
          item: {
            kind:
              failure.kind === "Rejected" ? "Rejected" : "AcceptanceUnresolved",
            id: item.id,
            intent: item,
            feedback: failure.feedback,
          },
        });
      }
    });
    if (!acceptedIdentityBlocked) {
      acceptedUploadIdentityByItemIdRef.current.clear();
      startedSubmissionItemIdsRef.current.clear();
      apply({ kind: "FinishMutation" });
    }
    if (defects.length > 0) throw defects[0];
  }, [apply]);

  const reconcileAcceptance = useCallback(
    async (itemId: string) => {
      const current = stateRef.current;
      if (current.mutation.kind !== "Idle") return;
      const item = current.items.find((candidate) => candidate.id === itemId);
      if (
        !item ||
        (item.kind !== "AcceptanceUnresolved" &&
          item.kind !== "AcceptedUncertain")
      ) {
        return;
      }
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      const operation: SessionMutationOperation = {
        kind: "ReconcileAcceptance",
        itemId,
      };
      acceptedUploadIdentityByItemIdRef.current.clear();
      if (
        item.kind === "AcceptedUncertain" &&
        item.intent.source.kind === "File"
      ) {
        acceptedUploadIdentityByItemIdRef.current.set(item.id, {
          mediaId: item.mediaId,
          sourceAttemptId: item.sourceAttemptId,
        });
      }
      apply({ kind: "StartMutation", operation });
      let defect: unknown;
      let acceptedIdentityBlocked = false;
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
            onAcceptedIdentity: (identity) => {
              if (generation === generationRef.current) {
                acceptedUploadIdentityByItemIdRef.current.set(
                  item.id,
                  identity,
                );
              }
            },
          });
          if (generation !== generationRef.current) return;
          if (
            item.kind === "AcceptedUncertain" &&
            !matchesAcceptedUploadIdentity(result, item)
          ) {
            // justify-defect: same-key upload replay must preserve both durable identity fields.
            throw new Error("Upload reconciliation changed accepted identity.");
          }
          apply({
            kind: "ResolveItem",
            item:
              result.kind === "Accepted"
                ? acceptedItem(item.id, item.intent, result.result)
                : acceptedUncertainItem(
                    item.id,
                    { ...item.intent, source: item.intent.source },
                    result,
                  ),
          });
        }
      } catch (error) {
        if (
          generation !== generationRef.current ||
          signal.aborted ||
          isAbortError(error)
        )
          return;
        const identity = acceptedUploadIdentityByItemIdRef.current.get(item.id);
        if (identity && item.intent.source.kind === "File") {
          if (handleUnauthenticatedApiError(error)) {
            acceptedIdentityBlocked = true;
            return;
          }
          const failure = acceptanceErrorMessage(error);
          if (failure.kind === "Defect") {
            acceptedIdentityBlocked = true;
            defect = failure.error;
          } else {
            apply({
              kind: "ResolveItem",
              item: acceptedUncertainItem(
                item.id,
                { ...item.intent, source: item.intent.source },
                {
                  kind: "AcceptedUncertain",
                  ...identity,
                  feedback: { ...failure.feedback, severity: "warning" },
                },
              ),
            });
          }
        } else if (handleUnauthenticatedApiError(error)) {
          return;
        } else {
          const failure = acceptanceErrorMessage(error);
          if (failure.kind === "Defect") {
            defect = failure.error;
          } else if (item.kind === "AcceptedUncertain") {
            apply({
              kind: "ResolveItem",
              item: {
                ...item,
                feedback: { ...failure.feedback, severity: "warning" },
              },
            });
          } else {
            apply({
              kind: "ResolveItem",
              item: {
                kind:
                  failure.kind === "Rejected"
                    ? "Rejected"
                    : "AcceptanceUnresolved",
                id: item.id,
                intent: item.intent,
                feedback: failure.feedback,
              },
            });
          }
        }
      } finally {
        if (generation === generationRef.current && !acceptedIdentityBlocked) {
          acceptedUploadIdentityByItemIdRef.current.clear();
          apply({ kind: "FinishMutation" });
        }
      }
      if (defect !== undefined) throw defect;
    },
    [apply],
  );

  const importOpml = useCallback(async () => {
    const current = stateRef.current;
    if (current.mutation.kind !== "Idle") return;
    if (current.opml.kind !== "Ready" && current.opml.kind !== "Failed") {
      apply({
        kind: "SetOpml",
        opml: {
          kind: "Invalid",
          input: { kind: "NoFile" },
          feedback: { severity: "error", title: "Choose an OPML or XML file." },
        },
      });
      return;
    }
    const file = current.opml.file;
    const generation = generationRef.current;
    const signal = sessionAbortRef.current.signal;
    apply({ kind: "StartMutation", operation: { kind: "ImportOpml" } });
    apply({ kind: "SetOpml", opml: { kind: "Importing", file } });
    let defect: unknown;
    try {
      const result = await importPodcastOpml({
        file,
        libraryIds: current.opmlDestinations.map(
          (destination) => destination.id,
        ),
        signal,
      });
      if (generation === generationRef.current) {
        apply({
          kind: "SetOpml",
          opml: {
            kind: "Complete",
            file: {
              kind: "File",
              name: file.name,
              sizeBytes: file.size,
              fileKind: "Opml",
            },
            result,
          },
        });
      }
    } catch (error) {
      if (
        generation !== generationRef.current ||
        signal.aborted ||
        isAbortError(error)
      )
        return;
      if (isSameSystemApiDefect(error)) {
        apply({ kind: "SetOpml", opml: current.opml });
        defect = error;
      } else if (handleUnauthenticatedApiError(error)) {
        apply({ kind: "SetOpml", opml: current.opml });
        return;
      } else if (error instanceof PodcastOpmlEncodingError) {
        apply({
          kind: "SetOpml",
          opml: {
            kind: "Failed",
            file,
            feedback: { severity: "error", title: error.message },
          },
        });
      } else if (
        isApiError(error) ||
        error instanceof TypeError ||
        error instanceof DOMException
      ) {
        apply({
          kind: "SetOpml",
          opml: {
            kind: "Failed",
            file,
            feedback: toFeedback(error, {
              fallback: "OPML could not be imported.",
            }),
          },
        });
      } else {
        apply({ kind: "SetOpml", opml: current.opml });
        defect = error;
      }
    } finally {
      if (generation === generationRef.current)
        apply({ kind: "FinishMutation" });
    }
    if (defect !== undefined) throw defect;
  }, [apply]);

  const runMembership = useCallback(
    async ({
      mediaIds,
      command,
    }: {
      mediaIds: readonly string[];
      command: MembershipCommand;
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
      membershipProgressByMediaIdRef.current.clear();
      apply({
        kind: "StartMutation",
        operation: { kind: "Membership", command, mediaIds: uniqueMediaIds },
      });
      const defects: unknown[] = [];
      const loaded = await runBoundedTasks({
        items: uniqueMediaIds,
        concurrency: MUTATION_CONCURRENCY,
        run: (mediaId) => {
          signal.throwIfAborted();
          return fetchMediaLibraryMemberships(mediaId, { signal });
        },
      });
      if (generation !== generationRef.current) return;

      const eligible: {
        mediaId: string;
        libraries: readonly LibraryTargetPickerItem[];
      }[] = [];
      loaded.forEach((outcome, index) => {
        const mediaId = requireIndexedItem(uniqueMediaIds, index);
        if (outcome.kind === "Rejected") {
          if (!signal.aborted && !isAbortError(outcome.error)) {
            if (handleUnauthenticatedApiError(outcome.error)) return;
            const feedback = membershipErrorMessage(
              outcome.error,
              "Libraries could not be loaded.",
            );
            if (feedback === null) {
              defects.push(outcome.error);
            } else {
              apply({
                kind: "SetMembership",
                mediaId,
                membership: { kind: "LoadFailed", feedback },
              });
            }
          }
          return;
        }
        const libraries = outcome.value;
        apply({
          kind: "SetMembership",
          mediaId,
          membership: { kind: "Ready", libraries },
        });
        const target = libraries.find(
          (library) => library.id === command.libraryId,
        );
        const canRun =
          command.kind === "Add"
            ? target?.canAdd === true && !target.isInLibrary
            : target?.canRemove === true && target.isInLibrary;
        if (canRun) eligible.push({ mediaId, libraries });
      });

      for (const work of eligible) {
        membershipProgressByMediaIdRef.current.set(work.mediaId, {
          phase: "Queued",
          libraries: work.libraries,
          command,
        });
        apply({
          kind: "SetMembership",
          mediaId: work.mediaId,
          membership: { kind: "Updating", libraries: work.libraries, command },
        });
      }
      const mutated = await runBoundedTasks({
        items: eligible,
        concurrency: MUTATION_CONCURRENCY,
        run: async ({ mediaId }) => {
          signal.throwIfAborted();
          const progress = membershipProgressByMediaIdRef.current.get(mediaId);
          if (generation === generationRef.current && progress) {
            membershipProgressByMediaIdRef.current.set(mediaId, {
              ...progress,
              phase: "Started",
            });
          }
          if (command.kind === "Add") {
            await ensureMediaInLibraries({
              mediaId,
              libraryIds: [command.libraryId],
              signal,
            });
          } else {
            await ensureMediaAbsentFromLibrary({
              mediaId,
              libraryId: command.libraryId,
              signal,
            });
          }
          const started = membershipProgressByMediaIdRef.current.get(mediaId);
          if (generation === generationRef.current && started) {
            membershipProgressByMediaIdRef.current.set(mediaId, {
              ...started,
              phase: "Succeeded",
            });
          }
        },
      });
      if (generation !== generationRef.current) return;

      const uncertain: {
        mediaId: string;
        libraries: readonly LibraryTargetPickerItem[];
        error: unknown;
      }[] = [];
      mutated.forEach((outcome, index) => {
        const work = requireIndexedItem(eligible, index);
        if (outcome.kind === "Fulfilled") {
          apply({
            kind: "SetMembership",
            mediaId: work.mediaId,
            membership: {
              kind: "Ready",
              libraries: patchLibraryMembership(
                [...work.libraries],
                command.libraryId,
                command.kind === "Add",
              ),
            },
          });
        } else if (!signal.aborted && !isAbortError(outcome.error)) {
          uncertain.push({ ...work, error: outcome.error });
          apply({
            kind: "SetMembership",
            mediaId: work.mediaId,
            membership: {
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
        run: ({ mediaId }) => fetchMediaLibraryMemberships(mediaId, { signal }),
      });
      if (generation !== generationRef.current) return;
      reconciled.forEach((outcome, index) => {
        const work = requireIndexedItem(uncertain, index);
        if (outcome.kind === "Rejected") {
          if (!signal.aborted && !isAbortError(outcome.error)) {
            if (handleUnauthenticatedApiError(outcome.error)) {
              apply({
                kind: "SetMembership",
                mediaId: work.mediaId,
                membership: { kind: "Ready", libraries: work.libraries },
              });
              return;
            }
            const feedback = membershipErrorMessage(outcome.error);
            if (feedback === null) {
              apply({
                kind: "SetMembership",
                mediaId: work.mediaId,
                membership: { kind: "Ready", libraries: work.libraries },
              });
              defects.push(outcome.error);
            } else {
              apply({
                kind: "SetMembership",
                mediaId: work.mediaId,
                membership: {
                  kind: "CommandFailed",
                  libraries: work.libraries,
                  command,
                  feedback,
                },
              });
            }
          }
          return;
        }
        const target = outcome.value.find(
          (library) => library.id === command.libraryId,
        );
        const desired =
          command.kind === "Add"
            ? target?.isInLibrary === true
            : !target?.isInLibrary;
        if (desired) {
          apply({
            kind: "SetMembership",
            mediaId: work.mediaId,
            membership: { kind: "Ready", libraries: outcome.value },
          });
          if (membershipErrorMessage(work.error) === null) {
            defects.push(work.error);
          }
        } else {
          const feedback = membershipErrorMessage(work.error);
          if (feedback === null) {
            apply({
              kind: "SetMembership",
              mediaId: work.mediaId,
              membership: { kind: "Ready", libraries: outcome.value },
            });
            defects.push(work.error);
          } else {
            apply({
              kind: "SetMembership",
              mediaId: work.mediaId,
              membership: {
                kind: "CommandFailed",
                libraries: outcome.value,
                command,
                feedback,
              },
            });
          }
        }
      });
      membershipProgressByMediaIdRef.current.clear();
      apply({ kind: "FinishMutation" });
      if (defects.length > 0) throw defects[0];
    },
    [apply],
  );

  const refreshMemberships = useCallback(
    async (mediaIds: readonly string[]) => {
      const current = stateRef.current;
      const accepted = new Set(acceptedMediaIds(current));
      const uniqueMediaIds = [...new Set(mediaIds)].filter((mediaId) => {
        const membership = current.membershipByMediaId.get(mediaId);
        return (
          accepted.has(mediaId) &&
          membership?.kind !== "Loading" &&
          membership?.kind !== "Updating" &&
          membership?.kind !== "Reconciling"
        );
      });
      if (uniqueMediaIds.length === 0) return;
      const generation = generationRef.current;
      const signal = sessionAbortRef.current.signal;
      for (const mediaId of uniqueMediaIds) {
        const previous =
          current.membershipByMediaId.get(mediaId) ??
          ({ kind: "Unloaded" } as const);
        apply({
          kind: "SetMembership",
          mediaId,
          membership: { kind: "Loading", previous },
        });
      }
      const outcomes = await runBoundedTasks({
        items: uniqueMediaIds,
        concurrency: MUTATION_CONCURRENCY,
        run: (mediaId) => {
          signal.throwIfAborted();
          return fetchMediaLibraryMemberships(mediaId, { signal });
        },
      });
      if (generation !== generationRef.current) return;

      const defects: unknown[] = [];
      outcomes.forEach((outcome, index) => {
        const mediaId = requireIndexedItem(uniqueMediaIds, index);
        if (outcome.kind === "Fulfilled") {
          apply({
            kind: "SetMembership",
            mediaId,
            membership: { kind: "Ready", libraries: outcome.value },
          });
          return;
        }
        if (signal.aborted || isAbortError(outcome.error)) return;
        const previousMembership =
          current.membershipByMediaId.get(mediaId) ??
          ({ kind: "Unloaded" } as const);
        if (handleUnauthenticatedApiError(outcome.error)) {
          apply({
            kind: "SetMembership",
            mediaId,
            membership: previousMembership,
          });
          return;
        }
        const feedback = membershipErrorMessage(
          outcome.error,
          "Libraries could not be loaded.",
        );
        if (feedback === null) {
          apply({
            kind: "SetMembership",
            mediaId,
            membership: previousMembership,
          });
          defects.push(outcome.error);
        } else {
          apply({
            kind: "SetMembership",
            mediaId,
            membership: { kind: "LoadFailed", feedback },
          });
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
      apply({
        kind: "StartMutation",
        operation: { kind: "CreateDestination" },
      });
      try {
        const destination = await createLibrary({ name, signal });
        if (generation !== generationRef.current || signal.aborted) {
          throw new DOMException(
            "Destination creation no longer belongs to the active Add session.",
            "AbortError",
          );
        }
        return {
          id: destination.id,
          name: destination.name,
          color: destination.color,
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
    openOpml,
    backToContent,
    setOpmlFile,
    setOpmlDestinations,
    submit,
    reconcileAcceptance,
    importOpml,
    refreshMemberships,
    runMembership,
    createDestination,
    stop,
    discard,
  };
}
