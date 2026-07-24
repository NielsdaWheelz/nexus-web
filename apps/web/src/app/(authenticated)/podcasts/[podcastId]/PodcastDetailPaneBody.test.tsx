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
const panePrimaryChromeState = vi.hoisted(() => ({
  options: [] as Array<{
    readonly id: string;
    readonly kind: string;
    readonly onSelect?: (detail: {
      readonly triggerEl: HTMLButtonElement | null;
    }) => void;
  }>,
}));
const primaryChromeMock = vi.hoisted(() => ({
  publish: vi.fn(),
}));
const shareControllerMock = vi.hoisted(() => ({
  openShare: vi.fn(),
}));

vi.mock("@/components/workspace/PanePrimaryChrome", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/workspace/PanePrimaryChrome")
  >("@/components/workspace/PanePrimaryChrome");
  return {
    ...actual,
    usePanePrimaryChrome: (publication: {
      readonly options?: typeof panePrimaryChromeState.options;
    }) => {
      panePrimaryChromeState.options = publication.options ?? [];
      primaryChromeMock.publish(publication);
    },
  };
});

vi.mock("@/lib/sharing/controller", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/sharing/controller")
  >("@/lib/sharing/controller");
  return {
    ...actual,
    useShareController: () => shareControllerMock,
  };
});

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
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

