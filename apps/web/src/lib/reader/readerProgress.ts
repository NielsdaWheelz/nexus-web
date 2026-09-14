/**
 * Pure reader-progress decisions and wire decoding.
 *
 * Owns strict parsing of the reader-state snapshot contract, cursor equality
 * arbitration, and the coordinator reducer over three orthogonal facts:
 *
 *   authority: Loading | Ready(snapshot) | LoadFailed
 *   local:     Clean | Dirty | Saving(sent, queued?) | SaveFailed
 *   remote:    None | Candidate(snapshot)
 *
 * The impure coordinator (`useReaderProgress`) owns timers, fetches,
 * generations, and event listeners; every decision lives here.
 */

import { isApiError } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import {
  parseReaderResumeState,
  readerResumeStatesEqual,
  type ReaderResumeState,
} from "./types";

export const READER_STATE_CONFLICT_CODE = "E_READER_STATE_CONFLICT";

export interface ReaderCursorEmpty {
  state: "Empty";
  revision: number;
}

export type ReaderCursorSource =
  | { readonly kind: "Publication"; readonly reader_generation: number }
  | { readonly kind: "Timeline" }
  | { readonly kind: "Unresolved" };

export function parseReaderCursorSource(value: unknown): ReaderCursorSource {
  if (!isRecord(value)) throw new Error("Invalid reader cursor source");
  if (value.kind === "Publication" && Object.keys(value).length === 2 &&
      typeof value.reader_generation === "number" &&
      Number.isSafeInteger(value.reader_generation) && value.reader_generation >= 1) {
    return { kind: "Publication", reader_generation: value.reader_generation };
  }
  if ((value.kind === "Timeline" || value.kind === "Unresolved") && Object.keys(value).length === 1) {
    return { kind: value.kind };
  }
  throw new Error("Invalid reader cursor source");
}

export function readerCursorSourcesEqual(left: ReaderCursorSource, right: ReaderCursorSource): boolean {
  return left.kind === "Publication" && right.kind === "Publication"
    ? left.reader_generation === right.reader_generation
    : left.kind === right.kind;
}

export interface ReaderCursorPositioned {
  state: "Positioned";
  revision: number;
  locator: ReaderResumeState;
  source: ReaderCursorSource;
}

export type ReaderCursorSnapshot = ReaderCursorEmpty | ReaderCursorPositioned;

export const EMPTY_READER_CURSOR: ReaderCursorEmpty = { state: "Empty", revision: 0 };

/**
 * Strictly decode a reader cursor snapshot. A malformed same-system response
 * is a contract error, never Empty.
 */
export function parseReaderCursorSnapshot(value: unknown): ReaderCursorSnapshot {
  if (!isRecord(value)) {
    throw new Error("Invalid reader cursor snapshot");
  }
  const keys = Object.keys(value);
  if (value.state === "Empty") {
    if (
      keys.length !== 2 ||
      typeof value.revision !== "number" ||
      !Number.isInteger(value.revision) ||
      value.revision < 0
    ) {
      throw new Error("Invalid reader cursor snapshot");
    }
    return { state: "Empty", revision: value.revision };
  }
  if (value.state === "Positioned") {
    if (
      keys.length !== 4 ||
      typeof value.revision !== "number" ||
      !Number.isInteger(value.revision) ||
      value.revision < 1
    ) {
      throw new Error("Invalid reader cursor snapshot");
    }
    const locator = parseReaderResumeState(value.locator);
    if (locator === null) {
      throw new Error("Invalid reader cursor snapshot");
    }
    const source = parseReaderCursorSource(value.source);
    if ((source.kind === "Timeline") !== (locator.kind === "transcript")) {
      throw new Error("Reader cursor source does not match its locator");
    }
    return { state: "Positioned", revision: value.revision, locator, source };
  }
  throw new Error("Invalid reader cursor snapshot");
}

/**
 * Extract the server's current snapshot from a reader-state 409. Returns null
 * when the error is not a reader-state conflict; throws when a conflict
 * arrives without a decodable current snapshot (contract error).
 */
export function readerStateConflictCurrent(error: unknown): ReaderCursorSnapshot | null {
  if (!isApiError(error) || error.status !== 409 || error.code !== READER_STATE_CONFLICT_CODE) {
    return null;
  }
  if (!isRecord(error.details)) {
    throw new Error("Reader state conflict carried no current snapshot");
  }
  return parseReaderCursorSnapshot(error.details.current);
}

