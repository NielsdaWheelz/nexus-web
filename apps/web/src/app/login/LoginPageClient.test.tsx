import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("LoginPageClient", () => {
  beforeEach(() => {
    mockSignInWithOAuth.mockReset().mockResolvedValue({ error: null });
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
});
