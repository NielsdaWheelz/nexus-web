import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  StrictMode,
  useState,
} from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import PaneShell from "@/components/workspace/PaneShell";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  assumePaneVisitId,
  createDefaultWorkspaceState,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import PodcastDetailPaneBody from "./PodcastDetailPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 3/4/5/6/7, Acceptance 7/8/9). The episode list used to mirror
 * `state` and `sort` into component state and write both keys back on every
 * mount, so the default view owned an address of its own and an unrecognized
 * one was silently normalized. These proofs pin the strict replacement: the
 * pane URL is the only owner, defaults are unaddressed, and an unaddressable
 * view requests nothing.
 */

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000201");
const PODCAST_ID = "44444444-4444-4444-8444-444444444444";
const noop = () => {};

// The canonical resource-action runtime the pane's rows and chrome render into.
const RESOURCE_ACTION_ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESOURCE_ACTION_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

class TestDefectBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly onDefect: (error: Error) => void;
  },
  { readonly error: Error | null }
> {
  state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onDefect(error);
  }

  render() {
    if (this.state.error !== null) {
      return <div role="alert">Podcast detail defect</div>;
    }
    return this.props.children;
  }
}

// Two episodes whose published and duration orders disagree, so a committed
// order is never ambiguous about which view produced it.
const CREW = episode({
  id: "55555555-5555-4555-8555-555555555555",
  title: "The Crew-4 Astronauts",
  published: "2026-08-02",
  durationSeconds: 3_600,
  state: "unplayed",
});
const ORBIT = episode({
  id: "66666666-6666-4666-8666-666666666666",
  title: "Orbital Mechanics",
  published: "2026-08-01",
  durationSeconds: 600,
  state: "played",
});
const NEWEST_ORDER = ["The Crew-4 Astronauts", "Orbital Mechanics"];
const SHORTEST_ORDER = ["Orbital Mechanics", "The Crew-4 Astronauts"];

function episode(input: {
  readonly id: string;
  readonly title: string;
  readonly published: string;
  readonly durationSeconds: number;
  readonly state: "unplayed" | "in_progress" | "played";
}) {
  return {
    id: input.id,
    kind: "podcast_episode",
    title: input.title,
    canonical_source_url: { kind: "Absent" },
    offline_download_eligible: false,
    processing_status: "ready_for_reading",
    transcript_state: "not_requested",
    transcript_coverage: "none",
    listening_state: { kind: "Absent" },
    episode_state: input.state,
    progress_resettable: false,
    capabilities: {
      can_retry: false,
      can_refresh_source: false,
      can_retry_metadata: false,
      can_edit_authors: false,
      can_delete: false,
    },
    contributors: [],
    author_mode: "automatic",
    original_published_date: { kind: "Present", value: input.published },
    duration_seconds: { kind: "Present", value: input.durationSeconds },
    has_show_notes: false,
    playerDescriptor: { kind: "Absent" },
  };
}

function episodesPage(items: readonly ReturnType<typeof episode>[]) {
  return Response.json({
    data: { items, collectionRevision: 5, nextCursor: { kind: "Absent" } },
  });
}

type DetailSubscriptionState = {
  readonly syncStatus: "Pending" | "Running" | "Complete" | "SourceLimited" | "Failed";
  readonly backfillState:
    | "Pending"
    | "Running"
    | "Complete"
    | "SourceLimited"
    | "Failed";
  readonly processedCount: number;
  readonly addedCount: number;
};

