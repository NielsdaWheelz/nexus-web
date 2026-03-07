import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PodcastsPage from "./page";
import PodcastSubscriptionsPage from "./subscriptions/page";
import PodcastDetailPage from "./[podcastId]/page";

const mockUsePaneParam = vi.fn<(param: string) => string | null>();
const mockPush = vi.fn<(href: string) => void>();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: mockPush, replace: mockPush }),
  useSetPaneTitle: () => {},
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("podcasts product flows", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  it("supports discover -> subscribe workflow in podcasts lane", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/media?")) {
          return jsonResponse({ data: [], page: { next_cursor: null } });
        }
        if (url.startsWith("/api/podcasts/discover?")) {
          return jsonResponse({
            data: [
              {
                provider_podcast_id: "provider-1",
                title: "Systems Podcast",
                author: "Systems Team",
                feed_url: "https://feeds.example.com/systems.xml",
                website_url: "https://example.com/systems",
                image_url: null,
                description: "Systems thinking show",
              },
            ],
          });
        }
        if (url === "/api/podcasts/subscriptions" && init?.method === "POST") {
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
        throw new Error(`Unexpected fetch call in test: ${url}`);
      });

    render(<PodcastsPage />);

    await user.type(
      screen.getByPlaceholderText("Search podcasts by title or topic..."),
      "systems"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Systems Podcast")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === "/api/podcasts/subscriptions" && init?.method === "POST"
        )
      ).toBe(true);
    });
    expect(screen.getByRole("link", { name: "View podcast" })).toBeInTheDocument();
  });

  it("renders subscribed podcasts and supports unsubscribe", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith("/api/podcasts/subscriptions?")) {
          return jsonResponse({
            data: [
              {
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
                podcast: {
                  id: "podcast-1",
                  provider: "podcast_index",
                  provider_podcast_id: "provider-1",
                  title: "Systems Podcast",
                  author: "Systems Team",
                  feed_url: "https://feeds.example.com/systems.xml",
                  website_url: null,
                  image_url: null,
                  description: null,
                  created_at: "2026-03-06T00:00:00Z",
                  updated_at: "2026-03-06T00:00:00Z",
                },
              },
            ],
          });
        }
        if (
          url === "/api/podcasts/subscriptions/podcast-1?mode=1" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-1",
              status: "unsubscribed",
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
          });
        }
        throw new Error(`Unexpected fetch call in test: ${url}`);
      });

    render(<PodcastSubscriptionsPage />);
    expect(await screen.findByText("Systems Podcast")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Unsubscribe from Systems Podcast" })
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === "/api/podcasts/subscriptions/podcast-1?mode=1" &&
            init?.method === "DELETE"
        )
      ).toBe(true);
    });
  });

  it("renders podcast detail episodes and supports library add/remove actions", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/podcasts/podcast-1") {
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
        if (url === "/api/podcasts/podcast-1/episodes?limit=100") {
          return jsonResponse({
            data: [
              {
                id: "media-1",
                kind: "podcast_episode",
                title: "Episode One",
                canonical_source_url: "https://feeds.example.com/systems.xml",
                processing_status: "ready_for_reading",
                failure_stage: null,
                last_error_code: null,
                playback_source: {
                  kind: "external_audio",
                  stream_url: "https://cdn.example.com/e1.mp3",
                  source_url: "https://cdn.example.com/e1.mp3",
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
                created_at: "2026-03-06T00:00:00Z",
                updated_at: "2026-03-06T00:00:00Z",
              },
              {
                id: "media-2",
                kind: "podcast_episode",
                title: "Episode Two",
                canonical_source_url: "https://feeds.example.com/systems.xml",
                processing_status: "ready_for_reading",
                failure_stage: null,
                last_error_code: null,
                playback_source: {
                  kind: "external_audio",
                  stream_url: "https://cdn.example.com/e2.mp3",
                  source_url: "https://cdn.example.com/e2.mp3",
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
                created_at: "2026-03-06T00:00:00Z",
                updated_at: "2026-03-06T00:00:00Z",
              },
            ],
          });
        }
        if (url === "/api/me") {
          return jsonResponse({
            data: {
              user_id: "user-1",
              default_library_id: "library-1",
            },
          });
        }
        if (url === "/api/libraries/library-1/media" && init?.method === "POST") {
          return jsonResponse({
            data: {
              library_id: "library-1",
              media_id: "media-1",
              created_at: "2026-03-06T00:00:00Z",
            },
          });
        }
        if (url === "/api/libraries/library-1/media/media-2" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url === "/api/libraries/library-1/media") {
          return jsonResponse({
            data: [
              {
                id: "media-2",
                kind: "podcast_episode",
                title: "Episode Two",
                canonical_source_url: null,
                processing_status: "ready_for_reading",
                created_at: "2026-03-06T00:00:00Z",
                updated_at: "2026-03-06T00:00:00Z",
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch call in test: ${url}`);
      });

    render(<PodcastDetailPage />);

    expect(await screen.findByText("Episode One")).toBeInTheDocument();
    expect(await screen.findByText("Episode Two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Episode One to library" }));
    await user.click(
      screen.getByRole("button", { name: "Remove Episode Two from library" })
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === "/api/libraries/library-1/media" && init?.method === "POST"
        )
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === "/api/libraries/library-1/media/media-2" &&
            init?.method === "DELETE"
        )
      ).toBe(true);
    });
  });
});
