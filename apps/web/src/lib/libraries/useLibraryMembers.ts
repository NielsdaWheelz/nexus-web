"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
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
  initialLibraryGovernanceState,
  libraryGovernanceFirstPage,
  libraryGovernanceMutationsEnabled,
  mergeLibraryGovernancePage,
  type LibraryGovernanceCommandKind,
  type LibraryGovernanceConfirmation,
  type LibraryGovernanceDraft,
  type LibraryGovernancePageState,
  type LibraryGovernanceSearch,
  type LibraryGovernanceSnapshot,
  type LibraryGovernanceState,
} from "@/lib/libraries/governanceState";
import { searchUsers, type UserSearchResult } from "@/lib/users/search";

export type LibraryMembersConfirmation = LibraryGovernanceConfirmation;

export interface LibraryMembersController {
  libraryId: string;
  library: LibraryOut;
  snapshot: LibraryGovernanceSnapshot;
  search: LibraryGovernanceSearch;
  command: LibraryGovernanceState["command"];
  draft: LibraryGovernanceDraft;
  announcement: string;
  mutationsDisabled: boolean;
  ensureFresh: () => Promise<void>;
  setQuery: (query: string) => void;
  selectUser: (user: UserSearchResult) => void;
  setInviteRole: (role: LibraryRole) => void;
  setConfirmation: (confirmation: LibraryGovernanceConfirmation | null) => void;
  inviteSelectedUser: () => Promise<void>;
  updateRole: (userHandle: string, toRole: LibraryRole) => Promise<void>;
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

type ReadySnapshot = Extract<LibraryGovernanceSnapshot, { kind: "Ready" }>;
type PageKind = "members" | "pendingInvites";
type GovernancePages = Pick<ReadySnapshot, PageKind>;
type GovernanceObservation =
  | { kind: "Stale" }
  | { kind: "NotFound" }
  | { kind: "AuthorityLost" }
  | { kind: "Ready"; pages: GovernancePages };
type CommandOutcome =
  | { kind: "Acknowledged" }
  | { kind: "Rejected" | "Unacknowledged"; feedback: FeedbackContent }
  | { kind: "Defect"; error: unknown };

function clearCanceledPageLoads(snapshot: ReadySnapshot): ReadySnapshot {
  return {
    ...snapshot,
    members: snapshot.members.pageLoad.kind === "Loading"
      ? { ...snapshot.members, pageLoad: { kind: "Idle" } }
      : snapshot.members,
    pendingInvites: snapshot.pendingInvites.pageLoad.kind === "Loading"
      ? { ...snapshot.pendingInvites, pageLoad: { kind: "Idle" } }
      : snapshot.pendingInvites,
  };
}

export function libraryGovernanceErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  const transport = apiTransportFeedback(error, title);
  if (transport) return transport;
  switch (error.code) {
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
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This member is no longer in the Library.",
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

function classifyGovernanceFailure(
  error: unknown,
  title: string,
): { kind: "Modeled"; feedback: FeedbackContent } | { kind: "Defect"; error: unknown } {
  try {
    return { kind: "Modeled", feedback: libraryGovernanceErrorMessage(error, title) };
  } catch (defect) {
    return { kind: "Defect", error: defect };
  }
}

function isDefinitiveCommandRejection(error: unknown): boolean {
  return (
    isApiError(error) &&
    [
      "E_LIBRARY_NOT_FOUND",
      "E_FORBIDDEN",
      "E_OWNER_REQUIRED",
      "E_OWNER_EXIT_FORBIDDEN",
      "E_LIBRARY_FORBIDDEN",
      "E_INVITE_ALREADY_EXISTS",
      "E_INVITE_MEMBER_EXISTS",
      "E_INVITE_NOT_PENDING",
      "E_INVITE_NOT_FOUND",
      "E_NOT_FOUND",
      "E_OWNERSHIP_TRANSFER_INVALID",
    ].includes(error.code)
  );
}

export function useLibraryMembers({
  libraryId,
  library,
  adoptLibrary,
  membersActive,
  announceAuthorityLoss,
}: UseLibraryMembersInput): LibraryMembersController | null {
  const [state, setState] = useState<LibraryGovernanceState>(initialLibraryGovernanceState);
  const [announcement, setAnnouncement] = useState("");
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const readAbortRef = useRef<AbortController | null>(null);
  const pageAbortRef = useRef<Record<PageKind, AbortController | null>>({
    members: null,
    pendingInvites: null,
  });
  const searchSequenceRef = useRef(0);
  const wasEligibleRef = useRef(false);
  const authorityLossAnnouncedRef = useRef(false);
  const previousCapabilityRef = useRef(library?.canManageMembers ?? null);
  stateRef.current = state;

  const commit = useCallback((reduce: (current: LibraryGovernanceState) => LibraryGovernanceState) => {
    if (!mountedRef.current) return;
    setState((current) => {
      if (!mountedRef.current) return current;
      const next = reduce(current);
      stateRef.current = next;
      return next;
    });
  }, []);

  const cancelReads = useCallback(() => {
    readAbortRef.current?.abort();
    pageAbortRef.current.members?.abort();
    pageAbortRef.current.pendingInvites?.abort();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      wasEligibleRef.current = false;
      cancelReads();
    };
  }, [cancelReads]);

  const announceObservedAuthorityLoss = useCallback((message: string) => {
    if (!mountedRef.current || authorityLossAnnouncedRef.current) return;
    authorityLossAnnouncedRef.current = true;
    announceAuthorityLoss?.(message);
  }, [announceAuthorityLoss]);

  useEffect(() => {
    const previous = previousCapabilityRef.current;
    previousCapabilityRef.current = library?.canManageMembers ?? null;
    if (library === null || library.canManageMembers) return;
    cancelReads();
    if (previous === true) {
      announceObservedAuthorityLoss(
        "Member-management access changed. Members is no longer available.",
      );
    }
    commit(() => initialLibraryGovernanceState());
  }, [announceObservedAuthorityLoss, cancelReads, commit, library]);

  useEffect(() => {
    if (library?.canManageMembers) authorityLossAnnouncedRef.current = false;
  }, [library?.canManageMembers]);

  const isCurrentRead = useCallback((controller: AbortController) =>
    mountedRef.current &&
    !controller.signal.aborted &&
    readAbortRef.current === controller, []);

  const loadPageExtent = useCallback(async <T,>({
    minimumRows,
    fetchFirst,
    fetchNext,
    rowHandle,
    creationIdentity,
    name,
    signal,
  }: {
    minimumRows: number;
    fetchFirst: (signal: AbortSignal) => Promise<LibraryGovernancePage<T>>;
    fetchNext: (cursor: string, signal: AbortSignal) => Promise<LibraryGovernancePage<T>>;
    rowHandle: (row: T) => string;
    creationIdentity: (row: T) => string;
    name: string;
    signal: AbortSignal;
  }): Promise<LibraryGovernancePageState<T>> => {
    for (let restartCount = 0; restartCount < 2; restartCount += 1) {
      let page = libraryGovernanceFirstPage(await fetchFirst(signal), rowHandle, name);
      let restart = false;
      while (page.nextCursor.kind === "Present" && page.rows.length < minimumRows) {
        const requestedCursor = page.nextCursor;
        const incoming = await fetchNext(requestedCursor.value, signal);
        const merged = mergeLibraryGovernancePage(
          page, incoming, requestedCursor, rowHandle, creationIdentity,
        );
        if (merged.kind === "RestartRequired") {
          restart = true;
          break;
        }
        page = merged.page;
      }
      if (!restart) return page;
    }
    throw new LibraryContractDefect(
      "Library governance pagination changed during both authoritative refresh attempts",
    );
  }, []);

  const loadGovernance = useCallback(async (
    signal: AbortSignal,
    minimumMembers: number,
    minimumInvites: number,
  ): Promise<GovernancePages> => {
    const [members, pendingInvites] = await Promise.all([
      loadPageExtent({
        minimumRows: minimumMembers,
        fetchFirst: (nextSignal) => listLibraryMembers({ libraryId, signal: nextSignal }),
        fetchNext: (cursor, nextSignal) => listLibraryMembers({ libraryId, cursor, signal: nextSignal }),
        rowHandle: (row: LibraryMember) => row.userHandle,
        creationIdentity: (row: LibraryMember) => row.createdAt,
        name: "Library members page",
        signal,
      }),
      loadPageExtent({
        minimumRows: minimumInvites,
        fetchFirst: (nextSignal) => listPendingLibraryInvites({ libraryId, signal: nextSignal }),
        fetchNext: (cursor, nextSignal) =>
          listPendingLibraryInvites({ libraryId, cursor, signal: nextSignal }),
        rowHandle: (row: LibraryInvitation) => row.invitationHandle,
        creationIdentity: (row: LibraryInvitation) => row.createdAt,
        name: "Library invitations page",
        signal,
      }),
    ]);
    return { members, pendingInvites };
  }, [libraryId, loadPageExtent]);

  const observe = useCallback(async (
    controller: AbortController,
    minimumMembers: number,
    minimumInvites: number,
  ): Promise<GovernanceObservation> => {
    let nextLibrary: LibraryOut;
    try {
      nextLibrary = await getMemberLibrary(libraryId, controller.signal);
    } catch (error) {
      if (isApiError(error) && error.status === 404) return { kind: "NotFound" };
      throw error;
    }
    if (!isCurrentRead(controller)) return { kind: "Stale" };
    adoptLibrary(nextLibrary);
    if (!nextLibrary.canManageMembers) return { kind: "AuthorityLost" };
    try {
      const pages = await loadGovernance(
        controller.signal, minimumMembers, minimumInvites,
      );
      return { kind: "Ready", pages };
    } catch (error) {
      if (!isApiError(error) || (error.status !== 403 && error.status !== 404)) {
        throw error;
      }
      try {
        const classified = await getMemberLibrary(libraryId, controller.signal);
        if (!isCurrentRead(controller)) return { kind: "Stale" };
        adoptLibrary(classified);
        if (!classified.canManageMembers) return { kind: "AuthorityLost" };
      } catch (classificationError) {
        if (isApiError(classificationError) && classificationError.status === 404) {
          return { kind: "NotFound" };
        }
        throw classificationError;
      }
      throw error;
    }
  }, [adoptLibrary, isCurrentRead, libraryId, loadGovernance]);

  const publishObservation = useCallback((
    observation: GovernanceObservation,
    afterReady?: (current: LibraryGovernanceState) => LibraryGovernanceState,
  ): GovernanceObservation["kind"] => {
    if (!mountedRef.current || observation.kind === "Stale") return "Stale";
    if (observation.kind === "NotFound") {
      announceObservedAuthorityLoss("Library access changed. This Library is no longer available.");
      adoptLibrary(null);
      commit(() => initialLibraryGovernanceState());
      return "NotFound";
    }
    if (observation.kind === "AuthorityLost") {
      announceObservedAuthorityLoss("Member-management access changed. Members is no longer available.");
      commit(() => initialLibraryGovernanceState());
      return "AuthorityLost";
    }
    commit((current) => {
      const next: LibraryGovernanceState = {
        ...current,
        snapshot: {
          kind: "Ready",
          members: observation.pages.members,
          pendingInvites: observation.pages.pendingInvites,
          refreshFeedback: null,
          reconciliation: { kind: "Confirmed" },
        },
        command: { kind: "Idle" },
      };
      return afterReady ? afterReady(next) : next;
    });
    return "Ready";
  }, [adoptLibrary, announceObservedAuthorityLoss, commit]);

  const ensureFresh = useCallback(async () => {
    if (!mountedRef.current) return;
    const captured = stateRef.current.snapshot;
    cancelReads();
    const before = captured.kind === "Ready"
      ? clearCanceledPageLoads(captured)
      : captured;
    const controller = new AbortController();
    readAbortRef.current = controller;
    commit((current) => ({
      ...current,
      snapshot: before.kind === "Ready"
        ? { ...before, refreshFeedback: null, reconciliation: { kind: "Reconciling" } }
        : { kind: "Loading" },
    }));
    try {
      const observation = await observe(
        controller,
        before.kind === "Ready" ? before.members.rows.length : 0,
        before.kind === "Ready" ? before.pendingInvites.rows.length : 0,
      );
      if (!isCurrentRead(controller)) return;
      publishObservation(observation, (next) =>
        before.kind === "Ready" && before.reconciliation.kind === "Unconfirmed"
          ? {
              ...next,
              draft: { ...next.draft, selectedUser: null, confirmation: null },
            }
          : next,
      );
    } catch (error) {
      if (!isCurrentRead(controller) || handleUnauthenticatedApiError(error)) return;
      if (isLibraryContractDefect(error)) {
        setDefectState({ error });
        return;
      }
      const failure = classifyGovernanceFailure(error, "Library members could not be loaded.");
      if (failure.kind === "Defect") {
        setDefectState({ error: failure.error });
        return;
      }
      commit((current) => ({
        ...current,
        snapshot: before.kind === "Ready"
          ? { ...before, refreshFeedback: failure.feedback }
          : { kind: "Failed", feedback: failure.feedback },
      }));
    }
  }, [cancelReads, commit, isCurrentRead, observe, publishObservation]);

  useEffect(() => {
    const eligible = membersActive && library?.canManageMembers === true;
    const becameEligible = eligible && !wasEligibleRef.current;
    wasEligibleRef.current = eligible;
    if (becameEligible) void ensureFresh();
  }, [ensureFresh, library?.canManageMembers, membersActive]);

  useEffect(() => {
    const current = stateRef.current;
    const trimmed = current.draft.query.trim();
    const sequence = searchSequenceRef.current + 1;
    searchSequenceRef.current = sequence;
    if (current.draft.selectedUser || trimmed.length < 3) {
      commit((latest) => ({
        ...latest,
        search: trimmed.length === 0 ? { kind: "Idle" } : { kind: "Waiting" },
      }));
      return;
    }
    commit((latest) => ({ ...latest, search: { kind: "Waiting" } }));
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        sequence !== searchSequenceRef.current
      ) return;
      commit((latest) => ({ ...latest, search: { kind: "Loading", sequence } }));
      try {
        const results = await searchUsers(trimmed, controller.signal);
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          sequence !== searchSequenceRef.current
        ) return;
        commit((latest) =>
          latest.search.kind === "Loading" && latest.search.sequence === sequence
            ? { ...latest, search: { kind: "Ready", sequence, results } }
            : latest,
        );
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted || sequence !== searchSequenceRef.current) return;
        if (handleUnauthenticatedApiError(error)) return;
        const failure = classifyGovernanceFailure(error, "People could not be searched.");
        if (failure.kind === "Defect") {
          setDefectState({ error: failure.error });
          return;
        }
        commit((latest) =>
          latest.search.kind === "Loading" && latest.search.sequence === sequence
            ? { ...latest, search: { kind: "Failed", sequence, feedback: failure.feedback } }
            : latest,
        );
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [commit, state.draft.query, state.draft.selectedUser]);

