"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getMemberLibrary } from "@/lib/libraries/client";
import {
  LibraryContractDefect,
  isLibraryContractDefect,
  type LibraryGovernancePage,
  type LibraryInvitation,
  type LibraryMember,
  type LibraryOut,
  type LibraryRole,
} from "@/lib/libraries/contract";
import {
  createLibraryInvite,
  listLibraryMembers,
  listPendingLibraryInvites,
  removeLibraryMember,
  revokeLibraryInvite,
  transferLibraryOwnership,
  updateLibraryMemberRole,
} from "@/lib/libraries/governance";
import {
  acceptsLibraryGovernanceSettlement,
  acceptsLibrarySearchSettlement,
  adoptConfirmedLibraryGovernance,
  beginLibraryGovernanceLoad,
  beginLibraryGovernancePageLoad,
  clearLibraryGovernanceAuthority,
  failLibraryGovernanceLoad,
  failLibraryGovernancePageLoad,
  initialLibraryGovernanceState,
  libraryGovernanceMutationsEnabled,
  libraryGovernanceRouteToken,
  markLibraryGovernanceReconciling,
  markLibraryGovernanceUnconfirmed,
  mergeLibraryGovernancePage,
  resetLibraryGovernanceState,
  type LibraryGovernanceCommand,
  type LibraryGovernanceCommandDescriptor,
  type LibraryGovernanceConfirmation,
  type LibraryGovernanceDraft,
  type LibraryGovernancePageState,
  type LibraryGovernanceSearch,
  type LibraryGovernanceSnapshot,
  type LibraryGovernanceState,
} from "@/lib/libraries/governanceState";
import {
  isUserSearchContractDefect,
  searchUsers,
  type UserSearchResult,
} from "@/lib/users/search";

export type LibraryMembersConfirmation = LibraryGovernanceConfirmation;

export interface LibraryMembersController {
  libraryId: string;
  library: LibraryOut;
  snapshot: LibraryGovernanceSnapshot;
  search: LibraryGovernanceSearch;
  command: LibraryGovernanceCommand;
  draft: LibraryGovernanceDraft;
  announcement: string;
  mutationsDisabled: boolean;
  ensureFresh: () => Promise<void>;
  setQuery: (query: string) => void;
  selectUser: (user: UserSearchResult) => void;
  setInviteRole: (role: LibraryRole) => void;
  setConfirmation: (
    confirmation: LibraryGovernanceConfirmation | null,
  ) => void;
  inviteSelectedUser: () => Promise<void>;
  updateRole: (
    userHandle: string,
    fromRole: LibraryRole,
    toRole: LibraryRole,
  ) => Promise<void>;
  removeMember: (userHandle: string) => Promise<void>;
  revokeInvite: (invitationHandle: string) => Promise<void>;
  transferOwnership: (userHandle: string) => Promise<void>;
  loadMoreMembers: () => Promise<void>;
  loadMoreInvites: () => Promise<void>;
  retryReconciliation: () => Promise<void>;
}

interface UseLibraryMembersInput {
  libraryId: string;
  library: LibraryOut | null;
  adoptLibrary: (library: LibraryOut | null) => void;
  membersActive: boolean;
  announceAuthorityLoss?: (message: string) => void;
}

type GovernancePages = {
  members: LibraryGovernancePage<LibraryMember>;
  pendingInvites: LibraryGovernancePage<LibraryInvitation>;
};
type GovernanceLoad = GovernancePages & {
  seenCursors: {
    members: string[];
    pendingInvites: string[];
  };
};

type GovernancePageKind = "members" | "pendingInvites";
type GovernanceObservation =
  | { kind: "Stale" }
  | { kind: "NotFound" }
  | { kind: "AuthorityLost"; library: LibraryOut }
  | {
      kind: "Ready";
      library: LibraryOut;
      governance: GovernanceLoad;
    };
type CommandWithoutEpoch =
  LibraryGovernanceCommandDescriptor extends infer Command
    ? Command extends { routeEpoch: number }
      ? Omit<Command, "routeEpoch">
      : never
    : never;

