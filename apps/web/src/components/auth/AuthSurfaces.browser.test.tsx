import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ErrorInfo, type ReactNode } from "react";
import "@/app/globals.css";
import PasswordUpdateForm from "@/app/account/password/PasswordUpdateForm";
import ForgotPasswordForm from "@/app/forgot-password/ForgotPasswordForm";
import LoginPageClient from "@/app/login/LoginPageClient";
import {
  AUTH_CALLBACK_CANCELLED_MESSAGE,
  AUTH_CALLBACK_FAILURE_MESSAGE,
  OAUTH_START_FAILURE_MESSAGE,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";
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

async function disclosePasswordSignIn() {
  await userEvent.click(
    screen.getByRole("button", { name: "Use email and password" }),
  );
  return {
    email: screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }),
    password: screen.getByLabelText<HTMLInputElement>("Password"),
  };
}

describe("password authentication surfaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("projects the fixed browser method hierarchy, disclosures, transport, and footer", async () => {
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern?mode=focus")}
        isShell={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(
      screen.getByText("Private workspace. No public registration."),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue with GitHub" }),
    ).toBeNull();
    const [, passwordTransport, githubTransport] = screen.getAllByRole("form", {
      hidden: true,
    });
    expect(passwordTransport).toHaveAttribute(
      "aria-label",
      "Sign in with email and password",
    );
    expect(passwordTransport).not.toBeVisible();
    expect(githubTransport).toHaveAttribute(
      "aria-label",
      "Continue with GitHub",
    );
    expect(githubTransport).not.toBeVisible();

    const closedEmail = screen.getByRole("textbox", {
      name: "Email",
      hidden: true,
    });
    const closedPassword = screen.getByLabelText("Password");
    const closedGitHub = screen.getByRole("button", {
      name: "Continue with GitHub",
      hidden: true,
    });

    expect(
      screen
        .getAllByRole("button")
        .map((control) => control.textContent?.trim()),
    ).toEqual([
      "Continue with Google",
      "Use email and password",
      "Other ways to sign in",
    ]);

    const google = screen.getByRole("button", {
      name: "Continue with Google",
    });
    const googleForm = screen.getByRole<HTMLFormElement>("form", {
      name: "Continue with Google",
    });
    expect(googleForm).toHaveAttribute("action", "/auth/oauth");
    expect(googleForm).toHaveAttribute("method", "get");
    expect(google).toHaveAttribute("type", "submit");
    expect(googleForm).toHaveFormValues({
      provider: "google",
      next: "/lectern?mode=focus",
    });
    expect(google).toBeEnabled();

    for (const control of [
      google,
      screen.getByRole("button", { name: "Use email and password" }),
      screen.getByRole("button", { name: "Other ways to sign in" }),
      screen.getByRole("link", { name: "Android" }),
    ]) {
      await userEvent.tab();
      expect(control).toHaveFocus();
      expect(closedEmail).not.toHaveFocus();
      expect(closedPassword).not.toHaveFocus();
      expect(closedGitHub).not.toHaveFocus();
    }

    await disclosePasswordSignIn();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeVisible();
    expect(screen.getByLabelText("Password")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Other ways to sign in" }),
    );
    const github = screen.getByRole("button", {
      name: "Continue with GitHub",
    });
    expect(github).toBeVisible();
    expect(
      screen.getByRole("form", { name: "Continue with GitHub" }),
    ).toHaveAttribute("action", "/auth/oauth");
    expect(github).toHaveAttribute("type", "submit");

    const footer = screen.getByRole("navigation", { name: "Login links" });
    expect(
      within(footer)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Android", "/android"],
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
    ]);
  });

  it("projects shell-owned provider handoffs without browser-only support or links", async () => {
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern?mode=focus")}
        isShell
      />,
    );

    expect(
      screen.getByText("Use the account connected to this Nexus."),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Continue with Google" }),
    ).toHaveAttribute(
      "href",
      "nexus://auth/native?provider=google&next=%2Flectern%3Fmode%3Dfocus",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Other ways to sign in" }),
    );
    expect(
      screen.getByRole("link", { name: "Continue with GitHub" }),
    ).toHaveAttribute(
      "href",
      "nexus://auth/start?provider=github&mode=signin&next=%2Flectern%3Fmode%3Dfocus",
    );

    const footer = screen.getByRole("navigation", { name: "Login links" });
    expect(within(footer).queryByRole("link", { name: "Android" })).toBeNull();
    expect(
      within(footer)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Privacy", "Terms"]);
  });

  it.each([
    {
      message: OAUTH_START_FAILURE_MESSAGE,
      role: "alert" as const,
      title: "We couldn't start sign in.",
      detail: "Please try again.",
    },
    {
      message: AUTH_CALLBACK_FAILURE_MESSAGE,
      role: "alert" as const,
      title: "We couldn't complete sign in.",
      detail: "Please try again.",
    },
    {
      message: SESSION_ENDED_MESSAGE,
      role: "status" as const,
      title: "Your session ended.",
      detail: "Please sign in again.",
    },
  ])(
    "projects the owned login feedback for $message",
    ({ message, role, title, detail }) => {
      render(
        <LoginPageClient
          initialFeedbackMessage={message}
          nextPath={parseAuthReturnTarget("/lectern")}
          isShell={false}
        />,
      );

      const feedback = screen.getByRole(role);
      expect(within(feedback).getByText(title, { exact: true })).toBeVisible();
      expect(within(feedback).getByText(detail, { exact: true })).toBeVisible();
    },
  );

  it("suppresses provider cancellation and leaves every method idle", () => {
    render(
      <LoginPageClient
        initialFeedbackMessage={AUTH_CALLBACK_CANCELLED_MESSAGE}
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Use email and password" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Other ways to sign in" }),
    ).toBeEnabled();
  });

  it("keeps sign-in single-purpose and clears only the password after one failed pending submission", async () => {
    const pending = deferredResponse();
    const retry = deferredResponse();
    const fetchStub = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(() => retry.promise);
    vi.stubGlobal("fetch", fetchStub);

    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(screen.queryByText(/create an account/i)).toBeNull();

    const { email, password } = await disclosePasswordSignIn();
    await userEvent.click(
      screen.getByRole("button", { name: "Other ways to sign in" }),
    );
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
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeDisabled();
    const passwordDisclosure = screen.getByRole("button", {
      name: "Use email and password",
    });
    expect(passwordDisclosure).toHaveAttribute("aria-disabled", "true");
    expect(passwordDisclosure).toHaveAttribute("tabindex", "-1");
    const otherDisclosure = screen.getByRole("button", {
      name: "Other ways to sign in",
    });
    expect(otherDisclosure).toHaveAttribute("aria-disabled", "true");
    expect(otherDisclosure).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeDisabled();
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
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();

    await userEvent.fill(password, "correct horse battery staple");
    const google = screen.getByRole("button", {
      name: "Continue with Google",
    });
    const googleTop = google.getBoundingClientRect().top;
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("button", { name: "Signing in…" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      google.getBoundingClientRect().top,
      "hiding stale retry feedback must preserve its occupied layout slot",
    ).toBeCloseTo(googleTop, 0);

    retry.resolve(outcome({ kind: "InvalidCredentials" }, 401));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect.",
    );
  });

  it("keeps a successful retry terminal while its redirect commits", async () => {
    const redirected = {
      redirected: true,
      url: "#password-sign-in-complete",
    } as Response;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(outcome({ kind: "InvalidCredentials" }, 401))
        .mockResolvedValueOnce(redirected),
    );
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );

    const { email, password } = await disclosePasswordSignIn();
    await userEvent.fill(email, "buddy@example.com");
    await userEvent.fill(password, "incorrect password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect.",
    );

    await userEvent.fill(password, "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("button", { name: "Signing in…" }),
    ).toBeDisabled();
    expect(window.location.hash).toBe("#password-sign-in-complete");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeDisabled();

    window.history.replaceState(null, "", window.location.pathname);
  });

  it("validates disclosed password fields without dispatching a request", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    render(
      <LoginPageClient
        nextPath={parseAuthReturnTarget("/lectern")}
        isShell={false}
      />,
    );

    const { email, password } = await disclosePasswordSignIn();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your email address.")).toBeVisible();
    expect(email).toHaveFocus();

    await userEvent.fill(email, "not-an-email");
    await userEvent.fill(password, "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("Enter a valid email address."),
    ).toBeVisible();
    expect(email).toHaveFocus();

    await userEvent.fill(email, "buddy@example.com");
    await userEvent.clear(password);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your password.")).toBeVisible();
    expect(password).toHaveFocus();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: "rate limiting",
      response: () => outcome({ kind: "RateLimited" }, 429),
      title: "Too many sign-in attempts.",
      message: "Wait a few minutes, then try again.",
    },
    {
      boundary: "authentication dependency failure",
      response: () => outcome({ kind: "ServiceUnavailable" }, 503),
      title: "Sign in is temporarily unavailable.",
      message: "Try again in a moment.",
    },
  ])(
    "projects $boundary without leaking provider detail",
    async ({ response, title, message }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response()),
      );
      render(
        <LoginPageClient
          nextPath={parseAuthReturnTarget("/lectern")}
          isShell={false}
        />,
      );
      const { email, password } = await disclosePasswordSignIn();
      await userEvent.fill(email, "buddy@example.com");
      await userEvent.fill(password, "correct horse battery staple");
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText(title, { exact: true })).toBeVisible();
      expect(within(alert).getByText(message, { exact: true })).toBeVisible();
    },
  );

  it.each([
    {
      online: false,
      title: "You’re offline.",
      message: "Reconnect to sign in.",
    },
    {
      online: true,
      title: "Sign in is temporarily unavailable.",
      message: "Try again in a moment.",
    },
  ])(
    "distinguishes known offline=$online from an ambiguous transport failure",
    async ({ online, title, message }) => {
      const simulatedNavigator = Object.create(window.navigator) as Navigator;
      Object.defineProperty(simulatedNavigator, "onLine", { value: online });
      vi.stubGlobal("navigator", simulatedNavigator);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("synthetic browser transport failure");
        }),
      );
      render(
        <LoginPageClient
          nextPath={parseAuthReturnTarget("/lectern")}
          isShell={false}
        />,
      );
      const { email, password } = await disclosePasswordSignIn();
      await userEvent.fill(email, "buddy@example.com");
      await userEvent.fill(password, "correct horse battery staple");
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText(title, { exact: true })).toBeVisible();
      expect(within(alert).getByText(message, { exact: true })).toBeVisible();
    },
  );

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
    const { email, password } = await disclosePasswordSignIn();
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
    const { email, password } = await disclosePasswordSignIn();
    email.value = "buddy@example.com";
    password.value = "correct horse battery staple";

    await userEvent.click(
      screen.getByRole("button", { name: "Show password" }),
    );

    expect(email.value).toBe("buddy@example.com");
    expect(password.value).toBe("correct horse battery staple");
    expect(password.type).toBe("text");

    await userEvent.click(
      screen.getByRole("button", { name: "Use email and password" }),
    );
    expect(password).not.toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Use email and password" }),
    );
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe(
      "correct horse battery staple",
    );
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
