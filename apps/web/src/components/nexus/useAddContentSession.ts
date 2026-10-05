"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
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
  UploadSessionError,
  type AcceptedIngestResult,
  type UploadFileKind,
  type UploadPhase,
} from "@/lib/media/ingestionClient";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import {
  addLibraryPlacement,
  libraryPlacementDestinationKey,
  listLibraryPlacements,
  projectLibraryPlacement,
  removeLibraryPlacement,
  type LibraryPlacementDestination,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import {
  IMPORTS_CONFLICT_MESSAGE,
  UPLOAD_REJECTED_LABEL,
  uploadVerificationFailureCopy,
} from "@/lib/status/imports";

const MAX_ITEMS = 20;
const EMPTY_SEED: AddSeed = { kind: "Content", initialFocus: "Url", initialDestinations: [] };

type AddSource =
  | { kind: "Url"; url: string }
  | { kind: "File"; file: File; fileKind: UploadFileKind };

type FileSummary = { kind: "File"; name: string; sizeBytes: number; fileKind: UploadFileKind | "Unsupported" };
type SourceSummary = Extract<AddSource, { kind: "Url" }> | FileSummary;
type AcceptanceIntent = Readonly<{
  source: AddSource;
  destinations: readonly LibraryDestinationSelection[];
  idempotencyKey: string;
}>;
type FileIntent = AcceptanceIntent & { source: Extract<AddSource, { kind: "File" }> };
type UrlIntent = AcceptanceIntent & { source: Extract<AddSource, { kind: "Url" }> };

export type AddItem =
  | { kind: "Invalid"; id: string; source: FileSummary; feedback: FeedbackContent }
  | { kind: "Draft"; id: string; intent: AcceptanceIntent }
  | { kind: "Queued"; id: string; intent: AcceptanceIntent }
  | { kind: "Submitting"; id: string; intent: FileIntent; phase: UploadPhase }
  | { kind: "Submitting"; id: string; intent: UrlIntent; phase: "Saving" | "Checking" }
  | { kind: "Rejected"; id: string; intent: AcceptanceIntent; feedback: FeedbackContent }
  | {
      kind: "AcceptanceUnresolved";
      id: string;
      intent: AcceptanceIntent;
      reason: "StatusUnknown" | "UploadIncomplete";
      feedback: FeedbackContent;
    }
  | { kind: "Accepted"; id: string; source: SourceSummary; result: AcceptedIngestResult };

export type PlacementCommand = { kind: "Add" | "Remove"; destination: LibraryPlacementDestination };
type PlacementWork = { libraries: readonly LibraryPlacementOption[]; command: PlacementCommand };
type RestingPlacement =
  | { kind: "Ready"; libraries: readonly LibraryPlacementOption[] }
  | { kind: "LoadFailed"; feedback: FeedbackContent }
  | { kind: "Unavailable"; feedback: FeedbackContent }
  | { kind: "Refused"; libraries: readonly LibraryPlacementOption[]; feedback: FeedbackContent }
  | ({ kind: "Uncertain"; feedback: FeedbackContent } & PlacementWork);

export type PlacementState =
  | RestingPlacement
  | { kind: "Loading"; previous: RestingPlacement | null }
  | { kind: "Queued"; previous: RestingPlacement | null; command: PlacementCommand }
  | ({ kind: "Updating" } & PlacementWork);

type Mutation =
  | { kind: "Idle" }
  | {
      kind: "Running";
      operation:
        | { kind: "Submit"; itemIds: readonly string[] }
        | { kind: "ReconcileAcceptance"; itemId: string }
        | { kind: "CreateDestination" }
        | { kind: "Placement"; mediaIds: readonly string[] };
    };

export type AddSessionState = Readonly<{
  sessionId: string;
  initialFocus: "Url" | "File";
  urlInput: { text: string; feedback?: FeedbackContent };
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  defaultDestinations: readonly LibraryDestinationSelection[];
  placementByMediaId: ReadonlyMap<string, PlacementState>;
  mutation: Mutation;
}>;

export interface AddContentSessionController {
  readonly state: AddSessionState;
  readonly dirty: boolean;
  start(seed: AddSeed): string;
  setUrlText(text: string): void;
  reviewUrls(): boolean;
  stageFiles(files: readonly File[]): boolean;
  removeItem(itemId: string): void;
  restageItem(itemId: string): void;
  setDefaultDestinations(destinations: readonly LibraryDestinationSelection[]): void;
  setItemDestinations(itemId: string, destinations: readonly LibraryDestinationSelection[]): void;
  submit(): Promise<void>;
  reconcileAcceptance(itemId: string): Promise<void>;
  refreshPlacements(mediaIds: readonly string[]): Promise<void>;
  runPlacement(input: { mediaIds: readonly string[]; command: PlacementCommand }): Promise<void>;
  retryPlacements(mediaIds: readonly string[]): Promise<void>;
  createDestination(name: string): Promise<LibraryDestinationSelection>;
  createAndPlace(input: { name: string; mediaIds: readonly string[] }): Promise<void>;
  stop(): void;
  discard(): void;
}

function initialState(seed: AddSeed): AddSessionState {
  return {
    sessionId: createRandomId("add-session"),
    initialFocus: seed.initialFocus,
    urlInput: { text: seed.initialUrlDraft ?? "" },
    items: [],
    defaultDestinations: [...seed.initialDestinations],
    placementByMediaId: new Map(),
    mutation: { kind: "Idle" },
  };
}

function acceptanceFailure(error: unknown):
  | { kind: "Rejected"; feedback: FeedbackContent }
  | { kind: "AcceptanceUnresolved"; reason: "StatusUnknown" | "UploadIncomplete"; feedback: FeedbackContent }
  | { kind: "Superseded" } {
  const rejected = (message: string) => ({
    kind: "Rejected" as const,
    feedback: { tone: "Danger" as const, title: "Couldn’t save", message },
  });
  const unresolved = (requestId?: string) => ({
    kind: "AcceptanceUnresolved" as const,
    reason: "StatusUnknown" as const,
    feedback: {
      tone: "Warning" as const,
      title: "Couldn’t confirm",
      message: "Nexus could not confirm whether this was saved. Check status to find out.",
      requestId,
    },
  });
  if (error instanceof UploadSessionError) {
    switch (error.outcome.kind) {
      case "NeedsAttention":
        return {
          kind: "Rejected",
          feedback: {
            tone: "Warning",
            title: "Upload needs attention",
            message: "Use Imports for the available next step, or restage this file as a new import.",
          },
        };
      case "VerificationRejected":
        return {
          kind: "Rejected",
          feedback: {
            tone: "Danger",
            title: UPLOAD_REJECTED_LABEL,
            message: uploadVerificationFailureCopy(error.outcome.code),
          },
        };
      case "BytesMissing":
        return {
          kind: "AcceptanceUnresolved",
          reason: "UploadIncomplete",
          feedback: {
            tone: "Warning",
            title: "Upload didn’t complete",
            message: "Nexus never received this file. Retry the upload, or remove it and start a new import.",
          },
        };
      case "Superseded":
        return { kind: "Superseded" };
      case "Conflicted":
        return rejected(IMPORTS_CONFLICT_MESSAGE);
      case "Unresolved":
        return unresolved();
      case "UnsupportedFileType":
        return rejected("This file type isn’t supported. Start a new import with a PDF or EPUB.");
      case "FileTooLarge":
        return rejected("This file exceeds the import limit. Start a new import with a smaller file.");
      case "LibraryForbidden":
        return rejected("You no longer have access to a destination library. Choose different libraries and start a new import.");
      case "IntentChanged":
        return rejected("This import changed. Start a new import.");
      case "FileMismatch":
        return rejected("That file doesn’t match this import. Choose the same file, or start a new import.");
      case "IntentMalformed":
        throw error;
    }
    return assertNever(error.outcome, "Unreachable upload outcome");
  }
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  if (
    error.status >= 500 || error.code === "E_NETWORK" ||
    error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT"
  ) return unresolved(error.requestId);
  return { kind: "Rejected", feedback: mediaCaptureErrorMessage(error, "SaveSource") };
}

export function useAddContentSession(): AddContentSessionController {
  const [state, setState] = useState(() => initialState(EMPTY_SEED));
  const current = useRef(state);
  const abort = useRef(new AbortController());
  const createIds = useRef(new Map<string, string>());

  function update(change: (snapshot: AddSessionState) => AddSessionState) {
    current.current = change(current.current);
    setState(current.current);
  }
  function item(next: AddItem) {
    update((snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((row) => row.id === next.id ? next : row),
    }));
  }
  function placement(mediaId: string, next: PlacementState | null) {
    update((snapshot) => {
      const placements = new Map(snapshot.placementByMediaId);
      if (next === null) placements.delete(mediaId);
      else placements.set(mediaId, next);
      return { ...snapshot, placementByMediaId: placements };
    });
  }
  function active(signal: AbortSignal) {
    return signal === abort.current.signal && !signal.aborted;
  }
  async function batch<T>(items: readonly T[], signal: AbortSignal, run: (value: T) => Promise<void>) {
    const outcomes = await runBoundedTasks({
      items,
      concurrency: 2,
      run: async (value) => {
        signal.throwIfAborted();
        await run(value);
      },
    });
    if (!active(signal)) return;
    update((snapshot) => ({ ...snapshot, mutation: { kind: "Idle" } }));
    const failed = outcomes.find((outcome) => outcome.kind === "Rejected");
    if (failed?.kind === "Rejected") throw failed.error;
  }

  useEffect(() => () => abort.current.abort(), []);
  useEffect(() => {
    if (state.mutation.kind !== "Running") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.mutation.kind]);

  function start(seed: AddSeed) {
    abort.current.abort();
    abort.current = new AbortController();
    createIds.current.clear();
    const next = initialState(seed);
    update(() => next);
    return next.sessionId;
  }
  function stop() {
    abort.current.abort();
    abort.current = new AbortController();
    update((snapshot) => ({
      ...snapshot,
      mutation: { kind: "Idle" },
      items: snapshot.items.map((row): AddItem => {
        if (row.kind === "Queued") return { kind: "Draft", id: row.id, intent: row.intent };
        if (row.kind !== "Submitting") return row;
        return row.intent.source.kind === "File"
          ? {
              kind: "Rejected", id: row.id, intent: row.intent,
              feedback: {
                tone: "Warning", title: "Upload stopped",
                message: "Use Imports to retry or remove any accepted upload, or restage this file as a new import.",
              },
            }
          : {
              kind: "AcceptanceUnresolved", id: row.id, intent: row.intent, reason: "StatusUnknown",
              feedback: {
                tone: "Warning", title: "Stopped · acceptance status unknown",
                message: "Server changes that already committed may remain.",
              },
            };
      }),
      placementByMediaId: new Map(
        [...snapshot.placementByMediaId].flatMap(([mediaId, row]): [string, PlacementState][] => {
          if (row.kind === "Loading") return row.previous ? [[mediaId, row.previous]] : [];
          if (row.kind === "Queued") return row.previous ? [[mediaId, row.previous]] : [];
          if (row.kind !== "Updating") return [[mediaId, row]];
          return [[mediaId, {
            kind: "Uncertain", libraries: row.libraries, command: row.command,
            feedback: {
              tone: "Warning", title: "Stopped before completion",
              message: "Server changes that already committed may remain.",
            },
          }]];
        }),
      ),
    }));
  }
  function setUrlText(text: string) {
    if (current.current.mutation.kind === "Idle") {
      update((snapshot) => ({ ...snapshot, urlInput: { text } }));
    }
  }
  function stage(items: readonly AddItem[], source: "Url" | "File") {
    const snapshot = current.current;
    if (snapshot.items.length + items.length > MAX_ITEMS) {
      const feedback: FeedbackContent = { tone: "Danger", title: "Add up to 20 items at a time." };
      update((next) => source === "Url"
        ? { ...next, urlInput: { ...next.urlInput, feedback } }
        : { ...next, intakeFeedback: feedback });
      return false;
    }
    update((next) => ({
      ...next,
      urlInput: source === "Url" ? { text: "" } : next.urlInput,
      intakeFeedback: undefined,
      items: [...next.items, ...items],
    }));
    return true;
  }
  function reviewUrls() {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return false;
    const urls = extractUrls(snapshot.urlInput.text);
    if (urls.length === 0) {
      update((next) => ({
        ...next,
        urlInput: { ...next.urlInput, feedback: { tone: "Danger", title: "Paste one or more http:// or https:// URLs." } },
      }));
      return false;
    }
    return stage(urls.map((url) => ({
      kind: "Draft", id: createRandomId("add-item"),
      intent: {
        source: { kind: "Url", url },
        destinations: [...snapshot.defaultDestinations],
        idempotencyKey: createRandomId("media-url"),
      },
    })), "Url");
  }
  function stageFiles(files: readonly File[]) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle" || files.length === 0) return false;
    return stage(files.map((file): AddItem => {
      const fileKind = getFileUploadKind(file);
      const error = getFileUploadError(file);
      if (error || fileKind === null) {
        return {
          kind: "Invalid", id: createRandomId("add-item"),
          source: { kind: "File", name: file.name, sizeBytes: file.size, fileKind: fileKind ?? "Unsupported" },
          feedback: { tone: "Danger", title: error ?? "Only PDF and EPUB files are supported." },
        };
      }
      return {
        kind: "Draft", id: createRandomId("add-item"),
        intent: {
          source: { kind: "File", file, fileKind },
          destinations: [...snapshot.defaultDestinations],
          idempotencyKey: createRandomId("media-upload"),
        },
      };
    }), "File");
  }
  function removeItem(itemId: string) {
    if (current.current.mutation.kind !== "Idle") return;
    update((snapshot) => {
      const items = snapshot.items.filter((row) => row.id !== itemId);
      const retained = new Set(items.flatMap((row) => row.kind === "Accepted" ? [row.result.mediaId] : []));
      return {
        ...snapshot, items,
        placementByMediaId: new Map([...snapshot.placementByMediaId].filter(([mediaId]) => retained.has(mediaId))),
      };
    });
  }
  function restageItem(itemId: string) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind !== "Rejected" && row?.kind !== "AcceptanceUnresolved") return;
    item({ kind: "Draft", id: row.id, intent: { ...row.intent, idempotencyKey: createRandomId("media-restage") } });
  }
  function setDefaultDestinations(destinations: readonly LibraryDestinationSelection[]) {
    if (current.current.mutation.kind !== "Idle") return;
    update((snapshot) => ({
      ...snapshot, defaultDestinations: [...destinations],
      items: snapshot.items.map((row) => row.kind === "Draft"
        ? { ...row, intent: { ...row.intent, destinations: [...destinations] } } : row),
    }));
  }
  function setItemDestinations(itemId: string, destinations: readonly LibraryDestinationSelection[]) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind === "Draft") item({ ...row, intent: { ...row.intent, destinations: [...destinations] } });
  }

  async function accept(row: Extract<AddItem, { kind: "Draft" | "AcceptanceUnresolved" }>, signal: AbortSignal) {
    if (!active(signal)) return;
    const { id, intent } = row;
    try {
      const libraryIds = intent.destinations.map((destination) => destination.id);
      let result: AcceptedIngestResult;
      if (intent.source.kind === "Url") {
        const urlIntent: UrlIntent = { ...intent, source: intent.source };
        item({ kind: "Submitting", id, intent: urlIntent, phase: row.kind === "AcceptanceUnresolved" ? "Checking" : "Saving" });
        result = await addMediaFromUrl({
          url: intent.source.url, libraryIds, idempotencyKey: intent.idempotencyKey, signal,
        });
      } else {
        const fileIntent: FileIntent = { ...intent, source: intent.source };
        item({ kind: "Submitting", id, intent: fileIntent, phase: "Preparing" });
        result = await uploadIngestFile({
          file: intent.source.file, libraryIds, idempotencyKey: intent.idempotencyKey, signal,
          onPhaseChange: (phase) => {
            if (active(signal)) item({ kind: "Submitting", id, intent: fileIntent, phase });
          },
        });
      }
      if (!active(signal)) return;
      const source = intent.source.kind === "Url" ? intent.source : {
        kind: "File" as const, name: intent.source.file.name, sizeBytes: intent.source.file.size, fileKind: intent.source.fileKind,
      };
      item({ kind: "Accepted", id, source, result });
    } catch (error) {
      if (!active(signal)) return;
      const frozen: AddItem = row.kind === "AcceptanceUnresolved" ? row : {
        kind: "AcceptanceUnresolved", id, intent, reason: "StatusUnknown",
        feedback: {
          tone: "Warning", title: "Couldn’t confirm",
          message: "Nexus could not confirm whether this was saved. Check status to find out.",
        },
      };
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) {
        item(frozen);
        return;
      }
      try {
        const failure = acceptanceFailure(error);
        if (failure.kind === "Superseded") {
          update((snapshot) => ({ ...snapshot, items: snapshot.items.filter((next) => next.id !== id) }));
        } else {
          item({ id, intent, ...failure });
        }
      } catch (defect) {
        item(frozen);
        throw defect;
      }
    }
  }
  async function submit() {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const rows = snapshot.items.filter((row): row is Extract<AddItem, { kind: "Draft" }> => row.kind === "Draft");
    if (rows.length === 0) return;
    const ids = new Set(rows.map((row) => row.id));
    const signal = abort.current.signal;
    update((next) => ({
      ...next,
      mutation: { kind: "Running", operation: { kind: "Submit", itemIds: [...ids] } },
      items: next.items.map((row) => row.kind === "Draft" && ids.has(row.id) ? { ...row, kind: "Queued" } : row),
    }));
    await batch(rows, signal, (row) => accept(row, signal));
  }
  async function reconcileAcceptance(itemId: string) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const row = snapshot.items.find((next) => next.id === itemId);
    if (row?.kind !== "AcceptanceUnresolved") return;
    const signal = abort.current.signal;
    update((next) => ({ ...next, mutation: { kind: "Running", operation: { kind: "ReconcileAcceptance", itemId } } }));
    await batch([row], signal, (next) => accept(next, signal));
  }

  async function refreshPlacements(mediaIds: readonly string[]) {
    const snapshot = current.current;
    const accepted = new Set(snapshot.items.flatMap((row) => row.kind === "Accepted" ? [row.result.mediaId] : []));
    const signal = abort.current.signal;
    const work = [...new Set(mediaIds)].flatMap((mediaId) => {
      if (!accepted.has(mediaId)) return [];
      const previous = current.current.placementByMediaId.get(mediaId) ?? null;
      if (previous?.kind === "Loading" || previous?.kind === "Queued" || previous?.kind === "Updating") return [];
      // An unresolved command stays available even if this media's inventory can
      // no longer be read after a successful but unacknowledged removal.
      if (previous?.kind === "Uncertain" || previous?.kind === "Unavailable") return [];
      const request: Extract<PlacementState, { kind: "Loading" }> = { kind: "Loading", previous };
      placement(mediaId, request);
      return [{ mediaId, request }];
    });
    const outcomes = await runBoundedTasks({
      items: work, concurrency: 2,
      run: async ({ mediaId, request }) => {
        signal.throwIfAborted();
        const ownsRead = () => active(signal) && current.current.placementByMediaId.get(mediaId) === request;
        try {
          const libraries = await listLibraryPlacements({ kind: "Media", id: mediaId }, { signal });
          if (ownsRead()) placement(mediaId, { kind: "Ready", libraries });
        } catch (error) {
          if (!ownsRead()) return;
          if (isAbortError(error) || handleUnauthenticatedApiError(error)) {
            placement(mediaId, request.previous);
            return;
          }
          try {
            const feedback = libraryRequestErrorMessage(error, { title: "Libraries couldn’t be loaded", request: "EntryRead" });
            placement(mediaId, isApiError(error) && error.code === "E_MEDIA_NOT_FOUND"
              ? { kind: "Unavailable", feedback: { ...feedback, message: "This item is no longer available." } }
              : { kind: "LoadFailed", feedback });
          } catch (defect) {
            placement(mediaId, request.previous);
            throw defect;
          }
        }
      },
    });
    if (!active(signal)) return;
    const failed = outcomes.find((outcome) => outcome.kind === "Rejected");
    if (failed?.kind === "Rejected") throw failed.error;
  }
  async function writePlacement({
    mediaId, libraries, command, signal, beforeRetry,
  }: PlacementWork & {
    mediaId: string;
    signal: AbortSignal;
    beforeRetry?: Extract<RestingPlacement, { kind: "Uncertain" }>;
  }) {
    const work = { libraries, command };
    if (!active(signal)) return;
    placement(mediaId, { kind: "Updating", ...work });
    try {
      const write = work.command.kind === "Add" ? addLibraryPlacement : removeLibraryPlacement;
      await write({ target: { kind: "Media", id: mediaId }, destination: work.command.destination, signal });
      if (!active(signal)) return;
      placement(mediaId, {
        kind: "Ready",
        libraries: projectLibraryPlacement(work.libraries, work.command.destination,
          work.command.kind === "Add" ? { kind: "Direct" } : { kind: "Absent" }),
      });
    } catch (error) {
      if (!active(signal)) return;
      if (isAbortError(error)) {
        placement(mediaId, {
          kind: "Uncertain", ...work,
          feedback: { tone: "Warning", title: "Stopped before completion", message: "Server changes that already committed may remain." },
        });
        return;
      }
      if (handleUnauthenticatedApiError(error)) {
        placement(mediaId, beforeRetry ?? { kind: "Ready", libraries: work.libraries });
        return;
      }
      try {
        const feedback = libraryRequestErrorMessage(error, { title: "Libraries couldn’t be updated", request: "PlacementMutation" });
        const uncertain = isApiError(error) && !isSameSystemApiDefect(error) &&
          apiTransportFeedback(error, "Libraries couldn’t be updated") !== null;
        placement(mediaId, uncertain
          ? { kind: "Uncertain", ...work, feedback }
          : isApiError(error) && error.code === "E_MEDIA_NOT_FOUND"
            ? { kind: "Unavailable", feedback: { ...feedback, message: "This item is no longer available." } }
            : { kind: "Refused", libraries: work.libraries, feedback });
      } catch (defect) {
        placement(mediaId, {
          kind: "Uncertain", ...work,
          feedback: {
            tone: "Warning", title: "Couldn’t confirm the library change",
            message: "Retry the same change to confirm its result.",
          },
        });
        throw defect;
      }
    }
  }
  async function runPlacement({ mediaIds, command }: { mediaIds: readonly string[]; command: PlacementCommand }) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const accepted = new Set(snapshot.items.flatMap((row) => row.kind === "Accepted" ? [row.result.mediaId] : []));
    const ids = [...new Set(mediaIds)].filter((mediaId) =>
      accepted.has(mediaId) && snapshot.placementByMediaId.get(mediaId)?.kind !== "Unavailable");
    if (ids.length === 0) return;
    if (ids.some((mediaId) => snapshot.placementByMediaId.get(mediaId)?.kind === "Loading")) return;
    const signal = abort.current.signal;
    const work = ids.map((mediaId) => {
      // justify-type-assertion: Idle excludes queued/sent work; Loading returned
      // above. TypeScript cannot refine this map lookup from those owner gates.
      const previous = (snapshot.placementByMediaId.get(mediaId) ?? null) as RestingPlacement | null;
      const queued: Extract<PlacementState, { kind: "Queued" }> = { kind: "Queued", previous, command };
      return { mediaId, queued };
    });
    update((next) => ({
      ...next,
      mutation: { kind: "Running", operation: { kind: "Placement", mediaIds: ids } },
      placementByMediaId: new Map([...next.placementByMediaId, ...work.map(({ mediaId, queued }) => [mediaId, queued] as const)]),
    }));
    await batch(work, signal, async ({ mediaId, queued }) => {
      const request: Extract<PlacementState, { kind: "Loading" }> = { kind: "Loading", previous: queued.previous };
      placement(mediaId, request);
      let libraries: LibraryPlacementOption[];
      try {
        libraries = await listLibraryPlacements({ kind: "Media", id: mediaId }, { signal });
      } catch (error) {
        if (!active(signal)) return;
        if (isAbortError(error) || handleUnauthenticatedApiError(error)) {
          placement(mediaId, request.previous);
          return;
        }
        try {
          const feedback = libraryRequestErrorMessage(error, { title: "Libraries couldn’t be loaded", request: "EntryRead" });
          if (request.previous?.kind === "Uncertain") {
            placement(mediaId, request.previous);
          } else {
            placement(mediaId, isApiError(error) && error.code === "E_MEDIA_NOT_FOUND"
              ? { kind: "Unavailable", feedback: { ...feedback, message: "This item is no longer available." } }
              : { kind: "LoadFailed", feedback });
          }
        } catch (defect) {
          placement(mediaId, request.previous);
          throw defect;
        }
        return;
      }
      if (!active(signal)) return;
      placement(mediaId, { kind: "Ready", libraries });
      const key = libraryPlacementDestinationKey(command.destination);
      const target = libraries.find((option) => libraryPlacementDestinationKey(option.destination) === key);
      if (target?.availability.kind !== "Available" ||
        target.relation.kind !== (command.kind === "Add" ? "Absent" : "Direct")) return;
      await writePlacement({ mediaId, libraries, command, signal });
    });
  }
  async function retryPlacements(mediaIds: readonly string[]) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const work = [...new Set(mediaIds)].flatMap((mediaId) => {
      const row = snapshot.placementByMediaId.get(mediaId);
      return row?.kind === "Uncertain" ? [{ mediaId, previous: row, libraries: row.libraries, command: row.command }] : [];
    });
    if (work.length === 0) return;
    const signal = abort.current.signal;
    update((next) => ({
      ...next, mutation: { kind: "Running", operation: { kind: "Placement", mediaIds: work.map((row) => row.mediaId) } },
      placementByMediaId: new Map([
        ...next.placementByMediaId,
        ...work.map((row) => [row.mediaId, { kind: "Queued" as const, previous: row.previous, command: row.command }] as const),
      ]),
    }));
    await batch(work, signal, (row) => writePlacement({
      mediaId: row.mediaId, libraries: row.libraries, command: row.command, signal, beforeRetry: row.previous,
    }));
  }
  async function createDestination(name: string): Promise<LibraryDestinationSelection> {
    if (current.current.mutation.kind !== "Idle") throw new Error("Another Add operation is already running.");
    const signal = abort.current.signal;
    const normalized = name.trim();
    const libraryId = createIds.current.get(normalized) ?? crypto.randomUUID();
    createIds.current.set(normalized, libraryId);
    update((next) => ({ ...next, mutation: { kind: "Running", operation: { kind: "CreateDestination" } } }));
    try {
      const destination = await createLibrary({ libraryId, name: normalized, signal });
      if (!active(signal)) throw new DOMException("Destination creation no longer belongs to the active Add session.", "AbortError");
      createIds.current.delete(normalized);
      return { id: destination.id, name: destination.name };
    } finally {
      if (active(signal)) update((next) => ({ ...next, mutation: { kind: "Idle" } }));
    }
  }
  async function createAndPlace({ name, mediaIds }: { name: string; mediaIds: readonly string[] }) {
    const signal = abort.current.signal;
    const ids = [...mediaIds];
    const library = await createDestination(name);
    if (!active(signal)) throw new DOMException("Add session stopped.", "AbortError");
    await runPlacement({ mediaIds: ids, command: { kind: "Add", destination: { kind: "Library", library } } });
  }

  return {
    state,
    dirty: state.urlInput.text.trim() !== "" || state.items.some((row) => row.kind !== "Accepted"),
    start, setUrlText, reviewUrls, stageFiles, removeItem, restageItem,
    setDefaultDestinations, setItemDestinations, submit, reconcileAcceptance,
    refreshPlacements, runPlacement, retryPlacements, createDestination, createAndPlace, stop,
    discard: () => { start(EMPTY_SEED); },
  };
}
