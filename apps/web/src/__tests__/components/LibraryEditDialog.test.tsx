import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LibraryEditDialog from "@/components/LibraryEditDialog";
import type {
  LibraryForEdit,
  LibraryMember,
  LibraryInvite,
} from "@/components/LibraryEditDialog";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    user_id: "user-member",
    role: "member",
    is_owner: false,
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
    created_at: "2026-02-01T00:00:00Z",
  },
];

const noop = async () => {};

function renderDialog(overrides: Partial<Parameters<typeof LibraryEditDialog>[0]> = {}) {
  const defaults = {
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
  };
  const props = { ...defaults, ...overrides };
  const view = render(<LibraryEditDialog {...props} />);
  return { ...view, props };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("LibraryEditDialog", () => {
  /* ---------- Name section ---------- */

  it("renders name input pre-filled with library name", () => {
    renderDialog();
    const input = screen.getByLabelText("Library name");
    expect(input).toHaveValue("Research Papers");
  });

  it("calls onRename with trimmed name on save", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    const input = screen.getByLabelText("Library name");
    await user.clear(input);
    await user.type(input, "  New Name  ");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(props.onRename).toHaveBeenCalledWith("New Name");
  });

  it("disables save button when name is unchanged", () => {
    renderDialog();
    const saveBtn = screen.getByRole("button", { name: "Save name" });
    expect(saveBtn).toBeDisabled();
  });

  /* ---------- Members section ---------- */

  it("renders member list with roles", () => {
    renderDialog();

    const memberSection = screen.getByRole("region", { name: "Members" });
    expect(within(memberSection).getByText("user-owner")).toBeInTheDocument();
    expect(within(memberSection).getByText("user-member")).toBeInTheDocument();
  });

  it("shows owner badge on owner row", () => {
    renderDialog();
    const memberSection = screen.getByRole("region", { name: "Members" });
    expect(within(memberSection).getByText("owner")).toBeInTheDocument();
  });

  it("calls onUpdateMemberRole when role is changed", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    // Find the role select for the non-owner member
    const memberSection = screen.getByRole("region", { name: "Members" });
    const roleSelect = within(memberSection).getByLabelText(
      "Role for user-member"
    );
    await user.selectOptions(roleSelect, "admin");

    expect(props.onUpdateMemberRole).toHaveBeenCalledWith(
      "user-member",
      "admin"
    );
  });

  it("does not show role select or remove button for owner", () => {
    renderDialog();
    const memberSection = screen.getByRole("region", { name: "Members" });
    expect(
      within(memberSection).queryByLabelText("Role for user-owner")
    ).not.toBeInTheDocument();
    expect(
      within(memberSection).queryByLabelText("Remove user-owner")
    ).not.toBeInTheDocument();
  });

  it("calls onRemoveMember when remove is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    const memberSection = screen.getByRole("region", { name: "Members" });
    await user.click(
      within(memberSection).getByRole("button", {
        name: "Remove user-member",
      })
    );

    expect(props.onRemoveMember).toHaveBeenCalledWith("user-member");
  });

  /* ---------- Invite section ---------- */

  it("renders pending invites", () => {
    renderDialog();
    const inviteSection = screen.getByRole("region", { name: "Invitations" });
    expect(
      within(inviteSection).getByText("user-pending")
    ).toBeInTheDocument();
  });

  it("calls onRevokeInvite when revoke is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    const inviteSection = screen.getByRole("region", { name: "Invitations" });
    await user.click(
      within(inviteSection).getByRole("button", { name: "Revoke" })
    );

    expect(props.onRevokeInvite).toHaveBeenCalledWith("inv-1");
  });

  it("calls onCreateInvite with user ID and role", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    const inviteSection = screen.getByRole("region", { name: "Invitations" });
    const userIdInput = within(inviteSection).getByLabelText("User ID");
    await user.type(userIdInput, "user-new");
    await user.click(
      within(inviteSection).getByRole("button", { name: "Invite" })
    );

    expect(props.onCreateInvite).toHaveBeenCalledWith("user-new", "member");
  });

  /* ---------- Delete section ---------- */

  it("calls onDelete when delete is confirmed", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Delete library" })
    );

    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  /* ---------- Non-admin view ---------- */

  it("hides edit controls for non-admin members", () => {
    renderDialog({
      library: { ...baseLibrary, role: "member" },
    });

    // Name input should be read-only
    const nameInput = screen.getByLabelText("Library name");
    expect(nameInput).toBeDisabled();

    // No save name button
    expect(
      screen.queryByRole("button", { name: "Save name" })
    ).not.toBeInTheDocument();

    // No role selects
    expect(
      screen.queryByLabelText("Role for user-member")
    ).not.toBeInTheDocument();

    // No remove buttons
    expect(
      screen.queryByRole("button", { name: /^Remove / })
    ).not.toBeInTheDocument();

    // No invite form
    expect(screen.queryByLabelText("User ID")).not.toBeInTheDocument();

    // No delete button
    expect(
      screen.queryByRole("button", { name: "Delete library" })
    ).not.toBeInTheDocument();
  });

  /* ---------- Close ---------- */

  it("calls onClose when dialog close button is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
