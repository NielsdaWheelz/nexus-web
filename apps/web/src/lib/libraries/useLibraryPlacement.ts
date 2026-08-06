"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { createLibrary } from "@/lib/libraries/client";
import {
  addLibraryPlacement,
  decideCreatedLibraryPlacement,
  libraryPlacementDestinationKey,
  listLibraryPlacements,
  projectLibraryPlacement,
  removeLibraryPlacement,
  type LibraryPlacementDestination,
  type LibraryPlacementDestinationKey,
  type LibraryPlacementOption,
  type LibraryPlacementTarget,
} from "@/lib/libraries/libraryPlacement";
import {
  decideUnconfirmedLibraryPlacement,
  reconcileCommittedLibraryPlacement,
} from "@/lib/libraries/libraryPlacementCommit";
import type { ResourceActionMutationLease } from "@/lib/actions/resourceActionMutation";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";

type PlacementOp = "Add" | "Remove";
type PlacementRequest = "Load" | PlacementOp | "Create";

interface PlacementCommand {
  readonly destination: LibraryPlacementDestination;
  readonly destinationKey: LibraryPlacementDestinationKey;
  readonly op: PlacementOp;
  readonly clientMutationId: string;
}

interface CreateCommand {
  readonly name: string;
  readonly libraryId: string;
}

// `rows` is always the last authoritative placement inventory. A placement
// relation is projected only during post-command reconciliation.
type Phase =
  | { kind: "Loading" }
  | { kind: "Ready"; rows: LibraryPlacementOption[] }
  | {
      kind: "Mutating";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      lease: ResourceActionMutationLease;
    }
  | {
      kind: "Creating";
      rows: LibraryPlacementOption[];
      command: CreateCommand;
      lease: ResourceActionMutationLease;
    }
  | {
      kind: "Reconciling";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      lease: ResourceActionMutationLease;
    }
  | {
      kind: "ReconcileFailed";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      lease: ResourceActionMutationLease;
      content: FeedbackContent;
    }
  | {
      kind: "CommandFailed";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      content: FeedbackContent;
    }
  | {
      kind: "CreateFailed";
      rows: LibraryPlacementOption[];
      command: CreateCommand;
      content: FeedbackContent;
    }
  | {
      kind: "Unconfirmed";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      lease: ResourceActionMutationLease;
      content: FeedbackContent;
    }
  | {
      kind: "ObservingUnconfirmed";
      rows: LibraryPlacementOption[];
      command: PlacementCommand;
      lease: ResourceActionMutationLease;
    }
  | {
      kind: "DestinationGone";
      rows: LibraryPlacementOption[];
      content: FeedbackContent;
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
  placements: readonly LibraryPlacementOption[];
  loading: boolean;
  commandsDisabled: boolean;
  pendingDestinationKey: LibraryPlacementDestinationKey | null;
  creating: boolean;
  failure: LibraryPlacementFailure | null;
  toggle: (destination: LibraryPlacementDestination) => void;
  createLibraryAndAdd: (name: string) => void;
}

const RECONCILE_FAILED_MESSAGE =
  "Your change was saved, but the list couldn’t refresh.";
const UNAVAILABLE_MESSAGE = "This item is no longer available.";

function destinationGoneContent(): FeedbackContent {
  return {
    tone: "Warning",
    title: "Library is no longer available",
    message:
      "The authoritative Library list changed while the placement was being confirmed.",
  };
}

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
    case "Create":
      return "Library wasn’t created";
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
    case "E_NAME_INVALID":
      if (request === "Create") {
        return {
          tone: "Danger",
          title,
          message: error.message,
          requestId,
        };
      }
      throw error;
    case "E_RESOURCE_CONFLICT":
      if (request === "Create") {
        return {
          tone: "Danger",
          title,
          message: "That library identity is already in use.",
          requestId,
        };
      }
      throw error;
    default:
      throw error;
  }
}

function isTargetGone(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND")
  );
}