  const runCommand = useCallback(async (
    kind: LibraryGovernanceCommandKind,
    execute: () => Promise<unknown>,
    failureTitle: string,
    successMessage: string,
    subjectHandle?: string,
  ) => {
    const current = stateRef.current;
    if (!mountedRef.current || !libraryGovernanceMutationsEnabled(current)) return;
    const before = current.snapshot;
    if (before.kind !== "Ready") return;
    commit((latest) => ({ ...latest, command: { kind: "Running", operation: { kind } } }));

    let outcome: CommandOutcome = { kind: "Acknowledged" };
    try {
      await execute();
    } catch (error) {
      if (!mountedRef.current) return;
      if (handleUnauthenticatedApiError(error)) {
        commit((latest) => ({ ...latest, command: { kind: "Idle" } }));
        return;
      }
      if (isLibraryContractDefect(error)) {
        outcome = { kind: "Defect", error };
      } else {
        const failure = classifyGovernanceFailure(error, failureTitle);
        if (failure.kind === "Defect") {
          outcome = { kind: "Defect", error: failure.error };
        } else if (isDefinitiveCommandRejection(error)) {
          outcome = { kind: "Rejected", feedback: failure.feedback };
        } else {
          outcome = {
            kind: "Unacknowledged",
            feedback: {
              ...failure.feedback,
              tone: "Warning",
              title: "The request was not acknowledged.",
            },
          };
        }
      }
    }
    if (!mountedRef.current) return;
    cancelReads();
    const controller = new AbortController();
    readAbortRef.current = controller;
    commit((latest) =>
      latest.snapshot.kind === "Ready"
        ? {
            ...latest,
            snapshot: {
              ...clearCanceledPageLoads(latest.snapshot),
              refreshFeedback: null,
              reconciliation: { kind: "Reconciling" },
            },
          }
        : latest,
    );
    try {
      const observation = await observe(
        controller, before.members.rows.length, before.pendingInvites.rows.length,
      );
      if (!isCurrentRead(controller)) return;
      const published = publishObservation(observation, (next) => {
        if (next.snapshot.kind !== "Ready") return next;
        if (outcome.kind === "Acknowledged") {
          return {
            ...next,
            draft: {
              ...next.draft,
              query: kind === "Invite" ? "" : next.draft.query,
              selectedUser: kind === "Invite" ? null : next.draft.selectedUser,
              confirmation: null,
            },
          };
        }
        if (outcome.kind === "Defect") return next;
        let feedback = outcome.feedback;
        if (kind === "Role" && outcome.kind === "Unacknowledged") {
          const observed = next.snapshot.members.rows.find((member) =>
            member.userHandle === subjectHandle,
          );
          feedback = {
            ...feedback,
            title: "The role change was not acknowledged.",
            message: observed
              ? `The current Library roster lists this person as ${observed.role}. Check before trying again.`
              : "Check the current Library roster before trying again.",
          };
        }
        return { ...next, snapshot: { ...next.snapshot, refreshFeedback: feedback } };
      });
      if (published !== "Ready") {
        if (outcome.kind === "Defect") setDefectState({ error: outcome.error });
        return;
      }
      if (outcome.kind === "Defect") {
        setDefectState({ error: outcome.error });
      } else if (outcome.kind === "Acknowledged") {
        setAnnouncement("");
        requestAnimationFrame(() => {
          if (mountedRef.current) setAnnouncement(successMessage);
        });
      }
    } catch (error) {
      if (!isCurrentRead(controller) || handleUnauthenticatedApiError(error)) return;
      if (isLibraryContractDefect(error)) {
        setDefectState({ error });
        return;
      }
      const failure = classifyGovernanceFailure(error, "Library governance could not be reconciled.");
      if (failure.kind === "Defect") {
        setDefectState({ error: failure.error });
        return;
      }
      commit((latest) =>
        latest.snapshot.kind === "Ready"
          ? {
              ...latest,
              command: { kind: "Idle" },
              snapshot: {
                ...latest.snapshot,
                refreshFeedback: {
                  tone: "Warning",
                  title: outcome.kind === "Rejected"
                    ? "Library authority could not be revalidated."
                    : "The outcome is not yet confirmed.",
                  message: "Member changes stay disabled until Nexus reconciles authoritative Library state.",
                },
                reconciliation: { kind: "Unconfirmed" },
              },
            }
          : latest,
      );
      if (outcome.kind === "Defect") setDefectState({ error: outcome.error });
    }
  }, [cancelReads, commit, isCurrentRead, observe, publishObservation]);

