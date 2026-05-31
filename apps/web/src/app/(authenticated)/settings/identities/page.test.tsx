import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface IdentityRecord {
  identity_id: string;
  provider: string;
  identity_data: { email: string };
  created_at: string;
}

const mockCookieStore = {
  getAll: vi.fn(() => [] as { name: string; value: string }[]),
  set: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mockCookieStore),
}));

// Scripted Supabase Auth outcomes — one getUserIdentities result per server
// read, so tests drive Server Actions through the real @supabase/ssr boundary
// without mocking internal modules.
type IdentitiesOutcome = {
  identities?: IdentityRecord[];
  error?: { message: string };
};

const getUserIdentitiesOutcomes: IdentitiesOutcome[] = [];
let unlinkOutcome: { error?: { message: string } } = {};
const unlinkIdentitySpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUserIdentities: async () => {
        const outcome = getUserIdentitiesOutcomes.shift() ?? { identities: [] };
        if (outcome.error) {
          return {
            data: { identities: [] },
            error: outcome.error,
          };
        }
        return {
          data: { identities: outcome.identities ?? [] },
          error: null,
        };
      },
      unlinkIdentity: async (identity: unknown) => {
        unlinkIdentitySpy(identity);
        return {
          data: {},
          error: unlinkOutcome.error ?? null,
        };
      },
    },
  })),
}));

import LinkedIdentitiesPage from "./page";

function identity(
  provider: string,
  overrides: Partial<IdentityRecord> = {}
): IdentityRecord {
  return {
    identity_id: `${provider}-id`,
    provider,
    identity_data: { email: `owner+${provider}@example.com` },
    created_at: "2026-03-21T00:00:00Z",
    ...overrides,
  };
}

describe("LinkedIdentitiesPage", () => {
  beforeEach(() => {
    mockCookieStore.getAll.mockReset().mockReturnValue([]);
    mockCookieStore.set.mockClear();
    unlinkIdentitySpy.mockClear();
    getUserIdentitiesOutcomes.length = 0;
    unlinkOutcome = {};
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  it("loads linked identities server-side and renders them", async () => {
    getUserIdentitiesOutcomes.push({ identities: [identity("github")] });

    render(<LinkedIdentitiesPage />);

    expect(
      await screen.findByText("owner+github@example.com")
    ).toBeInTheDocument();
  });

  it("offers a connect control for each not-yet-linked provider", async () => {
    getUserIdentitiesOutcomes.push({ identities: [identity("github")] });

    render(<LinkedIdentitiesPage />);

    // GitHub is linked; only Google remains connectable.
    expect(
      await screen.findByRole("button", { name: /connect google/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect github/i })
    ).toBeNull();
  });

  it("shows an error notice when identity loading fails", async () => {
    getUserIdentitiesOutcomes.push({ error: { message: "boom" } });

    render(<LinkedIdentitiesPage />);

    expect(
      await screen.findByText(/failed to load identities/i)
    ).toBeInTheDocument();
  });

  it("unlinks one provider identity while keeping another", async () => {
    const user = userEvent.setup();
    const beforeUnlink = [identity("github"), identity("google")];
    getUserIdentitiesOutcomes.push({ identities: beforeUnlink });
    getUserIdentitiesOutcomes.push({ identities: beforeUnlink });
    getUserIdentitiesOutcomes.push({ identities: [identity("google")] });

    render(<LinkedIdentitiesPage />);

    await screen.findByText("owner+github@example.com");
    await screen.findByText("owner+google@example.com");

    const unlinkButtons = screen.getAllByRole("button", { name: /unlink/i });
    await user.click(unlinkButtons[0]);

    expect(unlinkIdentitySpy).toHaveBeenCalledWith(
      expect.objectContaining({ identity_id: "github-id" })
    );
    await waitFor(() => {
      expect(
        screen.getByText("GitHub sign-in was removed.")
      ).toBeInTheDocument();
    });
  });

  it("shows an error notice when unlinking fails", async () => {
    const user = userEvent.setup();
    const beforeUnlink = [identity("github"), identity("google")];
    getUserIdentitiesOutcomes.push({ identities: beforeUnlink });
    getUserIdentitiesOutcomes.push({ identities: beforeUnlink });
    unlinkOutcome = { error: { message: "unlink failed" } };

    render(<LinkedIdentitiesPage />);

    await screen.findByText("owner+github@example.com");
    const unlinkButtons = screen.getAllByRole("button", { name: /unlink/i });
    await user.click(unlinkButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText(/we couldn't unlink this identity/i)
      ).toBeInTheDocument();
    });
  });
});
