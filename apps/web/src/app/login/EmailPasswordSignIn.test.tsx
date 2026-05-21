import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const signInWithPasswordAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password-actions", () => ({
  signInWithPasswordAction,
  signUpWithPasswordAction: vi.fn(),
  setPasswordAction: vi.fn(),
  changePasswordAction: vi.fn(),
  removePasswordAction: vi.fn(),
}));

import EmailPasswordSignIn from "./EmailPasswordSignIn";

describe("EmailPasswordSignIn", () => {
  it("renders email + password inputs, a Sign in button, and a Create account link", () => {
    render(<EmailPasswordSignIn nextPath="/libraries" />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /create account/i })
    ).toHaveAttribute("href", "/sign-up");
  });

  it("shows an error alert when the action returns an incorrect-credentials failure", async () => {
    signInWithPasswordAction.mockReset();
    signInWithPasswordAction.mockResolvedValue({
      ok: false,
      error: "Email or password is incorrect.",
    });
    const user = userEvent.setup();

    render(<EmailPasswordSignIn nextPath="/libraries" />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(
      screen.getByLabelText(/password/i),
      "wrong-password-123"
    );
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Email or password is incorrect."
      );
    });
    expect(signInWithPasswordAction).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "wrong-password-123",
      nextPath: "/libraries",
    });
  });

  it("disables the submit button and marks it busy while the action is pending", async () => {
    signInWithPasswordAction.mockReset();
    let resolveAction: (value: { ok: false; error: string }) => void = () => {};
    signInWithPasswordAction.mockImplementation(
      () =>
        new Promise<{ ok: false; error: string }>((resolve) => {
          resolveAction = resolve;
        })
    );
    const user = userEvent.setup();

    render(<EmailPasswordSignIn nextPath="/libraries" />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(
      screen.getByLabelText(/password/i),
      "correct-password-12"
    );
    const submit = screen.getByRole("button", { name: /sign in/i });
    await user.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveAttribute("aria-busy", "true");

    resolveAction({ ok: false, error: "Email or password is incorrect." });
  });
});