function asPage<T>(
  page: LibraryGovernancePageState<T>,
): LibraryGovernancePage<T> {
  return {
    data: [...page.rows],
    page: { nextCursor: page.nextCursor },
  };
}

function isAmbiguousCommandError(error: unknown): boolean {
  return !isApiError(error);
}

export function libraryGovernanceErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and try again.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Please wait a moment, then try again.",
        requestId,
      };
    case "E_LIBRARY_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This library is no longer available.",
        requestId,
      };
    case "E_FORBIDDEN":
    case "E_OWNER_REQUIRED":
    case "E_OWNER_EXIT_FORBIDDEN":
    case "E_LIBRARY_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "Your library permissions changed. Refresh Library access and try again.",
        requestId,
      };
    case "E_INVITE_ALREADY_EXISTS":
      return {
        tone: "Danger",
        title,
        message: "This person already has a pending invitation.",
        requestId,
      };
    case "E_INVITE_MEMBER_EXISTS":
      return {
        tone: "Danger",
        title,
        message: "This person is already a library member.",
        requestId,
      };
    case "E_INVITE_NOT_PENDING":
    case "E_INVITE_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This invitation is no longer pending. Refresh members and invitations.",
        requestId,
      };
    case "E_OWNERSHIP_TRANSFER_INVALID":
      return {
        tone: "Danger",
        title,
        message: "Ownership can be transferred only to a current library member.",
        requestId,
      };
    default:
      throw error;
  }
}

type GovernanceFailure =
  | { kind: "Modeled"; content: FeedbackContent }
  | { kind: "Defect"; defect: unknown };

function classifyGovernanceFailure(
  error: unknown,
  title: string,
): GovernanceFailure {
  try {
    return {
      kind: "Modeled",
      content: libraryGovernanceErrorMessage(error, title),
    };
  } catch (defect) {
    return { kind: "Defect", defect };
  }
}

