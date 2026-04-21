import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import PodcastDetailPaneBody from "./PodcastDetailPaneBody";
import ActionMenu from "@/components/ui/ActionMenu";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockViewportState = { isMobile: false };
const mockRequestOpenInAppPane = vi.fn();
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

vi.mock("@/lib/panes/openInAppPane", () => ({
  requestOpenInAppPane: (...args: unknown[]) => mockRequestOpenInAppPane(...args),
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

function buildEpisode(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe("PodcastDetailPaneBody", () => {
  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockRequestOpenInAppPane.mockReset();
    mockRequestOpenInAppPane.mockReturnValue(false);
    mockLibraryMembershipPanel.mockClear();
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
        return jsonResponse({
          data: [
            buildEpisode({
              authors: [
                { id: "author-1", name: "Host One", role: "host" },
                { id: "author-2", name: "Host Two", role: null },
              ],
            }),
          ],
        });
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
    expect(screen.getByText(/Host One \+1/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Systems Podcast" })).toBeInTheDocument();
    const episodesAside = screen.getByRole("complementary", { name: "Episodes" });
    expect(within(episodesAside).getByRole("heading", { name: "Episodes" })).toBeInTheDocument();
    expect(within(episodesAside).getByText("Episode 0")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Episodes" })).not.toBeInTheDocument();
  });

  it("uses a compact media pane title hint when opening an episode in a new pane", async () => {
    mockRequestOpenInAppPane.mockReturnValue(true);
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
        return jsonResponse({
          data: [
            buildEpisode({
              authors: [
                { id: "author-1", name: "Host One", role: "host" },
                { id: "author-2", name: "Host Two", role: null },
              ],
            }),
          ],
        });
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

    const episodeLink = await screen.findByRole("link", { name: /Episode 0/i });
    fireEvent.click(episodeLink, { button: 0, shiftKey: true });

    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/media/media-0", {
      titleHint: "Episode 0 · Host One +1",
      resourceRef: "media:media-0",
    });
  });

  it("moves subscribed show secondary actions into pane chrome options", async () => {
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
        return jsonResponse({ data: [buildEpisode()] });
      }
      if (url.pathname === "/api/podcasts/podcast-1/libraries") {
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
      if (url.pathname === "/api/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<PodcastDetailPaneBody />);

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

    const optionsView = renderLatestPaneOptionsMenu();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Libraries…" }));
    const librariesDialog = await screen.findByRole("dialog", { name: "Libraries" });
    expect(within(librariesDialog).getByRole("button", { name: "Sports" })).toBeInTheDocument();
    optionsView.unmount();
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
