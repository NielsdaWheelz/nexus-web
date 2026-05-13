import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const { mockGetUserIdentities, mockLinkIdentity, mockUnlinkIdentity } = vi.hoisted(
  () => ({
    mockGetUserIdentities: vi.fn(),
    mockLinkIdentity: vi.fn(),
    mockUnlinkIdentity: vi.fn(),
  })
);

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUserIdentities: mockGetUserIdentities,
      linkIdentity: mockLinkIdentity,
      unlinkIdentity: mockUnlinkIdentity,
    },
  }),
}));

import LinkedIdentitiesPage from "./page";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("LinkedIdentitiesPage", () => {
  beforeEach(() => {
    mockGetUserIdentities.mockReset();
    mockLinkIdentity.mockReset().mockResolvedValue({ error: null });
    mockUnlinkIdentity.mockReset().mockResolvedValue({ error: null });
    setUserAgent(DEFAULT_USER_AGENT);
    window.history.replaceState(null, "", "/settings/identities");
  });

  it("starts provider linking with an explicit callback return path", async () => {
    const user = userEvent.setup();
    mockGetUserIdentities.mockResolvedValue({
      data: {
        identities: [
          {
            identity_id: "github-id",
            provider: "github",
            identity_data: { email: "owner+github@example.com" },
            created_at: "2026-03-21T00:00:00Z",
          },
        ],
      },
      error: null,
    });

    render(<LinkedIdentitiesPage />);

    const connectGoogle = await screen.findByRole("button", {
      name: /connect google/i,
    });
    await user.click(connectGoogle);

    const expectedRedirect = `${window.location.origin}/auth/callback?next=%2Fsettings%2Fidentities`;
    expect(mockLinkIdentity).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: expectedRedirect,
      },
    });
  });

  it("uses the debug Android callback scheme for local shell identity linking", async () => {
    const user = userEvent.setup();
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
    mockGetUserIdentities.mockResolvedValue({
      data: {
        identities: [
          {
            identity_id: "github-id",
            provider: "github",
            identity_data: { email: "owner+github@example.com" },
            created_at: "2026-03-21T00:00:00Z",
          },
        ],
      },
      error: null,
    });

    render(<LinkedIdentitiesPage />);

    const connectGoogle = await screen.findByRole("button", {
      name: /connect google/i,
    });
    await user.click(connectGoogle);

    expect(mockLinkIdentity).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo:
          "nexus-dev://auth/callback?next=%2Fsettings%2Fidentities",
      },
    });
  });

  it("supports unlinking one provider identity while keeping another", async () => {
    const user = userEvent.setup();
    mockGetUserIdentities
      .mockResolvedValueOnce({
        data: {
          identities: [
            {
              identity_id: "github-id",
              provider: "github",
              identity_data: { email: "owner+github@example.com" },
              created_at: "2026-03-21T00:00:00Z",
            },
            {
              identity_id: "google-id",
              provider: "google",
              identity_data: { email: "owner+google@example.com" },
              created_at: "2026-03-22T00:00:00Z",
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          identities: [
            {
              identity_id: "google-id",
              provider: "google",
              identity_data: { email: "owner+google@example.com" },
              created_at: "2026-03-22T00:00:00Z",
            },
          ],
        },
        error: null,
      });

    render(<LinkedIdentitiesPage />);

    await screen.findByText("owner+github@example.com");
    await screen.findByText("owner+google@example.com");

    const unlinkButtons = screen.getAllByRole("button", { name: /unlink/i });
    await user.click(unlinkButtons[0]);

    expect(mockUnlinkIdentity).toHaveBeenCalledWith({
      identity_id: "github-id",
      provider: "github",
    });

    await waitFor(() => {
      expect(
        screen.getByText("GitHub sign-in was removed.")
      ).toBeInTheDocument();
    });
  });
});