function classifyFailure(
  error: unknown,
  request: PlacementRequest,
): FailureClass {
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

function projectedRows(
  rows: readonly LibraryPlacementOption[],
  command: PlacementCommand,
): LibraryPlacementOption[] {
  return projectLibraryPlacement(
    rows,
    command.destination,
    command.op === "Add" ? { kind: "Direct" } : { kind: "Absent" },
  );
}

export function useLibraryPlacement(
  session: LibraryPlacementSession | null,
): LibraryPlacementState {
  const [phase, setPhase] = useState<Phase>({ kind: "Loading" });
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(
    null,
  );
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

  const finishCommitted = useCallback(
    async (
      committedSession: LibraryPlacementSession,
      rows: LibraryPlacementOption[],
      command: PlacementCommand,
      lease: ResourceActionMutationLease,
    ) => {
      if (sessionKeyRef.current === committedSession.key) {
        transition({ kind: "Reconciling", rows, command, lease });
      }
      const outcome = await reconcileCommittedLibraryPlacement({
        target: committedSession.target,
        onCommitted: lease.reconcile,
        readPlacements: () => listLibraryPlacements(committedSession.target),
      });
      switch (outcome.kind) {
        case "ActionSnapshotFailed":
          // The callback is an application-owned reconciliation boundary. A
          // rejection is a wiring/contract defect, not a placement API failure.
          lease.abort();
          setDefectState({ error: outcome.error });
          return;
        case "PlacementReadFailed": {
          if (handleUnauthenticatedApiError(outcome.error)) {
            lease.abort();
            return;
          }
          const failure = classifyFailure(outcome.error, command.op);
          switch (failure.kind) {
            case "Defect":
              lease.abort();
              setDefectState({ error: failure.defect });
              return;
            case "Terminal":
              await lease.commit();
              if (sessionKeyRef.current === committedSession.key) {
                transition({ kind: "Unavailable", content: failure.content });
              }
              return;
            case "Transient":
              if (sessionKeyRef.current === committedSession.key) {
                transition({
                  kind: "ReconcileFailed",
                  rows,
                  command,
                  lease,
                  content: {
                    tone: "Warning",
                    title: "Library placement needs to be refreshed",
                    message: RECONCILE_FAILED_MESSAGE,
                    requestId: failure.content.requestId,
                  },
                });
              }
              return;
          }
        }
        case "Ready":
          await lease.commit();
          if (sessionKeyRef.current === committedSession.key) {
            transition({ kind: "Ready", rows: [...outcome.placements] });
          }
          return;
      }
    },
    [transition],
  );

  const retryCommittedRead = useCallback(
    async (
      committedSession: LibraryPlacementSession,
      rows: LibraryPlacementOption[],
      command: PlacementCommand,
      lease: ResourceActionMutationLease,
    ) => {
      transition({ kind: "Reconciling", rows, command, lease });
      let placements: LibraryPlacementOption[];
      try {
        placements = await listLibraryPlacements(committedSession.target);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) {
          lease.abort();
          return;
        }
        const failure = classifyFailure(error, command.op);
        switch (failure.kind) {
          case "Defect":
            lease.abort();
            setDefectState({ error: failure.defect });
            return;
          case "Terminal":
            await lease.commit();
            if (sessionKeyRef.current === committedSession.key) {
              transition({ kind: "Unavailable", content: failure.content });
            }
            return;
          case "Transient":
            if (sessionKeyRef.current === committedSession.key) {
              transition({
                kind: "ReconcileFailed",
                rows,
                command,
                lease,
                content: {
                  tone: "Warning",
                  title: "Library placement needs to be refreshed",
                  message: RECONCILE_FAILED_MESSAGE,
                  requestId: failure.content.requestId,
                },
              });
            }
            return;
        }
      }
      await lease.commit();
      if (sessionKeyRef.current === committedSession.key) {
        transition({ kind: "Ready", rows: placements });
      }
    },
    [transition],
  );

  const runCommand = useCallback(
    async (
      committedSession: LibraryPlacementSession,
      rows: LibraryPlacementOption[],
      command: PlacementCommand,
      lease: ResourceActionMutationLease,
    ) => {
      if (sessionKeyRef.current === committedSession.key) {
        transition({ kind: "Mutating", rows, command, lease });
      }
      try {
        if (command.op === "Add") {
          await addLibraryPlacement({
            target: committedSession.target,
            destination: command.destination,
            clientMutationId: command.clientMutationId,
          });
        } else {
          await removeLibraryPlacement({
            target: committedSession.target,
            destination: command.destination,
            clientMutationId: command.clientMutationId,
          });
        }
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) {
          lease.abort();
          return;
        }
        if (sessionKeyRef.current !== committedSession.key) {
          lease.abort();
          return;
        }
        if (isMutationSettlementUnknown(error)) {
          transition({
            kind: "Unconfirmed",
            rows,
            command,
            lease,
            content: unconfirmedContent(error),
          });
          return;
        }
        lease.abort();
        settleFailure(classifyFailure(error, command.op), (content) => ({
          kind: "CommandFailed",
          rows,
          command,
          content,
        }));
        return;
      }
      await finishCommitted(committedSession, rows, command, lease);
    },
    [finishCommitted, settleFailure, transition],
  );

  const observeUnconfirmed = useCallback(
    async (
      committedSession: LibraryPlacementSession,
      rows: LibraryPlacementOption[],
      command: PlacementCommand,
      lease: ResourceActionMutationLease,
    ) => {
      listAbortRef.current?.abort();
      const abort = new AbortController();
      listAbortRef.current = abort;
      transition({ kind: "ObservingUnconfirmed", rows, command, lease });

      let observed: LibraryPlacementOption[];
      try {
        observed = await listLibraryPlacements(committedSession.target, {
          signal: abort.signal,
        });
      } catch (error) {
        if (isAbortError(error)) return;
        if (handleUnauthenticatedApiError(error)) {
          lease.abort();
          return;
        }
        if (!isCurrentGet(committedSession.key, abort)) return;
        const failure = classifyFailure(error, "Load");
        switch (failure.kind) {
          case "Defect":
            lease.abort();
            setDefectState({ error: failure.defect });
            return;
          case "Terminal":
            try {
              await lease.reconcile({ kind: "AllRetained" });
              await lease.commit();
            } catch (reconcileError) {
              lease.abort();
              setDefectState({ error: reconcileError });
              return;
            }
            transition({ kind: "Unavailable", content: failure.content });
            return;
          case "Transient":
            transition({
              kind: "Unconfirmed",
              rows,
              command,
              lease,
              content: {
                tone: "Warning",
                title: "Placement couldn’t be confirmed",
                message:
                  "Authoritative Library state still couldn’t be loaded. Retry the check before making another change.",
                requestId: failure.content.requestId,
              },
            });
            return;
        }
        return;
      } finally {
        if (isCurrentGet(committedSession.key, abort)) {
          listAbortRef.current = null;
        }
      }
      if (sessionKeyRef.current !== committedSession.key) return;

      const decision = decideUnconfirmedLibraryPlacement({
        placements: observed,
        destinationKey: command.destinationKey,
        op: command.op,
      });
      switch (decision.kind) {
        case "Committed":
          await finishCommitted(committedSession, observed, command, lease);
          return;
        case "RetryCommand":
          // Replay the exact command identity. Podcast commands replay their
          // idempotency memo; Media placement commands are themselves
          // idempotent at the owning endpoint.
          await runCommand(committedSession, observed, command, lease);
          return;
        case "DestinationGone": {
          const outcome = await reconcileCommittedLibraryPlacement({
            target: committedSession.target,
            onCommitted: lease.reconcile,
            readPlacements: () =>
              listLibraryPlacements(committedSession.target),
          });
          switch (outcome.kind) {
            case "ActionSnapshotFailed":
              lease.abort();
              setDefectState({ error: outcome.error });
              return;
            case "PlacementReadFailed":
              if (handleUnauthenticatedApiError(outcome.error)) {
                lease.abort();
                return;
              }
              if (sessionKeyRef.current !== committedSession.key) return;
              const failure = classifyFailure(outcome.error, "Load");
              switch (failure.kind) {
                case "Defect":
                  lease.abort();
                  setDefectState({ error: failure.defect });
                  return;
                case "Terminal":
                  await lease.commit();
                  transition({
                    kind: "Unavailable",
                    content: failure.content,
                  });
                  return;
                case "Transient":
                  transition({
                    kind: "Unconfirmed",
                    rows: observed,
                    command,
                    lease,
                    content: {
                      tone: "Warning",
                      title: "Placement couldn’t be confirmed",
                      message:
                        "Authoritative Library state still couldn’t be loaded. Retry the check before making another change.",
                      requestId: failure.content.requestId,
                    },
                  });
                  return;
              }
            case "Ready":
              await lease.commit();
              if (sessionKeyRef.current === committedSession.key) {
                transition({
                  kind: "DestinationGone",
                  rows: [...outcome.placements],
                  content: destinationGoneContent(),
                });
              }
              return;
          }
        }
      }
    },
    [finishCommitted, isCurrentGet, runCommand, transition],
  );

  const runCreate = useCallback(
    async (
      committedSession: LibraryPlacementSession,
      rows: LibraryPlacementOption[],
      command: CreateCommand,
      lease: ResourceActionMutationLease,
    ) => {
      transition({ kind: "Creating", rows, command, lease });
      let created;
      try {
        created = await createLibrary({
          libraryId: command.libraryId,
          name: command.name,
        });
      } catch (error) {
        lease.abort();
        if (handleUnauthenticatedApiError(error)) return;
        if (sessionKeyRef.current !== committedSession.key) return;
        settleFailure(classifyFailure(error, "Create"), (content) => ({
          kind: "CreateFailed",
          rows,
          command,
          content,
        }));
        return;
      }
      let refreshed: LibraryPlacementOption[];
      try {
        // Reauthorize after governance mutation. In particular, an
        // unsubscribed Podcast publishes RequiresSubscription for the newly
        // created destination, so Create can never bypass placement authority.
        refreshed = await listLibraryPlacements(committedSession.target);
      } catch (error) {
        lease.abort();
        if (handleUnauthenticatedApiError(error)) return;
        if (sessionKeyRef.current !== committedSession.key) return;
        settleFailure(classifyFailure(error, "Load"), (content) => ({
          kind: "CreateFailed",
          rows,
          command,
          content,
        }));
        return;
      }
      let decision;
      try {
        decision = decideCreatedLibraryPlacement({
          placements: refreshed,
          libraryId: created.id,
        });
      } catch (error) {
        lease.abort();
        setDefectState({ error });
        return;
      }
      if (decision.kind === "DoNotAdd") {
        try {
          await lease.reconcile({ kind: "AllRetained" });
          await lease.commit();
        } catch (error) {
          lease.abort();
          setDefectState({ error });
          return;
        }
        if (sessionKeyRef.current === committedSession.key) {
          transition({ kind: "Ready", rows: refreshed });
        }
        return;
      }
      const destinationKey = libraryPlacementDestinationKey(
        decision.destination,
      );
      await runCommand(
        committedSession,
        refreshed,
        {
          destination: decision.destination,
          destinationKey,
          op: "Add",
          clientMutationId: crypto.randomUUID(),
        },
        lease,
      );
    },
    [runCommand, settleFailure, transition],
  );

  const toggle = useCallback(
    (destination: LibraryPlacementDestination) => {
      if (!session) return;
      const current = phaseRef.current;
      if (current.kind !== "Ready" && current.kind !== "DestinationGone") {
        return;
      }
      const destinationKey = libraryPlacementDestinationKey(destination);
      const option = current.rows.find(
        (row) =>
          libraryPlacementDestinationKey(row.destination) === destinationKey,
      );
      if (!option || option.availability.kind !== "Available") return;
      const op =
        option.relation.kind === "Absent"
          ? "Add"
          : option.relation.kind === "Direct"
            ? "Remove"
            : null;
      if (op === null) return;
      const lease = session.options.mutation.begin();
      if (lease === null) return;
      void runCommand(
        session,
        current.rows,
        {
          destination: option.destination,
          destinationKey,
          op,
          clientMutationId: crypto.randomUUID(),
        },
        lease,
      );
    },
    [runCommand, session],
  );

  const createLibraryAndAdd = useCallback(
    (rawName: string) => {
      if (!session) return;
      const current = phaseRef.current;
      if (current.kind !== "Ready" && current.kind !== "DestinationGone") {
        return;
      }
      const name = rawName.trim();
      if (name.length === 0 || name.length > 100) return;
      const lease = session.options.mutation.begin();
      if (lease === null) return;
      void runCreate(
        session,
        current.rows,
        {
          name,
          libraryId: crypto.randomUUID(),
        },
        lease,
      );
    },
    [runCreate, session],
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

  const base = {
    toggle,
    createLibraryAndAdd,
  };

  switch (phase.kind) {
    case "Loading":
      return {
        ...base,
        placements: [],
        loading: true,
        commandsDisabled: false,
        pendingDestinationKey: null,
        creating: false,
        failure: null,
      };
    case "Ready":
      return {
        ...base,
        placements: phase.rows,
        loading: false,
        commandsDisabled: false,
        pendingDestinationKey: null,
        creating: false,
        failure: null,
      };
    case "Mutating":
      return {
        ...base,
        placements: phase.rows,
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: phase.command.destinationKey,
        creating: false,
        failure: null,
      };
    case "Creating":
      return {
        ...base,
        placements: phase.rows,
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: null,
        creating: true,
        failure: null,
      };
    case "Reconciling":
      return {
        ...base,
        placements: projectedRows(phase.rows, phase.command),
        loading: true,
        commandsDisabled: true,
        pendingDestinationKey: phase.command.destinationKey,
        creating: false,
        failure: null,
      };
    case "ObservingUnconfirmed":
      return {
        ...base,
        placements: phase.rows,
        loading: true,
        commandsDisabled: true,
        pendingDestinationKey: phase.command.destinationKey,
        creating: false,
        failure: null,
      };
    case "ReconcileFailed": {
      const { rows, command, lease, content } = phase;
      return {
        ...base,
        placements: projectedRows(rows, command),
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: command.destinationKey,
        creating: false,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (session) {
              void retryCommittedRead(session, rows, command, lease);
            }
          },
        },
      };
    }
    case "CommandFailed": {
      const { rows, command, content } = phase;
      return {
        ...base,
        placements: rows,
        loading: false,
        commandsDisabled: false,
        pendingDestinationKey: null,
        creating: false,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (!session) return;
            const lease = session.options.mutation.begin();
            if (lease !== null) void runCommand(session, rows, command, lease);
          },
        },
      };
    }
    case "CreateFailed": {
      const { rows, command, content } = phase;
      return {
        ...base,
        placements: rows,
        loading: false,
        commandsDisabled: false,
        pendingDestinationKey: null,
        creating: false,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (!session) return;
            const lease = session.options.mutation.begin();
            if (lease !== null) void runCreate(session, rows, command, lease);
          },
        },
      };
    }
    case "Unconfirmed": {
      const { rows, command, lease, content } = phase;
      return {
        ...base,
        placements: rows,
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: command.destinationKey,
        creating: false,
        failure: {
          kind: "Retry",
          content,
          retry: () => {
            if (session) {
              void observeUnconfirmed(session, rows, command, lease);
            }
          },
        },
      };
    }
    case "DestinationGone":
      return {
        ...base,
        placements: phase.rows,
        loading: false,
        commandsDisabled: false,
        pendingDestinationKey: null,
        creating: false,
        failure: { kind: "Terminal", content: phase.content },
      };
    case "LoadFailed":
      return {
        ...base,
        placements: [],
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: null,
        creating: false,
        failure: {
          kind: "Retry",
          content: phase.content,
          retry: () => {
            if (session) void load(session.target, session.key);
          },
        },
      };
    case "Unavailable":
      return {
        ...base,
        placements: [],
        loading: false,
        commandsDisabled: true,
        pendingDestinationKey: null,
        creating: false,
        failure: { kind: "Terminal", content: phase.content },
      };
    default:
      return assertNever(phase);
  }
}
