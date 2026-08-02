import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
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

vi.mock("@/components/connections/ConnectionsSurface", () => ({
  default: () => null,
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

vi.mock("@/lib/podcasts/acquisition", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/podcasts/acquisition")
  >("@/lib/podcasts/acquisition");
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
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { OfflineMediaCommand } from "@/lib/offlineMedia/contract";
import type { OfflineMediaTransport } from "@/lib/offlineMedia/transport";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const REFRESH_RUN_HANDLE =
  "prr1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

function LecternStatus() {
  return (
    <output aria-label="lectern status">{useLectern().resource.status}</output>
  );
}

class OfflineHandshakeTransport implements OfflineMediaTransport {
  readonly commands: OfflineMediaCommand[] = [];
  private listener: ((message: unknown) => void) | null = null;

  constructor(
    private readonly connectOutcome: Record<string, unknown> | null,
  ) {}

  start = (listener: (message: unknown) => void) => {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  };

  send = (command: OfflineMediaCommand) => {
    this.commands.push(command);
    if (command.kind === "Connect" && this.connectOutcome !== null) {
      queueMicrotask(() => {
        this.listener?.({
          requestId: command.requestId,
          protocolVersion: 1,
          outcome: this.connectOutcome,
        });
      });
    }
  };
}

// Render the pane under the real Lectern + global-player providers (the pane
// reads both through the Lectern and player providers. The fetch boundary below
// answers the provider's initial GET /api/lectern.
function Wrapped({
  href: hrefOverride,
  onReplacePane = vi.fn(),
  offlineTransport,
}: {
  readonly href?: string;
  readonly onReplacePane?: ComponentProps<
    typeof PaneRuntimeProvider
  >["onReplacePane"];
  readonly offlineTransport?: OfflineMediaTransport;
} = {}) {
  const podcastId = mockUsePaneParam("podcastId");
  const href =
    hrefOverride ??
    (podcastId ? `/podcasts/${podcastId}` : "/podcasts/missing");
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  const pane = (
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
      onReplacePane={onReplacePane}
      onActivateWorkspaceTarget={vi.fn(() => ({
        kind: "Unchanged" as const,
        paneId: "pane-1",
      }))}
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
  );
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        {offlineTransport === undefined ? (
          pane
        ) : (
          <OfflineMediaProvider
            accountId="11111111-1111-4111-8111-111111111111"
            transport={offlineTransport}
          >
            {pane}
          </OfflineMediaProvider>
        )}
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

function publishedEpisodeFilterRows() {
  const publication = primaryChromeMock.publish.mock.lastCall?.[0] as
    PanePrimaryChromePublication | undefined;
  if (publication?.search?.kind !== "FilterRows") {
    throw new Error("Podcast detail did not publish FilterRows");
  }
  return publication.search;
}

function publishedPaneRefresh() {
  const publication = primaryChromeMock.publish.mock.lastCall?.[0] as
    PanePrimaryChromePublication | undefined;
  if (!publication?.refresh) {
    throw new Error("Podcast detail did not publish Pane Refresh");
  }
  return publication.refresh;
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
  const normalizedSubscription =
    typeof subscription === "object" &&
    subscription !== null &&
    !Array.isArray(subscription)
      ? {
          backfill: {
            id: "00000000-0000-4000-8000-000000000099",
            state: "Complete",
            processed_count: 24,
            added_count: 20,
          },
          ...subscription,
        }
      : subscription;
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
      subscription: normalizedSubscription,
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
  contributors = [],
  audioPlayable = false,
  offlineDownloadEligible = true,
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
  contributors?: unknown[];
  audioPlayable?: boolean;
  offlineDownloadEligible?: boolean;
  progressResettable?: boolean;
  episodeState?: "unplayed" | "in_progress" | "played" | null;
  listeningState?: {
    position_ms: number;
    duration_ms: number | null;
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
    offline_download_eligible: offlineDownloadEligible,
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
    contributors,
    author_mode: "automatic",
    published_date: { kind: "Absent" },
    duration_seconds: { kind: "Present", value: 60 },
    has_show_notes: descriptionText !== null,
  };
}

function episodePage(
  items: unknown[],
  nextCursor: unknown = { kind: "Absent" },
) {
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
      href: "/podcasts/00000000-0000-4000-8000-000000000011",
    });
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "podcastId" ? "00000000-0000-4000-8000-000000000011" : null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("canonicalizes legacy and unknown episode URL params on mount", async () => {
    const onReplacePane = vi.fn();
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

    render(
      <Wrapped
        href="/podcasts/00000000-0000-4000-8000-000000000011?q=legacy&state=played&unknown=value&sort=oldest"
        onReplacePane={onReplacePane}
      />,
    );

    await waitFor(() => {
      expect(onReplacePane).toHaveBeenCalledWith(
        "pane-1",
        "/podcasts/00000000-0000-4000-8000-000000000011?state=played&sort=oldest",
        { modality: "Programmatic" },
      );
    });
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
      screen.getByRole("button", { name: "Also add to Libraries" }),
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
      namedLibraryIds: string[];
      target: unknown;
    };
    expect(payload.namedLibraryIds).toEqual(["lib-research", "lib-books"]);
    expect(payload.target).toEqual({
      kind: "Canonical",
      podcastId: "00000000-0000-4000-8000-000000000011",
    });
  });

  it("shows canonical backfill counters and offers Failed-only Retry backlog", async () => {
    const retryRequests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(
          podcastDetailResponse({
            subscription: {
              podcast_id: "00000000-0000-4000-8000-000000000011",
              user_id: "user-1",
              default_playback_speed: { kind: "Absent" },
              pause_shortening_mode: { kind: "Absent" },
              auto_queue: false,
              sync_status: "Complete",
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: null,
              sync_completed_at: null,
              last_checked_at: null,
              updated_at: "2026-01-01T00:00:00Z",
              backfill: {
                id: "00000000-0000-4000-8000-000000000099",
                state: "Failed",
                processed_count: 12,
                added_count: 9,
              },
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
        return jsonResponse({ data: [] });
      }
      if (
        url.pathname ===
        "/api/podcasts/subscriptions/00000000-0000-4000-8000-000000000011/backfill/retry"
      ) {
        retryRequests.push(init ?? {});
        return jsonResponse({
          data: {
            podcastId: "00000000-0000-4000-8000-000000000011",
            outcome: "Retried",
            backfill: {
              id: "00000000-0000-4000-8000-000000000100",
              state: "Pending",
              processedCount: 0,
              addedCount: 0,
            },
          },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);

    expect(
      await screen.findByText("Backfill failed · 12 processed · 9 added"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry backlog" }));

    expect(
      await screen.findByText("Backfill pending · 0 processed · 0 added"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry backlog" }),
    ).not.toBeInTheDocument();
    expect(retryRequests).toHaveLength(1);
    expect(
      new Headers(retryRequests[0]!.headers).get("Idempotency-Key"),
    ).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("retains committed detail until Pane Refresh installs its exact detail and episode generation", async () => {
    const pendingDetail = deferredResponse();
    const pendingEpisodes = deferredResponse();
    let detailCalls = 0;
    let episodeCalls = 0;
    const subscription = {
      podcast_id: "00000000-0000-4000-8000-000000000011",
      user_id: "user-1",
      default_playback_speed: { kind: "Absent" },
      pause_shortening_mode: { kind: "Absent" },
      auto_queue: false,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 1,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-01-01T00:00:00Z",
    };
    let refreshRequestBody: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/refresh-runs" &&
        init?.method === "POST"
      ) {
        refreshRequestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            data: {
              refreshRunHandle: REFRESH_RUN_HANDLE,
              status: "Complete",
              requestedCount: 1,
            },
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (
        url.pathname ===
        `/api/podcasts/refresh-runs/${REFRESH_RUN_HANDLE}`
      ) {
        return jsonResponse({
          data: {
            refreshRunHandle: REFRESH_RUN_HANDLE,
            status: "Complete",
            requestedCount: 1,
            finishedCount: 1,
            succeededCount: 1,
            sourceLimitedCount: 0,
            failedCount: 0,
            skippedCount: 0,
            newEpisodeCount: 0,
            startedAt: "2026-07-30T12:00:00Z",
            completedAt: {
              kind: "Present",
              value: "2026-07-30T12:00:01Z",
            },
          },
        });
      }
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        detailCalls += 1;
        if (detailCalls === 2) return pendingDetail.promise;
        return jsonResponse(
          podcastDetailResponse({
            subscription,
            title: "Before refresh",
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
              title: "Before refresh episode",
            }),
          ]),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/00000000-0000-4000-8000-000000000111") {
        return jsonResponse({
          data: { description_text: "Detailed show notes" },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });
    render(<Wrapped />);

    expect(
      await screen.findByRole("link", { name: "Before refresh episode" }),
    ).toBeVisible();
    await waitFor(() => expect(primaryChromeMock.publish).toHaveBeenCalled());
    expect(
      panePrimaryChromeState.options.find(
        (option) => option.id === "ResourceOperation.Podcast.Refresh",
      ),
    ).toBeUndefined();
    const refresh = publishedPaneRefresh();
    expect(refresh.sourceKey).toContain(
      "00000000-0000-4000-8000-000000000011",
    );

    let refreshResult:
      | Awaited<ReturnType<typeof refresh.execute>>
      | undefined;
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = refresh
        .execute({
          signal: new AbortController().signal,
          reportProgress: vi.fn(),
        })
        .then((result) => {
          refreshResult = result;
        });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(detailCalls).toBe(2);
      expect(episodeCalls).toBe(2);
    });
    expect(
      screen.getByRole("link", { name: "Before refresh episode" }),
    ).toBeVisible();

    act(() => {
      pendingDetail.resolve(
        jsonResponse(
          podcastDetailResponse({
            subscription,
            title: "After refresh reconciliation",
          }),
        ),
      );
      pendingEpisodes.resolve(
        jsonResponse(
          episodePage([
            episodeMedia({ title: "After refresh episode" }),
          ]),
        ),
      );
    });
    await refreshPromise;
    expect(
      await screen.findByRole("link", { name: "After refresh episode" }),
    ).toBeVisible();
    expect(refreshResult).toEqual({
      kind: "Complete",
      announcement: "Up to date",
    });
    expect(refreshRequestBody).toEqual({
      kind: "Podcast",
      podcastId: "00000000-0000-4000-8000-000000000011",
    });
  });

  it("rejects an aborted owner refresh, ignores its late detail generation, and retains committed episodes through a later refresh error", async () => {
    const pendingDetail = deferredResponse();
    const pendingEpisodes = deferredResponse();
    let detailCalls = 0;
    let episodeCalls = 0;
    const subscription = {
      podcast_id: "00000000-0000-4000-8000-000000000011",
      user_id: "user-1",
      default_playback_speed: { kind: "Absent" },
      pause_shortening_mode: { kind: "Absent" },
      auto_queue: false,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 1,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-01-01T00:00:00Z",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/refresh-runs" &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            data: {
              refreshRunHandle: REFRESH_RUN_HANDLE,
              status: "Complete",
              requestedCount: 1,
            },
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (
        url.pathname ===
        `/api/podcasts/refresh-runs/${REFRESH_RUN_HANDLE}`
      ) {
        return jsonResponse({
          data: {
            refreshRunHandle: REFRESH_RUN_HANDLE,
            status: "Complete",
            requestedCount: 1,
            finishedCount: 1,
            succeededCount: 1,
            sourceLimitedCount: 0,
            failedCount: 0,
            skippedCount: 0,
            newEpisodeCount: 0,
            startedAt: "2026-07-30T12:00:00Z",
            completedAt: {
              kind: "Present",
              value: "2026-07-30T12:00:01Z",
            },
          },
        });
      }
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        detailCalls += 1;
        if (detailCalls === 2) return pendingDetail.promise;
        if (detailCalls > 2) {
          return new Response(
            JSON.stringify({
              error: { code: "E_BAD_REQUEST", message: "Refresh failed" },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse(
          podcastDetailResponse({
            subscription,
            title: "Stable podcast detail",
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
                  ? "Stable podcast episode"
                  : "Error-generation episode",
            }),
          ]),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/media/00000000-0000-4000-8000-000000000111") {
        return jsonResponse({
          data: { description_text: "Detailed show notes" },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);
    expect(
      await screen.findByRole("link", { name: "Stable podcast episode" }),
    ).toBeVisible();
    await waitFor(() => expect(primaryChromeMock.publish).toHaveBeenCalled());
    const refresh = publishedPaneRefresh();
    const owner = new AbortController();
    const abortedRefresh = refresh.execute({
      signal: owner.signal,
      reportProgress: vi.fn(),
    });
    const expectedAbort = expect(abortedRefresh).rejects.toMatchObject({
      name: "AbortError",
    });
    await waitFor(() => {
      expect(detailCalls).toBe(2);
      expect(episodeCalls).toBe(2);
    });
    owner.abort(new DOMException("Source replaced.", "AbortError"));
    await expectedAbort;

    act(() => {
      pendingDetail.resolve(
        jsonResponse(
          podcastDetailResponse({
            subscription,
            title: "Late stale podcast detail",
          }),
        ),
      );
      pendingEpisodes.resolve(
        jsonResponse(
          episodePage([
            episodeMedia({ title: "Late stale podcast episode" }),
          ]),
        ),
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Late stale podcast episode" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "Stable podcast episode" }),
    ).toBeVisible();

    await expect(
      refresh.execute({
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
      }),
    ).resolves.toEqual({
      kind: "Failed",
      announcement: "Podcast failed to refresh",
    });
    expect(
      screen.getByRole("link", { name: "Stable podcast episode" }),
    ).toBeVisible();
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
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

  it("offers Download only after native handshake and server eligibility", async () => {
    let offlineDownloadEligible = true;
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
          episodePage([episodeMedia({ offlineDownloadEligible })]),
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

    const { unmount: unmountUnavailable } = render(
      <Wrapped offlineTransport={new OfflineHandshakeTransport(null)} />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Download for offline" }),
    ).not.toBeInTheDocument();
    unmountUnavailable();

    const { unmount: unmountReady } = render(
      <Wrapped
        offlineTransport={
          new OfflineHandshakeTransport({
            kind: "Connected",
            items: [],
            networkPolicy: "UnmeteredOnly",
          })
        }
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Download for offline" }),
    ).toBeInTheDocument();
    unmountReady();

    offlineDownloadEligible = false;
    const { unmount: unmountIneligible } = render(
      <Wrapped
        offlineTransport={
          new OfflineHandshakeTransport({
            kind: "Connected",
            items: [],
            networkPolicy: "UnmeteredOnly",
          })
        }
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Download for offline" }),
    ).not.toBeInTheDocument();
    unmountIneligible();

    render(
      <Wrapped
        offlineTransport={
          new OfflineHandshakeTransport({
            kind: "Connected",
            items: [
              {
                mediaId: "00000000-0000-4000-8000-000000000111",
                title: "Episode 1",
                state: {
                  kind: "Present",
                  value: {
                    kind: "Ready",
                    sizeBytes: 2_000,
                    contentType: "audio/mpeg",
                    updatedAt: "2026-07-30T19:00:00Z",
                  },
                },
              },
            ],
            networkPolicy: "UnmeteredOnly",
          })
        }
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove download" }),
    ).toBeInTheDocument();
  });

  it("treats subscription absence as unsubscribed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname === "/api/podcasts/00000000-0000-4000-8000-000000000011"
      ) {
        return jsonResponse(podcastDetailResponse({ subscription: null }));
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
      ) {
        return jsonResponse(episodePage([]));
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
      if (url.pathname === "/api/media/00000000-0000-4000-8000-000000000111") {
        return jsonResponse({
          data: { description_text: "Detailed show notes" },
        });
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
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
                is_completed: false,
              },
            }),
          ]),
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
      if (
        url.pathname === "/api/consumption/commands" &&
        init?.method === "POST"
      ) {
        const command = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
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
                    episodePlaybackRate: {
                      kind: "Present",
                      value: 1.25,
                    },
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
      await screen.findByRole("menuitem", { name: "Re-enrich metadata" }),
    ).toBeInTheDocument();
  });

  it("keeps a modeled metadata retry state local with its request ID", async () => {
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
        return jsonResponse(
          {
            error: {
              code: "E_RETRY_INVALID_STATE",
              message: "Media is no longer ready",
              request_id: "req-metadata-state",
            },
          },
          409,
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
    fireEvent.click(
      await screen.findByRole("button", {
        name: "More actions for Episode 1",
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Re-enrich metadata" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Metadata can be retried only after this episode is ready to read.",
    );
    expect(
      screen.getByText("Nexus request ID: req-metadata-state"),
    ).toBeInTheDocument();
  });

  it.each(["E_NETWORK", "E_UPSTREAM_TIMEOUT"])(
    "retains an unconfirmed metadata Notice after reload and removes direct retry for %s",
    async (code) => {
      let episodeRequests = 0;
      let metadataPosts = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input), "http://localhost");
        if (
          url.pathname ===
          "/api/podcasts/00000000-0000-4000-8000-000000000011"
        ) {
          return jsonResponse(podcastDetailResponse());
        }
        if (
          url.pathname ===
          "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes"
        ) {
          episodeRequests += 1;
          return jsonResponse(
            episodePage([episodeMedia({ canRetryMetadata: true })]),
          );
        }
        if (
          url.pathname ===
          "/api/media/00000000-0000-4000-8000-000000000111/retry"
        ) {
          metadataPosts += 1;
          return jsonResponse(
            {
              error: {
                code,
                message: "The outcome is unknown",
                request_id: "req-metadata-unconfirmed",
              },
            },
            503,
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
      fireEvent.click(
        await screen.findByRole("button", {
          name: "More actions for Episode 1",
        }),
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Re-enrich metadata" }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Metadata request couldn’t be confirmed",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Its status is being checked. Don’t start it again yet.",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Nexus request ID: req-metadata-unconfirmed",
      );
      await waitFor(() => expect(episodeRequests).toBeGreaterThanOrEqual(2));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Metadata request couldn’t be confirmed",
      );

      fireEvent.click(
        await screen.findByRole("button", {
          name: "More actions for Episode 1",
        }),
      );
      expect(
        screen.queryByRole("menuitem", { name: "Re-enrich metadata" }),
      ).toBeNull();
      expect(metadataPosts).toBe(1);
    },
  );

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

  it("recovers focus after a rapid visible-signature change follows an author edit", async () => {
    const editedMediaId = "00000000-0000-4000-8000-000000000111";
    const animationFrames = new Map<number, FrameRequestCallback>();
    let nextAnimationFrame = 1;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (callback) => {
        const handle = nextAnimationFrame;
        nextAnimationFrame += 1;
        animationFrames.set(handle, callback);
        return handle;
      },
    );
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(
      (handle) => {
        animationFrames.delete(handle);
      },
    );
    const flushAnimationFrames = () => {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      callbacks.forEach((callback) => callback(0));
    };
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
        return jsonResponse(
          episodePage([
            episodeMedia({
              id: editedMediaId,
              title: "First Episode",
              canEditAuthors: true,
              contributors: [
                {
                  contributor_handle: "ada-lovelace",
                  contributor_display_name: "Ada Lovelace",
                  href: "/authors/ada-lovelace",
                  credited_name: "Ada Lovelace",
                  role: "author",
                  raw_role: null,
                  ordinal: 0,
                },
              ],
            }),
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000112",
              title: "Ada Neighbor",
            }),
          ]),
        );
      }
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
        return jsonResponse({ data: [] });
      }
      if (
        url.pathname === `/api/media/${editedMediaId}/authors` &&
        init?.method === "PUT"
      ) {
        return jsonResponse({
          data: {
            authorMode: "manual",
            authors: [],
            canEditAuthors: true,
          },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);
    await screen.findByRole("link", { name: "First Episode" });
    act(() => publishedEpisodeFilterRows().onQueryChange("ada"));
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for First Episode" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit authors…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Ada Lovelace" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: "First Episode" }),
      ).not.toBeInTheDocument();
    });
    act(() => publishedEpisodeFilterRows().onQueryChange("missing"));
    expect(
      screen.queryByRole("link", { name: "Ada Neighbor" }),
    ).not.toBeInTheDocument();
    act(() => publishedEpisodeFilterRows().onQueryChange("neighbor"));
    const neighbor = screen.getByRole("link", { name: "Ada Neighbor" });

    act(flushAnimationFrames);
    act(flushAnimationFrames);

    expect(neighbor).toHaveFocus();
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
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
                  playbackRate: {
                    value: 1,
                    source: "Product",
                    podcastPreference: { kind: "Absent" },
                  },
                  pauseShorteningMode: { kind: "Absent" },
                  consumptionOverrideRevision: { kind: "Absent" },
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

  it("commits the new domain view before continuing a partial episode chain", async () => {
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
          return newFirstPage.promise.then((response) => response.clone());
        }
        if (request.cursor === "page-2") {
          return oldContinuation.promise.then((response) => response.clone());
        }
        return jsonResponse(
          episodePage([episodeMedia()], { kind: "Present", value: "page-2" }),
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

    render(<>{publishedEpisodeFilterRows().filters}</>);
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
    expect(
      await screen.findByText("No episodes found for this podcast."),
    ).toBeVisible();
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

  it("does not forecast transcripts eagerly while the episode domain view changes", async () => {
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/libraries"
      ) {
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

    await screen.findByRole("link", { name: "Episode 1" });
    render(<>{publishedEpisodeFilterRows().filters}</>);
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

  it("filters complete episode rows by title and contributor without adding q", async () => {
    const episodeRequestQueries: string[] = [];
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
        episodeRequestQueries.push(url.search);
        return jsonResponse(
          episodePage([
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000111",
              title: "Signal Theory",
            }),
            episodeMedia({
              id: "00000000-0000-4000-8000-000000000112",
              title: "Release Notes",
              contributors: [
                {
                  contributor_handle: "grace-hopper",
                  contributor_display_name: "Grace Hopper",
                  href: "/authors/grace-hopper",
                  credited_name: "Grace Hopper",
                  role: "author",
                  raw_role: null,
                  ordinal: 0,
                },
              ],
            }),
          ]),
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
      await screen.findByRole("link", { name: "Signal Theory" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Release Notes" })).toBeVisible();

    act(() => publishedEpisodeFilterRows().onQueryChange("signal"));
    expect(screen.getByRole("link", { name: "Signal Theory" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Release Notes" }),
    ).not.toBeInTheDocument();

    act(() => publishedEpisodeFilterRows().onQueryChange("grace"));
    expect(
      screen.queryByRole("link", { name: "Signal Theory" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release Notes" })).toBeVisible();

    act(() => publishedEpisodeFilterRows().onQueryChange("missing"));
    expect(screen.getByText("No episodes match this filter.")).toBeVisible();
    expect(
      screen.queryByText("No episodes found for this podcast."),
    ).not.toBeInTheDocument();
    expect(
      episodeRequestQueries.every(
        (query) => !new URLSearchParams(query).has("q"),
      ),
    ).toBe(true);
  });

  it("shows Partial episode-filter feedback beside the initial loading state", async () => {
    const initialEpisodes = deferredResponse();
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
        return initialEpisodes.promise.then((response) => response.clone());
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
    await waitFor(() => {
      expect(
        primaryChromeMock.publish.mock.lastCall?.[0]?.search,
      ).toBeDefined();
    });
    act(() => publishedEpisodeFilterRows().onQueryChange("missing"));

    expect(
      screen.getByText("No matching episode found so far."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No episodes found for this podcast."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Loading podcast…")).toBeInTheDocument();

    await act(async () => {
      initialEpisodes.resolve(jsonResponse(episodePage([])));
      await initialEpisodes.promise;
    });
  });

  it("keeps episode-wide commands server-selected and accessible during local filtering", async () => {
    const continuation = deferredResponse();
    const episodeRequestQueries: string[] = [];
    let forecastCalls = 0;
    let markPlayedCalls = 0;
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
        episodeRequestQueries.push(url.search);
        if (url.searchParams.has("cursor")) {
          return continuation.promise.then((response) => response.clone());
        }
        return jsonResponse(
          episodePage([episodeMedia({ transcriptState: "ready" })], {
            kind: "Present",
            value: "next-episodes",
          }),
        );
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
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
      if (
        url.pathname ===
        "/api/podcasts/00000000-0000-4000-8000-000000000011/episodes/mark-played"
      ) {
        markPlayedCalls += 1;
        return jsonResponse({
          data: {
            matchedCount: 1,
            changedCount: 1,
            collectionRevision: 2,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<Wrapped />);
    expect(
      await screen.findByRole("link", { name: "Episode 1" }),
    ).toBeInTheDocument();
    expect(primaryChromeMock.publish.mock.lastCall?.[0]).toMatchObject({
      header: {
        kind: "section",
        folio: { kind: "none" },
        pending: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Episode actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Transcribe all episodes" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Mark all episodes as played",
      }),
    ).not.toBeDisabled();
    render(<>{publishedEpisodeFilterRows().filters}</>);
    fireEvent.click(screen.getByRole("button", { name: "Unplayed" }));
    expect(
      screen.getByRole("menuitem", {
        name: "Transcribe all unplayed episodes",
      }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Mark all unplayed episodes as played",
      }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    expect(
      screen.getByRole("menuitem", {
        name: "Transcribe all in-progress episodes",
      }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("menuitem", {
        name: "Mark all in-progress episodes as played",
      }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Played" }));
    expect(
      screen.getByRole("menuitem", {
        name: "Transcribe all played episodes",
      }),
    ).not.toBeDisabled();
    const playedMark = screen.getByRole("menuitem", {
      name: "All played episodes are already played",
    });
    expect(playedMark).toHaveAttribute("aria-disabled", "true");
    expect(playedMark).toHaveAccessibleDescription(
      "Every episode in this state is already played.",
    );

    const requestCountBeforeLocalFilter = episodeRequestQueries.length;
    act(() => publishedEpisodeFilterRows().onQueryChange("Episode"));
    const transcriptWhileFiltering = screen.getByRole("menuitem", {
      name: "Transcribe all played episodes",
    });
    const markWhileFiltering = screen.getByRole("menuitem", {
      name: "All played episodes are already played",
    });
    expect(transcriptWhileFiltering).toHaveAttribute("aria-disabled", "true");
    expect(markWhileFiltering).toHaveAttribute("aria-disabled", "true");
    expect(transcriptWhileFiltering).toHaveAccessibleDescription(
      "Clear Filter to use episode-wide actions",
    );
    expect(markWhileFiltering).toHaveAccessibleDescription(
      "Clear Filter to use episode-wide actions",
    );
    const actionMenu = screen.getByRole("menu", { name: "Episode actions" });
    fireEvent.keyDown(actionMenu, { key: "Home" });
    expect(transcriptWhileFiltering).toHaveFocus();
    fireEvent.keyDown(transcriptWhileFiltering, { key: "Enter" });
    fireEvent.click(transcriptWhileFiltering);
    fireEvent.keyDown(transcriptWhileFiltering, { key: "ArrowDown" });
    expect(markWhileFiltering).toHaveFocus();
    fireEvent.keyDown(markWhileFiltering, { key: "Enter" });
    fireEvent.click(markWhileFiltering);
    expect(forecastCalls).toBe(0);
    expect(markPlayedCalls).toBe(0);
    expect(episodeRequestQueries).toHaveLength(requestCountBeforeLocalFilter);
    expect(
      episodeRequestQueries.every(
        (query) => !new URLSearchParams(query).has("q"),
      ),
    ).toBe(true);

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
    await waitFor(() => {
      expect(primaryChromeMock.publish.mock.lastCall?.[0]).toMatchObject({
        header: {
          kind: "section",
          folio: { kind: "count", value: 2, unit: "episode" },
          pending: false,
        },
      });
    });
  });
});