// Render the pane under the real Lectern + global-player providers (the pane
// reads both via useLectern()/useGlobalPlayer()). The fetch boundary below
// answers the provider's initial GET /api/lectern.
function Wrapped() {
  const podcastId = mockUsePaneParam("podcastId");
  const href = podcastId ? `/podcasts/${podcastId}` : "/podcasts/missing";
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <PaneRuntimeProvider
          paneId="pane-1"
          visitId={TEST_VISIT_ID}
          isActive
          href={href}
          routeId="podcastDetail"
          routeKey={routeKey}
          pathParams={podcastId ? { podcastId } : {}}
          canGoBack={false}
          canGoForward={false}
          onGoBackPane={vi.fn()}
          onGoForwardPane={vi.fn()}
          onNavigatePane={vi.fn()}
          onReplacePane={vi.fn()}
          onOpenInNewPane={vi.fn()}
        >
          <LecternProvider>
            <GlobalPlayerProvider>
              <PodcastDetailPaneBody />
            </GlobalPlayerProvider>
          </LecternProvider>
        </PaneRuntimeProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
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
    panePrimaryChromeState.options = [];
    primaryChromeMock.publish.mockReset();
    shareControllerMock.openShare.mockReset();
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

  it("does not recapture sync-patched detail while refresh reconciliation is pending", async () => {
    const pendingDetail = deferredResponse();
    const pendingEpisodes = deferredResponse();
    let detailCalls = 0;
    let episodeCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        detailCalls += 1;
        if (detailCalls === 2) return pendingDetail.promise;
        return jsonResponse(
          podcastDetailResponse({
            subscription: {
              podcast_id: "podcast-1",
              user_id: "user-1",
              status: "active",
              default_playback_speed: null,
              auto_queue: false,
              sync_status: detailCalls === 1 ? "complete" : "pending",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: detailCalls,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-01-01T00:00:00Z",
            },
            title:
              detailCalls === 1
                ? "Before refresh"
                : "After refresh reconciliation",
          }),
        );
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        episodeCalls += 1;
        if (episodeCalls === 2) return pendingEpisodes.promise;
        return jsonResponse({
          data: [
            episodeMedia({
              title:
                episodeCalls === 1
                  ? "Before refresh episode"
                  : "After refresh episode",
            }),
          ],
        });
      }
      if (
        url.pathname === "/api/podcasts/subscriptions/podcast-1/sync" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          data: {
            podcast_id: "podcast-1",
            sync_status: "pending",
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 2,
            sync_enqueued: true,
          },
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
    let commands!: PaneReturnMementoCommands;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    let resourceGeneration = 0;
    const href = "/podcasts/podcast-1";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = () => (
      <PaneReturnJourneyHarness
        href={href}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publish}
      >
        <LecternProvider>
          <GlobalPlayerProvider>
            <PodcastDetailPaneBody />
          </GlobalPlayerProvider>
        </LecternProvider>
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());

    expect(await screen.findByText("Before refresh episode")).toBeVisible();
    await waitFor(() => expect(commands).toBeDefined());
    const refreshSync = panePrimaryChromeState.options.find(
      (option) => option.id === "refresh-podcast-sync",
    );
    expect(refreshSync?.kind).toBe("command");
    refreshSync?.onSelect?.({ triggerEl: null });
    await waitFor(() => {
      expect(detailCalls).toBe(2);
      expect(episodeCalls).toBe(2);
    });
    commands.capturePane({
      paneId: "pane-1",
      visitId: RETURN_JOURNEY_VISIT_ID,
      routeKey,
      modality: "Programmatic",
    });

    resourceGeneration += 1;
    view.rerender(journey());

    expect(
      await screen.findByText("After refresh episode"),
    ).toBeVisible();
    expect(detailCalls).toBe(3);
    expect(episodeCalls).toBe(3);
  });

  it("leaves pane-level Share ownership to PaneShell", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        return jsonResponse(podcastDetailResponse());
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        return jsonResponse({ data: [episodeMedia()] });
      }
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
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

    expect(await screen.findByText("Episode 1")).toBeInTheDocument();
    await waitFor(() => {
      const publication = primaryChromeMock.publish.mock.calls.at(-1)?.[0] as
        | { options?: Array<{ id: string }> }
        | undefined;
      expect(
        publication?.options?.filter((option) => option.id === "share") ?? [],
      ).toHaveLength(0);
    });
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

  it("restores the captured episode controller without initial load overwriting it", async () => {
    const episodeRequests: Array<{
      offset: string;
      sort: string | null;
    }> = [];
    let detailCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/podcasts/podcast-1") {
        detailCalls += 1;
        return jsonResponse(podcastDetailResponse());
      }
      if (url.pathname === "/api/podcasts/podcast-1/episodes") {
        const offset = url.searchParams.get("offset") ?? "0";
        episodeRequests.push({
          offset,
          sort: url.searchParams.get("sort"),
        });
        return jsonResponse({
          data:
            offset === "100"
              ? [
                  episodeMedia({
                    id: "episode-101",
                    title: "Restored Episode Second Page",
                  }),
                ]
              : Array.from({ length: 100 }, (_, index) =>
                  episodeMedia({
                    id: `episode-${index + 1}`,
                    title:
                      index === 0
                        ? "Restored Episode First"
                        : `Episode ${index + 1}`,
                  }),
                ),
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
    let commands!: PaneReturnMementoCommands;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    let resourceGeneration = 0;
    let href = "/podcasts/podcast-1";
    const journey = () => (
      <PaneReturnJourneyHarness
        href={href}
        paneId="pane-1"
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publish}
      >
        <LecternProvider>
          <GlobalPlayerProvider>
            <PodcastDetailPaneBody
              key={resolvePaneRouteIdentity(href).routeKey}
            />
          </GlobalPlayerProvider>
        </LecternProvider>
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(await screen.findByText("Restored Episode First")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more episodes" }),
    );
    expect(
      await screen.findByText("Restored Episode Second Page"),
    ).toBeVisible();
    commands.capturePane({
      paneId: "pane-1",
      visitId: RETURN_JOURNEY_VISIT_ID,
      routeKey: resolvePaneRouteIdentity("/podcasts/podcast-1").routeKey,
      modality: "Programmatic",
    });

    resourceGeneration += 1;
    view.rerender(journey());

    expect(screen.getAllByText("Restored Episode First")).toHaveLength(1);
    expect(
      screen.getAllByText("Restored Episode Second Page"),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(episodeRequests).toEqual([
        { offset: "0", sort: "newest" },
        { offset: "100", sort: "newest" },
      ]);
      expect(detailCalls).toBe(1);
    });

    href = "/podcasts/podcast-1?state=all&sort=oldest";
    view.rerender(journey());

    await waitFor(() => {
      expect(episodeRequests).toEqual([
        { offset: "0", sort: "newest" },
        { offset: "100", sort: "newest" },
        { offset: "0", sort: "oldest" },
      ]);
      expect(detailCalls).toBe(2);
    });
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
