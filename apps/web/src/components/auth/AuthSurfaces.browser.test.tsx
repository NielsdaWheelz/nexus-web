import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ErrorInfo, type ReactNode } from "react";
import "@/app/globals.css";
import PasswordUpdateForm from "@/app/account/password/PasswordUpdateForm";
import ForgotPasswordForm from "@/app/forgot-password/ForgotPasswordForm";
import LoginPageClient from "@/app/login/LoginPageClient";
import { parseAuthReturnTarget } from "@/lib/auth/redirects";
import EmailActionLanding from "./EmailActionLanding";

function outcome(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {}

  render() {
    return this.state.error ? (
      <p role="status">Authentication response defect</p>
    ) : (
      this.props.children
    );
  }
}

describe("password authentication surfaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps sign-in single-purpose and clears only the password after one failed pending submission", async () => {
    const pending = deferredResponse();
    const fetchStub = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchStub);

    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Sign in to Nexus" }),
    ).toBeVisible();
    expect(screen.queryByText(/create an account/i)).toBeNull();

    const email = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Email",
    });
    const password = screen.getByLabelText<HTMLInputElement>("Password");
    await userEvent.fill(email, "buddy@example.com");
    await userEvent.fill(password, "correct horse battery staple");

    expect(password.type).toBe("password");
    await userEvent.click(
      screen.getByRole("button", { name: "Show password" }),
    );
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const pendingButton = await screen.findByRole("button", {
      name: "Signing in…",
    });
    expect(pendingButton).toBeDisabled();
    pendingButton.click();
    expect(
      fetchStub,
      "repeat activation dispatched a second sign-in",
    ).toHaveBeenCalledTimes(1);

    pending.resolve(outcome({ kind: "InvalidCredentials" }, 401));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect.",
    );
    expect(email.value).toBe("buddy@example.com");
    expect(password.value).toBe("");
    expect(password.type).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeVisible();
  });

  it("runs owned short-password validation with inline feedback and focus", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    render(
      <PasswordUpdateForm
        nextPath={parseAuthReturnTarget("/settings/account")}
        saved={false}
      />,
    );
    const password = screen.getByLabelText<HTMLInputElement>("New password");
    await userEvent.fill(password, "x".repeat(14));
    await userEvent.click(
      screen.getByRole("button", { name: "Save password" }),
    );

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Password must be at least 15 characters.",
    );
    expect(password).toHaveFocus();
  });

  it("submits native password-manager values even without React input events", async () => {
    const fetchStub = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => outcome({ kind: "InvalidCredentials" }, 401));
    vi.stubGlobal("fetch", fetchStub);
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );
    const email = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Email",
    });
    const password = screen.getByLabelText<HTMLInputElement>("Password");
    email.value = "buddy@example.com";
    password.value = "correct horse battery staple";
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const body = fetchStub.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("email")).toBe("buddy@example.com");
    expect((body as FormData).get("password")).toBe(
      "correct horse battery staple",
    );
  });

  it("preserves native password-manager values across client-state updates", async () => {
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );
    const email = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Email",
    });
    const password = screen.getByLabelText<HTMLInputElement>("Password");
    email.value = "buddy@example.com";
    password.value = "correct horse battery staple";

    await userEvent.click(
      screen.getByRole("button", { name: "Show password" }),
    );

    expect(email.value).toBe("buddy@example.com");
    expect(password.value).toBe("correct horse battery staple");
    expect(password.type).toBe("text");
  });

  it("submits native recovery and update values without React input events", async () => {
    const fetchStub = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(outcome({ kind: "RateLimited" }, 429))
      .mockResolvedValueOnce(outcome({ kind: "ServiceUnavailable" }, 503));
    vi.stubGlobal("fetch", fetchStub);

    const view = render(<ForgotPasswordForm sent={false} />);
    screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).value =
      "buddy@example.com";
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    view.unmount();

    render(
      <PasswordUpdateForm
        nextPath={parseAuthReturnTarget("/settings/account")}
        saved={false}
      />,
    );
    screen.getByLabelText<HTMLInputElement>("New password").value =
      "correct horse battery staple";
    await userEvent.click(
      screen.getByRole("button", { name: "Save password" }),
    );
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));

    const [recoveryBody, updateBody] = fetchStub.mock.calls.map(
      (call) => call[1]?.body as FormData,
    );
    expect(recoveryBody.get("email")).toBe("buddy@example.com");
    expect(updateBody.get("password")).toBe("correct horse battery staple");
  });

  it("keeps recovery email in memory after a typed failure and renders the account-private acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => outcome({ kind: "RateLimited" }, 429)),
    );
    const view = render(<ForgotPasswordForm sent={false} />);
    const email = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Email",
    });
    await userEvent.fill(email, "buddy@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Too many reset requests.")).toBeVisible();
    expect(
      within(alert).getByText("Wait a few minutes, then try again."),
    ).toBeVisible();
    expect(email.value).toBe("buddy@example.com");

    view.rerender(<ForgotPasswordForm sent />);
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Check your email.")).toBeVisible();
    expect(
      within(status).getByText(
        "If this email belongs to a Nexus account, a password-reset link is on its way.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
  });

  it("announces password policy failure beside a cleared, remasked field and keeps success until Continue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        outcome({ kind: "PolicyRejected", reasons: ["length"] }, 400),
      ),
    );
    const view = render(
      <PasswordUpdateForm
        nextPath={parseAuthReturnTarget("/settings/account")}
        saved={false}
      />,
    );
    const password = screen.getByLabelText<HTMLInputElement>("New password");
    await userEvent.fill(password, "fifteen chars ok");
    await userEvent.click(
      screen.getByRole("button", { name: "Show password" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save password" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Password must be at least 15 characters.",
    );
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password.value).toBe("");
    expect(password.type).toBe("password");

    view.rerender(
      <PasswordUpdateForm
        nextPath={parseAuthReturnTarget("/settings/account")}
        saved
      />,
    );
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Password saved.")).toBeVisible();
    expect(
      within(status).getByText(
        "You can now sign in with your email and password.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute(
      "href",
      "/settings/account",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it.each([
    {
      boundary: "provider outage",
      fetchResult: () =>
        Promise.resolve(outcome({ kind: "ServiceUnavailable" }, 503)),
    },
    {
      boundary: "ambiguous network loss",
      fetchResult: () =>
        Promise.reject(new TypeError("synthetic ambiguous browser boundary")),
    },
  ])(
    "gives an honest, convergent password retry after $boundary",
    async ({ fetchResult }) => {
      vi.stubGlobal("fetch", vi.fn(fetchResult));
      render(
        <PasswordUpdateForm
          nextPath={parseAuthReturnTarget("/settings/account")}
          saved={false}
        />,
      );
      await userEvent.fill(
        screen.getByLabelText("New password"),
        "correct horse battery staple",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Save password" }),
      );

      const alert = await screen.findByRole("alert");
      expect(
        within(alert).getByText(
          "We couldn’t confirm whether your password was saved.",
        ),
      ).toBeVisible();
      expect(
        within(alert).getByText("Enter the same password and save again."),
      ).toBeVisible();
      expect(
        screen.getByLabelText<HTMLInputElement>("New password").value,
      ).toBe("");
    },
  );

  it("routes a malformed password response to the defect boundary instead of network guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        outcome(
          { kind: "ServiceUnavailable", mutableProviderDetail: "timeout" },
          503,
        ),
      ),
    );
    render(
      <DefectBoundary>
        <PasswordUpdateForm
          nextPath={parseAuthReturnTarget("/settings/account")}
          saved={false}
        />
      </DefectBoundary>,
    );
    await userEvent.fill(
      screen.getByLabelText("New password"),
      "correct horse battery staple",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save password" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Authentication response defect",
    );
    expect(
      screen.queryByText(
        "We couldn’t confirm whether your password was saved.",
      ),
    ).toBeNull();
  });

  it("retains an email-link token only in the mounted retry form", async () => {
    const tokenBodies: FormData[] = [];
    const fetchStub = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async (_input, init) => {
        tokenBodies.push(init?.body as FormData);
        return outcome({ kind: "RateLimited" }, 429);
      })
      .mockImplementationOnce(async (_input, init) => {
        tokenBodies.push(init?.body as FormData);
        return outcome({ kind: "InvalidOrExpired" }, 400);
      });
    vi.stubGlobal("fetch", fetchStub);

    render(
      <EmailActionLanding purpose="invite" tokenHash="opaque-token-hash" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Accept invitation" }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Too many attempts.")).toBeVisible();
    expect(
      within(alert).getByText("Wait a few minutes, then try again."),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("opaque-token-hash");

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    expect(tokenBodies.map((body) => body.get("token_hash"))).toEqual([
      "opaque-token-hash",
      "opaque-token-hash",
    ]);
    expect(await screen.findByRole("heading")).toHaveTextContent(
      "This invitation link can’t be used",
    );
    const invalidAlert = await screen.findByRole("alert");
    expect(
      within(invalidAlert).getByText(
        "It may be invalid, expired, or already used.",
      ),
    ).toBeVisible();
    expect(
      within(invalidAlert).getByText(
        "Ask the Nexus owner to send a new invitation.",
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("opaque-token-hash");
  });

  it("renders fixed recovery guidance without consuming or exposing a malformed link", () => {
    render(<EmailActionLanding purpose="recovery" tokenHash={null} />);

    expect(
      screen.getByRole("heading", {
        name: "This password-reset link can’t be used",
      }),
    ).toBeVisible();
    const invalidAlert = screen.getByRole("alert");
    expect(
      within(invalidAlert).getByText(
        "It may be invalid, expired, or already used.",
      ),
    ).toBeVisible();
    expect(
      within(invalidAlert).getByText("Request a new password-reset link."),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Request a new link" }),
    ).toHaveAttribute("href", "/forgot-password");
  });
});
