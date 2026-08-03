"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
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
type PlacementRequest = "Load" | PlacementOp;

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
      clientMutationId: string;
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
      content: FeedbackContent;
    }
  | {
      kind: "CommandFailed";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
      content: FeedbackContent;
      clientMutationId: string;
    }
  | {
      kind: "Unconfirmed";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
      content: FeedbackContent;
    }
  | {
      kind: "ObservingUnconfirmed";
      rows: LibraryPlacementOption[];
      libraryId: string;
      op: PlacementOp;
    }
  | { kind: "LoadFailed"; content: FeedbackContent }
  | { kind: "Unavailable"; content: FeedbackContent };

type FailureClass =
  | { kind: "Defect"; defect: unknown }
  | { kind: "Terminal"; content: FeedbackContent }
  | { kind: "Transient"; content: FeedbackContent };

export type LibraryPlacementFailure =
  | { kind: "Retry"; content: FeedbackContent; retry: () => void }
  | { kind: "Terminal"; content: FeedbackContent };

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

function placementFailureTitle(request: PlacementRequest): string {
  switch (request) {
    case "Load":
      return "Libraries couldn’t be loaded";
    case "Add":
      return "Item wasn’t added to the library";
    case "Remove":
      return "Item wasn’t removed from the library";
  }
}

function libraryPlacementErrorMessage(
  error: unknown,
  request: PlacementRequest,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const title = placementFailureTitle(request);
  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and try again.",
        requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Please wait a moment, then try again.",
        requestId,
      };
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
      return { tone: "Danger", title, message: UNAVAILABLE_MESSAGE, requestId };
    case "E_LIBRARY_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This library is no longer available.",
        requestId,
      };
    case "E_FORBIDDEN":
    case "E_DEFAULT_LIBRARY_FORBIDDEN":
    case "E_LIBRARY_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "You no longer have permission to change this library.",
        requestId,
      };
    case "E_MEDIA_LAST_REFERENCE":
      if (request === "Remove") {
        return {
          tone: "Danger",
          title,
          message: "This item must remain in at least one library.",
          requestId,
        };
      }
      throw error;
    case "E_MEDIA_DELETING":
      return {
        tone: "Danger",
        title,
        message: "This item is being removed and can't be placed right now.",
        requestId,
      };
    case "E_PODCAST_REPLACES_EPISODES":
      if (request === "Add") {
        return {
          tone: "Danger",
          title,
          message:
            "Remove individually filed episodes before adding this podcast to the library.",
          requestId,
        };
      }
      throw error;
    default:
      throw error;
  }
}

// Terminal codes raised by the list/mutation service owners when the media or
// podcast itself is gone. These do not enter a retry loop.
function isTargetGone(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND")
  );
}

function classifyFailure(error: unknown, request: PlacementRequest): FailureClass {
  let content: FeedbackContent;
  try {
    content = libraryPlacementErrorMessage(error, request);
  } catch (defect) {
    return { kind: "Defect", defect };
  }
  return isTargetGone(error)
    ? { kind: "Terminal", content }
    : { kind: "Transient", content };
}

function isMutationSettlementUnknown(error: unknown): boolean {
  return (
    isApiError(error) &&
    !isSameSystemApiDefect(error) &&
    (error.code === "E_NETWORK" || error.code === "E_UPSTREAM_TIMEOUT")
  );
}

function unconfirmedContent(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return {
    tone: "Warning",
    title: "Placement couldn’t be confirmed",
    message:
      "Check authoritative Library state before deciding whether to try the change again.",
    requestId: error.requestId,
  };
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
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
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
    (outcome: FailureClass, transient: (content: FeedbackContent) => Phase) => {
      switch (outcome.kind) {
        case "Defect":
          setDefectState({ error: outcome.defect });
          return;
        case "Terminal":
          transition({ kind: "Unavailable", content: outcome.content });
          return;
        case "Transient":
          transition(transient(outcome.content));
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
      transient: (content: FeedbackContent) => Phase,
      request: PlacementRequest,
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
        settleFailure(classifyFailure(error, request), transient);
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
        (content) => ({ kind: "LoadFailed", content }),
        "Load",
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
        (failureContent) => ({
          kind: "ReconcileFailed",
          rows,
          libraryId,
          op,
          content: {
            tone: "Warning",
            title: "Library placement needs to be refreshed",
            message: RECONCILE_FAILED_MESSAGE,
            requestId: failureContent.requestId,
          },
        }),
        op,
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
      clientMutationId: string,
    ) => {
      transition({ kind: "Mutating", rows, libraryId, op, clientMutationId });
      try {
        if (op === "Add") {
          await addLibraryPlacement(target, libraryId, { clientMutationId });
        } else {
          await removeLibraryPlacement(target, libraryId, { clientMutationId });
        }
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (sessionKeyRef.current !== key) return;
        if (isMutationSettlementUnknown(error)) {
          transition({
            kind: "Unconfirmed",
            rows,
            libraryId,
            op,
            content: unconfirmedContent(error),
          });
          return;
        }
        settleFailure(
          classifyFailure(error, op),
          (content) => ({
            kind: "CommandFailed",
            rows,
            libraryId,
            op,
            content,
            clientMutationId,
          }),
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
      if (current.kind !== "Ready") return;
      void runCommand(
        session.target,
        session.key,
        current.rows,
        libraryId,
        op,
        crypto.randomUUID(),
      );
    },
    [runCommand, session],
  );

  useEffect(() => {
    setDefectState(null);
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

  if (defectState !== null) throw defectState.error;

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
    case "ObservingUnconfirmed":
      return {
        libraries: phase.rows,
        loading: true,
        commandsDisabled: true,
        pendingLibraryId: phase.libraryId,
        failure: null,
        addToLibrary,
        removeFromLibrary,
      };
    case "ReconcileFailed": {
      const { rows, libraryId, op, content } = phase;
      return {
        libraries: projectMembership(rows, libraryId, op),
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: libraryId,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (session) void reconcile(session.target, session.key, rows, libraryId, op);
          },
        },
        addToLibrary,
        removeFromLibrary,
      };
    }
    case "CommandFailed": {
      const { rows, libraryId, op, content, clientMutationId } = phase;
      return {
        libraries: rows,
        loading: false,
        commandsDisabled: false,
        pendingLibraryId: null,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (session) {
              void runCommand(
                session.target,
                session.key,
                rows,
                libraryId,
                op,
                clientMutationId,
              );
            }
          },
        },
        addToLibrary,
        removeFromLibrary,
      };
    }
    case "Unconfirmed": {
      const { rows, libraryId, op, content } = phase;
      return {
        libraries: rows,
        loading: false,
        commandsDisabled: true,
        pendingLibraryId: libraryId,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (!session) return;
            void runList(
              session.target,
              session.key,
              { kind: "ObservingUnconfirmed", rows, libraryId, op },
              (failureContent) => ({
                kind: "Unconfirmed",
                rows,
                libraryId,
                op,
                content: {
                  tone: "Warning",
                  title: "Placement couldn’t be confirmed",
                  message:
                    "Authoritative Library state still couldn’t be loaded. Retry the check before making another change.",
                  requestId: failureContent.requestId,
                },
              }),
              "Load",
            );
          },
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
          content: phase.content,
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
        failure: { kind: "Terminal", content: phase.content },
        addToLibrary,
        removeFromLibrary,
      };
    default:
      return assertNever(phase);
  }
}
