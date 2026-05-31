import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";

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

    const emailInput = screen.getByLabelText(/email/i);
    const form = screen.getByRole("form", { name: /credential sign in/i });
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/auth/password");
    expect(screen.getByDisplayValue("signin")).toHaveAttribute("name", "mode");
    expect(emailInput).toBeInTheDocument();
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

  it("posts sign-in credentials to the password route with the nextPath", () => {
    render(<LoginPageClient nextPath="/search" isShell={false} />);

    const form = screen.getByRole("form", { name: /credential sign in/i });
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/auth/password");
    expect(within(form).getByDisplayValue("signin")).toHaveAttribute("name", "mode");
    expect(within(form).getByDisplayValue("/search")).toHaveAttribute("name", "next");
    expect(screen.getByLabelText(/email/i)).toHaveAttribute("name", "email");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("name", "password");
  });

  it("posts create-account credentials to the password route with display name", () => {
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialMode="create"
      />
    );

    const form = screen.getByRole("form", {
      name: /credential account creation/i,
    });
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/auth/password");
    expect(within(form).getByDisplayValue("create")).toHaveAttribute("name", "mode");
    expect(within(form).getByDisplayValue("/libraries")).toHaveAttribute("name", "next");
    expect(screen.getByLabelText(/display name/i)).toHaveAttribute(
      "name",
      "display_name"
    );
  });

  it("updates the posted mode when the user toggles modes", async () => {
    const user = userEvent.setup();
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    await user.click(
      screen.getByRole("button", { name: /create an account/i })
    );
    expect(screen.getByDisplayValue("create")).toHaveAttribute("name", "mode");

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(screen.getByDisplayValue("signin")).toHaveAttribute("name", "mode");
  });

  it("renders a calm 'you were signed out' notice for forced sign-out feedback", () => {
    render(
      <LoginPageClient
        nextPath="/libraries"
        isShell={false}
        initialFeedback={{
          severity: "info",
          title: "You were signed out.",
          message: SESSION_ENDED_MESSAGE,
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
