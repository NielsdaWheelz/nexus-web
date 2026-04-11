import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PodcastsPage from "./page";
import PodcastSubscriptionsPage from "./subscriptions/page";
import PodcastDetailPage from "./[podcastId]/page";
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

function buildSubscriptionRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    podcast_id: `podcast-${index}`,
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
    listening_state: null,
    subscription_default_playback_speed: null,
    episode_state: "unplayed",
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
    description_html: null,
    description_text: null,
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
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({ data: [] });
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

    await user.click(screen.getAllByRole("button", { name: "Actions" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Refresh sync" }));
    await user.selectOptions(screen.getByLabelText("Unsubscribe behavior"), "3");
    await user.click(screen.getAllByRole("button", { name: "Actions" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "Unsubscribe" }));

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

  it("imports subscriptions from OPML and exposes OPML export download", async () => {
    const user = userEvent.setup();
    let subscriptionsFetchCount = 0;
    const importBodies: Array<{ hasFile: boolean; fileName: string | null }> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions") {
        subscriptionsFetchCount += 1;
        if (subscriptionsFetchCount === 1) {
          return jsonResponse({ data: [] });
        }
        return jsonResponse({ data: [buildSubscriptionRow(200)] });
      }
      if (url.pathname === "/api/podcasts/import/opml" && init?.method === "POST") {
        const body = init.body;
        if (!(body instanceof FormData)) {
          throw new Error("Expected OPML import request body to be FormData");
        }
        const uploaded = body.get("file");
        importBodies.push({
          hasFile: uploaded instanceof File,
          fileName: uploaded instanceof File ? uploaded.name : null,
        });
        return jsonResponse({
          data: {
            total: 2,
            imported: 1,
            skipped_already_subscribed: 1,
            skipped_invalid: 0,
            errors: [],
          },
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(<PodcastSubscriptionsPage />);

    expect(await screen.findByText(/No active podcast subscriptions yet/i)).toBeInTheDocument();
    const exportLink = screen.getByRole("link", { name: "Export OPML" });
    expect(exportLink).toHaveAttribute("href", "/api/podcasts/export/opml");

    await user.click(screen.getByRole("button", { name: "Import OPML" }));
    const fileInput = screen.getByLabelText("OPML file");
    const opmlFile = new File(
      ['<?xml version="1.0"?><opml version="2.0"><body /></opml>'],
      "subscriptions.opml",
      { type: "application/xml" }
    );
    await user.upload(fileInput, opmlFile);
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Import complete")).toBeInTheDocument();
    expect(screen.getByText(/Total found: 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Imported: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Already subscribed: 1/i)).toBeInTheDocument();
    expect(await screen.findByText("Systems Podcast 200")).toBeInTheDocument();

    await waitFor(() => {
      expect(importBodies).toEqual([
        {
          hasFile: true,
          fileName: "subscriptions.opml",
        },
      ]);
      expect(subscriptionsFetchCount).toBeGreaterThanOrEqual(2);
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
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({ data: [] });
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

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

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

    await user.click(screen.getByRole("button", { name: "Refresh sync" }));
    expect(await screen.findByText("Resynced Episode 0")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Episode 100")).not.toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText("Unsubscribe behavior"), "2");
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));

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

  it("renders episode-state controls and sends filtered/sorted/searched episode queries", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    const episodeQueryCalls: Array<{ state: string; sort: string; q: string }> = [];

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
        episodeQueryCalls.push({
          state: url.searchParams.get("state") ?? "",
          sort: url.searchParams.get("sort") ?? "",
          q: url.searchParams.get("q") ?? "",
        });
        return jsonResponse({
          data: [
            buildEpisode(0, {
              title: "Interview Episode",
              transcript_state: "ready",
              transcript_coverage: "full",
              episode_state: "unplayed",
              listening_state: null,
            }),
          ],
        });
      }
      if (url.pathname === "/api/podcasts/categories") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/me") {
        return jsonResponse({
          data: {
            user_id: "user-1",
            default_library_id: null,
          },
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    expect(await screen.findByText("Interview Episode")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unplayed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Played" })).toBeInTheDocument();
    expect(screen.getByLabelText("Episode sort")).toBeInTheDocument();
    expect(screen.getByLabelText("Search episodes")).toBeInTheDocument();
    const episodeRow = screen.getByText("Interview Episode").closest("li");
    expect(episodeRow).not.toBeNull();
    expect(
      within(episodeRow as HTMLElement).getByRole("button", { name: "Actions" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unplayed" }));
    await user.selectOptions(screen.getByLabelText("Episode sort"), "duration_desc");
    await user.type(screen.getByLabelText("Search episodes"), "interview");

    await waitFor(() => {
      expect(
        episodeQueryCalls.some(
          (call) =>
            call.state === "unplayed" && call.sort === "duration_desc" && call.q === "interview"
        )
      ).toBe(true);
    });
  });

  it("shows show-notes preview expansion and batch transcript request summary", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    let episodesFetchCount = 0;
    const batchBodies: Array<{ media_ids: string[]; reason: string }> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse({
          data: {
            podcast: {
              id: "podcast-1",
              provider: "podcast_index",
              provider_podcast_id: "provider-1",
              title: "Show Notes Podcast",
              author: "Systems Team",
              feed_url: "https://feeds.example.com/show-notes.xml",
              website_url: null,
              image_url: null,
              description: "Show notes contract",
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
        episodesFetchCount += 1;
        if (episodesFetchCount === 1) {
          return jsonResponse({
            data: [
              buildEpisode(0, {
                title: "Batch Episode 0",
                transcript_state: "not_requested",
                transcript_coverage: "none",
                episode_state: "unplayed",
                listening_state: null,
                description_text:
                  "Episode zero show notes. " +
                  "This line is intentionally long so preview truncation and show-more behavior are testable. "
                    .repeat(6),
              }),
              buildEpisode(1, {
                title: "Batch Episode 1",
                transcript_state: "not_requested",
                transcript_coverage: "none",
                episode_state: "in_progress",
                listening_state: {
                  position_ms: 10_000,
                  duration_ms: 60_000,
                  playback_speed: 1,
                  is_completed: false,
                },
                description_text: "Episode one notes",
              }),
              buildEpisode(2, {
                title: "Played Episode",
                transcript_state: "ready",
                transcript_coverage: "full",
                episode_state: "played",
                listening_state: {
                  position_ms: 60_000,
                  duration_ms: 60_000,
                  playback_speed: 1,
                  is_completed: true,
                },
                description_text: "Episode two notes",
              }),
            ],
          });
        }
        return jsonResponse({
          data: [
            buildEpisode(0, {
              title: "Batch Episode 0",
              transcript_state: "queued",
              transcript_coverage: "none",
              processing_status: "extracting",
              description_text: "Episode zero show notes refreshed",
            }),
            buildEpisode(1, {
              title: "Batch Episode 1",
              transcript_state: "ready",
              transcript_coverage: "full",
              processing_status: "ready_for_reading",
              listening_state: {
                position_ms: 10_000,
                duration_ms: 60_000,
                playback_speed: 1,
                is_completed: false,
              },
              episode_state: "in_progress",
              description_text: "Episode one notes refreshed",
            }),
            buildEpisode(2, {
              title: "Played Episode",
              transcript_state: "ready",
              transcript_coverage: "full",
              processing_status: "ready_for_reading",
              listening_state: {
                position_ms: 60_000,
                duration_ms: 60_000,
                playback_speed: 1,
                is_completed: true,
              },
              episode_state: "played",
              description_text: "Episode two notes refreshed",
            }),
          ],
        });
      }
      if (url.pathname === "/api/podcasts/categories") {
        return jsonResponse({ data: [] });
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
        return jsonResponse({
          data: (Array.isArray(body.requests) ? body.requests : []).map(
            (request: { media_id: string }) => ({
              media_id: request.media_id,
              processing_status: "pending",
              transcript_state: "not_requested",
              transcript_coverage: "none",
              required_minutes: 1,
              remaining_minutes: 3,
              fits_budget: true,
              request_enqueued: false,
            })
          ),
        });
      }
      if (url.pathname === "/api/media/transcript/request/batch" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}"));
        batchBodies.push(body);
        return jsonResponse({
          data: {
            results: [
              { media_id: "media-0", status: "queued" },
              { media_id: "media-1", status: "already_ready" },
              { media_id: "media-9", status: "rejected_quota" },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    expect(await screen.findByText("Batch Episode 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more for Batch Episode 0" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show more for Batch Episode 0" }));
    expect(screen.getByRole("button", { name: "Show less for Batch Episode 0" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Transcribe unplayed episodes" }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });

    expect(confirmMock.mock.calls[0]?.[0]).toContain("Eligible episodes: 2");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("Estimated minutes: 2");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("Remaining quota: 3");
    expect(batchBodies).toEqual([
      {
        media_ids: ["media-0", "media-1"],
        reason: "search",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Batch transcript result: 1 queued, 1 already ready, 1 rejected (quota).")).toBeInTheDocument();
    });

    expect(episodesFetchCount).toBeGreaterThan(1);
  });

  it("shows subscription unplayed badges and supports subscription sorting", async () => {
    const user = userEvent.setup();
    const subscriptionQueryCalls: Array<{ sort: string }> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions") {
        subscriptionQueryCalls.push({ sort: url.searchParams.get("sort") ?? "" });
        return jsonResponse({
          data: [
            buildSubscriptionRow(0, { unplayed_count: 12 }),
            buildSubscriptionRow(1, { unplayed_count: 0 }),
          ],
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(<PodcastSubscriptionsPage />);

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(screen.getByText("12 new")).toBeInTheDocument();
    expect(screen.queryByText("0 new")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Subscription sort")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Subscription sort"), "unplayed_count");

    await waitFor(() => {
      expect(subscriptionQueryCalls.some((call) => call.sort === "recent_episode")).toBe(true);
      expect(subscriptionQueryCalls.some((call) => call.sort === "unplayed_count")).toBe(true);
    });
  });

  it("shows category tabs, filters subscriptions, and patches row category assignment", async () => {
    const user = userEvent.setup();
    const categoryFilterQueryCalls: Array<string | null> = [];
    const settingsPatchBodies: Array<{ podcast_id: string; category_id: string | null }> = [];
    const categories = [
      {
        id: "cat-tech",
        name: "Tech",
        position: 0,
        color: "#3366FF",
        created_at: "2026-03-06T00:00:00Z",
        subscription_count: 1,
        unplayed_count: 12,
      },
      {
        id: "cat-news",
        name: "News",
        position: 1,
        color: "#AA3311",
        created_at: "2026-03-06T00:00:00Z",
        subscription_count: 0,
        unplayed_count: 0,
      },
    ];
    const categoryByPodcastId: Record<string, string | null> = {
      "podcast-0": "cat-tech",
      "podcast-1": null,
    };

    const categoryRefById = (categoryId: string | null) => {
      if (!categoryId) {
        return null;
      }
      const row = categories.find((category) => category.id === categoryId);
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        name: row.name,
        color: row.color,
      };
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
      if (url.pathname === "/api/podcasts/categories" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: categories });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        const categoryFilter = url.searchParams.get("category_id");
        categoryFilterQueryCalls.push(categoryFilter);

        const rows = [
          buildSubscriptionRow(0, {
            unplayed_count: 12,
            category: categoryRefById(categoryByPodcastId["podcast-0"]),
          }),
          buildSubscriptionRow(1, {
            unplayed_count: 4,
            category: categoryRefById(categoryByPodcastId["podcast-1"]),
          }),
        ];

        if (categoryFilter === "null") {
          return jsonResponse({ data: rows.filter((row) => row.category === null) });
        }
        if (categoryFilter) {
          return jsonResponse({
            data: rows.filter((row) => {
              const category = row.category as { id: string } | null;
              return category?.id === categoryFilter;
            }),
          });
        }
        return jsonResponse({ data: rows });
      }
      if (
        url.pathname === "/api/podcasts/subscriptions/podcast-1/settings" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body ?? "{}"));
        const nextCategoryId =
          typeof body.category_id === "string" && body.category_id.length > 0
            ? body.category_id
            : null;
        settingsPatchBodies.push({
          podcast_id: "podcast-1",
          category_id: nextCategoryId,
        });
        categoryByPodcastId["podcast-1"] = nextCategoryId;
        return jsonResponse({
          data: {
            podcast_id: "podcast-1",
            default_playback_speed: null,
            auto_queue: false,
            category: categoryRefById(nextCategoryId),
            updated_at: "2026-03-06T00:00:00Z",
          },
        });
      }
      throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
    });

    render(<PodcastSubscriptionsPage />);

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tech \(12\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Uncategorized/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder category Tech" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tech \(12\)/ }));
    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    await waitFor(() => {
      expect(categoryFilterQueryCalls).toContain("cat-tech");
      expect(screen.queryByText("Systems Podcast 1")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Uncategorized/ }));
    expect(await screen.findByText("Systems Podcast 1")).toBeInTheDocument();
    await waitFor(() => {
      expect(categoryFilterQueryCalls).toContain("null");
    });

    await user.selectOptions(screen.getByLabelText("Category for Systems Podcast 1"), "cat-tech");

    await waitFor(() => {
      expect(settingsPatchBodies).toContainEqual({
        podcast_id: "podcast-1",
        category_id: "cat-tech",
      });
    });
  });

  it("shows play-next/add-to-queue controls and swaps to in-queue badge", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );

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
                title: "Queue Podcast",
                author: "Systems Team",
                feed_url: "https://feeds.example.com/queue.xml",
                website_url: null,
                image_url: null,
                description: "Queue podcast",
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
          return jsonResponse({ data: [buildEpisode(0)] });
        }
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/api/me") {
          return jsonResponse({
            data: {
              user_id: "user-1",
              default_library_id: null,
            },
          });
        }
        if (url.pathname === "/api/playback/queue" && (init?.method ?? "GET") === "GET") {
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/api/playback/queue/items" && init?.method === "POST") {
          return jsonResponse({
            data: [
              {
                item_id: "queue-item-0",
                media_id: "media-0",
                title: "Episode 0",
                podcast_title: "Queue Podcast",
                duration_seconds: 120,
                stream_url: "https://cdn.example.com/e0.mp3",
                source_url: "https://cdn.example.com/e0.mp3",
                position: 0,
                source: "manual",
                added_at: "2026-03-06T00:00:00Z",
                listening_state: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play next for Episode 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Episode 0 to queue" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add Episode 0 to queue" }));

    await waitFor(() => {
      expect(screen.getByText("In Queue")).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          if (url.pathname !== "/api/playback/queue/items" || init?.method !== "POST") {
            return false;
          }
          const body = JSON.parse(String(init.body ?? "{}"));
          return body.insert_position === "last" && body.media_ids?.includes("media-0");
        })
      ).toBe(true);
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
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({ data: [] });
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

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

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

  it("opens row settings in subscriptions list and saves default speed plus auto-queue", async () => {
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
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
          return jsonResponse({
            data: [
              buildSubscriptionRow(0, {
                default_playback_speed: null,
                auto_queue: false,
              }),
            ],
          });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions/podcast-0/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({
            data: {
              ...buildSubscriptionRow(0),
              default_playback_speed: 1.5,
              auto_queue: true,
            },
          });
        }
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(<PodcastSubscriptionsPage />);

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();

    const subscriptionRow = screen.getByText("Systems Podcast 0").closest("li");
    expect(subscriptionRow).not.toBeNull();
    await user.click(
      within(subscriptionRow as HTMLElement).getByRole("button", { name: "Actions" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Default playback speed"), "1.5");
    await user.click(screen.getByLabelText("Automatically add new episodes to my queue"));
    await user.click(screen.getByRole("button", { name: "Save subscription settings" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          if (
            parsed.pathname !== "/api/podcasts/subscriptions/podcast-0/settings" ||
            init?.method !== "PATCH"
          ) {
            return false;
          }
          const body = JSON.parse(String(init.body ?? "{}"));
          return body.default_playback_speed === 1.5 && body.auto_queue === true;
        })
      ).toBe(true);
    });
  });

  it("shows detail-page subscription summary and saves settings from header controls", async () => {
    const user = userEvent.setup();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "podcast-1" : null
    );

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
                default_playback_speed: 1.5,
                auto_queue: true,
                category: {
                  id: "cat-tech",
                  name: "Tech",
                  color: "#3366FF",
                },
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
            data: [buildEpisode(0, { subscription_default_playback_speed: 1.5 })],
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
        if (url.pathname === "/api/podcasts/categories") {
          return jsonResponse({
            data: [
              {
                id: "cat-tech",
                name: "Tech",
                position: 0,
                color: "#3366FF",
                created_at: "2026-03-06T00:00:00Z",
                subscription_count: 1,
                unplayed_count: 0,
              },
              {
                id: "cat-news",
                name: "News",
                position: 1,
                color: "#AA3311",
                created_at: "2026-03-06T00:00:00Z",
                subscription_count: 0,
                unplayed_count: 0,
              },
            ],
          });
        }
        if (
          url.pathname === "/api/podcasts/subscriptions/podcast-1/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({
            data: {
              user_id: "user-1",
              podcast_id: "podcast-1",
              status: "active",
              unsubscribe_mode: 1,
              default_playback_speed: 2.0,
              auto_queue: false,
              category: {
                id: "cat-news",
                name: "News",
                color: "#AA3311",
              },
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
        throw new Error(`Unexpected fetch call in test: ${url.pathname}${url.search}`);
      });

    render(
      <GlobalPlayerProvider>
        <PodcastDetailPage />
      </GlobalPlayerProvider>
    );

    expect(await screen.findByText("Episode 0")).toBeInTheDocument();
    expect(screen.getByText("1.5x default speed · Auto-queue on")).toBeInTheDocument();
    expect(screen.getByText("Category: Tech")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Default playback speed"), "2");
    await user.click(screen.getByLabelText("Automatically add new episodes to my queue"));
    await user.selectOptions(screen.getByLabelText("Subscription category"), "cat-news");
    await user.click(screen.getByRole("button", { name: "Save subscription settings" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          if (
            parsed.pathname !== "/api/podcasts/subscriptions/podcast-1/settings" ||
            init?.method !== "PATCH"
          ) {
            return false;
          }
          const body = JSON.parse(String(init.body ?? "{}"));
          return (
            body.default_playback_speed === 2 &&
            body.auto_queue === false &&
            body.category_id === "cat-news"
          );
        })
      ).toBe(true);
      expect(screen.getByText("2.0x default speed · Auto-queue off")).toBeInTheDocument();
      expect(screen.getByText("Category: News")).toBeInTheDocument();
    });
  });
});
