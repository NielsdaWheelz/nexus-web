import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LibraryMembersController } from "@/lib/libraries/useLibraryMembers";
import type { LibraryGovernanceConfirmation } from "@/lib/libraries/governanceState";
import LibraryMembersSurface from "./LibraryMembersSurface";

const USER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const OWNER_HANDLE =
  "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
const SECOND_USER_HANDLE =
  "nus1.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFF";

function controller(
  overrides: Partial<LibraryMembersController> = {},
): LibraryMembersController {
  return {
    libraryId: "11111111-1111-4111-8111-111111111111",
    library: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Research",
      color: null,
      ownerUserHandle: OWNER_HANDLE,
      isDefault: false,
      role: "admin",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    snapshot: {
      kind: "Ready",
      members: {
        rows: [
          {
            userHandle: USER_HANDLE,
            role: "member",
            isOwner: false,
            email: { kind: "Present", value: "ada@example.test" },
            displayName: { kind: "Present", value: "Ada Lovelace" },
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        nextCursor: { kind: "Absent" },
        pageLoad: { kind: "Idle" },
      },
      pendingInvites: {
        rows: [],
        nextCursor: { kind: "Absent" },
        pageLoad: { kind: "Idle" },
      },
      refreshFeedback: null,
      reconciliation: { kind: "Confirmed" },
    },
    search: { kind: "Ready", sequence: 1, results: [] },
    command: { kind: "Idle" },
    draft: {
      query: "nobody",
      selectedUser: null,
      inviteRole: "member",
      confirmation: null,
    },
    announcement: "",
    mutationsDisabled: false,
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    setQuery: vi.fn(),
    selectUser: vi.fn(),
    setInviteRole: vi.fn(),
    setConfirmation: vi.fn(),
    inviteSelectedUser: vi.fn().mockResolvedValue(undefined),
    updateRole: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    transferOwnership: vi.fn().mockResolvedValue(undefined),
    loadMoreMembers: vi.fn().mockResolvedValue(undefined),
    loadMoreInvites: vi.fn().mockResolvedValue(undefined),
    retryReconciliation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function ConfirmationHarness() {
  const [confirmation, setConfirmation] =
    useState<LibraryGovernanceConfirmation | null>(null);
  const value = controller({
    draft: {
      query: "",
      selectedUser: null,
      inviteRole: "member",
      confirmation,
    },
    setConfirmation,
  });
  return <LibraryMembersSurface controller={value} />;
}

function ConfirmationRemountHarness() {
  const [confirmation, setConfirmation] =
    useState<LibraryGovernanceConfirmation | null>(null);
  const [mounted, setMounted] = useState(true);
  const value = controller({
    draft: {
      query: "",
      selectedUser: null,
      inviteRole: "member",
      confirmation,
    },
    setConfirmation,
  });
  return (
    <>
      <button type="button" onClick={() => setMounted((current) => !current)}>
        Toggle Members
      </button>
      {mounted ? <LibraryMembersSurface controller={value} /> : null}
    </>
  );
}

function SuccessfulRemovalHarness({
  removeLastMember = false,
}: {
  removeLastMember?: boolean;
}) {
  const [confirmation, setConfirmation] =
    useState<LibraryGovernanceConfirmation | null>(null);
  const [phase, setPhase] = useState<"Idle" | "Running" | "Settled">(
    "Idle",
  );
  const base = controller();
  if (base.snapshot.kind !== "Ready") {
    throw new Error("expected Ready fixture");
  }
  const value = controller({
    snapshot: {
      ...base.snapshot,
      members: {
        ...base.snapshot.members,
        rows:
          phase === "Settled"
            ? removeLastMember
              ? []
              : [
                {
                  userHandle: SECOND_USER_HANDLE,
                  role: "member",
                  isOwner: false,
                  email: {
                    kind: "Present",
                    value: "grace@example.test",
                  },
                  displayName: {
                    kind: "Present",
                    value: "Grace Hopper",
                  },
                  createdAt: "2026-01-02T00:00:00Z",
                },
              ]
            : removeLastMember
              ? base.snapshot.members.rows
              : [
                ...base.snapshot.members.rows,
                {
                  userHandle: SECOND_USER_HANDLE,
                  role: "member",
                  isOwner: false,
                  email: {
                    kind: "Present",
                    value: "grace@example.test",
                  },
                  displayName: {
                    kind: "Present",
                    value: "Grace Hopper",
                  },
                  createdAt: "2026-01-02T00:00:00Z",
                },
              ],
      },
      pendingInvites: removeLastMember
        ? {
            rows: [
              {
                invitationHandle:
                  "nli1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
                libraryId:
                  "11111111-1111-4111-8111-111111111111",
                inviterUserHandle: OWNER_HANDLE,
                inviteeUserHandle: SECOND_USER_HANDLE,
                role: "member",
                status: "pending",
                inviteeEmail: {
                  kind: "Present",
                  value: "grace@example.test",
                },
                inviteeDisplayName: {
                  kind: "Present",
                  value: "Grace Hopper",
                },
                createdAt: "2026-01-02T00:00:00Z",
                respondedAt: { kind: "Absent" },
              },
            ],
            nextCursor: { kind: "Absent" },
            pageLoad: { kind: "Idle" },
          }
        : base.snapshot.pendingInvites,
    },
    command:
      phase === "Running"
        ? {
            kind: "Running",
            operation: {
              kind: "Remove",
              userHandle: USER_HANDLE,
              routeEpoch: 0,
            },
          }
        : { kind: "Idle" },
    draft: {
      query: "",
      selectedUser: null,
      inviteRole: "member",
      confirmation,
    },
    announcement: phase === "Settled" ? "Member removed." : "",
    setConfirmation,
    removeMember: async () => {
      setPhase("Running");
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      setConfirmation(null);
      setPhase("Settled");
    },
  });
  return <LibraryMembersSurface controller={value} />;
}

describe("LibraryMembersSurface", () => {
  it("presents account lookup, person facts, no matches, and an explicit empty invitations state", () => {
    render(<LibraryMembersSurface controller={controller()} />);

    expect(
      screen.getByRole("combobox", {
        name: "Find an existing Nexus user by name or account email",
      }),
    ).toHaveAccessibleDescription(
      "Find an existing Nexus user by name or account email. No matching Nexus users.",
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.test")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Role for Ada Lovelace" }),
    ).toHaveDisplayValue("Role: Member");
    expect(screen.getByText("No pending invitations.")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(USER_HANDLE))).not.toBeInTheDocument();
  });

  it("renders ownership and role as separate row facts", () => {
    const base = controller();
    if (base.snapshot.kind !== "Ready") {
      throw new Error("expected Ready fixture");
    }
    render(
      <LibraryMembersSurface
        controller={controller({
          snapshot: {
            ...base.snapshot,
            members: {
              ...base.snapshot.members,
              rows: [
                {
                  ...base.snapshot.members.rows[0],
                  userHandle: OWNER_HANDLE,
                  role: "admin",
                  isOwner: true,
                },
              ],
            },
          },
        })}
      />,
    );

    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Role: Admin")).toBeInTheDocument();
    expect(screen.queryByText("Owner · Admin")).not.toBeInTheDocument();
  });

  it("opens a named inline alertdialog without menu focus theft and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<ConfirmationHarness />);

    const trigger = screen.getByRole("button", {
      name: "Actions for Ada Lovelace",
    });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Remove member…" }));

    const dialog = screen.getByRole("alertdialog", {
      name: "Remove member?",
    });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(dialog).toHaveAccessibleDescription(
      "Remove Ada Lovelace from this Library? Other access paths are not changed.",
    );
    const cancel = screen.getByRole("button", {
      name: "Cancel removing Ada Lovelace",
    });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(trigger).not.toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toHaveFocus(),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    const nextTrigger = screen.getByRole("button", {
      name: "Actions for Ada Lovelace",
    });
    await user.click(nextTrigger);
    await user.click(screen.getByRole("menuitem", { name: "Remove member…" }));
    await user.click(
      screen.getByRole("button", {
        name: "Cancel removing Ada Lovelace",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toHaveFocus(),
    );
  });

  it("derives a section-local focus fallback after the Members body remounts", async () => {
    const user = userEvent.setup();
    render(<ConfirmationRemountHarness />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Ada Lovelace" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove member…" }));
    await user.click(
      screen.getByRole("button", { name: "Toggle Members" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Toggle Members" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Cancel removing Ada Lovelace",
        }),
      ).toHaveFocus(),
    );

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toHaveFocus(),
    );
  });

  it.each([280, 360, 720])(
    "keeps governance content usable in a %ipx container",
    (width) => {
      render(
        <div style={{ width }}>
          <LibraryMembersSurface controller={controller()} />
        </div>,
      );
      const row = screen.getByTestId(`library-member-${USER_HANDLE}`);
      expect(row).toBeVisible();
      expect(getComputedStyle(row).flexDirection).toBe(
        width <= 360 ? "column" : "row",
      );
      expect(
        screen.getByRole("combobox", {
          name: "Find an existing Nexus user by name or account email",
        }),
      ).toBeVisible();
      expect(screen.getByTestId("library-members-surface")).toBeVisible();
    },
  );

  it("retains confirmed rows while a failed next page is retryable", async () => {
    const user = userEvent.setup();
    const loadMoreMembers = vi.fn().mockResolvedValue(undefined);
    const base = controller();
    if (base.snapshot.kind !== "Ready") {
      throw new Error("expected Ready fixture");
    }
    const value = controller({
      snapshot: {
        ...base.snapshot,
        members: {
          ...base.snapshot.members,
          nextCursor: { kind: "Present", value: "next-page" },
          pageLoad: {
            kind: "Failed",
            feedback: {
              tone: "Danger",
              title: "More members could not be loaded.",
            },
          },
        },
      },
      loadMoreMembers,
    });
    render(<LibraryMembersSurface controller={value} />);

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadMoreMembers).toHaveBeenCalledOnce();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("announces that a failed role command applied no confirmed change", () => {
    const ready = controller().snapshot;
    if (ready.kind !== "Ready") throw new Error("expected Ready fixture");
    render(
      <LibraryMembersSurface
        controller={controller({
          snapshot: {
            ...ready,
            refreshFeedback: {
              tone: "Danger",
              title: "No confirmed role change was applied.",
            },
          },
          announcement: "No confirmed role change was applied.",
        })}
      />,
    );

    expect(
      screen.getAllByText("No confirmed role change was applied."),
    ).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps unconfirmed settlement details and recovery in one durable lane", async () => {
    const user = userEvent.setup();
    const retryReconciliation = vi.fn().mockResolvedValue(undefined);
    const ready = controller().snapshot;
    if (ready.kind !== "Ready") throw new Error("expected Ready fixture");
    render(
      <LibraryMembersSurface
        controller={controller({
          snapshot: {
            ...ready,
            refreshFeedback: {
              tone: "Warning",
              title: "The outcome is not yet confirmed.",
            },
            reconciliation: { kind: "Unconfirmed" },
          },
          retryReconciliation,
        })}
      />,
    );

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The outcome is not yet confirmed.",
    );
    expect(screen.getAllByText("The outcome is not yet confirmed.")).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Retry reconciliation" }),
    );
    expect(retryReconciliation).toHaveBeenCalledOnce();
  });

  it("associates a failed account search with the combobox", () => {
    render(
      <LibraryMembersSurface
        controller={controller({
          search: {
            kind: "Failed",
            sequence: 2,
            feedback: {
              tone: "Danger",
              title: "People could not be searched.",
            },
          },
        })}
      />,
    );

    expect(
      screen.getByRole("combobox", {
        name: "Find an existing Nexus user by name or account email",
      }),
    ).toHaveAccessibleDescription(
      "Find an existing Nexus user by name or account email. People could not be searched.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("status")
        .filter((node) =>
          node.textContent?.includes("People could not be searched."),
        ),
    ).toHaveLength(1);
  });

  it("keeps the server-confirmed role value controlled while requesting a change", async () => {
    const user = userEvent.setup();
    const updateRole = vi.fn().mockResolvedValue(undefined);
    render(
      <LibraryMembersSurface controller={controller({ updateRole })} />,
    );

    const select = screen.getByRole("combobox", {
      name: "Role for Ada Lovelace",
    });
    await user.selectOptions(select, "admin");
    expect(updateRole).toHaveBeenCalledWith(
      USER_HANDLE,
      "member",
      "admin",
    );
    expect(select).toHaveValue("member");
    expect(select).toHaveFocus();
  });

  it("moves focus to the next member after a confirmed removal disconnects its trigger", async () => {
    const user = userEvent.setup();
    render(<SuccessfulRemovalHarness />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Ada Lovelace" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove member…" }));
    await user.click(screen.getByRole("button", { name: "Remove Ada Lovelace" }));

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", {
          name: "Role for Grace Hopper",
        }),
      ).toHaveFocus(),
    );
    expect(screen.getByText("Member removed.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Actions for Ada Lovelace" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the People heading when a confirmed removal empties that section", async () => {
    const user = userEvent.setup();
    render(<SuccessfulRemovalHarness removeLastMember />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Ada Lovelace" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove member…" }));
    await user.click(
      screen.getByRole("button", { name: "Remove Ada Lovelace" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "People" }),
      ).toHaveFocus(),
    );
    expect(
      screen.getByRole("button", {
        name: "Revoke invitation for Grace Hopper",
      }),
    ).not.toHaveFocus();
    expect(screen.getByText("Member removed.")).toBeInTheDocument();
  });
});
