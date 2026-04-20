import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import PodcastsPage from "./page";
import PodcastDetailPage from "./[podcastId]/page";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

const mockUsePaneParam = vi.fn<(param: string) => string | null>();
const mockPush = vi.fn<(href: string) => void>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockViewportState = { isMobile: false };
const mockRequestOpenInAppPane = vi.fn();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: mockPush, replace: mockPush }),
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

vi.mock("@/lib/panes/openInAppPane", () => ({
  NEXUS_OPEN_PANE_EVENT: "nexus:open-pane",
  NEXUS_OPEN_PANE_MESSAGE_TYPE: "nexus:open-pane",
  consumePendingPaneOpenQueue: () => [],
  isOpenInAppPaneMessage: () => false,
  normalizePaneHref: (href: string) => href,
  setPaneGraphReady: vi.fn(),
  requestOpenInAppPane: (...args: unknown[]) => mockRequestOpenInAppPane(...args),
}));

vi.mock("@/lib/panes/paneRouteRegistry", () => ({
  resolvePaneRoute: () => null,
  getParentHref: () => null,
  DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX: 360,
  DEFAULT_HIGHLIGHTS_PANE_WIDTH_PX: 360,
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
    latest_episode_published_at: "2026-03-05T00:00:00Z",
    visible_libraries: [],
    podcast: {
      id: `podcast-${index}`,
      provider: "podcast_index",
      provider_podcast_id: `provider-${index}`,
      title: `Systems Podcast ${index}`,
      author: "Systems Team",
      feed_url: `https://feeds.example.com/systems-${index}.xml`,
      website_url: null,
      image_url: null,
      description: "Practical systems interviews for engineering teams.",
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

describe("podcasts product flows", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockRequestOpenInAppPane.mockReset();
    mockViewportState.isMobile = false;
    vi.restoreAllMocks();
  });

  it("opens row settings in the subscriptions list and saves default speed plus auto-queue", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [buildSubscriptionRow(0)] });
      }
      if (
        url.pathname === "/api/podcasts/subscriptions/podcast-0/settings" &&
        init?.method === "PATCH"
      ) {
        return jsonResponse({
          data: {
            podcast_id: "podcast-0",
            default_playback_speed: 1.5,
            auto_queue: true,
            updated_at: "2026-03-07T00:00:00Z",
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(PodcastsPage));

    expect(screen.getByPlaceholderText("Search followed podcasts...")).toBeInTheDocument();

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(
      screen.getByText("Practical systems interviews for engineering teams.")
    ).toBeInTheDocument();
    expect(screen.getByText((content) => content.startsWith("Latest "))).toBeInTheDocument();
    expect(screen.queryByText("https://feeds.example.com/systems-0.xml")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));

    await user.selectOptions(screen.getByLabelText("Default playback speed"), "1.5");
    await user.click(screen.getByLabelText("Automatically add new episodes to my queue"));
    await user.click(screen.getByRole("button", { name: "Save subscription settings" }));

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          if (parsed.pathname !== "/api/podcasts/subscriptions/podcast-0/settings") {
            return false;
          }
          const body = JSON.parse(String(init?.body ?? "{}"));
          return body.default_playback_speed === 1.5 && body.auto_queue === true;
        })
      ).toBe(true);
    });
  });

  it("describes library removal impact when unsubscribing from detail", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
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
              sync_status: "complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-03-06T00:00:00Z",
              default_playback_speed: 1.25,
              auto_queue: false,
            },
          },
        });
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({ data: [buildEpisode(0)] });
      }
      if (url.pathname === "/api/podcasts/podcast-1/libraries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "library-sports",
              name: "Sports",
              color: null,
              is_in_library: true,
              can_add: false,
              can_remove: true,
            },
            {
              id: "library-shared",
              name: "Shared",
              color: null,
              is_in_library: true,
              can_add: false,
              can_remove: false,
            },
          ],
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
              transcript_state: "ready",
              transcript_coverage: "full",
              required_minutes: 0,
              remaining_minutes: 30,
              fits_budget: true,
              request_enqueued: false,
            },
          ],
        });
      }
      if (url.pathname === "/api/podcasts/subscriptions/podcast-1" && init?.method === "DELETE") {
        return jsonResponse({ data: { ok: true } });
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

    expect((await screen.findAllByRole("button", { name: "Libraries" })).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Unsubscribe" }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(
        'Unsubscribe from "Systems Podcast"?\n\nThis will remove the podcast from 1 library.\n\nIt will remain in 1 shared library you cannot administer.'
      );
    });

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/podcasts/subscriptions/podcast-1" && init?.method === "DELETE";
        })
      ).toBe(true);
    });
  });

  it("shows episode library controls from the detail drawer", async () => {
    const user = userEvent.setup();
    mockViewportState.isMobile = true;
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
        return jsonResponse({ data: [buildEpisode(0)] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/podcast-1/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/media-0/libraries") {
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
              transcript_state: "ready",
              transcript_coverage: "full",
              required_minutes: 0,
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

    renderLatestPaneActions();
    await user.click(screen.getByRole("button", { name: "Episodes" }));

    const episodeDrawer = await screen.findByRole("dialog", { name: "Episodes" });
    expect(within(episodeDrawer).getByText("Episode 0")).toBeInTheDocument();
    expect(within(episodeDrawer).getByRole("button", { name: "Libraries" })).toBeVisible();
  });

  it("routes the empty subscriptions state to browse", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(PodcastsPage));

    const button = await screen.findByRole("button", { name: "Browse podcasts" });
    expect(button).toBeInTheDocument();

    await user.click(button);
    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/browse?types=podcasts");
  });
});