function detailResponse(subscriptionState?: DetailSubscriptionState) {
  return Response.json({
    data: {
      podcast: {
        id: PODCAST_ID,
        provider: "fixture",
        provider_podcast_id: "fixture-1",
        title: "Houston We Have a Podcast",
        contributors: [],
        feed_url: "https://example.test/feed.xml",
        website_url: null,
        image_url: null,
        description: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      subscription:
        subscriptionState === undefined
          ? null
          : {
              user_id: RESOURCE_ACTION_ACCOUNT_ID,
              podcast_id: PODCAST_ID,
              default_playback_speed: { kind: "Absent" },
              pause_shortening_mode: { kind: "Absent" },
              auto_queue: false,
              sync_status: subscriptionState.syncStatus,
              sync_error_code: null,
              sync_error_message: null,
              sync_attempts: 1,
              sync_started_at: "2026-08-18T00:00:00Z",
              sync_completed_at:
                subscriptionState.syncStatus === "Complete"
                  ? "2026-08-18T00:00:01Z"
                  : null,
              last_checked_at:
                subscriptionState.syncStatus === "Complete"
                  ? "2026-08-18T00:00:01Z"
                  : null,
              updated_at:
                subscriptionState.syncStatus === "Complete"
                  ? "2026-08-18T00:00:01Z"
                  : "2026-08-18T00:00:00Z",
              backfill: {
                id: "77777777-7777-4777-8777-777777777777",
                state: subscriptionState.backfillState,
                processed_count: subscriptionState.processedCount,
                added_count: subscriptionState.addedCount,
              },
            },
    },
  });
}

function lifecycleSnapshot(state: DetailSubscriptionState) {
  return {
    podcastId: PODCAST_ID,
    syncStatus: state.syncStatus,
    backfill: {
      id: "77777777-7777-4777-8777-777777777777",
      state: state.backfillState,
      processedCount: state.processedCount,
      addedCount: state.addedCount,
    },
  };
}

/**
 * The episodes endpoint as it has always behaved: `state` and `sort` are always
 * sent, defaults included. This fixture serves exactly the views the proofs
 * navigate between and records only the episode collection requests.
 */
function stubPodcastDetail(shortestPage?: Promise<Response>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      if (url.pathname === `/api/podcasts/${PODCAST_ID}`) {
        return detailResponse();
      }
      if (url.pathname === "/api/lectern") {
        return Response.json({ data: { items: [] } });
      }
      if (url.pathname === "/api/billing/account") {
        return Response.json({ data: { can_transcribe: false } });
      }
      if (url.pathname !== `/api/podcasts/${PODCAST_ID}/episodes`) {
        throw new Error(`Unexpected podcast request: ${url.pathname}`);
      }
      requests.push(`${url.pathname}${url.search}`);
      const state = url.searchParams.get("state");
      const sort = url.searchParams.get("sort");
      const inState = (candidate: ReturnType<typeof episode>) =>
        state === "all" || candidate.episode_state === state;
      const ordered =
        sort === "oldest" || sort === "duration_asc"
          ? [ORBIT, CREW]
          : [CREW, ORBIT];
      const items = ordered.filter(inState);
      if (sort === "duration_asc" && state === "all" && shortestPage) {
        return shortestPage;
      }
      return episodesPage(items);
    }),
  );
  return requests;
}

