import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import PodcastsPage from "./page";
import PodcastDetailPage from "./[podcastId]/page";
import PodcastSubscriptionsPage from "./subscriptions/page";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

const mockUsePaneParam = vi.fn<(param: string) => string | null>();
const mockPush = vi.fn<(href: string) => void>();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: mockPush, replace: mockPush }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => ({
    account: {
      billing_enabled: true,
      plan_tier: "ai_plus",
      subscription_status: "active",
      can_share: true,
      can_use_platform_llm: true,
      current_period_start: "2026-03-01T00:00:00Z",
      current_period_end: "2026-04-01T00:00:00Z",
      ai_token_usage: {
        used: 0,
        reserved: 0,
        limit: 1_000_000,
        remaining: 1_000_000,
        period_start: "2026-03-01T00:00:00Z",
        period_end: "2026-04-01T00:00:00Z",
      },
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 1_200,
        remaining: 1_200,
        period_start: "2026-03-01T00:00:00Z",
        period_end: "2026-04-01T00:00:00Z",
      },
    },
    loading: false,
    error: null,
    reload: async () => {},
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildEpisode(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "podcast_episode",
    title,
    canonical_source_url: "https://feeds.example.com/source.xml",
    processing_status: "ready_for_reading",
    transcript_state: "not_requested",
    transcript_coverage: "none",
    failure_stage: null,
    last_error_code: null,
    playback_source: {
      kind: "external_audio" as const,
      stream_url: `https://cdn.example.com/${id}.mp3`,
      source_url: `https://cdn.example.com/${id}.mp3`,
    },
    listening_state: null,
    subscription_default_playback_speed: null,
    episode_state: "unplayed",
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
    ...overrides,
  };
}

function buildSubscriptionRow() {
  return {
    podcast_id: "podcast-0",
    status: "active",
    default_playback_speed: null,
    auto_queue: false,
    sync_status: "complete",
    sync_error_code: null,
    sync_error_message: null,
    sync_attempts: 1,
    sync_started_at: null,
    sync_completed_at: null,
    last_synced_at: null,
    updated_at: "2026-03-06T00:00:00Z",
    unplayed_count: 0,
    podcast: {
      id: "podcast-0",
      provider: "podcast_index",
      provider_podcast_id: "provider-0",
      title: "Systems Podcast 0",
      author: "Systems Team",
      feed_url: "https://feeds.example.com/systems-0.xml",
      website_url: "https://example.com/systems-0",
      image_url: null,
      description: null,
      created_at: "2026-03-06T00:00:00Z",
      updated_at: "2026-03-06T00:00:00Z",
    },
  };
}

describe("podcast ui cutover", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  it("shows a subscribe CTA for readable-but-unsubscribed podcast detail", async () => {
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
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
        return jsonResponse({ data: [buildEpisode("media-0", "Episode 0")] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/playback/queue") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({
          data: [
            {
              media_id: "media-0",
              processing_status: "pending",
              transcript_state: "not_requested",
              transcript_coverage: "none",
              required_minutes: 1,
              remaining_minutes: 30,
              fits_budget: true,
              request_enqueued: false,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      createElement(
        GlobalPlayerProvider,
        null,
        createElement(PodcastDetailPage)
      )
    );

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).not.toBeInTheDocument();
  });

  it("moves subscription actions into the row menu and removes category controls from subscriptions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/subscriptions" && (_init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [buildSubscriptionRow()] });
      }
      if (url.pathname === "/api/libraries" && (_init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [{ id: "library-sports", name: "Sports", is_default: false, role: "admin" }],
        });
      }
      if (url.pathname === "/api/libraries/library-sports/entries" && (_init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(PodcastSubscriptionsPage));

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(screen.queryByLabelText("Subscription category")).not.toBeInTheDocument();
    expect(screen.queryByText("New category")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to Sports" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Unsubscribe" })).toBeInTheDocument();
  });

  it("keeps queue controls inline and moves episode library toggles into the row menu", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
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
            subscription: {
              user_id: "user-1",
              podcast_id: "podcast-1",
              status: "active",
              sync_status: "complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
              default_playback_speed: null,
              auto_queue: false,
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({
          data: [buildEpisode("media-0", "Episode 0", { transcript_state: "not_requested" })],
        });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: [
            { id: "library-sports", name: "Sports", is_default: false, role: "admin" },
            { id: "library-history", name: "History", is_default: false, role: "admin" },
          ],
        });
      }
      if (url.pathname === "/api/libraries/library-sports/entries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries/library-history/entries") {
        return jsonResponse({
          data: [{ kind: "media", media: { id: "media-0" } }],
        });
      }
      if (url.pathname === "/api/playback/queue") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({
          data: [
            {
              media_id: "media-0",
              processing_status: "pending",
              transcript_state: "not_requested",
              transcript_coverage: "none",
              required_minutes: 1,
              remaining_minutes: 30,
              fits_budget: true,
              request_enqueued: false,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      createElement(
        GlobalPlayerProvider,
        null,
        createElement(PodcastDetailPage)
      )
    );

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play next for Episode 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Episode 0 to queue" })).toBeVisible();
    expect(screen.queryByLabelText("Subscription category")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Mark as played" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to Sports" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove from History" })).toBeInTheDocument();
  });

  it("keeps discovery subscribe inline while moving subscribed library actions into the row menu", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/podcasts/subscriptions") {
        return jsonResponse({
          data: [
            {
              ...buildSubscriptionRow(),
              podcast_id: "podcast-1",
              podcast: {
                ...buildSubscriptionRow().podcast,
                id: "podcast-1",
                provider_podcast_id: "provider-1",
              },
            },
          ],
        });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: [{ id: "library-sports", name: "Sports", is_default: false, role: "admin" }],
        });
      }
      if (url.pathname === "/api/libraries/library-sports/entries") {
        return jsonResponse({
          data: [{ kind: "podcast", podcast: { id: "podcast-1" } }],
        });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
              podcast_id: "podcast-1",
              provider_podcast_id: "provider-1",
              title: "Discovery Podcast",
              author: "Discovery Team",
              feed_url: "https://feeds.example.com/discovery.xml",
              website_url: "https://example.com/discovery",
              image_url: null,
              description: "Discovery show",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(PodcastsPage));

    await user.type(screen.getByPlaceholderText("Search podcasts by title or topic..."), "discovery");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Discovery Podcast")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View podcast" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Remove from Sports" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open website" })).toBeInTheDocument();
  });
});