export function snapshotLocator(snapshot: ReaderCursorSnapshot): ReaderResumeState | null {
  return snapshot.state === "Positioned" ? snapshot.locator : null;
}

export type ProgressAuthority =
  | { status: "loading" }
  | { status: "ready"; snapshot: ReaderCursorSnapshot }
  | { status: "load_failed" };

export type ProgressLocal =
  | { status: "clean" }
  | { status: "dirty"; locator: ReaderResumeState }
  | { status: "saving"; sent: ReaderResumeState; queued: ReaderResumeState | null }
  | { status: "pending"; locator: ReaderResumeState }
  | { status: "save_failed"; locator: ReaderResumeState };

export type ProgressRemote =
  | { status: "none" }
  | { status: "candidate"; snapshot: ReaderCursorSnapshot };

export interface ReaderProgressState {
  source: Exclude<ReaderCursorSource, { kind: "Unresolved" }> | null;
  authority: ProgressAuthority;
  local: ProgressLocal;
  remote: ProgressRemote;
}

export const initialReaderProgressState: ReaderProgressState = {
  source: null,
  authority: { status: "loading" },
  local: { status: "clean" },
  remote: { status: "none" },
};

export type ReaderProgressEvent =
  | { type: "load_started" }
  | { type: "load_succeeded"; snapshot: ReaderCursorSnapshot }
  | { type: "load_failed" }
  | { type: "moved"; locator: ReaderResumeState }
  | { type: "save_started" }
  | { type: "save_succeeded"; snapshot: ReaderCursorPositioned }
  | { type: "save_conflicted"; current: ReaderCursorSnapshot }
  | { type: "save_failed" }
  | { type: "save_pending" }
  | { type: "capture_failed" }
  | { type: "revalidated"; snapshot: ReaderCursorSnapshot }
  | { type: "remote_applied" }
  | { type: "canonical_snapshot_installed"; snapshot: ReaderCursorSnapshot }
  | { type: "reset"; source: ReaderProgressState["source"] };

/** The locator the user still wants persisted, if any. */
export function pendingLocator(local: ProgressLocal): ReaderResumeState | null {
  switch (local.status) {
    case "clean":
      return null;
    case "dirty":
    case "save_failed":
    case "pending":
      return local.locator;
    case "saving":
      return local.queued ?? local.sent;
  }
}

/** Auto-save runs only with authority, a dirty position, and no open handoff. */
export function canScheduleSave(state: ReaderProgressState): boolean {
  return (
    state.authority.status === "ready" &&
    state.local.status === "dirty" &&
    state.remote.status === "none"
  );
}

function reduceRevalidated(
  state: ReaderProgressState,
  snapshot: ReaderCursorSnapshot,
): ReaderProgressState {
  if (state.authority.status !== "ready") {
    return state;
  }
  const authoritySnapshot = state.authority.snapshot;
  const knownRevision = Math.max(authoritySnapshot.revision,
    state.remote.status === "candidate" ? state.remote.snapshot.revision : 0);
  if (snapshot.revision < knownRevision) return state;
  const localWanted = pendingLocator(state.local);

  // An elsewhere-committed cursor identical to our unsaved position resolves
  // it (an ambiguous save that actually committed, or another device landing
  // on the same spot). In-flight saves settle through their own response.
  if (
    localWanted !== null &&
    state.local.status !== "saving" &&
    snapshot.state === "Positioned" &&
    state.source !== null && readerCursorSourcesEqual(state.source, snapshot.source) &&
    readerResumeStatesEqual(localWanted, snapshot.locator)
  ) {
    return {
      ...state,
      authority: { status: "ready", snapshot },
      local: { status: "clean" },
      remote: { status: "none" },
    };
  }

  if (snapshot.revision > authoritySnapshot.revision) {
    // The same position at a newer revision reconciles without a prompt. A
    // tombstone is a real newer state, never an old-row disappearance fallback.
    if (
      snapshot.state === "Positioned" &&
      authoritySnapshot.state === "Positioned" &&
      readerCursorSourcesEqual(authoritySnapshot.source, snapshot.source) &&
      readerResumeStatesEqual(authoritySnapshot.locator, snapshot.locator)
    ) {
      return { ...state, authority: { status: "ready", snapshot } };
    }
    return { ...state, remote: { status: "candidate", snapshot } };
  }

  if (snapshot.revision === authoritySnapshot.revision) {
    return { ...state, authority: { status: "ready", snapshot } };
  }

  // A lower revision from the same authority is stale; keep current truth.
  return state;
}

