import { describe, expect, it } from "vitest";
import type { LibraryGovernancePage } from "./contract";
import {
  acceptsLibraryGovernanceSettlement,
  acceptsLibrarySearchSettlement,
  adoptConfirmedLibraryGovernance,
  beginLibraryGovernanceLoad,
  clearLibraryGovernanceAuthority,
  initialLibraryGovernanceState,
  libraryGovernanceMutationsEnabled,
  libraryGovernanceRouteToken,
  markLibraryGovernanceReconciling,
  markLibraryGovernanceUnconfirmed,
  mergeLibraryGovernancePage,
  resetLibraryGovernanceState,
  type LibraryGovernancePageState,
} from "./governanceState";

const feedback = { severity: "error", title: "Not confirmed" } as const;
const absent = { kind: "Absent" } as const;
const present = (value: string) => ({ kind: "Present" as const, value });

interface Row {
  handle: string;
  createdAt: string;
}

function page(data: Row[], cursor?: string): LibraryGovernancePage<Row> {
  return {
    data,
    page: { nextCursor: cursor ? present(cursor) : absent },
  };
}

describe("Library governance state", () => {
  it("resets all presentation state and rejects stale route settlements", () => {
    const initial = initialLibraryGovernanceState("library-1", 4);
    const token = libraryGovernanceRouteToken(initial);
    const next = resetLibraryGovernanceState(initial, "library-2");

    expect(next).toMatchObject({
      libraryId: "library-2",
      routeEpoch: 5,
      snapshot: { kind: "Idle" },
      search: { kind: "Idle" },
      command: { kind: "Idle" },
      draft: { query: "", selectedUser: null, confirmation: null },
    });
    expect(acceptsLibraryGovernanceSettlement(next, token)).toBe(false);
    expect(beginLibraryGovernanceLoad(next, token)).toBe(next);
  });

  it("clears governance state only for the current observed authority", () => {
    const state = {
      ...initialLibraryGovernanceState("library-1", 2),
      snapshot: { kind: "Loading" as const },
      search: { kind: "Waiting" as const },
      draft: {
        ...initialLibraryGovernanceState("library-1", 2).draft,
        query: "Ada",
      },
    };
    const token = libraryGovernanceRouteToken(state);
    expect(clearLibraryGovernanceAuthority(state, token)).toEqual(
      initialLibraryGovernanceState("library-1", 2),
    );
  });

  it("accepts search results only for the captured route and latest sequence", () => {
    const state = {
      ...initialLibraryGovernanceState("library-1", 1),
      search: { kind: "Loading" as const, sequence: 3 },
    };
    const token = libraryGovernanceRouteToken(state);
    expect(acceptsLibrarySearchSettlement(state, token, 3)).toBe(true);
    expect(acceptsLibrarySearchSettlement(state, token, 2)).toBe(false);
    expect(
      acceptsLibrarySearchSettlement(
        resetLibraryGovernanceState(state, "library-2"),
        token,
        3,
      ),
    ).toBe(false);
  });

  it("retains the last confirmed snapshot while reconciliation is unconfirmed", () => {
    const initial = initialLibraryGovernanceState("library-1");
    const token = libraryGovernanceRouteToken(initial);
    const ready = adoptConfirmedLibraryGovernance(initial, token, {
      members: page([], "members-next") as never,
      pendingInvites: page([], "invites-next") as never,
    });
    const reconciling = markLibraryGovernanceReconciling(ready, token);
    const unconfirmed = markLibraryGovernanceUnconfirmed(
      reconciling,
      token,
      feedback,
    );

    expect(unconfirmed.snapshot).toMatchObject({
      kind: "Ready",
      members: { nextCursor: present("members-next") },
      pendingInvites: { nextCursor: present("invites-next") },
      reconciliation: { kind: "Unconfirmed" },
      refreshFeedback: feedback,
    });
    expect(libraryGovernanceMutationsEnabled(unconfirmed)).toBe(false);
  });

  it("preserves server order and tracks opaque cursors when appending", () => {
    const current: LibraryGovernancePageState<Row> = {
      rows: [{ handle: "a", createdAt: "one" }],
      nextCursor: present("cursor-1"),
      pageLoad: { kind: "Loading" },
    };
    expect(
      mergeLibraryGovernancePage(
        current,
        page([{ handle: "b", createdAt: "two" }], "cursor-2"),
        {
          rowHandle: (row) => row.handle,
          creationIdentity: (row) => row.createdAt,
          requestedCursor: present("cursor-1"),
          seenCursors: [],
        },
      ),
    ).toEqual({
      kind: "Merged",
      page: {
        rows: [
          { handle: "a", createdAt: "one" },
          { handle: "b", createdAt: "two" },
        ],
        nextCursor: present("cursor-2"),
        pageLoad: { kind: "Idle" },
      },
      seenCursors: ["cursor-1", "cursor-2"],
    });
  });

  it("restarts for a reincarnated stable handle", () => {
    const current: LibraryGovernancePageState<Row> = {
      rows: [{ handle: "a", createdAt: "old" }],
      nextCursor: present("cursor-1"),
      pageLoad: { kind: "Loading" },
    };
    expect(
      mergeLibraryGovernancePage(
        current,
        page([{ handle: "a", createdAt: "new" }]),
        {
          rowHandle: (row) => row.handle,
          creationIdentity: (row) => row.createdAt,
          requestedCursor: present("cursor-1"),
          seenCursors: [],
        },
      ),
    ).toEqual({ kind: "RestartRequired" });
  });

  it("defects on duplicate handles and cursor cycles", () => {
    const current: LibraryGovernancePageState<Row> = {
      rows: [{ handle: "a", createdAt: "one" }],
      nextCursor: present("cursor-1"),
      pageLoad: { kind: "Loading" },
    };
    expect(() =>
      mergeLibraryGovernancePage(
        current,
        page([{ handle: "b", createdAt: "two" }], "cursor-1"),
        {
          rowHandle: (row) => row.handle,
          creationIdentity: (row) => row.createdAt,
          requestedCursor: present("cursor-1"),
          seenCursors: [],
        },
      ),
    ).toThrow(/cursor cycle/);
    expect(() =>
      mergeLibraryGovernancePage(
        current,
        page([
          { handle: "b", createdAt: "two" },
          { handle: "b", createdAt: "two" },
        ]),
        {
          rowHandle: (row) => row.handle,
          creationIdentity: (row) => row.createdAt,
          requestedCursor: present("cursor-1"),
          seenCursors: [],
        },
      ),
    ).toThrow(/duplicate stable handle/);
  });
});
