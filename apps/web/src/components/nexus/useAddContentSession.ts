"use client";

/**
 * The Add session (docs/modules/add-content.md): stage links and files, send
 * them two at a time, reconcile unknown outcomes and file accepted items into
 * libraries, all browser-local. What was sent is frozen: an unknown outcome
 * keeps its intent for exact replay; a new attempt gets a key at submission.
 * At most one mutation runs; stop and reset fence every older completion, and a
 * placement read writes only while it still owns that media's placement.
 */

import { useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import {
  UNCONFIRMED,
  acceptanceFailure,
  type AcceptanceFailure,
} from "@/lib/imports/copy";
import {
  addMediaFromUrl,
  uploadIngestFile,
  type AcceptedIngest,
  type UploadFileKind,
  type UploadPhase,
} from "@/lib/imports/ingest";
import { createLibrary } from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import {
  addLibraryPlacement,
  libraryPlacementDestinationKey,
  listLibraryPlacements,
  projectLibraryPlacement,
  removeLibraryPlacement,
  type LibraryPlacementDestination,
  type LibraryPlacementOption,
} from "@/lib/libraries/libraryPlacement";
import { libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import type { AddSeed } from "@/lib/nexus/model";
import {
  findAmbiguousUrlSplit,
  parseAddUrlList,
  validateDraftSource,
  type AddSource,
  type DraftSource,
} from "./addInput";

export const MAX_ADD_ITEMS = 20;
const EMPTY_SEED: AddSeed = { kind: "Content", initialDestinations: [] };
const STOPPED: FeedbackContent = {
  tone: "Warning",
  title: "Stopped before completion",
  message: "Server changes that already committed may remain.",
};

type FileSummary = {
  kind: "File";
  name: string;
  sizeBytes: number;
  fileKind: UploadFileKind;
};
type AcceptanceIntent = Readonly<{
  source: AddSource;
  destinations: readonly LibraryDestinationSelection[];
  idempotencyKey: string;
}>;
type FileIntent = AcceptanceIntent & {
  source: Extract<AddSource, { kind: "File" }>;
};
type UrlIntent = AcceptanceIntent & {
  source: Extract<AddSource, { kind: "Url" }>;
};

export type AddItem =
  | { readonly kind: "Insertion"; readonly id: string }
  | {
      readonly kind: "Draft";
      readonly id: string;
      readonly source: DraftSource;
      readonly destinations: readonly LibraryDestinationSelection[];
      readonly showFeedback: boolean;
    }
  | { kind: "Queued"; id: string; intent: AcceptanceIntent }
  | { kind: "Submitting"; id: string; intent: FileIntent; phase: UploadPhase }
  | {
      kind: "Submitting";
      id: string;
      intent: UrlIntent;
      phase: "Saving" | "Checking";
    }
  | {
      kind: "Rejected";
      id: string;
      intent: AcceptanceIntent;
      feedback: FeedbackContent;
    }
  | {
      kind: "AcceptanceUnresolved";
      id: string;
      intent: AcceptanceIntent;
      reason: "StatusUnknown" | "UploadIncomplete";
      feedback: FeedbackContent;
    }
  | {
      kind: "Accepted";
      id: string;
      source: UrlIntent["source"] | FileSummary;
      result: AcceptedIngest;
    };

type PlacementCommand = {
  kind: "Add" | "Remove";
  destination: LibraryPlacementDestination;
};
type PlacementWork = {
  libraries: readonly LibraryPlacementOption[];
  command: PlacementCommand;
};
type RestingPlacement =
  | { kind: "Ready"; libraries: readonly LibraryPlacementOption[] }
  | { kind: "LoadFailed" | "Unavailable"; feedback: FeedbackContent }
  | {
      kind: "Refused";
      libraries: readonly LibraryPlacementOption[];
      feedback: FeedbackContent;
    }
  | ({ kind: "Uncertain"; feedback: FeedbackContent } & PlacementWork);
type LoadingPlacement = { kind: "Loading"; previous: RestingPlacement | null };

export type PlacementState =
  | RestingPlacement
  | LoadingPlacement
  | {
      kind: "Queued";
      previous: RestingPlacement | null;
      command: PlacementCommand;
    }
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
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  newItemDestinations: readonly LibraryDestinationSelection[];
  placementByMediaId: ReadonlyMap<string, PlacementState>;
  mutation: Mutation;
}>;

export type AddLeaveReason = "Stop" | "Unconfirmed" | "Discard" | null;

export type UrlPasteResult =
  | { kind: "Native" }
  | { kind: "Applied"; focusItemId: string | null }
  | { kind: "Rejected" };

export interface AddContentSessionController {
  readonly state: AddSessionState;
  readonly leaveReason: AddLeaveReason;
  start(seed: AddSeed): string;
  setItemUrl(input: {
    itemId: string;
    text: string;
    origin: "Typing" | "Paste";
  }): void;
  revealItemFeedback(input: { itemId: string }): void;
  pasteUrls(input: {
    itemId: string;
    text: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  }): UrlPasteResult;
  splitItemUrl(input: {
    itemId: string;
  }): Exclude<UrlPasteResult, { kind: "Native" }>;
  stageFiles(input: { files: readonly File[] }): boolean;
  removeItem(itemId: string): void;
  restageItem(itemId: string): void;
  setNewItemDestinations(input: {
    destinations: readonly LibraryDestinationSelection[];
  }): void;
  setItemDestinations(input: {
    itemId: string;
    destinations: readonly LibraryDestinationSelection[];
  }): void;
  setDraftLibrary(input: {
    destination: LibraryDestinationSelection;
    included: boolean;
  }): void;
  submit(): Promise<void>;
  reconcileAcceptance(itemId: string): Promise<void>;
  refreshPlacements(mediaIds: readonly string[]): Promise<void>;
  runPlacement(input: {
    mediaIds: readonly string[];
    command: PlacementCommand;
  }): Promise<void>;
  retryPlacements(mediaIds: readonly string[]): Promise<void>;
  createDestination(name: string): Promise<LibraryDestinationSelection>;
  createAndPlace(input: {
    name: string;
    mediaIds: readonly string[];
  }): Promise<void>;
  stop(): void;
  discard(): void;
}

function initialState(seed: AddSeed): AddSessionState {
  const { cells } = parseAddUrlList(seed.initialUrlDraft ?? "");
  if (cells.length > MAX_ADD_ITEMS) {
    // justify-defect: Add seeds are owned inputs; callers must respect capacity.
    throw new Error(
      `An Add seed cannot contain more than ${MAX_ADD_ITEMS} items.`,
    );
  }
  return {
    sessionId: createRandomId("add-session"),
    items: [
      ...cells.map(
        (text): AddItem => ({
          kind: "Draft",
          id: createRandomId("add-item"),
          source: { kind: "Url", text },
          destinations: [...seed.initialDestinations],
          showFeedback: true,
        }),
      ),
      { kind: "Insertion", id: createRandomId("add-item") },
    ],
    newItemDestinations: [...seed.initialDestinations],
    placementByMediaId: new Map(),
    mutation: { kind: "Idle" },
  };
}

export function isPopulatedAddItem(row: AddItem): boolean {
  switch (row.kind) {
    case "Insertion":
      return false;
    case "Draft":
      return row.source.kind === "File" || row.source.text.trim() !== "";
    case "Queued":
    case "Submitting":
    case "Rejected":
    case "AcceptanceUnresolved":
    case "Accepted":
      return true;
  }
}

function draftFromIntent(row: {
  id: string;
  intent: AcceptanceIntent;
}): Extract<AddItem, { kind: "Draft" }> {
  const { source, destinations } = row.intent;
  return {
    kind: "Draft",
    id: row.id,
    source:
      source.kind === "Url"
        ? { kind: "Url", text: source.url }
        : { kind: "File", file: source.file },
    destinations: [...destinations],
    showFeedback: true,
  };
}

const acceptedMediaIds = (snapshot: AddSessionState) =>
  new Set(
    snapshot.items.flatMap((row) =>
      row.kind === "Accepted" ? [row.result.mediaId] : [],
    ),
  );

/** A media the server no longer has is unavailable, whatever the request. */
function unavailable(
  error: unknown,
  feedback: FeedbackContent,
): RestingPlacement | null {
  return isApiError(error) && error.code === "E_MEDIA_NOT_FOUND"
    ? {
        kind: "Unavailable",
        feedback: { ...feedback, message: "This item is no longer available." },
      }
    : null;
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
      items: snapshot.items.map((row) => (row.id === next.id ? next : row)),
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
  function running(
    operation: Extract<Mutation, { kind: "Running" }>["operation"],
  ) {
    update((snapshot) => ({
      ...snapshot,
      mutation: { kind: "Running", operation },
    }));
  }
  /** Whether a completion still belongs to the session that started it. */
  function active(signal: AbortSignal) {
    return signal === abort.current.signal && !signal.aborted;
  }
  /** Runs one mutation's work two at a time; the first failure is rethrown. */
  async function batch<T>(
    items: readonly T[],
    signal: AbortSignal,
    run: (value: T) => Promise<void>,
  ) {
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
  // The browser warns on unload only while work is being sent.
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
    const next = initialState(seed);
    abort.current.abort();
    abort.current = new AbortController();
    createIds.current.clear();
    update(() => next);
    return next.sessionId;
  }
  /**
   * Fence everything in flight: unsent rows return to draft, a sent link's
   * acceptance is unknown, a sent file's upload stopped, and a placement
   * change in flight is uncertain.
   */
  function stop() {
    abort.current.abort();
    abort.current = new AbortController();
    update((snapshot) => ({
      ...snapshot,
      mutation: { kind: "Idle" },
      items: snapshot.items.map((row): AddItem => {
        if (row.kind === "Queued") return draftFromIntent(row);
        if (row.kind !== "Submitting") return row;
        return row.intent.source.kind === "File"
          ? {
              kind: "Rejected",
              id: row.id,
              intent: row.intent,
              feedback: {
                tone: "Warning",
                title: "Upload stopped",
                message:
                  "Use Imports to retry or remove any accepted upload, or restage this file as a new import.",
              },
            }
          : {
              kind: "AcceptanceUnresolved",
              id: row.id,
              intent: row.intent,
              reason: "StatusUnknown",
              feedback: {
                tone: "Warning",
                title: "Stopped · acceptance status unknown",
                message: STOPPED.message,
              },
            };
      }),
      placementByMediaId: new Map(
        [...snapshot.placementByMediaId].flatMap(
          ([mediaId, row]): [string, PlacementState][] => {
            if (row.kind === "Loading" || row.kind === "Queued") {
              return row.previous ? [[mediaId, row.previous]] : [];
            }
            if (row.kind !== "Updating") return [[mediaId, row]];
            return [
              [mediaId, { ...row, kind: "Uncertain", feedback: STOPPED }],
            ];
          },
        ),
      ),
    }));
  }
  function intakeAllowed() {
    if (current.current.mutation.kind === "Idle") return true;
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: {
        tone: "Warning",
        title:
          "Wait for this operation to finish, or stop it before adding items.",
      },
    }));
    return false;
  }
  function hasCapacity({
    count,
    replaced = 0,
  }: {
    count: number;
    replaced?: number;
  }) {
    const places =
      MAX_ADD_ITEMS -
      current.current.items.filter(isPopulatedAddItem).length +
      replaced;
    if (count <= places) return true;
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: {
        tone: "Danger",
        title: `Add up to ${MAX_ADD_ITEMS} items at a time.`,
        message: `${places} ${places === 1 ? "place" : "places"} left. ${
          count === 1 ? "This item wasn’t" : `These ${count} items weren’t`
        } added.`,
      },
    }));
    return false;
  }
  function setItemUrl({
    itemId,
    text,
    origin,
  }: {
    itemId: string;
    text: string;
    origin: "Typing" | "Paste";
  }) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const row = snapshot.items.find((next) => next.id === itemId);
    if (
      row?.kind !== "Insertion" &&
      !(row?.kind === "Draft" && row.source.kind === "Url")
    ) {
      return;
    }
    if (row.kind === "Insertion" && text === "") return;
    if (
      !hasCapacity({
        count: text.trim() === "" ? 0 : 1,
        replaced: isPopulatedAddItem(row) ? 1 : 0,
      })
    ) {
      return;
    }
    const next: AddItem = {
      kind: "Draft",
      id: row.id,
      source: { kind: "Url", text },
      destinations:
        row.kind === "Draft"
          ? row.destinations
          : [...snapshot.newItemDestinations],
      showFeedback:
        origin === "Paste" || (row.kind === "Draft" && row.showFeedback),
    };
    update((state) => ({
      ...state,
      intakeFeedback: undefined,
      items:
        row.kind === "Insertion"
          ? [
              ...state.items.slice(0, -1),
              next,
              { kind: "Insertion", id: createRandomId("add-item") },
            ]
          : state.items.map((entry) => (entry.id === row.id ? next : entry)),
    }));
  }
  function revealItemFeedback({ itemId }: { itemId: string }) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind === "Draft" && !row.showFeedback) {
      item({ ...row, showFeedback: true });
    }
  }
  function replaceUrlCells({
    row,
    cells,
  }: {
    row: Extract<AddItem, { kind: "Insertion" | "Draft" }>;
    cells: readonly string[];
  }): Exclude<UrlPasteResult, { kind: "Native" }> {
    if (cells.length === 0) return { kind: "Applied", focusItemId: null };
    if (
      !hasCapacity({
        count: cells.length,
        replaced: isPopulatedAddItem(row) ? 1 : 0,
      })
    ) {
      return { kind: "Rejected" };
    }
    const destinations =
      row.kind === "Draft"
        ? row.destinations
        : current.current.newItemDestinations;
    const inserted = cells.map(
      (text, index): Extract<AddItem, { kind: "Draft" }> => ({
        kind: "Draft",
        id: index === 0 ? row.id : createRandomId("add-item"),
        source: { kind: "Url", text },
        destinations: [...destinations],
        showFeedback: true,
      }),
    );
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: undefined,
      items: [
        ...snapshot.items.flatMap<AddItem>((entry) =>
          entry.id === row.id ? inserted : [entry],
        ),
        ...(row.kind === "Insertion"
          ? [{ kind: "Insertion" as const, id: createRandomId("add-item") }]
          : []),
      ],
    }));
    return { kind: "Applied", focusItemId: inserted[inserted.length - 1].id };
  }
  function pasteUrls({
    itemId,
    text,
    selectionStart,
    selectionEnd,
  }: {
    itemId: string;
    text: string;
    selectionStart: number | null;
    selectionEnd: number | null;
  }): UrlPasteResult {
    if (!intakeAllowed()) return { kind: "Rejected" };
    const row = current.current.items.find((next) => next.id === itemId);
    if (
      row?.kind !== "Insertion" &&
      !(row?.kind === "Draft" && row.source.kind === "Url")
    ) {
      return { kind: "Rejected" };
    }
    const parsed = parseAddUrlList(text);
    if (!parsed.hasDelimiters) return { kind: "Native" };
    if (parsed.cells.length === 0) return { kind: "Applied", focusItemId: null };
    if (
      row.kind === "Draft" &&
      row.source.kind === "Url" &&
      row.source.text.trim() !== "" &&
      !(selectionStart === 0 && selectionEnd === row.source.text.length)
    ) {
      update((snapshot) => ({
        ...snapshot,
        intakeFeedback: {
          tone: "Warning",
          title: "Select the whole link to paste a list.",
        },
      }));
      return { kind: "Rejected" };
    }
    return replaceUrlCells({ row, cells: parsed.cells });
  }
  function splitItemUrl({
    itemId,
  }: {
    itemId: string;
  }): Exclude<UrlPasteResult, { kind: "Native" }> {
    if (!intakeAllowed()) return { kind: "Rejected" };
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind !== "Draft" || row.source.kind !== "Url") {
      return { kind: "Rejected" };
    }
    const cells = findAmbiguousUrlSplit(row.source.text);
    if (cells === null) return { kind: "Rejected" };
    return replaceUrlCells({ row, cells });
  }
  function stageFiles({ files }: { files: readonly File[] }) {
    if (files.length === 0) return false;
    if (!intakeAllowed() || !hasCapacity({ count: files.length })) return false;
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: undefined,
      items: [
        ...snapshot.items.slice(0, -1),
        ...files.map(
          (file): AddItem => ({
            kind: "Draft",
            id: createRandomId("add-item"),
            source: { kind: "File", file },
            destinations: [...snapshot.newItemDestinations],
            showFeedback: true,
          }),
        ),
        ...snapshot.items.slice(-1),
      ],
    }));
    return true;
  }
  function removeItem(itemId: string) {
    if (current.current.mutation.kind !== "Idle") return;
    if (
      current.current.items.find((row) => row.id === itemId)?.kind === "Insertion"
    ) {
      return;
    }
    update((snapshot) => {
      const items = snapshot.items.filter((row) => row.id !== itemId);
      const retained = acceptedMediaIds({ ...snapshot, items });
      return {
        ...snapshot,
        intakeFeedback: undefined,
        items,
        placementByMediaId: new Map(
          [...snapshot.placementByMediaId].filter(([mediaId]) =>
            retained.has(mediaId),
          ),
        ),
      };
    });
  }
  function restageItem(itemId: string) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind !== "Rejected" && row?.kind !== "AcceptanceUnresolved")
      return;
    const draft = draftFromIntent(row);
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: undefined,
      items: snapshot.items.map((next) => (next.id === row.id ? draft : next)),
    }));
  }
  function setNewItemDestinations({
    destinations,
  }: {
    destinations: readonly LibraryDestinationSelection[];
  }) {
    if (current.current.mutation.kind !== "Idle") return;
    update((snapshot) => ({
      ...snapshot,
      newItemDestinations: [...destinations],
    }));
  }
  function setItemDestinations({
    itemId,
    destinations,
  }: {
    itemId: string;
    destinations: readonly LibraryDestinationSelection[];
  }) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind === "Draft") {
      item({
        ...row,
        destinations: [...destinations],
      });
    }
  }
  function setDraftLibrary({
    destination,
    included,
  }: {
    destination: LibraryDestinationSelection;
    included: boolean;
  }) {
    if (current.current.mutation.kind !== "Idle") return;
    const change = (destinations: readonly LibraryDestinationSelection[]) => {
      if (!included) {
        return destinations.filter((next) => next.id !== destination.id);
      }
      return destinations.some((next) => next.id === destination.id)
        ? destinations
        : [...destinations, destination];
    };
    update((snapshot) => ({
      ...snapshot,
      newItemDestinations: change(snapshot.newItemDestinations),
      items: snapshot.items.map((row) =>
        row.kind === "Draft" && isPopulatedAddItem(row)
          ? { ...row, destinations: change(row.destinations) }
          : row,
      ),
    }));
  }

  /** Sends one frozen intent; an unknown outcome keeps it for exact replay. */
  async function accept(
    row: Extract<AddItem, { kind: "Queued" | "AcceptanceUnresolved" }>,
    signal: AbortSignal,
  ) {
    if (!active(signal)) return;
    const { id, intent } = row;
    const libraryIds = intent.destinations.map((destination) => destination.id);
    const idempotencyKey = intent.idempotencyKey;
    try {
      let result: AcceptedIngest;
      const source = intent.source;
      if (source.kind === "Url") {
        const phase =
          row.kind === "AcceptanceUnresolved" ? "Checking" : "Saving";
        item({ kind: "Submitting", id, intent: { ...intent, source }, phase });
        result = await addMediaFromUrl({
          url: source.url,
          libraryIds,
          idempotencyKey,
          signal,
        });
      } else {
        const fileIntent: FileIntent = { ...intent, source };
        const onPhaseChange = (phase: UploadPhase) => {
          if (active(signal))
            item({ kind: "Submitting", id, intent: fileIntent, phase });
        };
        onPhaseChange("Preparing");
        result = await uploadIngestFile({
          file: source.file,
          libraryIds,
          idempotencyKey,
          signal,
          onPhaseChange,
        });
      }
      if (!active(signal)) return;
      item({
        kind: "Accepted",
        id,
        source:
          source.kind === "Url"
            ? source
            : {
                kind: "File",
                name: source.file.name,
                sizeBytes: source.file.size,
                fileKind: source.fileKind,
              },
        result,
      });
    } catch (error) {
      if (!active(signal)) return;
      const frozen: AddItem =
        row.kind === "AcceptanceUnresolved"
          ? row
          : {
              kind: "AcceptanceUnresolved",
              id,
              intent,
              reason: "StatusUnknown",
              feedback: UNCONFIRMED,
            };
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) {
        item(frozen);
        return;
      }
      let failure: AcceptanceFailure;
      try {
        failure = acceptanceFailure(error);
      } catch (defect) {
        item(frozen);
        throw defect;
      }
      if (failure.kind === "Superseded") {
        update((snapshot) => ({
          ...snapshot,
          items: snapshot.items.filter((next) => next.id !== id),
        }));
      } else {
        item({ id, intent, ...failure });
      }
    }
  }
  async function submit() {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const rows: Extract<AddItem, { kind: "Queued" }>[] = [];
    const items = snapshot.items.map((row): AddItem => {
      if (row.kind !== "Draft") return row;
      const validation = validateDraftSource(row.source);
      if (validation.kind !== "Ready") return { ...row, showFeedback: true };
      const queued: Extract<AddItem, { kind: "Queued" }> = {
        kind: "Queued",
        id: row.id,
        intent: {
          source: validation.source,
          destinations: [...row.destinations],
          idempotencyKey: createRandomId("media-add"),
        },
      };
      rows.push(queued);
      return queued;
    });
    const signal = abort.current.signal;
    update((next) => ({
      ...next,
      mutation:
        rows.length === 0
          ? { kind: "Idle" }
          : {
              kind: "Running",
              operation: { kind: "Submit", itemIds: rows.map((row) => row.id) },
            },
      items,
    }));
    if (rows.length === 0) return;
    await batch(rows, signal, (row) => accept(row, signal));
  }
  async function reconcileAcceptance(itemId: string) {
    if (current.current.mutation.kind !== "Idle") return;
    const row = current.current.items.find((next) => next.id === itemId);
    if (row?.kind !== "AcceptanceUnresolved") return;
    const signal = abort.current.signal;
    running({ kind: "ReconcileAcceptance", itemId });
    await batch([row], signal, (next) => accept(next, signal));
  }

  /**
   * One media's library inventory, written while `request` still owns its
   * placement. A stopped read, or one under an uncertain change, restores the
   * previous state; a failed one says whether the item is gone. Every path
   * that reads placements reads through this.
   */
  async function readPlacement(
    mediaId: string,
    request: LoadingPlacement,
    signal: AbortSignal,
  ): Promise<readonly LibraryPlacementOption[] | null> {
    const owns = () =>
      active(signal) &&
      current.current.placementByMediaId.get(mediaId) === request;
    try {
      const libraries = await listLibraryPlacements(
        { kind: "Media", id: mediaId },
        { signal },
      );
      if (!owns()) return null;
      placement(mediaId, { kind: "Ready", libraries });
      return libraries;
    } catch (error) {
      if (!owns()) return null;
      const stopped =
        isAbortError(error) || handleUnauthenticatedApiError(error);
      if (stopped || request.previous?.kind === "Uncertain") {
        placement(mediaId, request.previous);
        return null;
      }
      try {
        const feedback = libraryRequestErrorMessage(error, {
          title: "Libraries couldn’t be loaded",
          request: "EntryRead",
        });
        placement(
          mediaId,
          unavailable(error, feedback) ?? { kind: "LoadFailed", feedback },
        );
      } catch (defect) {
        placement(mediaId, request.previous);
        throw defect;
      }
      return null;
    }
  }
  async function refreshPlacements(mediaIds: readonly string[]) {
    const accepted = acceptedMediaIds(current.current);
    const signal = abort.current.signal;
    const work = [...new Set(mediaIds)].flatMap((mediaId) => {
      if (!accepted.has(mediaId)) return [];
      const previous = current.current.placementByMediaId.get(mediaId) ?? null;
      // A change in flight, an uncertain one or a gone item is not reread: an
      // uncertain change stays retryable even if the inventory is unreadable.
      if (
        previous !== null &&
        previous.kind !== "Ready" &&
        previous.kind !== "LoadFailed" &&
        previous.kind !== "Refused"
      ) {
        return [];
      }
      const request: LoadingPlacement = { kind: "Loading", previous };
      placement(mediaId, request);
      return [{ mediaId, request }];
    });
    const outcomes = await runBoundedTasks({
      items: work,
      concurrency: 2,
      run: async ({ mediaId, request }) => {
        signal.throwIfAborted();
        await readPlacement(mediaId, request, signal);
      },
    });
    if (!active(signal)) return;
    const failed = outcomes.find((outcome) => outcome.kind === "Rejected");
    if (failed?.kind === "Rejected") throw failed.error;
  }
  /**
   * Writes one admitted change. A transport failure leaves it uncertain (Retry
   * resends exactly it), a gone item is unavailable, anything else refused.
   */
  async function writePlacement({
    mediaId,
    libraries,
    command,
    signal,
    beforeRetry,
  }: PlacementWork & {
    mediaId: string;
    signal: AbortSignal;
    beforeRetry?: Extract<RestingPlacement, { kind: "Uncertain" }>;
  }) {
    const work = { libraries, command };
    if (!active(signal)) return;
    placement(mediaId, { kind: "Updating", ...work });
    try {
      const write =
        command.kind === "Add" ? addLibraryPlacement : removeLibraryPlacement;
      const target = { kind: "Media", id: mediaId } as const;
      await write({ target, destination: command.destination, signal });
      if (!active(signal)) return;
      const relation =
        command.kind === "Add"
          ? ({ kind: "Direct" } as const)
          : ({ kind: "Absent" } as const);
      placement(mediaId, {
        kind: "Ready",
        libraries: projectLibraryPlacement(
          libraries,
          command.destination,
          relation,
        ),
      });
    } catch (error) {
      if (!active(signal)) return;
      if (isAbortError(error)) {
        placement(mediaId, { kind: "Uncertain", ...work, feedback: STOPPED });
        return;
      }
      if (handleUnauthenticatedApiError(error)) {
        placement(mediaId, beforeRetry ?? { kind: "Ready", libraries });
        return;
      }
      try {
        const title = "Libraries couldn’t be updated";
        const feedback = libraryRequestErrorMessage(error, {
          title,
          request: "PlacementMutation",
        });
        const uncertain =
          isApiError(error) &&
          !isSameSystemApiDefect(error) &&
          apiTransportFeedback(error, title) !== null;
        placement(
          mediaId,
          uncertain
            ? { kind: "Uncertain", ...work, feedback }
            : (unavailable(error, feedback) ?? {
                kind: "Refused",
                libraries,
                feedback,
              }),
        );
      } catch (defect) {
        placement(mediaId, {
          kind: "Uncertain",
          ...work,
          feedback: {
            tone: "Warning",
            title: "Couldn’t confirm the library change",
            message: "Retry the same change to confirm its result.",
          },
        });
        throw defect;
      }
    }
  }
  /**
   * Rereads each media's eligibility, then writes the change only where it is
   * admitted: the destination is available and the media is absent from it
   * (Add) or directly in it (Remove).
   */
  async function runPlacement({
    mediaIds,
    command,
  }: {
    mediaIds: readonly string[];
    command: PlacementCommand;
  }) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const accepted = acceptedMediaIds(snapshot);
    const placements = snapshot.placementByMediaId;
    const ids = [...new Set(mediaIds)].filter(
      (mediaId) =>
        accepted.has(mediaId) &&
        placements.get(mediaId)?.kind !== "Unavailable",
    );
    if (ids.length === 0) return;
    if (ids.some((mediaId) => placements.get(mediaId)?.kind === "Loading"))
      return;
    const signal = abort.current.signal;
    const work = ids.map((mediaId) => ({
      mediaId,
      // justify-type-assertion: Idle excludes queued and sent work and Loading
      // returned above; a map lookup cannot be refined by those gates.
      previous: (placements.get(mediaId) ?? null) as RestingPlacement | null,
    }));
    update((next) => ({
      ...next,
      mutation: {
        kind: "Running",
        operation: { kind: "Placement", mediaIds: ids },
      },
      placementByMediaId: new Map([
        ...next.placementByMediaId,
        ...work.map(
          ({ mediaId, previous }) =>
            [mediaId, { kind: "Queued", previous, command }] as const,
        ),
      ]),
    }));
    await batch(work, signal, async ({ mediaId, previous }) => {
      const request: LoadingPlacement = { kind: "Loading", previous };
      placement(mediaId, request);
      const libraries = await readPlacement(mediaId, request, signal);
      if (libraries === null || !active(signal)) return;
      const key = libraryPlacementDestinationKey(command.destination);
      const target = libraries.find(
        (option) => libraryPlacementDestinationKey(option.destination) === key,
      );
      const admitted = command.kind === "Add" ? "Absent" : "Direct";
      if (
        target?.availability.kind !== "Available" ||
        target.relation.kind !== admitted
      ) {
        return;
      }
      await writePlacement({ mediaId, libraries, command, signal });
    });
  }
  /** Resends exactly the retained uncertain changes, without a read. */
  async function retryPlacements(mediaIds: readonly string[]) {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle") return;
    const work = [...new Set(mediaIds)].flatMap((mediaId) => {
      const row = snapshot.placementByMediaId.get(mediaId);
      return row?.kind === "Uncertain" ? [{ mediaId, row }] : [];
    });
    if (work.length === 0) return;
    const signal = abort.current.signal;
    update((next) => ({
      ...next,
      mutation: {
        kind: "Running",
        operation: { kind: "Placement", mediaIds: work.map((w) => w.mediaId) },
      },
      placementByMediaId: new Map([
        ...next.placementByMediaId,
        ...work.map(
          ({ mediaId, row }) =>
            [
              mediaId,
              { kind: "Queued", previous: row, command: row.command },
            ] as const,
        ),
      ]),
    }));
    await batch(work, signal, ({ mediaId, row }) =>
      writePlacement({
        mediaId,
        libraries: row.libraries,
        command: row.command,
        signal,
        beforeRetry: row,
      }),
    );
  }
  /** One library per normalized name, however often its creation is retried. */
  async function createDestination(
    name: string,
  ): Promise<LibraryDestinationSelection> {
    if (current.current.mutation.kind !== "Idle") {
      throw new Error("Another Add operation is already running.");
    }
    const signal = abort.current.signal;
    const normalized = name.trim();
    const libraryId = createIds.current.get(normalized) ?? crypto.randomUUID();
    createIds.current.set(normalized, libraryId);
    running({ kind: "CreateDestination" });
    try {
      const destination = await createLibrary({
        libraryId,
        name: normalized,
        signal,
      });
      if (!active(signal)) {
        throw new DOMException(
          "Destination creation no longer belongs to the active Add session.",
          "AbortError",
        );
      }
      createIds.current.delete(normalized);
      return { id: destination.id, name: destination.name };
    } finally {
      if (active(signal)) {
        update((next) => ({ ...next, mutation: { kind: "Idle" } }));
      }
    }
  }
  async function createAndPlace({
    name,
    mediaIds,
  }: {
    name: string;
    mediaIds: readonly string[];
  }) {
    const signal = abort.current.signal;
    const ids = [...mediaIds];
    const library = await createDestination(name);
    if (!active(signal))
      throw new DOMException("Add session stopped.", "AbortError");
    await runPlacement({
      mediaIds: ids,
      command: { kind: "Add", destination: { kind: "Library", library } },
    });
  }

  let leaveReason: AddLeaveReason = null;
  if (state.mutation.kind === "Running") {
    leaveReason = "Stop";
  } else if (
    state.items.some((row) => row.kind === "AcceptanceUnresolved") ||
    [...state.placementByMediaId.values()].some(
      (placement) =>
        placement.kind === "Uncertain" ||
        ((placement.kind === "Loading" || placement.kind === "Queued") &&
          placement.previous?.kind === "Uncertain"),
    )
  ) {
    leaveReason = "Unconfirmed";
  } else if (
    state.items.some(
      (row) =>
        row.kind === "Rejected" ||
        (row.kind === "Draft" && isPopulatedAddItem(row)),
    )
  ) {
    leaveReason = "Discard";
  }

  return {
    state,
    leaveReason,
    start,
    setItemUrl,
    revealItemFeedback,
    pasteUrls,
    splitItemUrl,
    stageFiles,
    removeItem,
    restageItem,
    setNewItemDestinations,
    setItemDestinations,
    setDraftLibrary,
    submit,
    reconcileAcceptance,
    refreshPlacements,
    runPlacement,
    retryPlacements,
    createDestination,
    createAndPlace,
    stop,
    discard: () => {
      start(EMPTY_SEED);
    },
  };
}
