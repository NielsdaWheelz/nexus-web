import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { Presence } from "@/lib/api/presence";
import { LibraryContractDefect } from "@/lib/libraries/contract";
import type {
  LibraryGovernanceCursor,
  LibraryGovernancePage,
  LibraryInvitation,
  LibraryMember,
  LibraryRole,
} from "@/lib/libraries/contract";
import type { UserSearchResult } from "@/lib/users/search";

export type LibraryGovernancePageLoad =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Failed"; feedback: FeedbackContent };

export interface LibraryGovernancePageState<T> {
  rows: T[];
  nextCursor: Presence<LibraryGovernanceCursor>;
  pageLoad: LibraryGovernancePageLoad;
}

export type LibraryGovernanceReconciliation =
  | { kind: "Confirmed" }
  | { kind: "Reconciling" }
  | { kind: "Unconfirmed" };

export type LibraryGovernanceSnapshot =
  | { kind: "Idle" }
  | { kind: "Loading" }
  | { kind: "Failed"; feedback: FeedbackContent }
  | {
      kind: "Ready";
      members: LibraryGovernancePageState<LibraryMember>;
      pendingInvites: LibraryGovernancePageState<LibraryInvitation>;
      refreshFeedback: FeedbackContent | null;
      reconciliation: LibraryGovernanceReconciliation;
    };

export type LibraryGovernanceSearch =
  | { kind: "Idle" }
  | { kind: "Waiting" }
  | { kind: "Loading"; sequence: number }
  | { kind: "Ready"; sequence: number; results: UserSearchResult[] }
  | { kind: "Failed"; sequence: number; feedback: FeedbackContent };

export type LibraryGovernanceCommandDescriptor =
  | {
      kind: "Invite";
      userHandle: string;
      role: LibraryRole;
      routeEpoch: number;
    }
  | {
      kind: "Role";
      userHandle: string;
      fromRole: LibraryRole;
      toRole: LibraryRole;
      routeEpoch: number;
    }
  | { kind: "Remove"; userHandle: string; routeEpoch: number }
  | { kind: "Revoke"; invitationHandle: string; routeEpoch: number }
  | { kind: "Transfer"; userHandle: string; routeEpoch: number };

export type LibraryGovernanceCommand =
  | { kind: "Idle" }
  | { kind: "Running"; operation: LibraryGovernanceCommandDescriptor };

export type LibraryGovernanceConfirmation =
  | {
      kind: "Remove";
      userHandle: string;
      label: string;
      returnFocusTarget: HTMLElement | null;
    }
  | {
      kind: "Transfer";
      userHandle: string;
      label: string;
      returnFocusTarget: HTMLElement | null;
    }
  | {
      kind: "Revoke";
      invitationHandle: string;
      label: string;
      returnFocusTarget: HTMLElement | null;
    };

export interface LibraryGovernanceDraft {
  query: string;
  selectedUser: UserSearchResult | null;
  inviteRole: LibraryRole;
  confirmation: LibraryGovernanceConfirmation | null;
}

export interface LibraryGovernanceState {
  libraryId: string;
  routeEpoch: number;
  snapshot: LibraryGovernanceSnapshot;
  search: LibraryGovernanceSearch;
  command: LibraryGovernanceCommand;
  draft: LibraryGovernanceDraft;
}

export interface LibraryGovernanceRouteToken {
  libraryId: string;
  routeEpoch: number;
}

export interface LibraryGovernancePageMergeOptions<T> {
  rowHandle: (row: T) => string;
  creationIdentity: (row: T) => string;
  requestedCursor: Presence<LibraryGovernanceCursor>;
  seenCursors: readonly LibraryGovernanceCursor[];
}

export type LibraryGovernancePageMerge<T> =
  | {
      kind: "Merged";
      page: LibraryGovernancePageState<T>;
      seenCursors: LibraryGovernanceCursor[];
    }
  | { kind: "RestartRequired" };

const idlePage = <T>(
  page: LibraryGovernancePage<T>,
): LibraryGovernancePageState<T> => ({
  rows: [...page.data],
  nextCursor: page.page.nextCursor,
  pageLoad: { kind: "Idle" },
});

function assertUniqueStableHandles<T>(
  rows: readonly T[],
  rowHandle: (row: T) => string,
  name: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const handle = rowHandle(row);
    if (seen.has(handle)) {
      throw new LibraryContractDefect(
        `${name} contains a duplicate stable handle`,
      );
    }
    seen.add(handle);
  }
}

export function initialLibraryGovernanceState(
  libraryId: string,
  routeEpoch = 0,
): LibraryGovernanceState {
  return {
    libraryId,
    routeEpoch,
    snapshot: { kind: "Idle" },
    search: { kind: "Idle" },
    command: { kind: "Idle" },
    draft: {
      query: "",
      selectedUser: null,
      inviteRole: "member",
      confirmation: null,
    },
  };
}

export function resetLibraryGovernanceState(
  state: LibraryGovernanceState,
  libraryId: string,
): LibraryGovernanceState {
  return initialLibraryGovernanceState(libraryId, state.routeEpoch + 1);
}

export function libraryGovernanceRouteToken(
  state: Pick<LibraryGovernanceState, "libraryId" | "routeEpoch">,
): LibraryGovernanceRouteToken {
  return {
    libraryId: state.libraryId,
    routeEpoch: state.routeEpoch,
  };
}

export function acceptsLibraryGovernanceSettlement(
  state: Pick<LibraryGovernanceState, "libraryId" | "routeEpoch">,
  token: LibraryGovernanceRouteToken,
): boolean {
  return (
    state.libraryId === token.libraryId &&
    state.routeEpoch === token.routeEpoch
  );
}

