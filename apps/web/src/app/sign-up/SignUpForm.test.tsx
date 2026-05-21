import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "@/lib/auth/messages";

const signUpWithPasswordAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password-actions", () => ({
  signInWithPasswordAction: vi.fn(),
  signUpWithPasswordAction,
  setPasswordAction: vi.fn(),
  changePasswordAction: vi.fn(),
  removePasswordAction: vi.fn(),
}));

import SignUpForm from "./SignUpForm";

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/display name/i), "Ada Lovelace");
  await user.type(screen.getByLabelText(/email/i), "ada@example.com");
  await user.type(
    screen.getByLabelText(/password/i),
    "long-enough-password-12"
  );
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

describe("SignUpForm", () => {
  it("renders display name, email, and password fields plus the sign-in footer link", () => {
    render(<SignUpForm />);

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create account/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /already have an account/i })
    ).toHaveAttribute("href", "/login");
  });

  it("shows the email-taken error notice when the action reports a duplicate email", async () => {
    signUpWithPasswordAction.mockReset();
    signUpWithPasswordAction.mockResolvedValue({
      ok: false,
      error: PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
    });

    render(<SignUpForm />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE
      );
    });
    expect(signUpWithPasswordAction).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "long-enough-password-12",
      displayName: "Ada Lovelace",
    });
  });

  it("shows the too-short error notice when the action reports a short password", async () => {
    signUpWithPasswordAction.mockReset();
    signUpWithPasswordAction.mockResolvedValue({
      ok: false,
      error: PASSWORD_TOO_SHORT_MESSAGE,
    });

    render(<SignUpForm />);
    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        PASSWORD_TOO_SHORT_MESSAGE
      );
    });
  });
});
