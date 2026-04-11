import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    unsubscribe_mode: 1,
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
    category: null,
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

describe("podcast ui action menu cutover", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  it("keeps My podcasts inline and moves detail secondary actions into the header menu", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
              unsubscribe_mode: 1,
              sync_status: "complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({ data: [buildEpisode("media-0", "Episode 0")] });
      }
      if (url.pathname === "/api/me") {
        return jsonResponse({ data: { user_id: "user-1", default_library_id: null } });
      }
      if (url.pathname === "/api/podcasts/categories") {
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
      if (url.pathname === "/api/podcasts/subscriptions/podcast-1/sync" && init?.method === "POST") {
        return jsonResponse({
          data: {
            podcast_id: "podcast-1",
            sync_status: "running",
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 2,
            sync_enqueued: true,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My podcasts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh sync" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/podcasts/subscriptions/podcast-1/sync" && init?.method === "POST";
        })
      ).toBe(true);
    });
  });

  it("moves subscription row actions into a row menu while keeping category editing inline", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/plan") {
        return jsonResponse({
          data: {
            plan: {
              plan_tier: "free",
              daily_transcription_minutes: 60,
              initial_episode_window: 3,
            },
            usage: {
              usage_date: "2026-03-06",
              used_minutes: 12,
              reserved_minutes: 3,
              total_minutes: 15,
              remaining_minutes: 45,
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/categories") {
        return jsonResponse({
          data: [
            {
              id: "cat-1",
              name: "Tech",
              position: 0,
              color: null,
              created_at: "2026-03-06T00:00:00Z",
              subscription_count: 1,
              unplayed_count: 0,
            },
          ],
        });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [buildSubscriptionRow()] });
      }
      if (url.pathname === "/api/podcasts/subscriptions/podcast-0/sync" && init?.method === "POST") {
        return jsonResponse({
          data: {
            podcast_id: "podcast-0",
            sync_status: "running",
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 2,
            sync_enqueued: true,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastSubscriptionsPage />);

    const rowTitle = await screen.findByText("Systems Podcast 0");
    const row = rowTitle.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByLabelText("Category for Systems Podcast 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open settings for Systems Podcast 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh sync for Systems Podcast 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unsubscribe from Systems Podcast 0" })).not.toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh sync" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Unsubscribe" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Refresh sync" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/podcasts/subscriptions/podcast-0/sync" && init?.method === "POST";
        })
      ).toBe(true);
    });
  });

  it("keeps episode primary controls inline and moves state/library toggles into row menu", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
              unsubscribe_mode: 1,
              sync_status: "complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({
          data: [buildEpisode("media-0", "Episode 0", { transcript_state: "not_requested" })],
        });
      }
      if (url.pathname === "/api/me") {
        return jsonResponse({
          data: {
            user_id: "user-1",
            default_library_id: "library-1",
          },
        });
      }
      if (url.pathname === "/api/libraries/library-1/media" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/categories") {
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
      if (url.pathname === "/api/media/media-0/listening-state" && init?.method === "PUT") {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    const rowTitle = await screen.findByText("Episode 0");
    const row = rowTitle.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "Play next for Episode 0" })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "Add Episode 0 to queue" })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByLabelText("Transcript request reason for Episode 0")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "Request transcript for Episode 0" })).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole("button", { name: "Mark as played for Episode 0" })).not.toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole("button", { name: "Add Episode 0 to library" })).not.toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Mark as played" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to library" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Mark as played" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/media/media-0/listening-state" && init?.method === "PUT";
        })
      ).toBe(true);
    });
  });

  it("adds discovery row menus while keeping primary subscribe inline", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/podcasts/subscriptions") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
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
      if (url.pathname === "/api/podcasts/subscriptions" && init?.method === "POST") {
        return jsonResponse({
          data: {
            podcast_id: "podcast-1",
            subscription_created: true,
            sync_status: "pending",
            sync_enqueued: true,
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 0,
            last_synced_at: null,
            window_size: 3,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastsPage />);

    await user.type(screen.getByPlaceholderText("Search podcasts by title or topic..."), "discovery");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const rowTitle = await screen.findByText("Discovery Podcast");
    const row = rowTitle.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "Subscribe" })).toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Open website" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open feed" })).toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/podcasts/subscriptions" && init?.method === "POST";
        })
      ).toBe(true);
    });
  });
});