export function reduceReaderProgress(
  state: ReaderProgressState,
  event: ReaderProgressEvent,
): ReaderProgressState {
  switch (event.type) {
    case "reset":
      return { ...initialReaderProgressState, source: event.source };

    case "load_started":
      return { ...state, authority: { status: "loading" } };

    case "load_succeeded": {
      // Movement that raced the initial load survives it unless the loaded
      // cursor already matches.
      const wanted = pendingLocator(state.local);
      const loadedLocator = snapshotLocator(event.snapshot);
      const local: ProgressLocal =
        wanted !== null && !(loadedLocator !== null && event.snapshot.state === "Positioned" &&
          state.source !== null && readerCursorSourcesEqual(state.source, event.snapshot.source) &&
          readerResumeStatesEqual(wanted, loadedLocator))
          ? { status: "dirty", locator: wanted }
          : { status: "clean" };
      return {
        ...state,
        authority: { status: "ready", snapshot: event.snapshot },
        local,
        remote: { status: "none" },
      };
    }

    case "load_failed":
      return { ...state, authority: { status: "load_failed" } };

    case "moved":
      if (state.local.status === "saving") {
        return {
          ...state,
          local: { status: "saving", sent: state.local.sent, queued: event.locator },
        };
      }
      return { ...state, local: { status: "dirty", locator: event.locator } };

    case "save_started":
      if (state.local.status !== "dirty" && state.local.status !== "save_failed" && state.local.status !== "pending") {
        return state;
      }
      return {
        ...state,
        local: { status: "saving", sent: state.local.locator, queued: null },
      };

    case "save_succeeded": {
      if (state.local.status !== "saving") {
        return state;
      }
      const wanted = state.local.queued ?? state.local.sent;
      const local: ProgressLocal =
        state.source !== null && readerCursorSourcesEqual(state.source, event.snapshot.source) &&
        readerResumeStatesEqual(wanted, event.snapshot.locator)
          ? { status: "clean" }
          : { status: "dirty", locator: wanted };
      // The acknowledgment commits this attempt, not a later observed write.
      return {
        ...state,
        authority: state.authority.status === "ready" &&
          state.authority.snapshot.revision > event.snapshot.revision
            ? state.authority : { status: "ready", snapshot: event.snapshot },
        local,
        remote: state.remote.status === "candidate" &&
          state.remote.snapshot.revision > event.snapshot.revision
            ? state.remote : { status: "none" },
      };
    }

    case "save_conflicted": {
      if (state.local.status !== "saving") {
        return state;
      }
      const latest = state.local.queued ?? state.local.sent;
      return {
        ...state,
        local: { status: "dirty", locator: latest },
        remote: state.remote.status === "candidate" &&
          state.remote.snapshot.revision > event.current.revision
            ? state.remote : { status: "candidate", snapshot: event.current },
      };
    }

    case "save_failed":
      if (state.local.status !== "saving") {
        return state;
      }
      return {
        ...state,
        local: {
          status: "save_failed",
          locator: state.local.queued ?? state.local.sent,
        },
      };

    case "save_pending": {
      const locator = pendingLocator(state.local);
      return locator === null ? state : { ...state, local: { status: "pending", locator } };
    }

    case "capture_failed": {
      const locator = pendingLocator(state.local);
      return locator === null ? state : { ...state, local: { status: "save_failed", locator } };
    }

    case "revalidated":
      return reduceRevalidated(state, event.snapshot);

    case "remote_applied":
      if (state.remote.status !== "candidate") {
        return state;
      }
      return {
        ...state,
        authority: { status: "ready", snapshot: state.remote.snapshot },
        local: { status: "clean" },
        remote: { status: "none" },
      };

    case "canonical_snapshot_installed":
      return {
        ...state,
        authority: { status: "ready", snapshot: event.snapshot },
        local: { status: "clean" },
        remote: { status: "none" },
      };
  }
}
