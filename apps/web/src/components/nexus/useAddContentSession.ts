"use client";

/**
 * The Add session (docs/modules/add-content.md): stage links and files with
 * their libraries, send them two at a time and reconcile unknown outcomes, all
 * browser-local. What was sent is frozen: an unknown outcome keeps its intent
 * for exact replay; a new attempt gets a key at submission. At most one
 * mutation runs; stop and reset fence every older completion. Accepted items
 * are filed afterwards through the shared "Libraries…" overlay.
 */

import { useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
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
import type { LibraryDestination } from "@/lib/libraries/api";
import { setDestination } from "@/components/libraries/DestinationChooser";
import { useDestinationCreation } from "@/components/libraries/useDestinationCreation";
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
  destinations: readonly LibraryDestination[];
  /** Minted once per frozen intent: every resend carries it (a url's attempt id). */
  id: string;
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
      readonly destinations: readonly LibraryDestination[];
      readonly showFeedback: boolean;
    }
  | { kind: "Queued"; id: string; intent: AcceptanceIntent }
  | {
      kind: "Submitting";
      id: string;
      intent: FileIntent;
      phase: UploadPhase;
      importRef: string | null;
    }
  | {
      kind: "Submitting";
      id: string;
      intent: UrlIntent;
      phase: "Saving" | "Checking";
      importRef: string | null;
    }
  | {
      kind: "Rejected";
      id: string;
      intent: AcceptanceIntent;
      feedback: FeedbackContent;
      importRef: string | null;
    }
  | {
      kind: "AcceptanceUnresolved";
      id: string;
      intent: AcceptanceIntent;
      reason: "StatusUnknown" | "UploadIncomplete";
      feedback: FeedbackContent;
      importRef: string | null;
    }
  | {
      kind: "Accepted";
      id: string;
      source: UrlIntent["source"] | FileSummary;
      result: AcceptedIngest;
    };

type Mutation =
  | { kind: "Idle" }
  | {
      kind: "Running";
      operation:
        | { kind: "Submit"; itemIds: readonly string[] }
        | { kind: "ReconcileAcceptance"; itemId: string };
    };

export type AddSessionState = Readonly<{
  sessionId: string;
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  newItemDestinations: readonly LibraryDestination[];
  mutation: Mutation;
}>;

export interface DraftDestinationScope {
  readonly sessionId: string;
  readonly itemIds: readonly string[];
  readonly includeNewItems: boolean;
}

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
  setLibrary(input: { scope: DraftDestinationScope; destination: LibraryDestination; included: boolean }): boolean;
  readonly creation: ReturnType<typeof useDestinationCreation>;
  submit(): Promise<void>;
  reconcileAcceptance(itemId: string): Promise<void>;
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

export function useAddContentSession(): AddContentSessionController {
  const [state, setState] = useState(() => initialState(EMPTY_SEED));
  const current = useRef(state);
  const abort = useRef(new AbortController());
  const creation = useDestinationCreation(state.sessionId);

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
    update(() => next);
    return next.sessionId;
  }
  /**
   * Fence everything in flight: unsent rows return to draft, a sent link's
   * acceptance is unknown and a sent file's upload stopped.
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
              importRef: row.importRef,
              feedback: {
                tone: "Warning",
                title: "Upload stopped",
                message: row.importRef === null
                  ? "check imports for any accepted upload, or edit this item to start a new import."
                  : "view this import for the available recovery, or edit this item to start a new import.",
              },
            }
          : {
              kind: "AcceptanceUnresolved",
              id: row.id,
              intent: row.intent,
              importRef: row.importRef,
              reason: "StatusUnknown",
              feedback: {
                tone: "Warning",
                title: "Stopped · acceptance status unknown",
                message: STOPPED.message,
              },
            };
      }),
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
    update((snapshot) => ({
      ...snapshot,
      intakeFeedback: undefined,
      items: snapshot.items.filter((row) => row.id !== itemId),
    }));
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
  function setLibrary({ scope, destination, included }: {
    scope: DraftDestinationScope;
    destination: LibraryDestination;
    included: boolean;
  }): boolean {
    const snapshot = current.current;
    if (snapshot.sessionId !== scope.sessionId || snapshot.mutation.kind !== "Idle") return false;
    const ids = new Set(scope.itemIds);
    if (!scope.includeNewItems && !snapshot.items.some(row => row.kind === "Draft" && ids.has(row.id))) return false;
    update(next => ({
      ...next,
      newItemDestinations: scope.includeNewItems ? setDestination(next.newItemDestinations, { destination, included }) : next.newItemDestinations,
      items: next.items.map(row => row.kind === "Draft" && ids.has(row.id)
        ? { ...row, destinations: setDestination(row.destinations, { destination, included }) } : row),
    }));
    return true;
  }

  /** Sends one frozen intent; an unknown outcome keeps it for exact replay. */
  async function accept(
    row: Extract<AddItem, { kind: "Queued" | "AcceptanceUnresolved" }>,
    signal: AbortSignal,
  ) {
    if (!active(signal)) return;
    const { id, intent } = row;
    let importRef = row.kind === "AcceptanceUnresolved" ? row.importRef : null;
    const libraryIds = intent.destinations.map((destination) => destination.id);
    try {
      let result: AcceptedIngest;
      const source = intent.source;
      if (source.kind === "Url") {
        const phase =
          row.kind === "AcceptanceUnresolved" ? "Checking" : "Saving";
        item({ kind: "Submitting", id, intent: { ...intent, source }, phase, importRef });
        result = await addMediaFromUrl({
          url: source.url,
          libraryIds,
          id: intent.id,
          signal,
        });
      } else {
        const fileIntent: FileIntent = { ...intent, source };
        const onPhaseChange = (phase: UploadPhase) => {
          if (active(signal))
            item({ kind: "Submitting", id, intent: fileIntent, phase, importRef });
        };
        onPhaseChange("Preparing");
        result = await uploadIngestFile({
          file: source.file,
          libraryIds,
          id: intent.id,
          signal,
          onPhaseChange,
          onImportRef: (ref) => {
            if (!active(signal)) return;
            importRef = ref;
            // Keep identity before a later transfer or confirmation can fail.
            onPhaseChange("Preparing");
          },
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
          ? { ...row, importRef }
          : {
              kind: "AcceptanceUnresolved",
              id,
              intent,
              importRef,
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
        item({ id, intent, importRef, ...failure });
      }
    }
  }
  async function submit() {
    const snapshot = current.current;
    if (snapshot.mutation.kind !== "Idle" || creation.creating) return;
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
          id: crypto.randomUUID(),
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

  let leaveReason: AddLeaveReason = null;
  if (state.mutation.kind === "Running") {
    leaveReason = "Stop";
  } else if (
    creation.creating || state.items.some((row) => row.kind === "AcceptanceUnresolved")
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
    setLibrary,
    creation,
    submit,
    reconcileAcceptance,
    stop,
    discard: () => {
      start(EMPTY_SEED);
    },
  };
}
