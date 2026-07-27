"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toFeedback } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  addLibraryPlacement,
  listLibraryPlacements,
  removeLibraryPlacement,
  type LibraryPlacementOption,
  type LibraryPlacementTarget,
} from "@/lib/libraries/libraryPlacement";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";

type PlacementOp = "Add" | "Remove";

// One media/podcast's standing library placement as a closed phase union.
// `rows` is always the last authoritative decoded inventory; the post-204
// confirmed-membership overlay is derived by id at read time, never mutated in.
type Phase =
  | { kind: "Loading" }
  | { kind: "Ready"; rows: LibraryPlacementOption[] }
  | {
      kind: "Mutating";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
    }
  | {
      kind: "Reconciling";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
    }
  | {
      kind: "ReconcileFailed";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
      message: string;
    }
  | {
      kind: "CommandFailed";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
      message: string;
    }
  | { kind: "LoadFailed"; message: string }
  | { kind: "Unavailable"; message: string };

type FailureClass =
  | { kind: "Defect"; defect: unknown }
  | { kind: "Terminal"; message: string }
  | { kind: "Transient"; message: string };

export type LibraryPlacementFailure =
  | { kind: "Retry"; message: string; retry: () => void }
  | { kind: "Terminal"; message: string };

export interface LibraryPlacementState {
  libraries: LibraryPlacementOption[];
  loading: boolean;
  commandsDisabled: boolean;
  pendingLibraryId: string | null;
  failure: LibraryPlacementFailure | null;
  addToLibrary: (libraryId: string) => void;
  removeFromLibrary: (libraryId: string) => void;
}

// The two app-defined states carry fixed copy, not the raw API error: the flip
// already succeeded (ReconcileFailed) or the target is gone (Unavailable), so the
// state itself is the message. Transient load/command failures still surface the
// server message when present (via libraryPlacementErrorMessage).
const RECONCILE_FAILED_MESSAGE =
  "Your change was saved, but the list couldn’t refresh.";
const UNAVAILABLE_MESSAGE = "This item is no longer available.";

function assertNever(phase: never): never {
  throw new Error(`Unreachable placement phase: ${JSON.stringify(phase)}`);
}

function fallbackMessage(op: PlacementOp): string {
  return op === "Add"
    ? "Failed to add item to library"
    : "Failed to remove item from library";
}

function libraryPlacementErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (isApiError(error) && !isSameSystemApiDefect(error)) {
    return toFeedback(error, { fallback }).title;
  }
  if (error instanceof TypeError) {
    return toFeedback(error, { fallback }).title;
  }
  throw error;
}

// Terminal codes raised by the list/mutation service owners when the media or
// podcast itself is gone. These do not enter a retry loop.
function isTargetGone(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND")
  );
}

function classifyFailure(error: unknown, fallback: string): FailureClass {
  let message: string;
  try {
    message = libraryPlacementErrorMessage(error, fallback);
  } catch (defect) {
    return { kind: "Defect", defect };
  }
  return isTargetGone(error)
    ? { kind: "Terminal", message }
    : { kind: "Transient", message };
}

// Project only the server-confirmed membership flip for one library id. Never
// synthesize can_add/can_remove; those stay authoritative until the GET.
function projectMembership(
  rows: LibraryPlacementOption[],
  libraryId: string,
  op: PlacementOp,
): LibraryPlacementOption[] {
  return rows.map((row) =>
    row.id === libraryId ? { ...row, isInLibrary: op === "Add" } : row,
  );
}