  const loadMorePage = useCallback(async <T,>({
    kind,
    pageOf,
    withPage,
    fetchNext,
    rowHandle,
    creationIdentity,
    errorTitle,
  }: {
    kind: PageKind;
    pageOf: (snapshot: ReadySnapshot) => LibraryGovernancePageState<T>;
    withPage: (snapshot: ReadySnapshot, page: LibraryGovernancePageState<T>) => ReadySnapshot;
    fetchNext: (cursor: string, signal: AbortSignal) => Promise<LibraryGovernancePage<T>>;
    rowHandle: (row: T) => string;
    creationIdentity: (row: T) => string;
    errorTitle: string;
  }) => {
    const current = stateRef.current;
    if (!mountedRef.current || current.snapshot.kind !== "Ready") return;
    const page = pageOf(current.snapshot);
    if (page.nextCursor.kind !== "Present" || page.pageLoad.kind === "Loading") return;
    const requestedCursor = page.nextCursor;
    pageAbortRef.current[kind]?.abort();
    const controller = new AbortController();
    pageAbortRef.current[kind] = controller;
    commit((latest) =>
      latest.snapshot.kind === "Ready"
        ? {
            ...latest,
            snapshot: withPage(latest.snapshot, {
              ...pageOf(latest.snapshot),
              pageLoad: { kind: "Loading" },
            }),
          }
        : latest,
    );
    try {
      const incoming = await fetchNext(requestedCursor.value, controller.signal);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        pageAbortRef.current[kind] !== controller
      ) return;
      const captured = stateRef.current.snapshot;
      if (captured.kind !== "Ready") return;
      const merged = mergeLibraryGovernancePage(
        pageOf(captured), incoming, requestedCursor, rowHandle, creationIdentity,
      );
      if (merged.kind === "RestartRequired") {
        await ensureFresh();
        return;
      }
      commit((latest) =>
        latest.snapshot.kind === "Ready"
          ? { ...latest, snapshot: withPage(latest.snapshot, merged.page) }
          : latest,
      );
    } catch (error) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        pageAbortRef.current[kind] !== controller
      ) return;
      if (handleUnauthenticatedApiError(error)) return;
      if (isLibraryContractDefect(error)) {
        setDefectState({ error });
        return;
      }
      if (isApiError(error) && (error.status === 403 || error.status === 404)) {
        await ensureFresh();
        return;
      }
      const failure = classifyGovernanceFailure(error, errorTitle);
      if (failure.kind === "Defect") {
        setDefectState({ error: failure.error });
        return;
      }
      commit((latest) =>
        latest.snapshot.kind === "Ready"
          ? {
              ...latest,
              snapshot: withPage(latest.snapshot, {
                ...pageOf(latest.snapshot),
                pageLoad: { kind: "Failed", feedback: failure.feedback },
              }),
            }
          : latest,
      );
    }
  }, [commit, ensureFresh]);

  const loadMoreMembers = useCallback(() => loadMorePage<LibraryMember>({
    kind: "members",
    pageOf: (snapshot) => snapshot.members,
    withPage: (snapshot, members) => ({ ...snapshot, members }),
    fetchNext: (cursor, signal) => listLibraryMembers({ libraryId, cursor, signal }),
    rowHandle: (row) => row.userHandle,
    creationIdentity: (row) => row.createdAt,
    errorTitle: "More members could not be loaded.",
  }), [libraryId, loadMorePage]);

  const loadMoreInvites = useCallback(() => loadMorePage<LibraryInvitation>({
    kind: "pendingInvites",
    pageOf: (snapshot) => snapshot.pendingInvites,
    withPage: (snapshot, pendingInvites) => ({ ...snapshot, pendingInvites }),
    fetchNext: (cursor, signal) => listPendingLibraryInvites({ libraryId, cursor, signal }),
    rowHandle: (row) => row.invitationHandle,
    creationIdentity: (row) => row.createdAt,
    errorTitle: "More invitations could not be loaded.",
  }), [libraryId, loadMorePage]);

  const setQuery = useCallback((query: string) => {
    commit((current) => ({
      ...current,
      draft: { ...current.draft, query, selectedUser: null },
    }));
  }, [commit]);

  const selectUser = useCallback((user: UserSearchResult) => {
    const label = user.displayName.kind === "Present"
      ? user.displayName.value
      : user.email.kind === "Present"
        ? user.email.value
        : user.userHandle;
    commit((current) => ({
      ...current,
      search: { kind: "Idle" },
      draft: { ...current.draft, query: label, selectedUser: user },
    }));
  }, [commit]);

  const setInviteRole = useCallback((inviteRole: LibraryRole) => {
    commit((current) => ({ ...current, draft: { ...current.draft, inviteRole } }));
  }, [commit]);

  const setConfirmation = useCallback((confirmation: LibraryGovernanceConfirmation | null) => {
    commit((current) => ({ ...current, draft: { ...current.draft, confirmation } }));
  }, [commit]);

  if (defectState !== null) throw defectState.error;
  if (library === null) return null;

  const inviteSelectedUser = async () => {
    const selected = stateRef.current.draft.selectedUser;
    const role = stateRef.current.draft.inviteRole;
    if (!selected) return;
    await runCommand(
      "Invite",
      () => createLibraryInvite({ libraryId, userHandle: selected.userHandle, role }),
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
    updateRole: (userHandle, toRole) => runCommand(
      "Role",
      () => updateLibraryMemberRole({ libraryId, userHandle, role: toRole }),
      "No confirmed role change was applied.",
      `Role changed to ${toRole}.`,
      userHandle,
    ),
    removeMember: (userHandle) => runCommand(
      "Remove",
      () => removeLibraryMember({ libraryId, userHandle }),
      "The member could not be removed.",
      "Member removed.",
    ),
    revokeInvite: (invitationHandle) => runCommand(
      "Revoke",
      () => revokeLibraryInvite(invitationHandle),
      "The invitation could not be revoked.",
      "Invitation revoked.",
    ),
    transferOwnership: (userHandle) => runCommand(
      "Transfer",
      () => transferLibraryOwnership({ libraryId, newOwnerUserHandle: userHandle }),
      "Ownership could not be transferred.",
      "Library ownership transferred.",
    ),
    loadMoreMembers,
    loadMoreInvites,
    retryReconciliation: ensureFresh,
  };
}
