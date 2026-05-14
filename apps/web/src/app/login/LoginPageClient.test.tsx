import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const { mockSignInWithOAuth } = vi.hoisted(() => ({
  mockSignInWithOAuth: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: mockSignInWithOAuth,
    },
  }),
}));

import LoginPageClient from "./LoginPageClient";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("LoginPageClient", () => {
  beforeEach(() => {
    mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
    setUserAgent(DEFAULT_USER_AGENT);
    window.history.replaceState(null, "", "/login?next=%2Flibraries");
  });

  it("does not auto-process hash tokens on mount", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?next=%2Flibraries#access_token=attacker-access&refresh_token=attacker-refresh"
    );

    render(<LoginPageClient nextPath="/libraries" />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("starts OAuth using an explicit callback URL with normalized next path", async () => {
    const user = userEvent.setup();
    render(<LoginPageClient nextPath="/libraries" />);

    await user.click(screen.getByRole("button", { name: /continue with github/i }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=%2Flibraries`,
      },
    });
  });

  it("uses the debug Android callback scheme for local shell OAuth", async () => {
    const user = userEvent.setup();
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);

    render(<LoginPageClient nextPath="/libraries" />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "nexus-dev://auth/callback?next=%2Flibraries",
      },
    });
  });

  it("keeps generic local WebViews on the standard web callback", async () => {
    const user = userEvent.setup();
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; SM-S906W Build/UP1A.231005.007; wv) AppleWebKit/537.36"
    );

    render(<LoginPageClient nextPath="/libraries" />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=%2Flibraries`,
      },
    });
  });

  it("shows public links for privacy policy and terms of service", () => {
    render(<LoginPageClient nextPath="/libraries" />);

    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "/privacy"
    );
    expect(
      screen.getByRole("link", { name: /terms of service/i })
    ).toHaveAttribute("href", "/terms");
  });
});