export function useLibraryMembers({
  libraryId,
  library,
  adoptLibrary,
  membersActive,
  announceAuthorityLoss,
}: UseLibraryMembersInput): LibraryMembersController | null {
  const [state, setState] = useState<LibraryGovernanceState>(() =>
    initialLibraryGovernanceState(libraryId),
  );
  const [announcement, setAnnouncement] = useState("");
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
  const stateRef = useRef(state);
  const readAbortRef = useRef<AbortController | null>(null);
  const pageAbortRef = useRef<{
    members: AbortController | null;
    pendingInvites: AbortController | null;
  }>({ members: null, pendingInvites: null });
  const seenCursorsRef = useRef<{
    members: string[];
    pendingInvites: string[];
  }>({ members: [], pendingInvites: [] });
  const searchSequenceRef = useRef(0);
  const wasMembersActiveRef = useRef(false);
  const authorityLossAnnouncedRef = useRef(false);
  const authorityProjectionRef = useRef<{
    libraryId: string;
    canManageMembers: boolean | null;
  }>({
    libraryId,
    canManageMembers: library?.canManageMembers ?? null,
  });
  stateRef.current = state;

  const commit = useCallback(
    (reduce: (current: LibraryGovernanceState) => LibraryGovernanceState) => {
      setState((current) => {
        const next = reduce(current);
        stateRef.current = next;
        return next;
      });
    },
    [],
  );
  const announceObservedAuthorityLoss = useCallback(
    (message: string) => {
      if (authorityLossAnnouncedRef.current) return;
      authorityLossAnnouncedRef.current = true;
      announceAuthorityLoss?.(message);
    },
    [announceAuthorityLoss],
  );

  useEffect(() => {
    if (stateRef.current.libraryId === libraryId) return;
    readAbortRef.current?.abort();
    pageAbortRef.current.members?.abort();
    pageAbortRef.current.pendingInvites?.abort();
    seenCursorsRef.current = { members: [], pendingInvites: [] };
    searchSequenceRef.current += 1;
    wasMembersActiveRef.current = false;
    setAnnouncement("");
    setDefectState(null);
    commit((current) => resetLibraryGovernanceState(current, libraryId));
  }, [commit, libraryId]);

  useEffect(
    () => () => {
      readAbortRef.current?.abort();
      pageAbortRef.current.members?.abort();
      pageAbortRef.current.pendingInvites?.abort();
    },
    [],
  );

  useEffect(() => {
    const previous = authorityProjectionRef.current;
    authorityProjectionRef.current = {
      libraryId,
      canManageMembers: library?.canManageMembers ?? null,
    };
    if (library === null || library.canManageMembers) return;
    const current = stateRef.current;
    if (current.libraryId !== libraryId) return;
    const token = libraryGovernanceRouteToken(current);
    readAbortRef.current?.abort();
    pageAbortRef.current.members?.abort();
    pageAbortRef.current.pendingInvites?.abort();
    seenCursorsRef.current = { members: [], pendingInvites: [] };
    if (
      previous.libraryId === libraryId &&
      previous.canManageMembers === true
    ) {
      announceObservedAuthorityLoss(
        "Member-management access changed. Members is no longer available.",
      );
    }
    commit((latest) => clearLibraryGovernanceAuthority(latest, token));
  }, [
    announceObservedAuthorityLoss,
    commit,
    library,
    libraryId,
  ]);

  useEffect(() => {
    if (library?.canManageMembers) {
      authorityLossAnnouncedRef.current = false;
    }
  }, [library?.canManageMembers]);

  const loadPageExtent = useCallback(
    async <T,>({
      minimumRows,
      fetchFirst,
      fetchNext,
      rowHandle,
      creationIdentity,
      signal,
    }: {
      minimumRows: number;
      fetchFirst: (signal: AbortSignal) => Promise<LibraryGovernancePage<T>>;
      fetchNext: (
        cursor: string,
        signal: AbortSignal,
      ) => Promise<LibraryGovernancePage<T>>;
      rowHandle: (row: T) => string;
      creationIdentity: (row: T) => string;
      signal: AbortSignal;
    }): Promise<{
      page: LibraryGovernancePage<T>;
      seenCursors: string[];
    }> => {
      for (let restartCount = 0; restartCount < 2; restartCount += 1) {
        const first = await fetchFirst(signal);
        let current: LibraryGovernancePageState<T> = {
          rows: [...first.data],
          nextCursor: first.page.nextCursor,
          pageLoad: { kind: "Idle" },
        };
        let seenCursors: string[] = [];
        let restartRequired = false;
        while (
          current.nextCursor.kind === "Present" &&
          current.rows.length < minimumRows
        ) {
          const requestedCursor = current.nextCursor;
          const incoming = await fetchNext(requestedCursor.value, signal);
          const merge = mergeLibraryGovernancePage(current, incoming, {
            rowHandle,
            creationIdentity,
            requestedCursor,
            seenCursors,
          });
          if (merge.kind === "RestartRequired") {
            restartRequired = true;
            break;
          }
          current = merge.page;
          seenCursors = merge.seenCursors;
        }
        if (!restartRequired) {
          return { page: asPage(current), seenCursors };
        }
      }
      throw new LibraryContractDefect(
        "Library governance pagination changed during both authoritative refresh attempts",
      );
    },
    [],
  );

  const loadGovernance = useCallback(
    async (
      signal: AbortSignal,
      minimumMembers: number,
      minimumInvites: number,
    ): Promise<GovernanceLoad> => {
      const [membersLoad, pendingInvitesLoad] = await Promise.all([
        loadPageExtent({
          minimumRows: minimumMembers,
          fetchFirst: (nextSignal) =>
            listLibraryMembers({ libraryId, signal: nextSignal }),
          fetchNext: (cursor, nextSignal) =>
            listLibraryMembers({
              libraryId,
              cursor,
              signal: nextSignal,
            }),
          rowHandle: (row: LibraryMember) => row.userHandle,
          creationIdentity: (row: LibraryMember) => row.createdAt,
          signal,
        }),
        loadPageExtent({
          minimumRows: minimumInvites,
          fetchFirst: (nextSignal) =>
            listPendingLibraryInvites({
              libraryId,
              signal: nextSignal,
            }),
          fetchNext: (cursor, nextSignal) =>
            listPendingLibraryInvites({
              libraryId,
              cursor,
              signal: nextSignal,
            }),
          rowHandle: (row: LibraryInvitation) => row.invitationHandle,
          creationIdentity: (row: LibraryInvitation) => row.createdAt,
          signal,
        }),
      ]);
      return {
        members: membersLoad.page,
        pendingInvites: pendingInvitesLoad.page,
        seenCursors: {
          members: membersLoad.seenCursors,
          pendingInvites: pendingInvitesLoad.seenCursors,
        },
      };
    },
    [libraryId, loadPageExtent],
  );

  const reconcile = useCallback(
    async (
      signal: AbortSignal,
      minimumMembers: number,
      minimumInvites: number,
      token: ReturnType<typeof libraryGovernanceRouteToken>,
    ): Promise<GovernanceObservation> => {
      let nextLibrary: LibraryOut;
      try {
        nextLibrary = await getMemberLibrary(libraryId, signal);
      } catch (error) {
        if (isApiError(error) && error.status === 404) {
          return { kind: "NotFound" };
        }
        throw error;
      }
      if (
        signal.aborted ||
        !acceptsLibraryGovernanceSettlement(stateRef.current, token)
      ) {
        return { kind: "Stale" };
      }
      adoptLibrary(nextLibrary);
      if (!nextLibrary.canManageMembers) {
        return { kind: "AuthorityLost", library: nextLibrary };
      }
      try {
        return {
          kind: "Ready",
          library: nextLibrary,
          governance: await loadGovernance(
            signal,
            minimumMembers,
            minimumInvites,
          ),
        };
      } catch (error) {
        if (
          !isApiError(error) ||
          (error.status !== 403 && error.status !== 404)
        ) {
          throw error;
        }
        try {
          const classified = await getMemberLibrary(libraryId, signal);
          if (
            signal.aborted ||
            !acceptsLibraryGovernanceSettlement(stateRef.current, token)
          ) {
            return { kind: "Stale" };
          }
          adoptLibrary(classified);
          if (!classified.canManageMembers) {
            return { kind: "AuthorityLost", library: classified };
          }
        } catch (classificationError) {
          if (
            isApiError(classificationError) &&
            classificationError.status === 404
          ) {
            return { kind: "NotFound" };
          }
          throw classificationError;
        }
        throw error;
      }
    },
    [adoptLibrary, libraryId, loadGovernance],
  );

  const ensureFresh = useCallback(async () => {
    const current = stateRef.current;
    if (current.libraryId !== libraryId) return;
    const token = libraryGovernanceRouteToken(current);
    const before = current.snapshot;
    readAbortRef.current?.abort();
    pageAbortRef.current.members?.abort();
    pageAbortRef.current.pendingInvites?.abort();
    const controller = new AbortController();
    readAbortRef.current = controller;
    commit((latest) =>
      before.kind === "Ready"
        ? markLibraryGovernanceReconciling(latest, token)
        : beginLibraryGovernanceLoad(latest, token),
    );
    try {
      const observation = await reconcile(
        controller.signal,
        before.kind === "Ready" ? before.members.rows.length : 0,
        before.kind === "Ready" ? before.pendingInvites.rows.length : 0,
        token,
      );
      if (
        controller.signal.aborted ||
        !acceptsLibraryGovernanceSettlement(stateRef.current, token)
      ) {
        return;
      }
      if (observation.kind === "Stale") return;
      if (observation.kind === "NotFound") {
        announceObservedAuthorityLoss(
          "Library access changed. This Library is no longer available.",
        );
        adoptLibrary(null);
        commit((latest) =>
          clearLibraryGovernanceAuthority(latest, token),
        );
        return;
      }
      if (observation.kind === "AuthorityLost") {
        announceObservedAuthorityLoss(
          "Member-management access changed. Members is no longer available.",
        );
        commit((latest) =>
          clearLibraryGovernanceAuthority(latest, token),
        );
        return;
      }
      const pages = observation.governance;
      seenCursorsRef.current = pages.seenCursors;
      commit((latest) => {
        const next = adoptConfirmedLibraryGovernance(latest, token, {
          members: pages.members,
          pendingInvites: pages.pendingInvites,
        });
        return before.kind === "Ready" &&
          before.reconciliation.kind === "Unconfirmed"
          ? {
              ...next,
              draft: {
                ...next.draft,
                selectedUser: null,
                confirmation: null,
              },
            }
          : next;
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !acceptsLibraryGovernanceSettlement(stateRef.current, token) ||
        handleUnauthenticatedApiError(error)
      ) {
        return;
      }
      if (isLibraryContractDefect(error)) {
        setDefectState({ error });
        return;
      }
      const failure = classifyGovernanceFailure(
        error,
        "Library members could not be loaded.",
      );
      if (failure.kind === "Defect") {
        setDefectState({ error: failure.defect });
        return;
      }
      const feedback = failure.content;
      commit((latest) => {
        if (!acceptsLibraryGovernanceSettlement(latest, token)) return latest;
        if (before.kind !== "Ready") {
          return failLibraryGovernanceLoad(latest, token, feedback);
        }
        return {
          ...latest,
          snapshot: {
            ...before,
            refreshFeedback: feedback,
          },
        };
      });
    }
  }, [
    adoptLibrary,
    announceObservedAuthorityLoss,
    commit,
    libraryId,
    reconcile,
  ]);

  useEffect(() => {
    if (state.libraryId !== libraryId) {
      wasMembersActiveRef.current = false;
      return;
    }
    const becameActive = membersActive && !wasMembersActiveRef.current;
    wasMembersActiveRef.current = membersActive;
    if (becameActive && library?.canManageMembers) {
      void ensureFresh();
    }
  }, [
    ensureFresh,
    library?.canManageMembers,
    libraryId,
    membersActive,
    state.libraryId,
  ]);

  useEffect(() => {
    const current = stateRef.current;
    const token = libraryGovernanceRouteToken(current);
    const trimmed = current.draft.query.trim();
    const sequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = sequence;
    if (current.draft.selectedUser || trimmed.length < 3) {
      commit((latest) =>
        acceptsLibraryGovernanceSettlement(latest, token)
          ? {
              ...latest,
              search:
                trimmed.length === 0
                  ? { kind: "Idle" }
                  : { kind: "Waiting" },
            }
          : latest,
      );
      return;
    }
    commit((latest) =>
      acceptsLibraryGovernanceSettlement(latest, token)
        ? { ...latest, search: { kind: "Waiting" } }
        : latest,
    );
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      commit((latest) =>
        acceptsLibraryGovernanceSettlement(latest, token)
          ? { ...latest, search: { kind: "Loading", sequence } }
          : latest,
      );
      try {
        const results = await searchUsers(trimmed, controller.signal);
        if (controller.signal.aborted) return;
        commit((latest) =>
          acceptsLibrarySearchSettlement(latest, token, sequence)
            ? {
                ...latest,
                search: { kind: "Ready", sequence, results },
              }
            : latest,
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          !acceptsLibrarySearchSettlement(
            stateRef.current,
            token,
            sequence,
          )
        ) {
          return;
        }
        if (isUserSearchContractDefect(error)) {
          setDefectState({ error });
          return;
        }
        const failure = classifyGovernanceFailure(
          error,
          "People could not be searched.",
        );
        if (failure.kind === "Defect") {
          setDefectState({ error: failure.defect });
          return;
        }
        const feedback = failure.content;
        commit((latest) =>
          acceptsLibrarySearchSettlement(latest, token, sequence)
            ? {
                ...latest,
                search: {
                  kind: "Failed",
                  sequence,
                  feedback,
                },
              }
            : latest,
        );
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [commit, state.draft.query, state.draft.selectedUser]);

  const runCommand = useCallback(
    async (
      operation: CommandWithoutEpoch,
      execute: () => Promise<unknown>,
      failureTitle: string,
      successMessage: string,
    ) => {
      const current = stateRef.current;
      if (!libraryGovernanceMutationsEnabled(current)) return;
      const token = libraryGovernanceRouteToken(current);
      const before = current.snapshot;
      if (before.kind !== "Ready") return;
      const commandOperation = {
        ...operation,
        routeEpoch: token.routeEpoch,
      } as LibraryGovernanceCommandDescriptor;
      commit((latest) =>
        acceptsLibraryGovernanceSettlement(latest, token)
          ? {
              ...latest,
              command: { kind: "Running", operation: commandOperation },
            }
          : latest,
      );

      let commandError: unknown = null;
      let commandFeedback: FeedbackContent | null = null;
      let commandDefect: { error: unknown } | null = null;
      try {
        await execute();
      } catch (error) {
        if (isLibraryContractDefect(error)) {
          commandDefect = { error };
        } else {
          const failure = classifyGovernanceFailure(error, failureTitle);
          if (failure.kind === "Defect") {
            commandDefect = { error: failure.defect };
          } else {
            commandError = error;
            commandFeedback = failure.content;
          }
        }
      }
      if (!acceptsLibraryGovernanceSettlement(stateRef.current, token)) {
        return;
      }
      pageAbortRef.current.members?.abort();
      pageAbortRef.current.pendingInvites?.abort();
      commit((latest) => markLibraryGovernanceReconciling(latest, token));
      const controller = new AbortController();
      readAbortRef.current?.abort();
      readAbortRef.current = controller;
      try {
        const observation = await reconcile(
          controller.signal,
          before.members.rows.length,
          before.pendingInvites.rows.length,
          token,
        );
        if (
          controller.signal.aborted ||
          !acceptsLibraryGovernanceSettlement(stateRef.current, token)
        ) {
          return;
        }
        if (observation.kind === "Stale") return;
        if (observation.kind === "NotFound") {
          announceObservedAuthorityLoss(
            "Library access changed. This Library is no longer available.",
          );
          adoptLibrary(null);
          commit((latest) =>
            clearLibraryGovernanceAuthority(latest, token),
          );
          if (commandDefect !== null) setDefectState(commandDefect);
          return;
        }
        if (observation.kind === "AuthorityLost") {
          announceObservedAuthorityLoss(
            "Member-management access changed. Members is no longer available.",
          );
          commit((latest) =>
            clearLibraryGovernanceAuthority(latest, token),
          );
          if (commandDefect !== null) setDefectState(commandDefect);
          return;
        }
        const pages = observation.governance;
        seenCursorsRef.current = pages.seenCursors;
        commit((latest) => {
          let next = adoptConfirmedLibraryGovernance(latest, token, {
            members: pages.members,
            pendingInvites: pages.pendingInvites,
          });
          if (next.snapshot.kind === "Ready" && commandError !== null) {
            next = {
              ...next,
              snapshot: {
                ...next.snapshot,
                refreshFeedback:
                  commandFeedback ?? next.snapshot.refreshFeedback,
              },
            };
          }
          if (commandError === null && commandDefect === null) {
            next = {
              ...next,
              draft: {
                ...next.draft,
                query:
                  operation.kind === "Invite" ? "" : next.draft.query,
                selectedUser:
                  operation.kind === "Invite"
                    ? null
                    : next.draft.selectedUser,
                confirmation: null,
              },
            };
          }
          return next;
        });
        if (commandDefect !== null) {
          setDefectState(commandDefect);
        } else if (commandError === null) {
          setAnnouncement("");
          requestAnimationFrame(() => setAnnouncement(successMessage));
        } else if (operation.kind === "Role") {
          setAnnouncement("");
          requestAnimationFrame(() =>
            setAnnouncement("No confirmed role change was applied."),
          );
        }
      } catch (reconciliationError) {
        if (
          controller.signal.aborted ||
          !acceptsLibraryGovernanceSettlement(stateRef.current, token)
        ) {
          return;
        }
        if (isLibraryContractDefect(reconciliationError)) {
          setDefectState({ error: reconciliationError });
          return;
        }
        const reconciliationFailure = classifyGovernanceFailure(
          reconciliationError,
          "Library governance could not be reconciled.",
        );
        if (reconciliationFailure.kind === "Defect") {
          setDefectState({ error: reconciliationFailure.defect });
          return;
        }
        const ambiguous =
          commandError === null || isAmbiguousCommandError(commandError);
        const feedback: FeedbackContent = {
          tone: "Warning",
          title: ambiguous
            ? "The outcome is not yet confirmed."
            : "Library authority could not be revalidated.",
          message:
            "Member changes stay disabled until Nexus reconciles authoritative Library state.",
        };
        commit((latest) =>
          markLibraryGovernanceUnconfirmed(latest, token, feedback),
        );
        if (commandDefect !== null) {
          setDefectState(commandDefect);
        }
      }
    },
    [
      adoptLibrary,
      announceObservedAuthorityLoss,
      commit,
      reconcile,
    ],
  );

  const loadMore = useCallback(
    async (kind: GovernancePageKind) => {
      const current = stateRef.current;
      if (current.snapshot.kind !== "Ready") return;
      const token = libraryGovernanceRouteToken(current);
      const page = current.snapshot[kind];
      if (
        page.nextCursor.kind !== "Present" ||
        page.pageLoad.kind === "Loading"
      ) {
        return;
      }
      const requestedCursor = page.nextCursor;
      pageAbortRef.current[kind]?.abort();
      const controller = new AbortController();
      pageAbortRef.current[kind] = controller;
      commit((latest) => {
        if (
          !acceptsLibraryGovernanceSettlement(latest, token) ||
          latest.snapshot.kind !== "Ready"
        ) {
          return latest;
        }
        return kind === "members"
          ? {
              ...latest,
              snapshot: {
                ...latest.snapshot,
                members: beginLibraryGovernancePageLoad(
                  latest.snapshot.members,
                ),
              },
            }
          : {
              ...latest,
              snapshot: {
                ...latest.snapshot,
                pendingInvites: beginLibraryGovernancePageLoad(
                  latest.snapshot.pendingInvites,
                ),
              },
            };
      });
      try {
        const incoming =
          kind === "members"
            ? await listLibraryMembers({
                libraryId,
                cursor: requestedCursor.value,
                signal: controller.signal,
              })
            : await listPendingLibraryInvites({
                libraryId,
                cursor: requestedCursor.value,
                signal: controller.signal,
              });
        if (controller.signal.aborted) return;
        const captured = stateRef.current;
        if (
          !acceptsLibraryGovernanceSettlement(captured, token) ||
          captured.snapshot.kind !== "Ready"
        ) {
          return;
        }
        if (kind === "members") {
          const merge = mergeLibraryGovernancePage(
            captured.snapshot.members,
            incoming as LibraryGovernancePage<LibraryMember>,
            {
              rowHandle: (row) => row.userHandle,
              creationIdentity: (row) => row.createdAt,
              requestedCursor,
              seenCursors: seenCursorsRef.current.members,
            },
          );
          if (merge.kind === "RestartRequired") {
            await ensureFresh();
            return;
          }
          seenCursorsRef.current.members = merge.seenCursors;
          commit((latest) =>
            acceptsLibraryGovernanceSettlement(latest, token) &&
            latest.snapshot.kind === "Ready"
              ? {
                  ...latest,
                  snapshot: {
                    ...latest.snapshot,
                    members: merge.page,
                  },
                }
              : latest,
          );
          return;
        }
        const merge = mergeLibraryGovernancePage(
          captured.snapshot.pendingInvites,
          incoming as LibraryGovernancePage<LibraryInvitation>,
          {
            rowHandle: (row) => row.invitationHandle,
            creationIdentity: (row) => row.createdAt,
            requestedCursor,
            seenCursors: seenCursorsRef.current.pendingInvites,
          },
        );
        if (merge.kind === "RestartRequired") {
          await ensureFresh();
          return;
        }
        seenCursorsRef.current.pendingInvites = merge.seenCursors;
        commit((latest) =>
          acceptsLibraryGovernanceSettlement(latest, token) &&
          latest.snapshot.kind === "Ready"
            ? {
                ...latest,
                snapshot: {
                  ...latest.snapshot,
                  pendingInvites: merge.page,
                },
              }
            : latest,
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          !acceptsLibraryGovernanceSettlement(stateRef.current, token)
        ) {
          return;
        }
        if (isLibraryContractDefect(error)) {
          setDefectState({ error });
          return;
        }
        if (
          isApiError(error) &&
          (error.status === 403 || error.status === 404)
        ) {
          await ensureFresh();
          return;
        }
        const failure = classifyGovernanceFailure(
          error,
          kind === "members"
            ? "More members could not be loaded."
            : "More invitations could not be loaded.",
        );
        if (failure.kind === "Defect") {
          setDefectState({ error: failure.defect });
          return;
        }
        const feedback = failure.content;
        commit((latest) => {
          if (
            !acceptsLibraryGovernanceSettlement(latest, token) ||
            latest.snapshot.kind !== "Ready"
          ) {
            return latest;
          }
          return kind === "members"
            ? {
                ...latest,
                snapshot: {
                  ...latest.snapshot,
                  members: failLibraryGovernancePageLoad(
                    latest.snapshot.members,
                    feedback,
                  ),
                },
              }
            : {
                ...latest,
                snapshot: {
                  ...latest.snapshot,
                  pendingInvites: failLibraryGovernancePageLoad(
                    latest.snapshot.pendingInvites,
                    feedback,
                  ),
                },
              };
        });
      }
    },
    [commit, ensureFresh, libraryId],
  );

  const setQuery = useCallback(
    (query: string) => {
      commit((current) => ({
        ...current,
        draft: { ...current.draft, query, selectedUser: null },
      }));
    },
    [commit],
  );
  const selectUser = useCallback(
    (user: UserSearchResult) => {
      const label =
        user.displayName.kind === "Present"
          ? user.displayName.value
          : user.email.kind === "Present"
            ? user.email.value
            : user.userHandle;
      commit((current) => ({
        ...current,
        search: { kind: "Idle" },
        draft: { ...current.draft, query: label, selectedUser: user },
      }));
    },
    [commit],
  );
  const setInviteRole = useCallback(
    (inviteRole: LibraryRole) => {
      commit((current) => ({
        ...current,
        draft: { ...current.draft, inviteRole },
      }));
    },
    [commit],
  );
  const setConfirmation = useCallback(
    (confirmation: LibraryGovernanceConfirmation | null) => {
      commit((current) => ({
        ...current,
        draft: { ...current.draft, confirmation },
      }));
    },
    [commit],
  );

  if (defectState !== null) throw defectState.error;
  if (library === null || state.libraryId !== libraryId) return null;
  const inviteSelectedUser = async () => {
    const selected = stateRef.current.draft.selectedUser;
    const role = stateRef.current.draft.inviteRole;
    if (!selected) return;
    await runCommand(
      { kind: "Invite", userHandle: selected.userHandle, role },
      () =>
        createLibraryInvite({
          libraryId,
          userHandle: selected.userHandle,
          role,
        }),
      "The invitation could not be created.",
      "Invitation created. They’ll see it in Nexus when they next open Libraries; no email was sent.",
    );
  };

  return {
    libraryId,
    library,
    snapshot: state.snapshot,
    search: state.search,
    command: state.command,
    draft: state.draft,
    announcement,
    mutationsDisabled: !libraryGovernanceMutationsEnabled(state),
    ensureFresh,
    setQuery,
    selectUser,
    setInviteRole,
    setConfirmation,
    inviteSelectedUser,
    updateRole: (userHandle, fromRole, toRole) =>
      runCommand(
        { kind: "Role", userHandle, fromRole, toRole },
        () =>
          updateLibraryMemberRole({ libraryId, userHandle, role: toRole }),
        "No confirmed role change was applied.",
        `Role changed to ${toRole}.`,
      ),
    removeMember: (userHandle) =>
      runCommand(
        { kind: "Remove", userHandle },
        () => removeLibraryMember({ libraryId, userHandle }),
        "The member could not be removed.",
        "Member removed.",
      ),
    revokeInvite: (invitationHandle) =>
      runCommand(
        { kind: "Revoke", invitationHandle },
        () => revokeLibraryInvite(invitationHandle),
        "The invitation could not be revoked.",
        "Invitation revoked.",
      ),
    transferOwnership: (userHandle) =>
      runCommand(
        { kind: "Transfer", userHandle },
        () =>
          transferLibraryOwnership({
            libraryId,
            newOwnerUserHandle: userHandle,
          }),
        "Ownership could not be transferred.",
        "Library ownership transferred.",
      ),
    loadMoreMembers: () => loadMore("members"),
    loadMoreInvites: () => loadMore("pendingInvites"),
    retryReconciliation: ensureFresh,
  };
}