function stubSubscriptionLifecycle({
  initiallySubscribed = false,
  streamFailure = null,
  terminalOnStreamFailure = false,
  canonicalFailure = null,
}: {
  readonly initiallySubscribed?: boolean;
  readonly streamFailure?: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
  } | null;
  readonly terminalOnStreamFailure?: boolean;
  readonly canonicalFailure?: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
  } | null;
} = {}) {
  const active: DetailSubscriptionState = {
    syncStatus: "Running",
    backfillState: "Pending",
    processedCount: 0,
    addedCount: 0,
  };
  const terminal: DetailSubscriptionState = {
    syncStatus: "Complete",
    backfillState: "Complete",
    processedCount: 1,
    addedCount: 1,
  };
  const encoder = new TextEncoder();
  let subscribed = initiallySubscribed;
  let current = active;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let streamOpen = false;
  let detailReads = 0;
  let episodeReads = 0;
  let streamOpens = 0;
  const initSignals: AbortSignal[] = [];
  let blockedDetailSignal: AbortSignal | null = null;
  let blockedDetail:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly response: ReturnType<typeof deferred<Response>>;
      }
    | null = null;

  const emit = (type: "state" | "done", state: DetailSubscriptionState) => {
    if (streamController === null) {
      throw new Error("Podcast subscription lifecycle stream is not open");
    }
    streamController.enqueue(
      encoder.encode(
        `event: ${type}\ndata: ${JSON.stringify(lifecycleSnapshot(state))}\n\n`,
      ),
    );
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";

      if (url.pathname === "/api/lectern") {
        return Response.json({ data: { items: [] } });
      }
      if (url.pathname === "/api/billing/account") {
        return Response.json({ data: { can_transcribe: false } });
      }
      if (url.pathname === "/api/resource-items/action-snapshots/resolve") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        return Response.json({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "none",
                href: null,
                unresolvedReason: null,
              },
              missing: true,
              factsRevision: "0".repeat(64),
              capabilities: [],
            })),
          },
        });
      }
      if (
        url.pathname === "/api/podcasts/subscriptions" &&
        method === "POST"
      ) {
        subscribed = true;
        return Response.json({
          data: {
            href: `/podcasts/${PODCAST_ID}`,
            podcastId: PODCAST_ID,
            outcome: "Subscribed",
            destinations: [],
            backfill: {
              id: "77777777-7777-4777-8777-777777777777",
              state: "Pending",
              processedCount: 0,
              addedCount: 0,
            },
            collectionRevision: 6,
            libraryEntriesCollectionRevision: 8,
          },
        });
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}`) {
        detailReads += 1;
        if (detailReads > 1 && canonicalFailure !== null) {
          return Response.json(
            {
              error: {
                code: canonicalFailure.code,
                message: canonicalFailure.message,
                request_id: "subscription-lifecycle-reconciliation",
              },
            },
            { status: canonicalFailure.status },
          );
        }
        if (blockedDetail !== null) {
          const blocked = blockedDetail;
          blockedDetailSignal = init?.signal ?? null;
          blocked.started.resolve();
          return blocked.response.promise;
        }
        return detailResponse(subscribed ? current : undefined);
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}/episodes`) {
        episodeReads += 1;
        return episodesPage(
          subscribed && current.syncStatus === "Complete" ? [CREW] : [],
        );
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}/libraries`) {
        return Response.json({ data: [] });
      }
      if (url.pathname === "/api/stream-token") {
        return Response.json({
          data: {
            token: "podcast-lifecycle-token",
            stream_base_url: "https://stream.nexus.test",
            expires_at: "2026-08-18T00:01:00Z",
          },
        });
      }
      if (
        url.pathname ===
        `/stream/podcast-subscriptions/${PODCAST_ID}/events`
      ) {
        streamOpens += 1;
        if (init?.signal) initSignals.push(init.signal);
        if (streamFailure !== null) {
          if (streamFailure.code === "E_NOT_FOUND") subscribed = false;
          if (terminalOnStreamFailure) current = terminal;
          return Response.json(
            {
              error: {
                code: streamFailure.code,
                message: streamFailure.message,
                request_id: "subscription-lifecycle-gone",
              },
            },
            { status: streamFailure.status },
          );
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            streamOpen = true;
            init?.signal?.addEventListener(
              "abort",
              () => {
                if (!streamOpen) return;
                streamOpen = false;
                controller.error(
                  new DOMException(
                    "Podcast lifecycle observer was replaced",
                    "AbortError",
                  ),
                );
              },
              { once: true },
            );
            emit("state", active);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected podcast lifecycle request: ${url.pathname}`);
    }),
  );

  return {
    reads: () => ({ detail: detailReads, episodes: episodeReads }),
    streamOpens: () => streamOpens,
    streamAborted: () => initSignals.some((signal) => signal.aborted),
    deferNextDetail() {
      if (blockedDetail !== null) {
        throw new Error("A Podcast detail read is already blocked");
      }
      const started = deferred<void>();
      const response = deferred<Response>();
      blockedDetail = { started, response };
      return {
        started: started.promise,
        aborted: () => blockedDetailSignal?.aborted === true,
        resolveWithCurrent() {
          response.resolve(detailResponse(subscribed ? current : undefined));
          blockedDetail = null;
        },
      };
    },
    publish(state: DetailSubscriptionState) {
      current = state;
      emit("state", state);
    },
    installWithoutEvent(state: DetailSubscriptionState) {
      current = state;
    },
    complete() {
      current = terminal;
      emit("state", terminal);
      emit("done", terminal);
      streamController?.close();
      streamOpen = false;
    },
  };
}

