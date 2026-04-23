import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import type {
  LibraryForEdit,
  LibraryInvite,
  LibraryMember,
} from "@/components/LibraryEditDialog";

const baseLibrary: LibraryForEdit = {
  id: "lib-1",
  name: "Research Papers",
  is_default: false,
  role: "admin",
  owner_user_id: "user-owner",
};

const members: LibraryMember[] = [
  {
    user_id: "user-owner",
    role: "admin",
    is_owner: true,
    email: "owner@example.com",
    display_name: "Alice Owner",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    user_id: "user-member",
    role: "member",
    is_owner: false,
    email: "member@example.com",
    display_name: null,
    created_at: "2026-01-02T00:00:00Z",
  },
];

const invites: LibraryInvite[] = [
  {
    id: "inv-1",
    library_id: "lib-1",
    inviter_user_id: "user-owner",
    invitee_user_id: "user-pending",
    role: "member",
    status: "pending",
    invitee_email: "pending@example.com",
    invitee_display_name: "Pending User",
    created_at: "2026-02-01T00:00:00Z",
  },
];

const noop = async () => {};

function renderDialog(
  overrides: Partial<Parameters<typeof LibraryEditDialog>[0]> = {}
) {
  const dialogProps = {
    open: true,
    onClose: vi.fn(),
    library: baseLibrary,
    members,
    invites,
    onRename: vi.fn(noop),
    onUpdateMemberRole: vi.fn(noop),
    onRemoveMember: vi.fn(noop),
    onCreateInvite: vi.fn(noop),
    onRevokeInvite: vi.fn(noop),
    onDelete: vi.fn(noop),
    ...overrides,
  };

  render(<LibraryEditDialog {...dialogProps} />);
  return dialogProps;
}

describe("LibraryEditDialog", () => {
  it("saves a trimmed library name", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const input = screen.getByLabelText("Library name");

    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();

    await user.clear(input);
    await user.type(input, "  New Name  ");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(view.onRename).toHaveBeenCalledWith("New Name");
  });

  it("updates a member role", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const membersRegion = screen.getByRole("region", { name: "Members" });

    await user.selectOptions(
      within(membersRegion).getByLabelText("Role for member@example.com"),
      "admin"
    );

    expect(view.onUpdateMemberRole).toHaveBeenCalledWith(
      "user-member",
      "admin"
    );
  });

  it("removes a member", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const membersRegion = screen.getByRole("region", { name: "Members" });

    await user.click(
      within(membersRegion).getByRole("button", {
        name: "Remove member@example.com",
      })
    );

    expect(view.onRemoveMember).toHaveBeenCalledWith("user-member");
  });

  it("revokes a pending invite", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const invitationsRegion = screen.getByRole("region", { name: "Invitations" });

    await user.click(
      within(invitationsRegion).getByRole("button", { name: "Revoke" })
    );

    expect(view.onRevokeInvite).toHaveBeenCalledWith("inv-1");
  });

  it("creates an invite with the typed email", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const invitationsRegion = screen.getByRole("region", { name: "Invitations" });

    await user.type(
      within(invitationsRegion).getByLabelText("Invitee email"),
      "newuser@example.com"
    );
    await user.click(
      within(invitationsRegion).getByRole("button", { name: "Invite" })
    );

    expect(view.onCreateInvite).toHaveBeenCalledWith(
      "newuser@example.com",
      "member"
    );
  });

  it("falls back to user_id when a member has no name or email", () => {
    renderDialog({
      members: [
        {
          user_id: "user-bare",
          role: "member",
          is_owner: false,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(
      within(screen.getByRole("region", { name: "Members" })).getByText(
        "user-bare"
      )
    ).toBeInTheDocument();
  });

  it("calls onDelete when delete is confirmed", async () => {
    const user = userEvent.setup();
    const view = renderDialog();

    await user.click(screen.getByRole("button", { name: "Delete library" }));

    expect(view.onDelete).toHaveBeenCalledTimes(1);
  });

  it("hides admin-only controls for non-admin members", () => {
    renderDialog({
      library: { ...baseLibrary, role: "member" },
    });

    expect(screen.getByLabelText("Library name")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Save name" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Role for member@example.com")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Remove / })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Invitee email")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete library" })
    ).not.toBeInTheDocument();
  });
});
