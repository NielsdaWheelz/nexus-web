import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import PodcastsPage from "./page";
import PodcastDetailPage from "./[podcastId]/page";
import ActionMenu from "@/components/ui/ActionMenu";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

const mockUsePaneParam = vi.fn<(param: string) => string | null>();
const mockPush = vi.fn<(href: string) => void>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockViewportState = { isMobile: false };
const mockLibraryMembershipPanel = vi.fn(
  (props: {
    open?: boolean;
    loading?: boolean;
    libraries?: Array<{ id: string; name: string; isInLibrary: boolean }>;
    onClose?: () => void;
    onAddToLibrary?: (libraryId: string) => void;
    onRemoveFromLibrary?: (libraryId: string) => void;
  }) => {
    if (!props.open) {
      return null;
    }
    return (
      <div role="dialog" aria-label="Libraries">
        {props.loading ? <div>Loading libraries...</div> : null}
        {(props.libraries ?? []).map((library) => (
          <button
            key={library.id}
            type="button"
            onClick={() =>
              library.isInLibrary
                ? props.onRemoveFromLibrary?.(library.id)
                : props.onAddToLibrary?.(library.id)
            }
          >
            {library.name}
          </button>
        ))}
        <button type="button" onClick={() => props.onClose?.()}>
          Close
        </button>
      </div>
    );
  }
);

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
  requestOpenInAppPane: () => false,
}));

vi.mock("@/lib/panes/paneRouteRegistry", () => ({
  resolvePaneRoute: () => null,
  getParentHref: () => null,
  DEFAULT_LINKED_ITEMS_PANE_WIDTH_PX: 360,
  DEFAULT_HIGHLIGHTS_PANE_WIDTH_PX: 360,
}));

vi.mock("@/components/LibraryMembershipPanel", () => ({
  default: (props: Parameters<typeof mockLibraryMembershipPanel>[0]) =>
    mockLibraryMembershipPanel(props),
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
    latest_episode_published_at: "2026-03-05T00:00:00Z",
    visible_libraries: [],
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

function renderLatestPaneOptionsMenu() {
  const options = getLatestPaneOptions();
  if (options.length === 0) {
    throw new Error("Expected pane options override to be present");
  }
  return render(<ActionMenu label="Options" options={options as never} />);
}

function getLatestPaneOptions() {
  const options = getLatestChromeOverride().options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options as Array<{
    id: string;
    label: string;
    tone?: "default" | "danger";
    disabled?: boolean;
    onSelect?: (context?: { triggerEl?: HTMLElement | null }) => void;
  }>;
}

describe("podcast ui cutover", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockPush.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockLibraryMembershipPanel.mockClear();
    mockViewportState.isMobile = false;
    vi.restoreAllMocks();
  });

  it("shows a subscribe CTA for readable-but-unsubscribed podcast detail", async () => {
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

    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscribe + library" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "RSS feed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).not.toBeInTheDocument();

    renderLatestPaneActions();
    await user.click(screen.getByRole("button", { name: "Episodes" }));

    const episodeDrawer = await screen.findByRole("dialog", { name: "Episodes" });
    expect(within(episodeDrawer).getByText("Episode 0")).toBeInTheDocument();
  });

  it("moves subscription library membership behind a Libraries menu item and removes category controls from subscriptions", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, _init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/podcasts/subscriptions" && (_init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [buildSubscriptionRow()] });
      }
      if (url.pathname === "/api/podcasts/podcast-0/libraries" && (_init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "library-sports",
              name: "Sports",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(PodcastsPage));

    expect(await screen.findByText("Systems Podcast 0")).toBeInTheDocument();
    expect(screen.queryByLabelText("Subscription category")).not.toBeInTheDocument();
    expect(screen.queryByText("New category")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Libraries" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Libraries…" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh sync" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unsubscribe" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Libraries…" }));
    const librariesDialog = await screen.findByRole("dialog", { name: "Libraries" });
    expect(await within(librariesDialog).findByRole("button", { name: /Sports/i })).toBeInTheDocument();
  });

  it("keeps queue controls inline and exposes episode library controls in the drawer", async () => {
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
      if (url.pathname === "/api/podcasts/podcast-1/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/media-0/libraries") {
        return jsonResponse({
          data: [
            {
              id: "library-sports",
              name: "Sports",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
            {
              id: "library-history",
              name: "History",
              color: null,
              is_in_library: true,
              can_add: false,
              can_remove: true,
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

    expect(await screen.findByRole("heading", { name: "Systems Podcast" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Libraries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).not.toBeInTheDocument();
    expect(getLatestPaneOptions().map((option) => option.label)).toEqual([
      "Libraries…",
      "Settings",
      "Refresh sync",
      "Unsubscribe",
    ]);

    const view = renderLatestPaneOptionsMenu();
    await user.click(screen.getByRole("button", { name: "Options" }));
    expect(await screen.findByRole("menuitem", { name: "Libraries…" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Libraries…" }));
    expect(await screen.findByRole("dialog", { name: "Libraries" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    view.unmount();

    renderLatestPaneActions();
    await user.click(screen.getByRole("button", { name: "Episodes" }));

    const episodeDrawer = await screen.findByRole("dialog", { name: "Episodes" });
    expect(within(episodeDrawer).getByText("Episode 0")).toBeInTheDocument();
    expect(within(episodeDrawer).getByRole("button", { name: "Play next for Episode 0" })).toBeVisible();
    expect(
      within(episodeDrawer).getByRole("button", { name: "Add Episode 0 to queue" })
    ).toBeVisible();
    expect(within(episodeDrawer).queryByRole("button", { name: "Libraries" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Subscription category")).not.toBeInTheDocument();

    await user.click(within(episodeDrawer).getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Libraries…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Mark as played" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Libraries…" }));
    const librariesDialog = await screen.findByRole("dialog", { name: "Libraries" });
    expect(within(librariesDialog).getByRole("button", { name: "Sports" })).toBeInTheDocument();
    expect(within(librariesDialog).getByRole("button", { name: "History" })).toBeInTheDocument();
  });

});
