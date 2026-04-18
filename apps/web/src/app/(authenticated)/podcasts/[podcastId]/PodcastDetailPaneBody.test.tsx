import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import PodcastDetailPaneBody from "./PodcastDetailPaneBody";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockViewportState = { isMobile: false };

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: (overrides: Record<string, unknown>) =>
    mockUsePaneChromeOverride(overrides),
}));

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mockViewportState.isMobile,
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: {
      billing_enabled: true,
      plan_tier: "ai_plus",
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 1_200,
        remaining: 1_200,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getLatestChromeOverride(): Record<string, unknown> {
  const latest = mockUsePaneChromeOverride.mock.calls.at(-1)?.[0];
  if (!latest) {
    throw new Error("Expected usePaneChromeOverride to be called");
  }
  return latest;
}

function renderLatestPaneActions() {
  const actions = getLatestChromeOverride().actions as ReactNode;
  if (!actions) {
    throw new Error("Expected pane actions override to be present");
  }
  return render(<>{actions}</>);
}

function buildEpisode() {
  return {
    id: "media-0",
    kind: "podcast_episode",
    title: "Episode 0",
    canonical_source_url: "https://feeds.example.com/systems.xml",
    processing_status: "ready_for_reading",
    transcript_state: "ready",
    transcript_coverage: "full",
    listening_state: null,
    subscription_default_playback_speed: null,
    episode_state: "unplayed",
    failure_stage: null,
    last_error_code: null,
    playback_source: {
      kind: "external_audio" as const,
      stream_url: "https://cdn.example.com/e0.mp3",
      source_url: "https://cdn.example.com/e0.mp3",
    },
    capabilities: {
      can_read: true,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: true,
      can_download_file: false,
    },
    authors: [],
    published_date: null,
    publisher: null,
    language: null,
    description: null,
    description_html: null,
    description_text: null,
    created_at: "2026-03-06T00:00:00Z",
    updated_at: "2026-03-06T00:00:00Z",
  };
}

describe("PodcastDetailPaneBody", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockViewportState.isMobile = false;
    vi.restoreAllMocks();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("renders podcast detail beside a persistent desktop episodes column", async () => {
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
              author: "Systems Team",
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
        return jsonResponse({ data: [buildEpisode()] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Systems Podcast" })).toBeInTheDocument();
    const episodesAside = screen.getByRole("complementary", { name: "Episodes" });
    expect(within(episodesAside).getByRole("heading", { name: "Episodes" })).toBeInTheDocument();
    expect(within(episodesAside).getByText("Episode 0")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Episodes" })).not.toBeInTheDocument();
  });

  it("opens and closes the mobile episodes drawer from the pane header action", async () => {
    const user = userEvent.setup();
    mockViewportState.isMobile = true;

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
              author: "Systems Team",
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
        return jsonResponse({ data: [buildEpisode()] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);
    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Systems Podcast" })).toBeInTheDocument();

    let view = renderLatestPaneActions();
    await user.click(screen.getByRole("button", { name: "Episodes" }));

    const dialog = await screen.findByRole("dialog", { name: "Episodes" });
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByText("Episode 0")).toBeInTheDocument();
    view.unmount();
    view = renderLatestPaneActions();
    expect(screen.getByRole("button", { name: "Episodes" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Episodes" })).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    });

    view.unmount();
  });

  it("supports escape and backdrop close for the mobile episodes drawer", async () => {
    const user = userEvent.setup();
    mockViewportState.isMobile = true;

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
              author: "Systems Team",
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
        return jsonResponse({ data: [buildEpisode()] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);
    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Systems Podcast" })).toBeInTheDocument();

    const view = renderLatestPaneActions();
    await user.click(screen.getByRole("button", { name: "Episodes" }));

    expect(await screen.findByRole("dialog", { name: "Episodes" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Episodes" })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Episodes" }));
    await screen.findByRole("dialog", { name: "Episodes" });
    await user.click(screen.getByTestId("episodes-backdrop"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Episodes" })).not.toBeInTheDocument();
    });

    view.unmount();
  });
});