export function useLibraryPlacement(
  session: LibraryPlacementSession | null,
): LibraryPlacementState {
  const [phase, setPhase] = useState<Phase>({ kind: "Loading" });
  const [defect, setDefect] = useState<unknown>(null);
  const phaseRef = useRef<Phase>(phase);
  const sessionKeyRef = useRef(session?.key);
  const listAbortRef = useRef<AbortController | null>(null);
  sessionKeyRef.current = session?.key;

  const transition = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const isCurrentGet = useCallback(
    (key: number, abort: AbortController) =>
      listAbortRef.current === abort && sessionKeyRef.current === key,
    [],
  );

  const settleFailure = useCallback(
    (outcome: FailureClass, transient: (message: string) => Phase) => {
      switch (outcome.kind) {
        case "Defect":
          setDefect(outcome.defect);
          return;
        case "Terminal":
          transition({ kind: "Unavailable", message: UNAVAILABLE_MESSAGE });
          return;
        case "Transient":
          transition(transient(outcome.message));
          return;
      }
    },
    [transition],
  );

  // One GET seam for both the initial/retry load and the post-204 reconcile.
  // It resolves to Ready, to a caller-shaped transient phase, or to Unavailable.
  const runList = useCallback(
    async (
      target: LibraryPlacementTarget,
      key: number,
      pending: Phase,
      transient: (message: string) => Phase,
      fallback: string,
    ) => {
      listAbortRef.current?.abort();
      const abort = new AbortController();
      listAbortRef.current = abort;
      transition(pending);
      try {
        const rows = await listLibraryPlacements(target, {
          signal: abort.signal,
        });
        if (isCurrentGet(key, abort)) transition({ kind: "Ready", rows });
      } catch (error) {
        if (isAbortError(error)) return;
        if (handleUnauthenticatedApiError(error)) return;
        if (!isCurrentGet(key, abort)) return;
        settleFailure(classifyFailure(error, fallback), transient);
      } finally {
        if (isCurrentGet(key, abort)) listAbortRef.current = null;
      }
    },
    [isCurrentGet, settleFailure, transition],
  );

  const load = useCallback(
    (target: LibraryPlacementTarget, key: number) =>
      runList(
        target,
        key,
        { kind: "Loading" },
        (message) => ({ kind: "LoadFailed", message }),
        "Couldn’t load your libraries.",
      ),
    [runList],
  );

  const reconcile = useCallback(
    (
      target: LibraryPlacementTarget,
      key: number,
      rows: LibraryPlacementOption[],
      libraryId: string,
      op: PlacementOp,
    ) =>
      runList(
        target,
        key,
        { kind: "Reconciling", rows, libraryId, op },
        () => ({
          kind: "ReconcileFailed",
          rows,
          libraryId,
          op,
          message: RECONCILE_FAILED_MESSAGE,
        }),
        fallbackMessage(op),
      ),
    [runList],
  );

  // The POST/DELETE command. It is never aborted on close: closing may drop a
  // list GET, but an in-flight mutation runs to completion and its result is
  // discarded when the session it belongs to is gone or superseded.
  const runCommand = useCallback(
    async (
      target: LibraryPlacementTarget,
      key: number,
      rows: LibraryPlacementOption[],
      libraryId: string,
      op: PlacementOp,
    ) => {
      transition({ kind: "Mutating", rows, libraryId, op });
      try {
        if (op === "Add") await addLibraryPlacement(target, libraryId);
        else await removeLibraryPlacement(target, libraryId);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (sessionKeyRef.current !== key) return;
        settleFailure(
          classifyFailure(error, fallbackMessage(op)),
          (message) => ({ kind: "CommandFailed", rows, libraryId, op, message }),
        );
        return;
      }
      if (sessionKeyRef.current !== key) return;
      void reconcile(target, key, rows, libraryId, op);
    },
    [reconcile, settleFailure, transition],
  );

  // One mutation runs at a time per chooser: a command may start only from an
  // actionable phase, and the synchronous phaseRef gate rejects a second click
  // before React commits the Mutating render.
  const start = useCallback(
    (libraryId: string, op: PlacementOp) => {
      if (!session) return;
      const current = phaseRef.current;
      if (current.kind !== "Ready" && current.kind !== "CommandFailed") return;
      void runCommand(session.target, session.key, current.rows, libraryId, op);
    },
    [runCommand, session],
  );

  useEffect(() => {
    setDefect(null);
    if (!session) {
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      transition({ kind: "Loading" });
      return;
    }
    void load(session.target, session.key);
    return () => {
      listAbortRef.current?.abort();
      listAbortRef.current = null;
    };
  }, [load, session, transition]);

  if (defect !== null) throw defect;

  const addToLibrary = (libraryId: string) => start(libraryId, "Add");
  const removeFromLibrary = (libraryId: string) => start(libraryId, "Remove");

  switch (phase.kind) {
    case "Loading":
      return {
        libraries: [],
        loading: true,
        commandsDisabled: false,
        pendingLibraryId: null,
        failure: null,
        addToLibrary,
        removeFromLibrary,
      };
    case "Ready":
      return {
        libraries: phase.rows,
        loading: false,
        commandsDisabled: false,
        pendingLibraryId: null,
        failure: null,
        addToLibrary,
        removeFromLibrary,
      };
    case "Mutating":
      return {
        libraries: phase.rows,
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: phase.libraryId,
        failure: null,
        addToLibrary,
        removeFromLibrary,
      };
    case "Reconciling":
      return {
        libraries: projectMembership(phase.rows, phase.libraryId, phase.op),
        loading: true,
        commandsDisabled: true,
        pendingLibraryId: phase.libraryId,
        failure: null,
        addToLibrary,
        removeFromLibrary,
      };
    case "ReconcileFailed": {
      const { rows, libraryId, op, message } = phase;
      return {
        libraries: projectMembership(rows, libraryId, op),
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: libraryId,
        failure: {
          kind: "Retry",
          message,
          retry: () => {
            if (session) void reconcile(session.target, session.key, rows, libraryId, op);
          },
        },
        addToLibrary,
        removeFromLibrary,
      };
    }
    case "CommandFailed": {
      const { libraryId, op, message } = phase;
      return {
        libraries: phase.rows,
        loading: false,
        commandsDisabled: false,
        pendingLibraryId: null,
        failure: {
          kind: "Retry",
          message,
          retry: () => start(libraryId, op),
        },
        addToLibrary,
        removeFromLibrary,
      };
    }
    case "LoadFailed":
      return {
        libraries: [],
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: null,
        failure: {
          kind: "Retry",
          message: phase.message,
          retry: () => {
            if (session) void load(session.target, session.key);
          },
        },
        addToLibrary,
        removeFromLibrary,
      };
    case "Unavailable":
      return {
        libraries: [],
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: null,
        failure: { kind: "Terminal", message: phase.message },
        addToLibrary,
        removeFromLibrary,
      };
    default:
      return assertNever(phase);
  }
}
