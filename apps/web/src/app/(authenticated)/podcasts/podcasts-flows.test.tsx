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

function buildSubscriptionRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    podcast_id: `podcast-${index}`,
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
      id: `podcast-${index}`,
      provider: "podcast_index",
      provider_podcast_id: `provider-${index}`,
      title: `Systems Podcast ${index}`,
      author: "Systems Team",
      feed_url: `https://feeds.example.com/systems-${index}.xml`,
      website_url: null,
      image_url: null,
      description: null,
      created_at: "2026-03-06T00:00:00Z",
      updated_at: "2026-03-06T00:00:00Z",
    },
    ...overrides,
  };
}

function buildEpisode(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `media-${index}`,
    kind: "podcast_episode",
    title: `Episode ${index}`,
    canonical_source_url: "https://feeds.example.com/systems.xml",
    processing_status: "ready_for_reading",
    transcript_state: "ready",
    transcript_coverage: "full",
    failure_stage: null,
    last_error_code: null,
    playback_source: {
      kind: "external_audio" as const,
      stream_url: `https://cdn.example.com/e${index}.mp3`,
      source_url: `https://cdn.example.com/e${index}.mp3`,
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
    ...overrides,
  };
}

describe("podcasts product flows", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    vi.restoreAllMocks();
  });

  it("hydrates existing subscriptions before rendering discovery actions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({ data: [], page: { next_cursor: null } });
      }
      if (url.pathname === "/api/podcasts/subscriptions") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (offset === 0) {
          return jsonResponse({
            data: [buildSubscriptionRow(1)],
          });
        }
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/discover") {
        return jsonResponse({
          data: [
            {
              provider_podcast_id: "provider-1",
              title: "Systems Podcast 1",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/systems-1.xml",
              website_url: "https://example.com/systems",
              image_url: null,
              description: "Systems thinking show",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(<PodcastsPage />);

    await user.type(
      screen.getByPlaceholderText("Search podcasts by title or topic..."),
      "systems"
    );
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Systems Podcast 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View podcast" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe" })).not.toBeInTheDocument();
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
        if (url.startsWith("/api/podcasts/subscriptions?")) {
          return jsonResponse({ data: [] });
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

  it("renders subscriptions with sync controls, unsubscribe modes, and load-more pagination", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
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
        if (url.pathname === "/api/podcasts/subscriptions") {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          if (offset === 0) {
            return jsonResponse({
              data: [
                buildSubscriptionRow(0, {
                  sync_status: "failed",
                  sync_error_code: "E_SYNC_PROVIDER_TIMEOUT",
                  sync_error_message: "Provider timeout while fetching episodes",
                }),
                ...Array.from({ length: 99 }, (_, idx) => buildSubscriptionRow(idx + 1)),
              ],
            });
          }
          if (offset === 100) {
            return jsonResponse({
              data: [buildSubscriptionRow(100)],
            });
          }
          return jsonResponse({ data: [] });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions/podcast-0/sync" &&
          init?.method === "POST"
        ) {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-0",
              status: "active",
              unsubscribe_mode: 1,
              sync_status: "running",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 2,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
          });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions/podcast-0" &&
          url.searchParams.get("mode") === "3" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-0",
              status: "unsubscribed",
              unsubscribe_mode: 3,
              sync_status: "running",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 2,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
          });
        }
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(<PodcastSubscriptionsPage />);

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(await screen.findByText(/E_SYNC_PROVIDER_TIMEOUT/)).toBeInTheDocument();
    expect(await screen.findByText(/Provider timeout while fetching episodes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save plan" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Plan tier")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Daily transcription minutes")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Initial episode window")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh sync for Systems Podcast 0" }));
    await user.selectOptions(screen.getByLabelText("Unsubscribe behavior"), "3");
    await user.click(
      screen.getByRole("button", { name: "Unsubscribe from Systems Podcast 0" })
    );

    await user.click(screen.getByRole("button", { name: "Load more subscriptions" }));
    expect(await screen.findByText("Systems Podcast 100")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/subscriptions/podcast-0/sync" &&
            init?.method === "POST"
          );
        })
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/subscriptions/podcast-0" &&
            parsed.searchParams.get("mode") === "3" &&
            init?.method === "DELETE"
          );
        })
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/subscriptions" &&
            parsed.searchParams.get("offset") === "100"
          );
        })
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/podcasts/plan" && init?.method === "PUT";
        })
      ).toBe(false);
    });
  });

  it("renders podcast detail with sync controls, transcript demand reasons, and paginated episodes", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    let episodesOffsetZeroCalls = 0;
    let mediaZeroRefreshCalls = 0;
    const transcriptForecastBatchBodies: Array<
      Array<{ media_id: string; reason: string }>
    > = [];
    const transcriptRequestBodies: Array<{ dry_run: boolean; reason: string }> = [];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
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
                sync_status: "failed",
                sync_error_code: "E_SYNC_PROVIDER_TIMEOUT",
                sync_error_message: "Provider timeout while fetching episodes",
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
          const offset = Number(url.searchParams.get("offset") ?? "0");
          if (offset === 0) {
            episodesOffsetZeroCalls += 1;
            if (episodesOffsetZeroCalls > 1) {
              return jsonResponse({
                data: [
                  {
                    ...buildEpisode(0),
                    title: "Resynced Episode 0",
                    processing_status: "queued",
                  },
                  {
                    ...buildEpisode(1),
                    title: "Resynced Episode 1",
                    processing_status: "queued",
                  },
                ],
              });
            }
            return jsonResponse({
              data: Array.from({ length: 100 }, (_, idx) => {
                if (idx === 0) {
                  return buildEpisode(0, {
                    transcript_state: "not_requested",
                    transcript_coverage: "none",
                    capabilities: {
                      can_read: false,
                      can_highlight: false,
                      can_quote: false,
                      can_search: false,
                      can_play: true,
                      can_download_file: false,
                    },
                  });
                }
                if (idx === 2) {
                  return buildEpisode(2, {
                    transcript_state: "queued",
                    transcript_coverage: "none",
                    processing_status: "extracting",
                    capabilities: {
                      can_read: false,
                      can_highlight: false,
                      can_quote: false,
                      can_search: false,
                      can_play: true,
                      can_download_file: false,
                    },
                  });
                }
                return buildEpisode(idx);
              }),
            });
          }
          if (offset === 100) {
            return jsonResponse({ data: [buildEpisode(100)] });
          }
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/api/podcasts/subscriptions/podcast-1/sync" && init?.method === "POST") {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-1",
              status: "active",
              unsubscribe_mode: 1,
              sync_status: "running",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 2,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
          });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions/podcast-1" &&
          url.searchParams.get("mode") === "2" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-1",
              status: "unsubscribed",
              unsubscribe_mode: 2,
              sync_status: "running",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 2,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
            },
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
        if (url.pathname === "/api/media/transcript/forecasts" && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}"));
          transcriptForecastBatchBodies.push(Array.isArray(body.requests) ? body.requests : []);
          return jsonResponse({
            data: (Array.isArray(body.requests) ? body.requests : []).map(
              (request: { media_id: string }) => ({
                media_id: String(request.media_id),
                processing_status: "pending",
                transcript_state: "not_requested",
                transcript_coverage: "none",
                required_minutes: 1,
                remaining_minutes: 29,
                fits_budget: true,
                request_enqueued: false,
              })
            ),
          });
        }
        if (url.pathname === "/api/media/media-0/transcript/request" && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}"));
          transcriptRequestBodies.push({
            dry_run: Boolean(body.dry_run),
            reason: String(body.reason),
          });
          if (body.dry_run === true) {
            return jsonResponse(
              {
                error: {
                  code: "E_TEST_SHOULD_NOT_DRY_RUN",
                  message: "podcast detail should batch dry-run forecasts instead of per-row requests",
                },
              },
              400
            );
          }
          return jsonResponse({
            data: {
              media_id: "media-0",
              processing_status: "extracting",
              transcript_state: "queued",
              transcript_coverage: "none",
              request_reason: "quote",
              required_minutes: 1,
              remaining_minutes: 29,
              fits_budget: true,
              request_enqueued: true,
            },
          });
        }
        if (url.pathname === "/api/media/media-0") {
          mediaZeroRefreshCalls += 1;
          if (mediaZeroRefreshCalls === 1) {
            return jsonResponse({
              data: {
                ...buildEpisode(0, {
                  transcript_state: "queued",
                  transcript_coverage: "none",
                  processing_status: "extracting",
                  capabilities: {
                    can_read: false,
                    can_highlight: false,
                    can_quote: false,
                    can_search: false,
                    can_play: true,
                    can_download_file: false,
                  },
                }),
              },
            });
          }
          return jsonResponse({
            data: {
              ...buildEpisode(0),
              processing_status: "ready_for_reading",
              transcript_state: "partial",
              transcript_coverage: "partial",
            },
          });
        }
        if (url.pathname === "/api/libraries/library-1/media") {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          if (offset === 0) {
            return jsonResponse({
              data: Array.from({ length: 200 }, (_, idx) => ({ id: `library-media-${idx}` })),
            });
          }
          if (offset === 200) {
            return jsonResponse({
              data: [{ id: "media-100" }],
            });
          }
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(<PodcastDetailPage />);

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(await screen.findByText(/E_SYNC_PROVIDER_TIMEOUT/)).toBeInTheDocument();
    expect(await screen.findByText(/Provider timeout while fetching episodes/)).toBeInTheDocument();
    expect(screen.getAllByText(/transcript ready \(full coverage\)/i).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Request transcript for Episode 1" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Request transcript for Episode 2" })
    ).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Transcript request reason for Episode 0"), "quote");
    await user.click(screen.getByRole("button", { name: "Request transcript for Episode 0" }));
    expect(
      await screen.findByText(/transcript partial \(partial coverage\)/i, undefined, {
        timeout: 8000,
      })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more episodes" }));
    expect(await screen.findByText("Episode 100")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh sync for Systems Podcast" }));
    expect(await screen.findByText("Resynced Episode 0")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Episode 100")).not.toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText("Unsubscribe behavior"), "2");
    await user.click(screen.getByRole("button", { name: "Unsubscribe from Systems Podcast" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/subscriptions/podcast-1/sync" &&
            init?.method === "POST"
          );
        })
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/subscriptions/podcast-1" &&
            parsed.searchParams.get("mode") === "2" &&
            init?.method === "DELETE"
          );
        })
      ).toBe(true);
      expect(
        transcriptForecastBatchBodies.some((batch) =>
          batch.some((request) => request.media_id === "media-0" && request.reason === "quote")
        )
      ).toBe(true);
      expect(
        transcriptRequestBodies.some((body) => body.reason === "quote" && !body.dry_run)
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/podcast-1/episodes" &&
            parsed.searchParams.get("offset") === "100"
          );
        })
      ).toBe(true);
      expect(
        fetchMock.mock.calls.filter(([url]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/podcasts/podcast-1/episodes" &&
            parsed.searchParams.get("offset") === "0"
          );
        }).length
      ).toBeGreaterThan(1);
      expect(
        fetchMock.mock.calls.some(([url]) => {
          const parsed = new URL(String(url), "http://localhost");
          return (
            parsed.pathname === "/api/libraries/library-1/media" &&
            parsed.searchParams.get("offset") === "200"
          );
        })
      ).toBe(true);
      expect(mediaZeroRefreshCalls).toBeGreaterThan(1);
    });
  });

  it("disables transcript requests when dry-run forecast exceeds available quota", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    const transcriptForecastBatchBodies: Array<
      Array<{ media_id: string; reason: string }>
    > = [];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
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
            data: [
              buildEpisode(0, {
                title: "Budget Episode",
                transcript_state: "not_requested",
                transcript_coverage: "none",
                capabilities: {
                  can_read: false,
                  can_highlight: false,
                  can_quote: false,
                  can_search: false,
                  can_play: true,
                  can_download_file: false,
                },
              }),
            ],
          });
        }
        if (url.pathname === "/api/me") {
          return jsonResponse({
            data: {
              user_id: "user-1",
              default_library_id: null,
            },
          });
        }
        if (url.pathname === "/api/media/transcript/forecasts" && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}"));
          transcriptForecastBatchBodies.push(Array.isArray(body.requests) ? body.requests : []);
          return jsonResponse({
            data: [
              {
                media_id: "media-0",
                processing_status: "pending",
                transcript_state: "not_requested",
                transcript_coverage: "none",
                required_minutes: 2,
                remaining_minutes: 1,
                fits_budget: false,
                request_enqueued: false,
              },
            ],
          });
        }
        if (url.pathname === "/api/media/media-0/transcript/request" && init?.method === "POST") {
          return jsonResponse({
            error: {
              code: "E_TEST_SHOULD_NOT_REQUEST",
              message: "single transcript request should not be made when quota does not fit",
            },
          }, 400);
        }
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(<PodcastDetailPage />);

    expect(await screen.findByText("Budget Episode")).toBeInTheDocument();

    const requestButton = screen.getByRole("button", {
      name: "Request transcript for Budget Episode",
    });
    await waitFor(() => {
      expect(requestButton).toBeDisabled();
      expect(screen.getByText(/2 min · remaining 1 min/i)).toBeInTheDocument();
    });

    await user.click(requestButton);

    await waitFor(() => {
      const transcriptRequestCalls = fetchMock.mock.calls.filter(([url]) => {
        const parsed = new URL(String(url), "http://localhost");
        return parsed.pathname === "/api/media/media-0/transcript/request";
      });
      expect(transcriptRequestCalls).toHaveLength(0);
      expect(transcriptForecastBatchBodies).toHaveLength(1);
      expect(transcriptForecastBatchBodies[0]).toEqual([
        {
          media_id: "media-0",
          reason: "search",
        },
      ]);
    });
  });
});
