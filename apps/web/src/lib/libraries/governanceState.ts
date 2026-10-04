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
  seenCursors: LibraryGovernanceCursor[];
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

export type LibraryGovernanceCommandKind =
  | "Invite"
  | "Role"
  | "Remove"
  | "Revoke"
  | "Transfer";

export type LibraryGovernanceCommand =
  | { kind: "Idle" }
  | { kind: "Running"; operation: { kind: LibraryGovernanceCommandKind } };

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
  snapshot: LibraryGovernanceSnapshot;
  search: LibraryGovernanceSearch;
  command: LibraryGovernanceCommand;
  draft: LibraryGovernanceDraft;
}

export function initialLibraryGovernanceState(): LibraryGovernanceState {
  return {
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

export function libraryGovernanceMutationsEnabled(
  state: Pick<LibraryGovernanceState, "snapshot" | "command">,
): boolean {
  return (
    state.snapshot.kind === "Ready" &&
    state.snapshot.reconciliation.kind === "Confirmed" &&
    state.command.kind === "Idle"
  );
}

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

export function libraryGovernanceFirstPage<T>(
  page: LibraryGovernancePage<T>,
  rowHandle: (row: T) => string,
  name: string,
): LibraryGovernancePageState<T> {
  assertUniqueStableHandles(page.data, rowHandle, name);
  return {
    rows: [...page.data],
    nextCursor: page.page.nextCursor,
    seenCursors: [],
    pageLoad: { kind: "Idle" },
  };
}

export function mergeLibraryGovernancePage<T>(
  current: LibraryGovernancePageState<T>,
  incoming: LibraryGovernancePage<T>,
  requestedCursor: Presence<LibraryGovernanceCursor>,
  rowHandle: (row: T) => string,
  creationIdentity: (row: T) => string,
):
  | { kind: "Merged"; page: LibraryGovernancePageState<T> }
  | { kind: "RestartRequired" } {
  if (
    requestedCursor.kind !== "Present" ||
    current.nextCursor.kind !== "Present" ||
    requestedCursor.value !== current.nextCursor.value
  ) {
    throw new LibraryContractDefect(
      "Library governance page settlement does not match the requested next cursor",
    );
  }

  const existing = new Map<string, string>();
  for (const row of current.rows) {
    const handle = rowHandle(row);
    if (existing.has(handle)) {
      throw new LibraryContractDefect(
        "Library governance page state contains a duplicate stable handle",
      );
    }
    existing.set(handle, creationIdentity(row));
  }

  const incomingHandles = new Set<string>();
  for (const row of incoming.data) {
    const handle = rowHandle(row);
    if (incomingHandles.has(handle)) {
      throw new LibraryContractDefect(
        "Library governance page contains a duplicate stable handle",
      );
    }
    incomingHandles.add(handle);
    const existingCreation = existing.get(handle);
    if (existingCreation !== undefined) {
      if (existingCreation !== creationIdentity(row)) {
        return { kind: "RestartRequired" };
      }
      throw new LibraryContractDefect(
        "Library governance page repeats a stable handle",
      );
    }
  }

  const seenCursors = new Set(current.seenCursors);
  seenCursors.add(requestedCursor.value);
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
      seenCursors: [...seenCursors],
      pageLoad: { kind: "Idle" },
    },
  };
}