export function acceptsLibrarySearchSettlement(
  state: Pick<LibraryGovernanceState, "libraryId" | "routeEpoch" | "search">,
  token: LibraryGovernanceRouteToken,
  sequence: number,
): boolean {
  return (
    acceptsLibraryGovernanceSettlement(state, token) &&
    state.search.kind === "Loading" &&
    state.search.sequence === sequence
  );
}

export function beginLibraryGovernanceLoad(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
): LibraryGovernanceState {
  if (!acceptsLibraryGovernanceSettlement(state, token)) return state;
  return { ...state, snapshot: { kind: "Loading" } };
}

export function clearLibraryGovernanceAuthority(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
): LibraryGovernanceState {
  if (!acceptsLibraryGovernanceSettlement(state, token)) return state;
  return initialLibraryGovernanceState(state.libraryId, state.routeEpoch);
}

export function failLibraryGovernanceLoad(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
  feedback: FeedbackContent,
): LibraryGovernanceState {
  if (!acceptsLibraryGovernanceSettlement(state, token)) return state;
  return { ...state, snapshot: { kind: "Failed", feedback } };
}

export function adoptConfirmedLibraryGovernance(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
  pages: {
    members: LibraryGovernancePage<LibraryMember>;
    pendingInvites: LibraryGovernancePage<LibraryInvitation>;
  },
): LibraryGovernanceState {
  if (!acceptsLibraryGovernanceSettlement(state, token)) return state;
  assertUniqueStableHandles(
    pages.members.data,
    (member) => member.userHandle,
    "Library members page",
  );
  assertUniqueStableHandles(
    pages.pendingInvites.data,
    (invitation) => invitation.invitationHandle,
    "Library invitations page",
  );
  return {
    ...state,
    snapshot: {
      kind: "Ready",
      members: idlePage(pages.members),
      pendingInvites: idlePage(pages.pendingInvites),
      refreshFeedback: null,
      reconciliation: { kind: "Confirmed" },
    },
    command: { kind: "Idle" },
  };
}

export function markLibraryGovernanceReconciling(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
): LibraryGovernanceState {
  if (
    !acceptsLibraryGovernanceSettlement(state, token) ||
    state.snapshot.kind !== "Ready"
  ) {
    return state;
  }
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      refreshFeedback: null,
      reconciliation: { kind: "Reconciling" },
    },
  };
}

export function markLibraryGovernanceUnconfirmed(
  state: LibraryGovernanceState,
  token: LibraryGovernanceRouteToken,
  feedback: FeedbackContent,
): LibraryGovernanceState {
  if (
    !acceptsLibraryGovernanceSettlement(state, token) ||
    state.snapshot.kind !== "Ready"
  ) {
    return state;
  }
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      refreshFeedback: feedback,
      reconciliation: { kind: "Unconfirmed" },
    },
    command: { kind: "Idle" },
  };
}

export function libraryGovernanceMutationsEnabled(
  state: Pick<LibraryGovernanceState, "snapshot" | "command">,
): boolean {
  return (
    state.snapshot.kind === "Ready" &&
    state.snapshot.reconciliation.kind === "Confirmed" &&
    state.command.kind === "Idle"
  );
}

export function mergeLibraryGovernancePage<T>(
  current: LibraryGovernancePageState<T>,
  incoming: LibraryGovernancePage<T>,
  options: LibraryGovernancePageMergeOptions<T>,
): LibraryGovernancePageMerge<T> {
  if (
    options.requestedCursor.kind !== "Present" ||
    current.nextCursor.kind !== "Present" ||
    options.requestedCursor.value !== current.nextCursor.value
  ) {
    throw new LibraryContractDefect(
      "Library governance page settlement does not match the requested next cursor",
    );
  }

  const existing = new Map<string, string>();
  for (const row of current.rows) {
    const handle = options.rowHandle(row);
    if (existing.has(handle)) {
      throw new LibraryContractDefect(
        "Library governance page state contains a duplicate stable handle",
      );
    }
    existing.set(handle, options.creationIdentity(row));
  }

  const incomingHandles = new Set<string>();
  for (const row of incoming.data) {
    const handle = options.rowHandle(row);
    if (incomingHandles.has(handle)) {
      throw new LibraryContractDefect(
        "Library governance page contains a duplicate stable handle",
      );
    }
    incomingHandles.add(handle);
    const existingCreation = existing.get(handle);
    if (existingCreation !== undefined) {
      if (existingCreation !== options.creationIdentity(row)) {
        return { kind: "RestartRequired" };
      }
      throw new LibraryContractDefect(
        "Library governance page repeats a stable handle",
      );
    }
  }

  const seenCursors = new Set(options.seenCursors);
  seenCursors.add(options.requestedCursor.value);
  if (
    incoming.page.nextCursor.kind === "Present" &&
    seenCursors.has(incoming.page.nextCursor.value)
  ) {
    throw new LibraryContractDefect(
      "Library governance pagination returned a cursor cycle",
    );
  }
  if (incoming.page.nextCursor.kind === "Present") {
    seenCursors.add(incoming.page.nextCursor.value);
  }

  return {
    kind: "Merged",
    page: {
      rows: [...current.rows, ...incoming.data],
      nextCursor: incoming.page.nextCursor,
      pageLoad: { kind: "Idle" },
    },
    seenCursors: [...seenCursors],
  };
}

export function beginLibraryGovernancePageLoad<T>(
  page: LibraryGovernancePageState<T>,
): LibraryGovernancePageState<T> {
  return { ...page, pageLoad: { kind: "Loading" } };
}

export function failLibraryGovernancePageLoad<T>(
  page: LibraryGovernancePageState<T>,
  feedback: FeedbackContent,
): LibraryGovernancePageState<T> {
  return { ...page, pageLoad: { kind: "Failed", feedback } };
}