function stubTerminalDetailCommittedAfterTheFirstEpisodeRead({
  deferActionSnapshots = false,
}: { readonly deferActionSnapshots?: boolean } = {}) {
  const detailStarted = deferred<void>();
  const terminalDetail = deferred<Response>();
  const actionSnapshotsReleased = deferred<void>();
  let terminalEpisodesVisible = false;
  let episodeReads = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      if (url.pathname === "/api/lectern") {
        return Response.json({ data: { items: [] } });
      }
      if (url.pathname === "/api/billing/account") {
        return Response.json({ data: { can_transcribe: false } });
      }
      if (url.pathname === "/api/resource-items/action-snapshots/resolve") {
        if (deferActionSnapshots) await actionSnapshotsReleased.promise;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        return Response.json({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "none",
                href: null,
                unresolvedReason: null,
              },
              missing: true,
              factsRevision: "0".repeat(64),
              capabilities: [],
            })),
          },
        });
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}`) {
        detailStarted.resolve();
        return terminalDetail.promise;
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}/episodes`) {
        episodeReads += 1;
        return episodesPage(terminalEpisodesVisible ? [CREW] : []);
      }
      if (url.pathname === `/api/podcasts/${PODCAST_ID}/libraries`) {
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected mixed lifecycle request: ${url.pathname}`);
    }),
  );

  return {
    detailStarted: detailStarted.promise,
    releaseActionSnapshots() {
      actionSnapshotsReleased.resolve();
    },
    settleTerminalDetail() {
      terminalEpisodesVisible = true;
      terminalDetail.resolve(
        detailResponse({
          syncStatus: "Complete",
          backfillState: "Complete",
          processedCount: 1,
          addedCount: 1,
        }),
      );
    },
    episodeReads: () => episodeReads,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function PodcastDetailPane({
  initialHref,
  onDefect = noop,
  replaced,
}: {
  readonly initialHref: string;
  readonly onDefect?: (error: Error) => void;
  readonly replaced: string[];
}) {
  const [href, setHref] = useState(initialHref);
  const routeKey = resolvePaneRouteIdentity(href).routeKey;
  return (
    <MobileChromeProvider>
      <FeedbackProvider>
        <ShareControllerProvider>
          <LibraryPlacementControllerProvider>
            <PaneReturnMementoProvider>
              <PaneRuntimeProvider
                paneId="pane"
                visitId={VISIT_ID}
                isActive
                href={href}
                routeId="podcastDetail"
                routeKey={routeKey}
                pathParams={{ podcastId: PODCAST_ID }}
                canGoBack={false}
                canGoForward={false}
                onNavigatePane={noop}
                onReplacePane={(_paneId, nextHref) => {
                  replaced.push(nextHref);
                  setHref(nextHref);
                }}
                onActivateWorkspaceTarget={() => ({
                  kind: "ActivatedExisting" as const,
                  paneId: "pane",
                })}
                onGoBackPane={noop}
                onGoForwardPane={noop}
              >
                <LecternProvider>
                  <GlobalPlayerProvider>
                    <AuthenticatedAccountProvider
                      account={{
                        accountId: RESOURCE_ACTION_ACCOUNT_ID,
                        calendarTimeZone: "UTC",
                      }}
                    >
                    <KeybindingsProvider>
                    <WorkspaceStoreProvider
                      initialState={createDefaultWorkspaceState(
                        `/podcasts/${PODCAST_ID}`,
                        RESOURCE_ACTION_METRICS,
                      )}
                      workspacePrimaryMetrics={RESOURCE_ACTION_METRICS}
                    >
                    <OfflineMediaProvider
                      accountId={RESOURCE_ACTION_ACCOUNT_ID}
                      transport={null}
                    >
                    <ResourceOverlaysProvider>
                    <ResourceActionRuntimeProvider>
                    <div data-pane-id="pane" data-active="true">
                      <PaneShell
                        paneId="pane"
                        routeKey={routeKey}
                        routeHeader={{
                          kind: "Section",
                          destinationId: "podcasts",
                          context: "Destination",
                        }}
                        label="Podcast"
                        returnMementoEnabled
                        queryNavigation="in-place"
                        sizing={{
                          primaryWidthPx: 720,
                          primaryMinWidthPx: 320,
                          primaryMaxWidthPx: 1_400,
                          renderedPrimarySlotWidthPx: 720,
                          renderedPrimarySlotMinWidthPx: 320,
                          renderedPrimarySlotMaxWidthPx: 1_400,
                          fixedChromeWidthPx: 0,
                          storedWidthCorrectionPx: null,
                        }}
                        bodyMode="standard"
                        onResizePrimaryPane={noop}
                        isActive
                      >
                        <TestDefectBoundary onDefect={onDefect}>
                          <PodcastDetailPaneBody />
                        </TestDefectBoundary>
                      </PaneShell>
                    </div>
                    <ResourceActionOverlays />
                    </ResourceActionRuntimeProvider>
                    </ResourceOverlaysProvider>
                    </OfflineMediaProvider>
                    </WorkspaceStoreProvider>
                    </KeybindingsProvider>
                    </AuthenticatedAccountProvider>
                  </GlobalPlayerProvider>
                </LecternProvider>
              </PaneRuntimeProvider>
            </PaneReturnMementoProvider>
          </LibraryPlacementControllerProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>
  );
}

function episodeTitles(): string[] {
  return within(screen.getByRole("list", { name: "Episodes" }))
    .getAllByRole("listitem")
    .map(
      (row) =>
        NEWEST_ORDER.find((title) => row.textContent?.includes(title)) ??
        "unknown",
    );
}

async function openFilter(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Filter/ }));
}

describe("Podcast episodes domain view", () => {
  it("cannot commit terminal subscription detail with a pre-terminal episode page", async () => {
    const lifecycle = stubTerminalDetailCommittedAfterTheFirstEpisodeRead();

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await lifecycle.detailStarted;
    lifecycle.settleTerminalDetail();

    await screen.findByRole("link", { name: "The Crew-4 Astronauts" });
    expect(lifecycle.episodeReads()).toBe(1);
  });

  it("revalidates a newly subscribed pane when live sync and backfill publish their terminal snapshot", async () => {
    const lifecycle = stubSubscriptionLifecycle();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={replaced}
      />,
    );

    const subscribe = await screen.findByRole("button", {
      name: "Subscribe",
    });
    await userEvent.click(
      subscribe,
    );

    await screen.findByText("Checking for new episodes");
    await waitFor(() => expect(lifecycle.streamOpens()).toBe(1));
    expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 });
    expect(
      screen.queryByRole("link", { name: "The Crew-4 Astronauts" }),
    ).toBeNull();

    lifecycle.complete();

    await screen.findByRole("link", { name: "The Crew-4 Astronauts" });
    await waitFor(() =>
      expect(lifecycle.reads()).toEqual({ detail: 3, episodes: 3 }),
    );
    expect(lifecycle.streamOpens()).toBe(1);
    expect(replaced).toEqual([]);
  });

  it("serializes lifecycle revalidation and adopts the newest committed snapshot", async () => {
    const lifecycle = stubSubscriptionLifecycle({ initiallySubscribed: true });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByText("Checking for new episodes");
    await waitFor(() => expect(lifecycle.streamOpens()).toBe(1));
    const pending = lifecycle.deferNextDetail();
    lifecycle.publish({
      syncStatus: "Running",
      backfillState: "Running",
      processedCount: 1,
      addedCount: 0,
    });
    await pending.started;

    lifecycle.complete();
    pending.resolveWithCurrent();

    await screen.findByRole("link", { name: "The Crew-4 Astronauts" });
    await waitFor(() =>
      expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 }),
    );
  });

  it("settles one delivered generation when its read installs newer canonical state", async () => {
    const lifecycle = stubSubscriptionLifecycle({ initiallySubscribed: true });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByText("Checking for new episodes");
    await waitFor(() => expect(lifecycle.streamOpens()).toBe(1));
    const pending = lifecycle.deferNextDetail();
    lifecycle.publish({
      syncStatus: "Running",
      backfillState: "Running",
      processedCount: 1,
      addedCount: 0,
    });
    await pending.started;
    lifecycle.installWithoutEvent({
      syncStatus: "Running",
      backfillState: "Running",
      processedCount: 2,
      addedCount: 1,
    });
    pending.resolveWithCurrent();

    await screen.findByText("Backfilling · 2 processed · 1 added");
    expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 });
  });

  it("aborts an active subscription lifecycle observer when the pane unmounts", async () => {
    const lifecycle = stubSubscriptionLifecycle({
      initiallySubscribed: true,
    });
    const view = render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByText("Checking for new episodes");
    await waitFor(() => expect(lifecycle.streamOpens()).toBe(1));
    expect(lifecycle.reads()).toEqual({ detail: 1, episodes: 1 });

    view.unmount();

    await waitFor(() => expect(lifecycle.streamAborted()).toBe(true));
  });

  it("canonically revalidates once when the observed subscription is gone", async () => {
    const lifecycle = stubSubscriptionLifecycle({
      initiallySubscribed: true,
      streamFailure: {
        status: 404,
        code: "E_NOT_FOUND",
        message: "Podcast subscription not found",
      },
    });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByRole("button", { name: "Subscribe" });
    await waitFor(() =>
      expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 }),
    );
    expect(lifecycle.streamOpens()).toBe(1);
  });

  it("reconciles once and preserves a modeled lifecycle observation failure", async () => {
    const lifecycle = stubSubscriptionLifecycle({
      initiallySubscribed: true,
      streamFailure: {
        status: 429,
        code: "E_RATE_LIMITED",
        message: "Stream capacity exhausted",
      },
    });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByText("Podcast updates couldn’t be observed");
    await screen.findByText("Wait a moment, then retry.");
    await waitFor(() =>
      expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 }),
    );
    expect(lifecycle.streamOpens()).toBe(1);
  });

  it("preserves observation loss when the canonical fallback installs terminal state", async () => {
    const lifecycle = stubSubscriptionLifecycle({
      initiallySubscribed: true,
      terminalOnStreamFailure: true,
      streamFailure: {
        status: 429,
        code: "E_RATE_LIMITED",
        message: "Stream capacity exhausted",
      },
    });

    render(
      <StrictMode>
        <PodcastDetailPane
          initialHref={`/podcasts/${PODCAST_ID}`}
          replaced={[]}
        />
      </StrictMode>,
    );

    await screen.findByRole("link", { name: "The Crew-4 Astronauts" });
    await screen.findByText("Podcast updates couldn’t be observed");
    await waitFor(() =>
      expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 2 }),
    );
    expect(lifecycle.streamOpens()).toBe(1);
  });

  it("preserves observer loss before a same-system reconciliation defect", async () => {
    const defects: Error[] = [];
    const lifecycle = stubSubscriptionLifecycle({
      initiallySubscribed: true,
      streamFailure: {
        status: 429,
        code: "E_RATE_LIMITED",
        message: "Stream capacity exhausted",
      },
      canonicalFailure: {
        status: 500,
        code: "E_INTERNAL",
        message: "Canonical lifecycle projection failed",
      },
    });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        onDefect={(error) => defects.push(error)}
        replaced={[]}
      />,
    );

    await screen.findByText("Podcast detail defect");
    await waitFor(() => expect(defects).toHaveLength(1));
    const [defect] = defects;
    expect(defect).toBeInstanceOf(AggregateError);
    expect(
      (defect as AggregateError).errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual([
      "Stream capacity exhausted",
      "Canonical lifecycle projection failed",
    ]);
    expect(lifecycle.reads()).toEqual({ detail: 2, episodes: 1 });
    expect(lifecycle.streamOpens()).toBe(1);
  });

  it("aborts an in-flight lifecycle revalidation when the pane unmounts", async () => {
    const lifecycle = stubSubscriptionLifecycle({ initiallySubscribed: true });
    const view = render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await screen.findByText("Checking for new episodes");
    await waitFor(() => expect(lifecycle.streamOpens()).toBe(1));
    const pending = lifecycle.deferNextDetail();
    lifecycle.publish({
      syncStatus: "Running",
      backfillState: "Running",
      processedCount: 1,
      addedCount: 0,
    });
    await pending.started;

    view.unmount();

    await waitFor(() => expect(pending.aborted()).toBe(true));
    pending.resolveWithCurrent();
  });

  it("replaces the pane URL with the selected sort and state, requests exactly those views, and keeps the filter text and prior rows until the new page commits", async () => {
    const shortest = deferred<Response>();
    const requests = stubPodcastDetail(shortest.promise);
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={replaced}
      />,
    );

    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(replaced).toEqual([]);
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);

    await openFilter();
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter podcast episodes" }),
      "o",
    );

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "duration_asc",
    );

    await waitFor(() =>
      expect(replaced).toEqual([`/podcasts/${PODCAST_ID}?sort=duration_asc`]),
    );
    await waitFor(() =>
      expect(requests).toEqual([
        `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
        `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=duration_asc&limit=100`,
      ]),
    );
    expect(
      screen.getByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toHaveValue("o");
    expect(episodeTitles()).toEqual(NEWEST_ORDER);

    shortest.resolve(episodesPage([ORBIT, CREW]));

    await waitFor(() => expect(episodeTitles()).toEqual(SHORTEST_ORDER));
    expect(
      screen.getByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toHaveValue("o");

    await userEvent.click(screen.getByRole("button", { name: "Unplayed" }));

    await waitFor(() =>
      expect(replaced.at(-1)).toBe(
        `/podcasts/${PODCAST_ID}?state=unplayed&sort=duration_asc`,
      ),
    );
    await waitFor(() =>
      expect(episodeTitles()).toEqual(["The Crew-4 Astronauts"]),
    );
  });

  it("restores both selected controls and requests only that view when the pane mounts at a non-default href", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?state=played&sort=oldest`}
        replaced={replaced}
      />,
    );

    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics"]),
    );
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=played&sort=oldest&limit=100`,
    ]);
    expect(replaced).toEqual([]);

    await openFilter();
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toHaveDisplayValue("Oldest");
    expect(screen.getByRole("button", { name: "Played" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the invalid episodes view with a reset action and issues no episodes request for an explicitly written default sort", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?sort=newest`}
        replaced={replaced}
      />,
    );

    await screen.findByText("Invalid episodes view");
    expect(requests).toEqual([]);
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() => expect(replaced).toEqual([`/podcasts/${PODCAST_ID}`]));
    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);
  });

  it("keeps the domain view when Escape clears the text and returns to the default view on Clear filters", async () => {
    const requests = stubPodcastDetail();
    const replaced: string[] = [];

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}?sort=oldest`}
        replaced={replaced}
      />,
    );

    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics", "The Crew-4 Astronauts"]),
    );
    await openFilter();
    await userEvent.type(
      await screen.findByRole("searchbox", { name: "Filter podcast episodes" }),
      "orbital",
    );
    await waitFor(() =>
      expect(episodeTitles()).toEqual(["Orbital Mechanics"]),
    );

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("searchbox", { name: "Filter podcast episodes" }),
    ).toBeNull();
    expect(replaced).toEqual([]);
    expect(episodeTitles()).toEqual([
      "Orbital Mechanics",
      "The Crew-4 Astronauts",
    ]);

    await openFilter();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(replaced).toEqual([`/podcasts/${PODCAST_ID}`]));
    await waitFor(() => expect(episodeTitles()).toEqual(NEWEST_ORDER));
    expect(requests).toEqual([
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=oldest&limit=100`,
      `/api/podcasts/${PODCAST_ID}/episodes?state=all&sort=newest&limit=100`,
    ]);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  // Refresh pulls a subscription's new episodes, so its eligibility is a fact
  // of the detail response. Until that response lands the answer is unknown,
  // not negative: the header holds Refresh in its final place, blocked with a
  // reason, instead of growing an entry under an already-open menu.
  it("holds Refresh in the header prefix, blocked, while the subscription fact is in flight", async () => {
    const lifecycle = stubTerminalDetailCommittedAfterTheFirstEpisodeRead();

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await lifecycle.detailStarted;
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    const localPrefix = () =>
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("data-action-id"))
        .slice(0, 2);
    await waitFor(() =>
      expect(localPrefix()).toEqual(["Pane.Search", "Pane.Refresh"]),
    );
    const pending = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Refresh",
    });
    expect(pending).toHaveAttribute("data-action-availability", "Blocked");
    expect(pending).toHaveAccessibleDescription(
      "Available when this pane finishes loading.",
    );

    lifecycle.settleTerminalDetail();

    await waitFor(() =>
      expect(
        within(screen.getByRole("menu")).getByRole("menuitem", {
          name: "Refresh",
        }),
      ).toHaveAttribute("data-action-availability", "Available"),
    );
    expect(localPrefix()).toEqual(["Pane.Search", "Pane.Refresh"]);
  });

  // The pane's canonical identity is its route key. Gating it on the detail read
  // left the menu with no subject at all: it resolved no snapshot, rendered no
  // resource suffix, and — because the loading row only exists once a subject
  // does — announced nothing either. A reader, and any one-shot reader of this
  // surface, saw a settled menu that was still missing every resource action.
  it("resolves the Podcast's canonical actions from its route identity, before the detail read lands", async () => {
    const lifecycle = stubTerminalDetailCommittedAfterTheFirstEpisodeRead({
      deferActionSnapshots: true,
    });

    render(
      <PodcastDetailPane
        initialHref={`/podcasts/${PODCAST_ID}`}
        replaced={[]}
      />,
    );

    await lifecycle.detailStarted;
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(
      await within(screen.getByRole("menu")).findByRole("menuitem", {
        name: "Resource actions are loading…",
      }),
      "the menu claimed to be settled while it carried no resource suffix",
    ).toBeTruthy();

    lifecycle.releaseActionSnapshots();

    await waitFor(() =>
      expect(
        within(screen.getByRole("menu")).queryByRole("menuitem", {
          name: "Resource actions are loading…",
        }),
      ).toBeNull(),
    );
    // The detail read is still in flight: identity never depended on it.
    expect(
      screen.queryByRole("link", { name: "The Crew-4 Astronauts" }),
    ).toBeNull();
  });
});
