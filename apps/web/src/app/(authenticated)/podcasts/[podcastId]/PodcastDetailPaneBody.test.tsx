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
      readonly menu?: {
        readonly kind: "ResourceMenu" | "FlatMenu";
        readonly actions?: typeof panePrimaryChromeState.options;
        readonly groups?: {
          readonly operations: typeof panePrimaryChromeState.options;
          readonly relationships: typeof panePrimaryChromeState.options;
          readonly view: typeof panePrimaryChromeState.options;
        };
      };
    }) => {
      panePrimaryChromeState.options =
        publication.menu?.kind === "FlatMenu"
          ? (publication.menu.actions ?? [])
          : publication.menu?.groups
            ? [
                ...publication.menu.groups.operations,
                ...publication.menu.groups.relationships,
                ...publication.menu.groups.view,
              ]
            : [];
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
import {
  LecternProvider,
  useLectern,
} from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

function LecternStatus() {
  return (
    <output aria-label="lectern status">{useLectern().resource.status}</output>
  );
}

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
          onActivateWorkspaceTarget={vi.fn(() => ({ kind: "Unchanged" as const, paneId: "pane-1" }))}
        >
          <LecternProvider>
            <GlobalPlayerProvider>
              <LibraryPlacementControllerProvider>
                <LecternStatus />
                <PodcastDetailPaneBody />
              </LibraryPlacementControllerProvider>
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
  id = "00000000-0000-4000-8000-000000000011",
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
  id = "00000000-0000-4000-8000-000000000111",
  title = "Episode 1",
  descriptionText = null,
  transcriptState = "ready",
  transcriptCoverage = "full",
  canRetryMetadata = false,
  canEditAuthors = false,
  audioPlayable = false,
  progressResettable = false,
  episodeState = "unplayed",
  listeningState = null,
}: {
  id?: string;
  title?: string;
  descriptionText?: string | null;
  transcriptState?: string;
  transcriptCoverage?: string;
  canRetryMetadata?: boolean;
  canEditAuthors?: boolean;
  audioPlayable?: boolean;
  progressResettable?: boolean;
  episodeState?: "unplayed" | "in_progress" | "played" | null;
  listeningState?: {
    position_ms: number;
    duration_ms: number | null;
    playback_speed: number;
    is_completed: boolean;
  } | null;
} = {}) {
  return {
    id,
    kind: "podcast_episode",
    title,
    canonical_source_url: {
      kind: "Present",
      value: "https://feeds.example.com/systems.xml",
    },
    processing_status: "ready_for_reading",
    transcript_state: transcriptState,
    transcript_coverage: transcriptCoverage,
    listening_state:
      listeningState === null
        ? { kind: "Absent" }
        : {
            kind: "Present",
            value: {
              position_ms: listeningState.position_ms,
              duration_ms:
                listeningState.duration_ms === null
                  ? { kind: "Absent" }
                  : {
                      kind: "Present",
                      value: listeningState.duration_ms,
                    },
              playback_speed: listeningState.playback_speed,
            },
          },
    episode_state: episodeState ?? "unplayed",
    progress_resettable: progressResettable,
    playerDescriptor: audioPlayable
      ? {
          kind: "Present",
          value: {
            kind: "FooterAudio",
            mediaId: id,
          },
        }
      : { kind: "Absent" },
    capabilities: {
      can_retry: false,
      can_refresh_source: false,
      can_retry_metadata: canRetryMetadata,
      can_edit_authors: canEditAuthors,
      can_delete: false,
    },
    contributors: [],
    author_mode: "automatic",
    published_date: { kind: "Absent" },
    duration_seconds: { kind: "Present", value: 60 },
    has_show_notes: descriptionText !== null,
  };
}

function episodePage(items: unknown[], nextCursor: unknown = { kind: "Absent" }) {
  return {
    data: {
      items,
      collectionRevision: 1,
      nextCursor,
    },
  };
}

