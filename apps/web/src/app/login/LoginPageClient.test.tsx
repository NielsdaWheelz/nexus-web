import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PASSWORD_SIGN_IN_FAILURE_MESSAGE,
  PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
} from "@/lib/auth/messages";

const signInWithPasswordAction = vi.hoisted(() => vi.fn());
const signUpWithPasswordAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password-actions", () => ({
  signInWithPasswordAction,
  signUpWithPasswordAction,
  setPasswordAction: vi.fn(),
  changePasswordAction: vi.fn(),
  removePasswordAction: vi.fn(),
}));

import LoginPageClient from "./LoginPageClient";

describe("LoginPageClient", () => {
  it("renders the Nexus wordmark", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Nexus" })
    ).toBeInTheDocument();
  });

  it("offers a Google and a GitHub sign-in control", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(
      screen.getByRole("button", { name: /continue with google/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with github/i })
    ).toBeInTheDocument();
  });

  it("opens in sign-in mode with email + password, no display name, and a Continue submit", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /^continue$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create an account/i })
    ).toBeInTheDocument();
  });

  it("toggles to create-account mode in place when the link is clicked", async () => {
    const user = userEvent.setup();
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    await user.click(
      screen.getByRole("button", { name: /create an account/i })
    );

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^create account$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^sign in$/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^continue$/i })).toBeNull();
  });

  it("opens in create-account mode when initialMode is 'create'", () => {
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialMode="create"
      />
    );

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^create account$/i })
    ).toBeInTheDocument();
  });

  it("submits sign-in via signInWithPasswordAction with the nextPath", async () => {
    signInWithPasswordAction.mockReset();
    signInWithPasswordAction.mockResolvedValue({
      ok: false,
      error: PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    });
    const user = userEvent.setup();
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(
      screen.getByLabelText(/password/i),
      "wrong-password-123"
    );
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        PASSWORD_SIGN_IN_FAILURE_MESSAGE
      );
    });
    expect(signInWithPasswordAction).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "wrong-password-123",
      nextPath: "/libraries",
    });
  });

  it("submits create-account via signUpWithPasswordAction with display name", async () => {
    signUpWithPasswordAction.mockReset();
    signUpWithPasswordAction.mockResolvedValue({
      ok: false,
      error: PASSWORD_SIGN_UP_EMAIL_TAKEN_MESSAGE,
    });
    const user = userEvent.setup();
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialMode="create"
      />
    );

    await user.type(screen.getByLabelText(/display name/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/email/i), "ada@example.com");
    await user.type(
      screen.getByLabelText(/password/i),
      "long-enough-password-12"
    );
    await user.click(
      screen.getByRole("button", { name: /^create account$/i })
    );

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

  it("clears the form error when the user toggles modes", async () => {
    signInWithPasswordAction.mockReset();
    signInWithPasswordAction.mockResolvedValue({
      ok: false,
      error: PASSWORD_SIGN_IN_FAILURE_MESSAGE,
    });
    const user = userEvent.setup();
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.type(
      screen.getByLabelText(/password/i),
      "wrong-password-123"
    );
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /create an account/i })
    );

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a calm 'you were signed out' notice for forced-logout feedback", () => {
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialFeedback={{
          severity: "info",
          title: "You were signed out.",
          message: "Your session ended. Please sign in again.",
        }}
      />
    );

    expect(screen.getByText("You were signed out.")).toBeInTheDocument();
    expect(screen.getByText(/your session ended/i)).toBeInTheDocument();
    // A forced sign-out is informational, not an error: it is not an alert.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an OAuth failure as an error alert", () => {
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialFeedback={{
          severity: "error",
          title: "We couldn't start sign in. Please try again.",
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't start sign in/i
    );
  });

  it("renders no feedback when none is given", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows public links for the privacy policy and terms of service", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(
      screen.getByRole("link", { name: /privacy policy/i })
    ).toHaveAttribute("href", "/privacy");
    expect(
      screen.getByRole("link", { name: /terms of service/i })
    ).toHaveAttribute("href", "/terms");
  });

  it("renders nexus://auth/start for github when isShell is true", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={true} />);

    expect(
      screen.getByRole("link", { name: /continue with github/i })
    ).toHaveAttribute(
      "href",
      "nexus://auth/start?provider=github&mode=signin&next=%2Flibraries"
    );
  });

  it("renders nexus://auth/native for google when isShell is true", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={true} />);

    expect(
      screen.getByRole("link", { name: /continue with google/i })
    ).toHaveAttribute(
      "href",
      "nexus://auth/native?provider=google&next=%2Flibraries"
    );
  });
});
