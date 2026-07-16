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
  revision: 0;
}

export interface ReaderCursorPositioned {
  state: "Positioned";
  revision: number;
  locator: ReaderResumeState;
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
    if (keys.length !== 2 || value.revision !== 0) {
      throw new Error("Invalid reader cursor snapshot");
    }
    return { state: "Empty", revision: 0 };
  }
  if (value.state === "Positioned") {
    if (
      keys.length !== 3 ||
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
    return { state: "Positioned", revision: value.revision, locator };
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
  | { status: "save_failed"; locator: ReaderResumeState };

export type ProgressRemote =
  | { status: "none" }
  | { status: "candidate"; snapshot: ReaderCursorPositioned };

export interface ReaderProgressState {
  authority: ProgressAuthority;
  local: ProgressLocal;
  remote: ProgressRemote;
}

export const initialReaderProgressState: ReaderProgressState = {
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
  | { type: "revalidated"; snapshot: ReaderCursorSnapshot }
  | { type: "remote_applied" }
  | { type: "reset" };

/** The locator the user still wants persisted, if any. */
export function pendingLocator(local: ProgressLocal): ReaderResumeState | null {
  switch (local.status) {
    case "clean":
      return null;
    case "dirty":
    case "save_failed":
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

export function saveBaseRevision(state: ReaderProgressState): number {
  if (state.authority.status !== "ready") {
    throw new Error("Cannot save without cursor authority");
  }
  return state.authority.snapshot.revision;
}

function reduceRevalidated(
  state: ReaderProgressState,
  snapshot: ReaderCursorSnapshot,
): ReaderProgressState {
  if (state.authority.status !== "ready") {
    return state;
  }
  const authoritySnapshot = state.authority.snapshot;
  const localWanted = pendingLocator(state.local);

  // An elsewhere-committed cursor identical to our unsaved position resolves
  // it (an ambiguous save that actually committed, or another device landing
  // on the same spot). In-flight saves settle through their own response.
  if (
    localWanted !== null &&
    state.local.status !== "saving" &&
    snapshot.state === "Positioned" &&
    readerResumeStatesEqual(localWanted, snapshot.locator)
  ) {
    return {
      authority: { status: "ready", snapshot },
      local: { status: "clean" },
      remote: { status: "none" },
    };
  }

  if (snapshot.revision > authoritySnapshot.revision && snapshot.state === "Positioned") {
    // The same position at a newer revision reconciles without a prompt.
    if (
      authoritySnapshot.state === "Positioned" &&
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
      return initialReaderProgressState;

    case "load_started":
      return { ...initialReaderProgressState, authority: { status: "loading" } };

    case "load_succeeded": {
      // Movement that raced the initial load survives it unless the loaded
      // cursor already matches.
      const wanted = pendingLocator(state.local);
      const loadedLocator = snapshotLocator(event.snapshot);
      const local: ProgressLocal =
        wanted !== null && !(loadedLocator !== null && readerResumeStatesEqual(wanted, loadedLocator))
          ? { status: "dirty", locator: wanted }
          : { status: "clean" };
      return {
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
      if (state.local.status !== "dirty" && state.local.status !== "save_failed") {
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
      const queued = state.local.queued;
      const local: ProgressLocal =
        queued !== null && !readerResumeStatesEqual(queued, event.snapshot.locator)
          ? { status: "dirty", locator: queued }
          : { status: "clean" };
      // Any accepted write supersedes an open candidate: this viewport is
      // canonical now.
      return {
        authority: { status: "ready", snapshot: event.snapshot },
        local,
        remote: { status: "none" },
      };
    }

    case "save_conflicted": {
      if (state.local.status !== "saving") {
        return state;
      }
      const latest = state.local.queued ?? state.local.sent;
      if (event.current.state === "Empty") {
        // Defensive: the row cannot vanish post-cutover. Adopt Empty authority
        // so the retained locator can recreate the cursor from base 0.
        return {
          authority: { status: "ready", snapshot: event.current },
          local: { status: "dirty", locator: latest },
          remote: { status: "none" },
        };
      }
      return {
        ...state,
        local: { status: "dirty", locator: latest },
        remote: { status: "candidate", snapshot: event.current },
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

    case "revalidated":
      return reduceRevalidated(state, event.snapshot);

    case "remote_applied":
      if (state.remote.status !== "candidate") {
        return state;
      }
      return {
        authority: { status: "ready", snapshot: state.remote.snapshot },
        local: { status: "clean" },
        remote: { status: "none" },
      };
  }
}
