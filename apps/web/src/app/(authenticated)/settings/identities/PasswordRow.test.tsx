import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LinkedIdentity } from "@/lib/auth/identities";

const setPasswordAction = vi.hoisted(() => vi.fn());
const changePasswordAction = vi.hoisted(() => vi.fn());
const removePasswordAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password-actions", () => ({
  setPasswordAction,
  changePasswordAction,
  removePasswordAction,
}));

import { PasswordRow } from "./PasswordRow";

function googleIdentity(): LinkedIdentity {
  return {
    id: "google-id",
    provider: "google",
    email: "owner+google@example.com",
    createdAt: "2026-03-21T00:00:00Z",
  };
}

function emailIdentity(): LinkedIdentity {
  return {
    id: "email-id",
    provider: "email",
    email: "owner@example.com",
    createdAt: "2026-03-21T00:00:00Z",
  };
}

describe("PasswordRow", () => {
  it("renders a Set password button and opens a dialog with a password input when no email identity exists", async () => {
    const user = userEvent.setup();
    render(<PasswordRow identities={[googleIdentity()]} onChanged={vi.fn()} />);

    const setButton = screen.getByRole("button", { name: /set password/i });
    expect(setButton).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change password/i })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /remove password/i })
    ).toBeNull();

    await user.click(setButton);

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-label",
      "Set password"
    );
    expect(screen.getByLabelText(/new password/i)).toHaveAttribute(
      "type",
      "password"
    );
  });

  it("renders the email subtitle plus Change and Remove buttons when an email identity exists alongside others", () => {
    render(
      <PasswordRow
        identities={[emailIdentity(), googleIdentity()]}
        onChanged={vi.fn()}
      />
    );

    expect(
      screen.getByText(/password is set on owner@example\.com/i)
    ).toBeInTheDocument();
    const changeButton = screen.getByRole("button", {
      name: /change password/i,
    });
    const removeButton = screen.getByRole("button", {
      name: /remove password/i,
    });
    expect(changeButton).toBeEnabled();
    expect(removeButton).toBeEnabled();
    expect(
      screen.queryByText(/add a linked provider first/i)
    ).not.toBeInTheDocument();
  });

  it("disables Remove password and shows the hint text when the email identity is the only one", () => {
    render(<PasswordRow identities={[emailIdentity()]} onChanged={vi.fn()} />);

    const removeButton = screen.getByRole("button", {
      name: /remove password/i,
    });
    expect(removeButton).toBeDisabled();
    expect(
      screen.getByText(/add a linked provider first/i)
    ).toBeInTheDocument();
  });
});
