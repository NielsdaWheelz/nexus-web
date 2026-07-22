import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const subscribeToPodcastMock = vi.fn();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRuntime: () => ({ openInNewPane: vi.fn() }),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneLabel: () => {},
}));

vi.mock("@/components/workspace/PanePrimaryChrome", () => ({
  usePanePrimaryChrome: () => {},
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
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";

// Render the pane under the real Lectern + global-player providers (the pane
// reads both via useLectern()/useGlobalPlayer()). The fetch boundary below
// answers the provider's initial GET /api/lectern.
function Wrapped() {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <PodcastDetailPaneBody />
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function podcastDetailResponse({
  id = "podcast-1",
  title = "Systems Podcast",
  subscription = null,
}: {
  id?: string;
  title?: string;
  subscription?: unknown;
} = {}) {
  return {
    data: {
      podcast: {
        id,
        provider: "podcast_index",
        provider_podcast_id: `provider-${id}`,
        title,
        contributors: [],
        feed_url: "https://feeds.example.com/systems.xml",
        website_url: null,
        image_url: null,
        description: "Systems thinking show",
        created_at: "2026-03-06T00:00:00Z",
        updated_at: "2026-03-06T00:00:00Z",
      },
      subscription,
    },
  };
}

function episodeMedia({
  id = "episode-1",
  title = "Episode 1",
  descriptionText = null,
  transcriptState = "ready",
  transcriptCoverage = "full",
}: {
  id?: string;
  title?: string;
  descriptionText?: string | null;
  transcriptState?: string;
  transcriptCoverage?: string;
} = {}) {
  return {
    id,
    kind: "podcast_episode",
    title,
    canonical_source_url: "https://feeds.example.com/systems.xml",
    processing_status: "ready_for_reading",
    transcript_state: transcriptState,
    transcript_coverage: transcriptCoverage,
    listening_state: null,
    subscription_default_playback_speed: null,
    episode_state: "unplayed",
    failure_stage: null,
    last_error_code: null,
    playback_source: null,
    playerDescriptor: { kind: "Absent" },
    capabilities: {
      can_read: true,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: true,
      can_download_file: false,
    },
    contributors: [],
    published_date: null,
    publisher: null,
    language: null,
    description: descriptionText,
    description_html: null,
    description_text: descriptionText,
    created_at: "2026-03-06T00:00:00Z",
    updated_at: "2026-03-06T00:00:00Z",
  };
}

function transcriptForecast(mediaId = "episode-1") {
  return {
    media_id: mediaId,
    processing_status: "ready_for_reading",
    transcript_state: "not_requested",
    transcript_coverage: "none",
    required_minutes: 1,
    remaining_minutes: 100,
    fits_budget: true,
    request_enqueued: false,
  };
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
        return jsonResponse(podcastDetailResponse());
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [
            {
              id: "lib-research",
              name: "Research",
              color: "#0ea5e9",
              created_at: "2026-03-06T00:00:00Z",
              updated_at: "2026-03-06T00:00:00Z",
            },
            {
              id: "lib-books",
              name: "Books",
              color: "#22c55e",
              created_at: "2026-03-06T00:00:00Z",
              updated_at: "2026-03-06T00:00:00Z",
            },
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    const subscribeButton = await screen.findByRole("button", {
      name: "Subscribe",
    });
    expect(subscribeButton).toBeInTheDocument();

    const picker = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(await screen.findByRole("option", { name: "Books" }));
    fireEvent.keyDown(picker, { key: "Escape" });

    fireEvent.click(subscribeButton);

    await waitFor(() => {
      expect(subscribeToPodcastMock).toHaveBeenCalledTimes(1);
    });

    const payload = subscribeToPodcastMock.mock.calls[0][0] as {
      library_ids: string[];
    };
    expect(payload.library_ids).toEqual(["lib-research", "lib-books"]);
  });

  it("does not refetch podcast episodes when show notes expand", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse(podcastDetailResponse());
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({
          data: [
            episodeMedia({
              descriptionText: "Detailed show notes",
            }),
          ],
        });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show notes" }));
    expect(await screen.findByText("Detailed show notes")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Episode 1" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide notes" }));

    await waitFor(() => {
      expect(screen.queryByText("Detailed show notes")).not.toBeInTheDocument();
    });
    expect(calls.filter((call) => call === "/api/podcasts/podcast-1")).toHaveLength(
      1,
    );
    expect(
      calls.filter((call) =>
        call.startsWith("/api/podcasts/podcast-1/episodes"),
      ),
    ).toHaveLength(1);
  });

  it("ignores older podcast loads that resolve after a newer route load", async () => {
    let currentPodcastId = "podcast-1";
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? currentPodcastId : null,
    );
    const oldDetail = deferredResponse();
    const oldEpisodes = deferredResponse();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/podcasts/podcast-1") {
        return oldDetail.promise;
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return oldEpisodes.promise;
      }
      if (url.pathname === "/api/podcasts/podcast-2") {
        return jsonResponse(
          podcastDetailResponse({ id: "podcast-2", title: "Current Podcast" }),
        );
      }
      if (url.pathname === "/api/podcasts/podcast-2/episodes") {
        return jsonResponse({
          data: [episodeMedia({ id: "episode-2", title: "Current Episode" })],
        });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    const { rerender } = render(<Wrapped />);
    await waitFor(() => {
      expect(calls).toContain("/api/podcasts/podcast-1");
    });

    currentPodcastId = "podcast-2";
    rerender(<Wrapped />);

    expect(await screen.findByText("Current Episode")).toBeInTheDocument();

    await act(async () => {
      oldDetail.resolve(jsonResponse(podcastDetailResponse()));
      oldEpisodes.resolve(
        jsonResponse({
          data: [episodeMedia({ id: "episode-old", title: "Old Episode" })],
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Old Episode")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Current Episode")).toBeInTheDocument();
  });

  it("keeps transcript forecast reservations until the POST settles", async () => {
    const firstForecast = deferredResponse();
    let forecastCalls = 0;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse(podcastDetailResponse());
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({
          data: [
            episodeMedia({
              transcriptState: "not_requested",
              transcriptCoverage: "none",
            }),
          ],
        });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        forecastCalls += 1;
        if (forecastCalls === 1) {
          return firstForecast.promise;
        }
        return jsonResponse({ data: [transcriptForecast()] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    await waitFor(() => {
      expect(forecastCalls).toBe(1);
    });
    fireEvent.change(screen.getByLabelText("Episode sort"), {
      target: { value: "oldest" },
    });
    await waitFor(() => {
      expect(
        calls.some((call) =>
          call.includes("/api/podcasts/podcast-1/episodes?") &&
          call.includes("sort=oldest"),
        ),
      ).toBe(true);
    });
    expect(forecastCalls).toBe(1);

    await act(async () => {
      firstForecast.resolve(jsonResponse({ data: [transcriptForecast()] }));
    });
    await waitFor(() => {
      expect(forecastCalls).toBe(2);
    });
  });
});
