import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const subscribeToPodcastMock = vi.fn();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRuntime: () => ({ openInNewPane: vi.fn() }),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: () => {},
  usePaneMobileChromeController: () => null,
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: {
      billing_enabled: true,
      billing_plan_tier: "plus",
      billing_status: "active",
      subscription_current_period_start: "2026-03-01T00:00:00Z",
      subscription_current_period_end: "2026-04-01T00:00:00Z",
      cancel_at_period_end: false,
      can_manage_billing: true,
      entitlement_plan_tier: "plus",
      entitlement_source: "subscription",
      entitlement_expires_at: null,
      can_share: true,
      can_use_platform_llm: false,
      can_transcribe: true,
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 100,
        remaining: 100,
        period_start: "2026-03-01T00:00:00Z",
        period_end: "2026-04-01T00:00:00Z",
      },
    },
  }),
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    addToQueue: vi.fn(async () => []),
    queueItems: [],
  }),
}));

vi.mock("../podcastSubscriptions", async () => {
  const actual = await vi.importActual<
    typeof import("../podcastSubscriptions")
  >("../podcastSubscriptions");
  return {
    ...actual,
    subscribeToPodcast: (...args: unknown[]) => subscribeToPodcastMock(...args),
  };
});

import PodcastDetailPaneBody from "@/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PodcastDetailPaneBody subscribe flow", () => {
  beforeEach(() => {
    subscribeToPodcastMock.mockReset();
    subscribeToPodcastMock.mockResolvedValue({
      podcast_id: "podcast-1",
      subscription_created: true,
      sync_status: "pending",
      sync_enqueued: true,
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 0,
      last_synced_at: null,
      window_size: 0,
    });
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends selected library_ids on subscribe", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse({
          data: {
            podcast: {
              id: "podcast-1",
              provider: "podcast_index",
              provider_podcast_id: "provider-1",
              title: "Systems Podcast",
              contributors: [],
              feed_url: "https://feeds.example.com/systems.xml",
              website_url: null,
              image_url: null,
              description: "Systems thinking show",
              created_at: "2026-03-06T00:00:00Z",
              updated_at: "2026-03-06T00:00:00Z",
            },
            subscription: null,
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: [
            { id: "lib-default", name: "My Library", is_default: true, color: null },
            { id: "lib-research", name: "Research", is_default: false, color: "#0ea5e9" },
            { id: "lib-books", name: "Books", is_default: false, color: "#22c55e" },
          ],
        });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);

    const subscribeButton = await screen.findByRole("button", {
      name: "Subscribe",
    });
    expect(subscribeButton).toBeInTheDocument();

    // Open the library picker (the chip showing "My Library only").
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /My Library only/ })
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /My Library only/ }));

    const panel = await screen.findByRole("dialog", { name: "Select libraries" });
    fireEvent.click(within(panel).getByRole("option", { name: /Research/ }));
    fireEvent.click(within(panel).getByRole("option", { name: /Books/ }));

    fireEvent.click(subscribeButton);

    await waitFor(() => {
      expect(subscribeToPodcastMock).toHaveBeenCalledTimes(1);
    });

    const payload = subscribeToPodcastMock.mock.calls[0][0] as {
      library_ids: string[];
    };
    expect(payload.library_ids).toEqual(["lib-research", "lib-books"]);
  });
});