describe("PodcastDetailPaneBody subscribe flow", () => {
  beforeEach(() => {
    panePrimaryChromeState.options = [];
    primaryChromeMock.publish.mockReset();
    shareControllerMock.openShare.mockReset();
    subscribeToPodcastMock.mockReset();
    subscribeToPodcastMock.mockResolvedValue({
      podcast_id: "00000000-0000-4000-8000-000000000011",
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
      paramName === "podcastId" ? "00000000-0000-4000-8000-000000000011" : null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends selected library_ids on subscribe", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([]));
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

    fireEvent.click(
      screen.getByRole("button", { name: "Libraries: No libraries selected" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(await screen.findByRole("option", { name: "Books" }));
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search or create a library" }),
      { key: "Escape" },
    );

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
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        detailCalls += 1;
        if (detailCalls === 2) return pendingDetail.promise;
        return jsonResponse(
          podcastDetailResponse({
            subscription: {
              podcast_id: "00000000-0000-4000-8000-000000000011",
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        episodeCalls += 1;
        if (episodeCalls === 2) return pendingEpisodes.promise;
        return jsonResponse(
          episodePage([
            episodeMedia({
              title:
                episodeCalls === 1
                  ? "Before refresh episode"
                  : "After refresh episode",
            }),
          ]),
        );
      }
      if (
        url.pathname ===
          "/api/podcasts/subscriptions/00000000-0000-4000-8000-000000000011/sync" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          data: {
            podcast_id: "00000000-0000-4000-8000-000000000011",
            sync_status: "pending",
            sync_error_code: null,
            sync_error_message: null,
            sync_attempts: 2,
            sync_enqueued: true,
            collectionRevision: 4,
            libraryEntriesCollectionRevision: 6,
          },
        });
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (
        url.pathname ===
        "/api/media/00000000-0000-4000-8000-000000000111"
      ) {
        return jsonResponse({
          data: { description_text: "Detailed show notes" },
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
    const href = "/podcasts/00000000-0000-4000-8000-000000000011";
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

    expect(
      await screen.findByRole("link", { name: "Before refresh episode" }),
    ).toBeVisible();
    await waitFor(() => expect(commands).toBeDefined());
    const refreshSync = panePrimaryChromeState.options.find(
      (option) => option.id === "ResourceOperation.Podcast.Refresh",
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
      await screen.findByRole("link", { name: "After refresh episode" }),
    ).toBeVisible();
    expect(detailCalls).toBe(3);
    expect(episodeCalls).toBe(3);
  });

  it("publishes a grouped resource target and leaves core ownership to PaneShell", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([episodeMedia()]));
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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

    expect(
      await screen.findByRole("link", { name: "Episode 1" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const publication = primaryChromeMock.publish.mock.calls.at(-1)?.[0] as
        | {
            menu?: {
              kind: string;
              target?: { ref: string };
              groups?: { core: Array<{ id: string }> };
            };
          }
        | undefined;
      expect(publication?.menu?.kind).toBe("ResourceMenu");
      expect(publication?.menu?.target?.ref).toBe(
        "podcast:00000000-0000-4000-8000-000000000011",
      );
      expect(publication?.menu?.groups?.core).toEqual([]);
    });
  });

  it("treats an unsubscribed detail row as unavailable for subscription operations", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(
          podcastDetailResponse({
            subscription: {
              podcast_id: "00000000-0000-4000-8000-000000000011",
              user_id: "user-1",
              status: "unsubscribed",
              default_playback_speed: null,
              auto_queue: false,
              sync_status: "complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_synced_at: null,
              updated_at: "2026-01-01T00:00:00Z",
            },
          }),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([]));
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    expect(
      await screen.findByRole("button", { name: "Subscribe" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        panePrimaryChromeState.options.map((option) => option.id),
      ).not.toEqual(
        expect.arrayContaining([
          "ResourceOperation.Podcast.Settings",
          "ResourceOperation.Podcast.Refresh",
          "RelationshipAction.Podcast.Unsubscribe",
        ]),
      );
    });
  });

  it("does not refetch podcast episodes when show notes expand", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(
          episodePage([
            episodeMedia({
              descriptionText: "Detailed show notes",
            }),
          ]),
        );
      }
      if (
        url.pathname ===
        "/api/media/00000000-0000-4000-8000-000000000111"
      ) {
        return jsonResponse({
          data: { description_text: "Detailed show notes" },
        });
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Show notes" }),
    );
    expect(await screen.findByText("Detailed show notes")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Episode 1" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide notes" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Detailed show notes")).not.toBeInTheDocument();
    });
    expect(
      calls.filter(
        (call) => call === "/api/podcasts/00000000-0000-4000-8000-000000000011",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter((call) =>
        call.startsWith(
          "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes",
        ),
      ),
    ).toHaveLength(1);
  });

  it("uses the returned completion handle for exact Mark as played Undo", async () => {
    const completionHandle =
      "ncc1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
    const commandBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([episodeMedia()]));
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (
        url.pathname === "/api/consumption/commands" &&
        init?.method === "POST"
      ) {
        const command = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        commandBodies.push(command);
        return jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            progressState: { kind: "Absent" },
            completionHandle:
              command.kind === "EnsureMediaFinished"
                ? { kind: "Present", value: completionHandle }
                : { kind: "Absent" },
            libraryEntriesCollectionRevision: 7,
          },
        });
      }
      if (url.pathname === "/api/lectern/commands" && init?.method === "POST") {
        commandBodies.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
        return jsonResponse({
          data: {
            outcome: {
              kind: "Placed",
              itemIds: ["aaaaaaaa-0000-4000-8000-000000000001"],
            },
            lectern: { items: [] },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    await screen.findByText("ready", {
      selector: '[aria-label="lectern status"]',
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark as played" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(commandBodies.map((command) => command.kind)).toEqual([
        "EnsureMediaFinished",
        "UndoCompletion",
        "PlaceItems",
      ]);
    });
    expect(commandBodies[1]).toMatchObject({
      kind: "UndoCompletion",
      completionHandle,
    });
  });

  it("resets an independently resettable episode to its canonical unplayed state", async () => {
    const mediaId = "00000000-0000-4000-8000-000000000111";
    const commandBodies: Array<Record<string, unknown>> = [];
    const confirmReset = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resetCommitted = false;
    let episodeRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        episodeRequests += 1;
        return jsonResponse(
          episodePage([
            episodeMedia({
              progressResettable: !resetCommitted,
              episodeState: resetCommitted ? "unplayed" : "in_progress",
              listeningState: {
                position_ms: resetCommitted ? 0 : 30_000,
                duration_ms: 60_000,
                playback_speed: 1.25,
                is_completed: false,
              },
            }),
          ]),
        );
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (
        url.pathname === "/api/consumption/commands" &&
        init?.method === "POST"
      ) {
        const command = JSON.parse(String(init.body)) as Record<string, unknown>;
        commandBodies.push(command);
        resetCommitted = true;
        return jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            progressState: {
              kind: "Present",
              value: {
                mediaId,
                readerCursor: { state: "Empty", revision: 1 },
                listeningState: {
                  kind: "Present",
                  value: {
                    positionMs: 0,
                    durationMs: { kind: "Present", value: 60_000 },
                    playbackSpeed: 1.25,
                    writeRevision: 1,
                    resetEpoch: 1,
                  },
                },
              },
            },
            completionHandle: { kind: "Absent" },
            libraryEntriesCollectionRevision: 8,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    await screen.findByRole("link", { name: "Episode 1" });
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Episode 1" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reset progress" }),
    );

    await waitFor(() => {
      expect(commandBodies).toEqual([
        expect.objectContaining({ kind: "ResetProgress", mediaId }),
      ]);
    });
    expect(confirmReset).toHaveBeenCalledWith(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.",
    );
    expect(await screen.findByText("Progress reset.")).toBeInTheDocument();

    await waitFor(() => expect(episodeRequests).toBe(2));
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Episode 1" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Reset progress" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: "Mark as played" }),
      ).toBeInTheDocument();
    });
  });

  it("re-enriches metadata from a capable episode row without consuming the server capability", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({ path: url.pathname, init });
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(
          episodePage([episodeMedia({ canRetryMetadata: true })]),
        );
      }
      if (
        url.pathname === "/api/media/00000000-0000-4000-8000-000000000111/retry"
      ) {
        return jsonResponse({ data: { accepted: true } });
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Re-enrich metadata",
      }),
    );

    await waitFor(() => {
      const retry = calls.find(
        (call) =>
          call.path === "/api/media/00000000-0000-4000-8000-000000000111/retry",
      );
      expect(retry?.init).toMatchObject({
        method: "POST",
        body: JSON.stringify({ from_stage: "metadata" }),
      });
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Re-enrich metadata" }),
    ).toBeInTheDocument();
  });

  it("keys episode busy state by action and derives Lectern Add from ready membership", async () => {
    const metadataResponse = deferredResponse();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(
          episodePage([episodeMedia({ canRetryMetadata: true })]),
        );
      }
      if (
        url.pathname === "/api/media/00000000-0000-4000-8000-000000000111/retry"
      ) {
        return metadataResponse.promise;
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Re-enrich metadata",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "More actions for Episode 1",
      }),
    );

    expect(
      await screen.findByRole("menuitem", { name: "Re-enriching..." }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Add to Lectern" }),
    ).not.toHaveAttribute("aria-disabled", "true");

    act(() => {
      metadataResponse.resolve(jsonResponse({ data: { accepted: true } }));
    });
    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: "Re-enrich metadata" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  it("opens the shared authors editor from a capable episode row", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(
          episodePage([episodeMedia({ canEditAuthors: true })]),
        );
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit authors…" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Edit authors" }),
    ).toBeVisible();
  });

  it("projects Remove from ready Lectern membership without a player descriptor", async () => {
    const itemId = "aaaaaaaa-0000-4000-8000-000000000001";
    const mediaId = "00000000-0000-4000-8000-000000000111";
    const commandBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([episodeMedia()]));
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (
        url.pathname === "/api/lectern" &&
        (init?.method ?? "GET") === "GET"
      ) {
        return jsonResponse({
          data: {
            items: [
              {
                itemId,
                mediaId,
                kind: "podcast_episode",
                title: "Episode 1",
                subtitle: { kind: "Absent" },
                href: `/media/${mediaId}`,
                consumption: {
                  state: "Unread",
                  progress: { kind: "Absent" },
                  progressResettable: false,
                },
                activation: {
                  kind: "FooterAudio",
                  streamUrl: "https://cdn.example.test/episode.mp3",
                  sourceUrl: "https://example.test/episode",
                  positionMs: 0,
                  writeRevision: 0,
                  resetEpoch: 0,
                  playbackSpeed: 1,
                  durationMs: { kind: "Present", value: 60_000 },
                  artworkUrl: { kind: "Absent" },
                  chapters: [],
                },
              },
            ],
          },
        });
      }
      if (url.pathname === "/api/lectern/commands" && init?.method === "POST") {
        commandBodies.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
        return jsonResponse({
          data: {
            outcome: { kind: "Removed", itemId },
            lectern: { items: [] },
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from Lectern" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Add to Lectern" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Lectern" }),
    );

    await waitFor(() =>
      expect(commandBodies).toEqual([
        expect.objectContaining({
          kind: "RemoveItem",
          itemId,
        }),
      ]),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Add to Lectern" }),
    ).toBeInTheDocument();
  });

  it("restores the captured episode controller without initial load overwriting it", async () => {
    const episodeRequests: Array<{
      cursor: string | null;
      sort: string | null;
    }> = [];
    let detailCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        detailCalls += 1;
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        const cursor = url.searchParams.get("cursor");
        episodeRequests.push({
          cursor,
          sort: url.searchParams.get("sort"),
        });
        return jsonResponse(
          episodePage(
            cursor === "page-2"
              ? [
                  episodeMedia({
                    id: "00000000-0000-4000-8000-000000000113",
                    title: "Restored Episode Second Page",
                  }),
                  episodeMedia({
                    id: "00000000-0000-4000-8000-000000000113",
                    title: "Restored Episode Second Page",
                  }),
                ]
              : Array.from({ length: 100 }, (_, index) =>
                  episodeMedia({
                    id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
                    title:
                      index === 0
                        ? "Restored Episode First"
                        : `Episode ${index + 1}`,
                  }),
                ),
            cursor === "page-2"
              ? { kind: "Absent" }
              : { kind: "Present", value: "page-2" },
          ),
        );
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
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
    let bodyGeneration = 0;
    let href = "/podcasts/00000000-0000-4000-8000-000000000011";
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
              key={`${resolvePaneRouteIdentity(href).routeKey}:${bodyGeneration}`}
            />
          </GlobalPlayerProvider>
        </LecternProvider>
      </PaneReturnJourneyHarness>
    );
    const view = render(journey());
    expect(
      await screen.findByRole("link", { name: "Restored Episode First" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", {
        name: "Restored Episode Second Page",
      }),
    ).toBeVisible();
    commands.capturePane({
      paneId: "pane-1",
      visitId: RETURN_JOURNEY_VISIT_ID,
      routeKey: resolvePaneRouteIdentity(
        "/podcasts/00000000-0000-4000-8000-000000000011",
      ).routeKey,
      modality: "Programmatic",
    });

    resourceGeneration += 1;
    bodyGeneration += 1;
    view.rerender(journey());

    expect(
      screen.getAllByRole("link", { name: "Restored Episode First" }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("link", { name: "Restored Episode Second Page" }),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(episodeRequests).toEqual([
        { cursor: null, sort: "newest" },
        { cursor: "page-2", sort: "newest" },
      ]);
      expect(detailCalls).toBe(1);
    });

    href =
      "/podcasts/00000000-0000-4000-8000-000000000011?state=all&sort=oldest";
    view.rerender(journey());

    await waitFor(() => {
      expect(episodeRequests).toEqual([
        { cursor: null, sort: "newest" },
        { cursor: "page-2", sort: "newest" },
        { cursor: null, sort: "oldest" },
        { cursor: "page-2", sort: "oldest" },
      ]);
      expect(detailCalls).toBe(2);
    });
  });

  it("commits the new query before continuing a partial episode chain", async () => {
    const oldContinuation = deferredResponse();
    const newFirstPage = deferredResponse();
    const requests: Array<{ cursor: string | null; sort: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        const request = {
          cursor: url.searchParams.get("cursor"),
          sort: url.searchParams.get("sort"),
        };
        requests.push(request);
        if (request.sort === "oldest") {
          return newFirstPage.promise;
        }
        if (request.cursor === "page-2") {
          return oldContinuation.promise;
        }
        return jsonResponse(
          episodePage(
            [episodeMedia()],
            { kind: "Present", value: "page-2" },
          ),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);
    expect(
      await screen.findByRole("link", { name: "Episode 1" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(requests).toContainEqual({
        cursor: "page-2",
        sort: "newest",
      }),
    );

    fireEvent.change(screen.getByLabelText("Episode sort"), {
      target: { value: "oldest" },
    });
    await waitFor(() =>
      expect(requests).toContainEqual({ cursor: null, sort: "oldest" }),
    );
    expect(requests).not.toContainEqual({
      cursor: "page-2",
      sort: "oldest",
    });

    newFirstPage.resolve(jsonResponse(episodePage([])));
  });

  it("ignores older podcast loads that resolve after a newer route load", async () => {
    let currentPodcastId = "00000000-0000-4000-8000-000000000011";
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? currentPodcastId : null,
    );
    const oldDetail = deferredResponse();
    const oldEpisodes = deferredResponse();
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return oldDetail.promise;
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return oldEpisodes.promise;
      }
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000022"
      ) {
        return jsonResponse(
          podcastDetailResponse({
            id: "00000000-0000-4000-8000-000000000022",
            title: "Current Podcast",
          }),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000022/episodes"
      ) {
        return jsonResponse(
          episodePage([
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000112",
              title: "Current Episode",
            }),
          ]),
        );
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    const { rerender } = render(<Wrapped />);
    await waitFor(() => {
      expect(calls).toContain(
        "/api/podcasts/00000000-0000-4000-8000-000000000011",
      );
    });

    currentPodcastId = "00000000-0000-4000-8000-000000000022";
    rerender(<Wrapped />);

    expect(
      await screen.findByRole("link", { name: "Current Episode" }),
    ).toBeInTheDocument();

    await act(async () => {
      oldDetail.resolve(jsonResponse(podcastDetailResponse()));
      oldEpisodes.resolve(
        jsonResponse(
          episodePage([
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000099",
              title: "Old Episode",
            }),
          ]),
        ),
      );
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: "Old Episode" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("link", { name: "Current Episode" }),
    ).toBeInTheDocument();
  });

  it("does not forecast transcripts eagerly while the episode query changes", async () => {
    let forecastCalls = 0;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(
          episodePage([
            episodeMedia({
              transcriptState: "not_requested",
              transcriptCoverage: "none",
            }),
          ]),
        );
      }
      if (url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/transcript/forecasts") {
        forecastCalls += 1;
        return jsonResponse({
          data: {
            eligibleCount: 1,
            requiredMinutes: 1,
            remainingMinutes: { kind: "Present", value: 100 },
            fitsBudget: true,
            selectionFingerprint: "a".repeat(64),
          },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    expect(forecastCalls).toBe(0);
    fireEvent.change(screen.getByLabelText("Episode sort"), {
      target: { value: "oldest" },
    });
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.includes(
              "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes?",
            ) && call.includes("sort=oldest"),
        ),
      ).toBe(true);
    });
    expect(forecastCalls).toBe(0);
  });

  it("does not derive the query-wide transcript command from rendered rows", async () => {
    const continuation = deferredResponse();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse());
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        if (url.searchParams.has("cursor")) {
          return continuation.promise.then((response) => response.clone());
        }
        return jsonResponse(
          episodePage(
            [episodeMedia({ transcriptState: "ready" })],
            { kind: "Present", value: "next-episodes" },
          ),
        );
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);
    expect(
      await screen.findByRole("link", { name: "Episode 1" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Episode actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Transcribe all episodes" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Mark all episodes as played",
      }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Unplayed" }));
    expect(
      screen.getByRole("menuitem", {
        name: "Transcribe matching episodes",
      }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Mark matching episodes as played",
      }),
    ).not.toBeDisabled();

    await act(async () => {
      continuation.resolve(
        jsonResponse(
          episodePage([
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000112",
              title: "Needs transcript",
              transcriptState: "not_requested",
              transcriptCoverage: "none",
            }),
          ]),
        ),
      );
      await continuation.promise;
    });
  });
});
