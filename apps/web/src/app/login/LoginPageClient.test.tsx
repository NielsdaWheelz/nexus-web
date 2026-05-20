import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPageClient from "./LoginPageClient";

describe("LoginPageClient", () => {
  it("offers a Google and a GitHub sign-in control", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(
      screen.getByRole("button", { name: /continue with google/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with github/i })
    ).toBeInTheDocument();
  });

  it("renders no in-page password or token field — OAuth is the only path", () => {
    render(<LoginPageClient nextPath="/libraries" isShell={false} />);

    expect(screen.queryByLabelText(/password/i)).toBeNull();
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

    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "/privacy"
    );
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
