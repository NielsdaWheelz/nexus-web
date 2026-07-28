import {
  Component,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ResolvedPaneBodyMarker } from "@/lib/panes/paneRenderRegistry";
import { usePaneReturnScrollport } from "@/lib/workspace/paneReturnMemento";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import {
  definePaneReturnGeometry,
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import {
  publishLibraryPlacementChange,
  resetLibraryPlacementRevisionForTest,
} from "@/lib/libraries/placementRevision";
import {
  OPEN_LAUNCHER_EVENT,
  type OpenLauncherDetail,
} from "@/lib/launcher/launcherEvents";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import type { PanePrimaryChromePublicationUpdate } from "@/lib/panes/panePublications";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import {
  MAX_PANE_VISIT_DATA_BYTES,
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
  usePaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import LibraryPaneBody from "./LibraryPaneBody";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

// A pane host whose href is real state, so a pane-router replace (the library
// view codec's write path) re-decodes the view and drives the entries endpoint
// exactly as production does. renderHydratedPane's onReplacePane is inert, so it
// cannot exercise a user-driven view change.
function StatefulLibraryPane({
  initialHref,
  resources,
  resourceGeneration = 0,
  publishCommands,
}: {
  initialHref: string;
  resources: Record<string, unknown>;
  resourceGeneration?: number;
  publishCommands?: (commands: PaneReturnMementoCommands) => void;
}) {
  const [href, setHref] = useState(initialHref);
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneReturnMementoProvider>
      {publishCommands ? (
        <PaneReturnCommandsProbe publish={publishCommands} />
      ) : null}
      <FeedbackProvider>
        <ResourceCacheProvider key={resourceGeneration} value={resources}>
          <ShareControllerProvider>
            <PaneRuntimeProvider
              paneId="pane-1"
              visitId={TEST_VISIT_ID}
              isActive
              href={href}
              routeId={identity.routeId}
              routeKey={identity.routeKey}
              pathParams={{ id: LIBRARY_ID }}
              canGoBack={false}
              canGoForward={false}
              onNavigatePane={(_paneId: string, next: string) => setHref(next)}
              onReplacePane={(_paneId: string, next: string) => setHref(next)}
              onActivateWorkspaceTarget={vi.fn(() => ({ kind: "Unchanged" as const, paneId: "pane-1" }))}
              onGoBackPane={vi.fn()}
              onGoForwardPane={vi.fn()}
            >
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <span hidden data-testid="library-pane-href">
                    {href}
                  </span>
                  <div
                    data-pane-content="true"
                    data-testid="library-pane-scrollport"
                  >
                    <LibraryPaneBody />
                  </div>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </PaneRuntimeProvider>
          </ShareControllerProvider>
        </ResourceCacheProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}

function PaneReturnCommandsProbe({
  publish,
}: {
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  const commands = usePaneReturnMementoCommands();
  useLayoutEffect(() => publish(commands), [commands, publish]);
  return null;
}

class DefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error ? (
      <p>Library defect boundary</p>
    ) : (
      this.props.children
    );
  }
}

// AC-4 hydration-hit: when the server prefetched the library pane's primary
// resource into the bootstrap hydration cache under the bare library id (the
// same cacheKey `libraryResource` reads — see paneResourceLoaders.library seeding
// `{ library, entries }`), LibraryPaneBody must paint from the seed and never
// fetch `/api/libraries/<id>`. We exercise the real useResource → apiFetch →
// global fetch path (apiFetch is NOT mocked) and assert the library GET never
// fires. `usePanePrimaryChrome` / `usePaneSecondary` no-op without their
// contexts, so the minimal harness is FeedbackProvider + ShareControllerProvider
// + PaneRuntimeProvider.

const LIBRARY_ID = "00000000-0000-4000-8000-000000000201";
const LIBRARY_NAME = "AC-4 Seeded Library";
const ACTION_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const SETTINGS_PODCAST_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_USER_HANDLE = "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

function publishedMenuActions(
  update: PanePrimaryChromePublicationUpdate,
): readonly ActionDescriptor[] {
  const menu = update.publication?.menu;
  if (!menu) return [];
  if (menu.kind === "FlatMenu") return menu.actions;
  return [
    ...menu.groups.core,
    ...menu.groups.operations,
    ...menu.groups.relationships,
    ...menu.groups.view,
  ];
}

function seededLibrary() {
  // Minimal valid Library in the loader's composed shape. `entries: []` keeps
  // the body in its empty state, so the only candidate primary network call is
  // the library GET, which the seed serves.
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    color: "#0ea5e9",
    isDefault: false,
    role: "admin",
    ownerUserHandle: OWNER_USER_HANDLE,
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function seededSystemLibraryWithMutableMedia() {
  return {
    library: {
      id: LIBRARY_ID,
      name: "Oracle Corpus",
      color: null,
      isDefault: false,
      role: "admin",
      ownerUserHandle: OWNER_USER_HANDLE,
      systemKey: "oracle_corpus",
      canRename: false,
      canDelete: false,
      canEditEntries: false,
      canManageMembers: false,
      canTransferOwnership: false,
    },
    entries: [
      seededMediaEntry(
        "entry-1",
        "11111111-1111-4111-8111-111111111112",
        "Corpus Work",
        {
          capabilities: {
            can_delete: true,
            can_refresh_source: true,
            can_retry: true,
            can_retry_metadata: true,
          },
        },
      ),
    ],
    entriesPage: { has_more: false, next_cursor: null },
  };
}

function mediaEntryWire(
  id: string,
  mediaId: string,
  title: string,
  options: {
    readState?: "unread" | "in_progress" | "finished";
    progressFraction?: number | null;
    kind?: "web_article" | "podcast_episode";
    progressResettable?: boolean;
    totalMinutes?: number;
    remainingMinutes?: number;
    capabilities?: Record<string, boolean>;
    createdAt?: string;
  } = {},
) {
  return {
    id,
    kind: "media",
    position: 0,
    created_at: options.createdAt ?? "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: options.kind ?? "web_article",
      title,
      contributors: [],
      author_mode: "automatic",
      published_date: null,
      publisher: null,
      canonical_source_url: null,
      created_at: options.createdAt ?? "2026-01-01T00:00:00Z",
      processing_status: "ready_for_reading",
      read_state: options.readState ?? "unread",
      progress_resettable: options.progressResettable ?? false,
      progress_fraction: options.progressFraction ?? null,
      capabilities: { can_quote: true, ...options.capabilities },
    },
    readingTimeEstimate:
      options.kind === "podcast_episode"
        ? { kind: "Absent" }
        : {
            kind: "Present",
            value: {
              totalMinutes: options.totalMinutes ?? 15,
              remainingMinutes:
                options.remainingMinutes === undefined
                  ? { kind: "Absent" }
                  : { kind: "Present", value: options.remainingMinutes },
            },
          },
  };
}

function seededMediaEntry(...args: Parameters<typeof mediaEntryWire>) {
  return decodeLibraryReadingTimeEntry(mediaEntryWire(...args));
}

function seededPodcastEntry() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "podcast",
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    podcast: {
      id: SETTINGS_PODCAST_ID,
      title: "Settings Podcast",
      contributors: [],
      feed_url: "https://feeds.example.test/settings.xml",
      website_url: null,
      image_url: null,
      unplayed_count: 2,
      unplayedCount: { kind: "Present", value: { value: 2 } },
      publicationDate: { kind: "Absent" },
      syncStatus: { kind: "Present", value: "complete" },
    },
    subscription: {
      status: "active",
      default_playback_speed: 1.5,
      auto_queue: true,
      sync_status: "complete",
    },
    readingTimeEstimate: { kind: "Absent" },
  };
}

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

// LibraryPaneBody now consumes the Lectern capability (mark-finished / mark-unread /
// add-to-lectern), so it must render under a LecternProvider. The provider issues an
// initial GET /api/lectern on mount; `lecternGetResponse` answers it with an empty
// snapshot envelope so the provider settles to Ready without console noise.
function LecternStatusProbe() {
  const lectern = useLectern();
  return (
    <>
      <span hidden data-testid="lectern-status">
        {lectern.resource.status}
      </span>
      <span hidden data-testid="lectern-mutation">
        {lectern.mutation.kind}
      </span>
    </>
  );
}

const paneWithLectern = (
  <LecternProvider>
    <LibraryPlacementControllerProvider>
      <LecternStatusProbe />
      <LibraryPaneBody />
    </LibraryPlacementControllerProvider>
  </LecternProvider>
);

// A capture/restore host that exposes `isActive`, so a test can deactivate the
// source pane before advancing a revision (an inactive pane never reconciles,
// which is what keeps the captured visit snapshot intact) and then remount at a
// new resource generation to model Back. The transient memento provider lives
// above the generation-keyed resource cache, so it persists across the remount.
function RestoreScrollport({
  paneId,
  children,
}: {
  paneId: string;
  children: ReactNode;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  usePaneReturnScrollport({ paneId, enabled: true, scrollportRef });
  return (
    <div ref={scrollportRef} data-testid="return-journey-scrollport">
      <div>
        <ResolvedPaneBodyMarker>{children}</ResolvedPaneBodyMarker>
      </div>
    </div>
  );
}

function RestorePane({
  resourceGeneration,
  isActive,
  resources,
  publishCommands,
}: {
  resourceGeneration: number;
  isActive: boolean;
  resources: Record<string, unknown>;
  publishCommands: (commands: PaneReturnMementoCommands) => void;
}) {
  const href = `/libraries/${LIBRARY_ID}`;
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneReturnMementoProvider>
      <PaneReturnCommandsProbe publish={publishCommands} />
      <FeedbackProvider>
        <ShareControllerProvider>
          <ResourceCacheProvider key={resourceGeneration} value={resources}>
            <PaneRuntimeProvider
              paneId="pane-return-journey"
              visitId={RETURN_JOURNEY_VISIT_ID}
              isActive={isActive}
              href={href}
              routeId={identity.routeId}
              routeKey={identity.routeKey}
              pathParams={{ id: LIBRARY_ID }}
              canGoBack
              canGoForward
              onNavigatePane={vi.fn()}
              onReplacePane={vi.fn()}
              onActivateWorkspaceTarget={vi.fn(() => ({
                kind: "Unchanged" as const,
                paneId: "pane-return-journey",
              }))}
              onGoBackPane={vi.fn()}
              onGoForwardPane={vi.fn()}
            >
              <RestoreScrollport paneId="pane-return-journey">
                {paneWithLectern}
              </RestoreScrollport>
            </PaneRuntimeProvider>
          </ResourceCacheProvider>
        </ShareControllerProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}

function lecternGetResponse(input: unknown): Response | null {
  const path = fetchInputPath(input);
  if (
    path === "/api/lectern" ||
    path === `/api/libraries/${LIBRARY_ID}/slate`
  ) {
    return Response.json({ data: { items: [] } });
  }
  return null;
}

function consumptionSuccessResponse(): Response {
  return Response.json({
    data: {
      outcome: { kind: "StateOnly" },
      lectern: { items: [] },
      nextItem: { kind: "Absent" },
      progressState: { kind: "Absent" },
      completionHandle: { kind: "Absent" },
    },
  });
}

// The placement/consumption revision stores are module-global and vitest shares
// module state across a file's tests. Reset placement before each test so the
// pane can claim its bootstrap seed (only at process revision zero); the
// consumption store has no reset export, so the consumption-publishing tests are
// grouped LAST in this file to keep every seed-adoption test above them at zero.
beforeEach(() => {
  resetLibraryPlacementRevisionForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LibraryPaneBody (AC-4 hydration hit)", () => {
  it.each([320, 390, 960])(
    "keeps a populated canonical row within the real %ipx Library pane host",
    async (width) => {
      stubFetch(async (input) => {
        const lectern = lecternGetResponse(input);
        if (lectern) return lectern;
        return Response.json({});
      });
      const longTitle =
        "A deliberately long Library title that must wrap compactly without widening the pane";

      renderHydratedPane({
        href: `/libraries/${LIBRARY_ID}`,
        resources: {
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry("entry-width", ACTION_MEDIA_ID, longTitle),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        },
        children: (
          <div
            data-testid={`library-host-${width}`}
            style={{ width: `${width}px`, maxWidth: `${width}px` }}
          >
            {paneWithLectern}
          </div>
        ),
      });

      expect(await screen.findByRole("link", { name: longTitle })).toBeVisible();
      const host = screen.getByTestId(`library-host-${width}`);
      expect(host.clientWidth).toBe(width);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      expect(horizontallyScrollableElements(host)).toEqual([]);
      expect(
        screen.getByRole("list", { name: LIBRARY_NAME }),
      ).toBeVisible();
      expect(screen.queryByRole("img")).toBeNull();
      expect(screen.queryByRole("progressbar")).toBeNull();
    },
  );

  it("paints from the bootstrap seed without fetching the library resource", async () => {
    // Any fetch of the library resource is a failure signal; reject it loudly
    // and resolve everything else empty so a stray call never masks the assertion.
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}`) {
        throw new Error(`library resource fetched: ${String(input)}`);
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    const { onSetPaneLabel } = renderHydratedPane({
      href,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    // Seed consumed: the pane left the loading state and rendered the seeded
    // library's empty body (proves resource.data.library/entries drove render).
    expect(
      await screen.findByText("No podcasts or media in this library yet."),
    ).toBeInTheDocument();

    // Seed surfaced: the pane label is published from the seeded library name.
    await waitFor(() => {
      expect(onSetPaneLabel).toHaveBeenCalledWith(
        expect.objectContaining({ label: LIBRARY_NAME }),
      );
    });

    // The hydration hit: the primary library GET never fired.
    const libraryCalls = fetchCallsForPath(
      fetchMock,
      `/api/libraries/${LIBRARY_ID}`,
    );
    expect(libraryCalls).toHaveLength(0);
  });

  it("seeds editable library context into direct Add intent", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return Response.json({});
    });
    const publish =
      vi.fn<(update: PanePrimaryChromePublicationUpdate) => void>();
    const details: OpenLauncherDetail[] = [];
    const onOpen = (event: Event) => {
      details.push((event as CustomEvent<OpenLauncherDetail>).detail);
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, onOpen);

    try {
      renderHydratedPane({
        href: `/libraries/${LIBRARY_ID}`,
        resources: {
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [],
            entriesPage: { has_more: false, next_cursor: null },
          },
        },
        children: (
          <PanePrimaryChromeProvider publish={publish}>
            {paneWithLectern}
          </PanePrimaryChromeProvider>
        ),
      });

      let update: PanePrimaryChromePublicationUpdate | undefined;
      await waitFor(() => {
        update = publish.mock.calls
          .map(([value]) => value)
          .find((value) =>
            publishedMenuActions(value).some(
              (option) => option.id === "ViewAction.Library.AddContent",
            ),
          );
        expect(update).toBeDefined();
      });
      const add = update
        ? publishedMenuActions(update).find(
            (option) => option.id === "ViewAction.Library.AddContent",
          )
        : undefined;
      expect(update?.publication?.menu?.kind).toBe("ResourceMenu");
      if (update?.publication?.menu?.kind === "ResourceMenu") {
        expect(update.publication.menu.groups.core).toEqual([]);
      }
      expect(add?.kind).toBe("command");
      if (add?.kind !== "command")
        throw new Error("Add content command was not published");

      add.onSelect({ triggerEl: null });

      expect(details).toEqual([
        {
          kind: "Add",
          seed: {
            kind: "Content",
            initialFocus: "Url",
            initialDestinations: [
              { id: LIBRARY_ID, name: LIBRARY_NAME, color: "#0ea5e9" },
            ],
          },
        },
      ]);
    } finally {
      window.removeEventListener(OPEN_LAUNCHER_EVENT, onOpen);
    }
  });

  it("derives canonical media actions from media capabilities, not library editability", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    renderHydratedPane({
      href,
      resources: { [LIBRARY_ID]: seededSystemLibraryWithMutableMedia() },
      children: paneWithLectern,
    });

    expect(await screen.findByRole("link", { name: "Corpus Work" })).toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Corpus Work",
      }),
    );

    expect(
      await screen.findByRole("menuitem", {
        name: "Chat about this resource",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Retry processing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Refresh source" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Re-enrich metadata" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Share…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Remove media" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move down" }),
    ).not.toBeInTheDocument();
  });

  it("opens podcast settings from the existing library subscription facts", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === "/api/resource-graph/connections/summary") {
        return Response.json({ data: { summaries: [] } });
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededPodcastEntry()],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Settings Podcast",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(
      screen.getByRole("dialog", { name: "Subscription settings" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Default playback speed" }),
    ).toHaveValue("1.5");
    expect(
      screen.getByRole("checkbox", {
        name: "Automatically add new episodes to my queue",
      }),
    ).toBeChecked();
    expect(
      fetchCallsForPath(fetchMock, `/api/podcasts/${SETTINGS_PODCAST_ID}`),
    ).toHaveLength(0);
  });

  it("loads another page of library entries", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-2",
              "22222222-2222-4222-8222-222222222222",
              "Second Page Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const href = `/libraries/${LIBRARY_ID}`;
    renderHydratedPane({
      href,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "First Page Work",
            ),
          ],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByRole("link", { name: "First Page Work" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    expect(await screen.findByRole("link", { name: "Second Page Work" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("restores loaded entry pages and their semantic eye-line without refetching or duplication", async () => {
    const user = userEvent.setup();
    let primaryResourceRequests = 0;
    let loadMoreRequests = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`) {
        loadMoreRequests += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-2",
              "22222222-2222-4222-8222-222222222222",
              "Second Page Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (
        path === `/api/libraries/${LIBRARY_ID}` ||
        path === `/api/libraries/${LIBRARY_ID}/entries`
      ) {
        primaryResourceRequests += 1;
        return Response.json({
          data: [
            mediaEntryWire("replacement", "replacement", "Replacement Work"),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/libraries/${LIBRARY_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (resourceGeneration: number) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={
          resourceGeneration === 0
            ? {
                [LIBRARY_ID]: {
                  library: seededLibrary(),
                  entries: [
                    seededMediaEntry(
                      "entry-1",
                      "11111111-1111-4111-8111-111111111112",
                      "First Page Work",
                    ),
                  ],
                  entriesPage: {
                    has_more: true,
                    next_cursor: "cursor-2",
                  },
                },
              }
            : {}
        }
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        {paneWithLectern}
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(await screen.findByRole("link", { name: "First Page Work" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(await screen.findByRole("link", { name: "Second Page Work" })).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(sourceScrollport, {
      "entry-1": 0,
      "entry-2": 120,
    });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(1));

    const restoredScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(restoredScrollport, {
      "entry-1": 0,
      "entry-2": 120,
    });
    expect(screen.getByRole("link", { name: "First Page Work" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Second Page Work" })).toBeInTheDocument();
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    const restoredSecondTitle = screen.getByRole("link", { name: "Second Page Work" });
    const restoredSecondRow =
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the scoped semantic-anchor attributes are the observable restoration contract under test.
      restoredSecondTitle.closest<HTMLElement>(
        "[data-collection-row-id]",
      );
    expect(restoredSecondRow).toHaveAttribute(
      "data-collection-row-id",
      "entry-2",
    );
    expect(
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: row ids are collision-safe only together with their nearest published scope.
      restoredSecondRow?.closest("[data-pane-return-scope]"),
    ).toHaveAttribute("data-pane-return-scope", "Library.Entries");
    expect(restoredSecondRow?.getBoundingClientRect().top).toBe(20);
    expect(loadMoreRequests).toBe(1);
    expect(primaryResourceRequests).toBe(0);
    expect(screen.queryByText("Replacement Work")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "First Page Work" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Second Page Work" })).toHaveLength(1);
  });

  it("captures only a coherent committed factual view and its loaded pages", async () => {
    const user = userEvent.setup();
    const canonicalHref = `/libraries/${LIBRARY_ID}`;
    const factualHref = `${canonicalHref}?sort=title&direction=asc`;
    const factualPath =
      `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`;
    const factualPageTwoPath = `${factualPath}&cursor=cursor-factual-2`;
    let resolveSupersededRequest!: (response: Response) => void;
    const supersededRequest = new Promise<Response>((resolve) => {
      resolveSupersededRequest = resolve;
    });
    let factualAttempts = 0;
    let factualPageTwoRequests = 0;
    let libraryRequests = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}`) {
        libraryRequests += 1;
        return Response.json({ data: seededLibrary() });
      }
      if (path === factualPath) {
        factualAttempts += 1;
        if (factualAttempts === 1) return supersededRequest;
        if (factualAttempts === 2) {
          return Response.json(
            {
              error: {
                code: "E_FORBIDDEN",
                message: "The requested view is unavailable",
              },
            },
            { status: 403 },
          );
        }
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-factual-1",
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "Committed Factual Work",
            ),
          ],
          page: {
            has_more: true,
            next_cursor: "cursor-factual-2",
          },
        });
      }
      if (path === factualPageTwoPath) {
        factualPageTwoRequests += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-factual-2",
              "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              "Committed Factual Page Two",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-canonical-network",
              "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              "Canonical Network Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (fetchInputPath(input) === "/api/resource-graph/connections/summary") {
        return Response.json({ data: { summaries: [] } });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const seededResources = {
      [LIBRARY_ID]: {
        library: seededLibrary(),
        entries: [
          seededMediaEntry(
            "entry-canonical",
            "11111111-1111-4111-8111-111111111112",
            "Canonical Work",
          ),
        ],
        entriesPage: { has_more: false, next_cursor: null },
      },
    };
    const journey = (
      href: string,
      resourceGeneration: number,
      resources: Record<string, unknown>,
    ) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={resources}
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        {paneWithLectern}
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(canonicalHref, 0, seededResources));
    const factualRouteKey = resolvePaneRouteIdentity(factualHref).routeKey;

    expect(await screen.findByRole("link", { name: "Canonical Work" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await waitFor(() => expect(commands).not.toBeNull());
    view.rerender(journey(factualHref, 0, seededResources));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading All items · Title — A–Z. Showing All items · Custom order.",
    );
    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey: factualRouteKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(factualHref, 1, {}));
    // Metadata is known (route resource) but no page committed and the exact
    // first page failed: the single status node carries the initial failure copy
    // with no committed view to "show".
    expect(
      await screen.findByText("Could not load All items · Title — A–Z."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    expect(factualAttempts).toBe(2);
    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey: factualRouteKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(factualHref, 2, {}));
    expect(
      await screen.findByRole("link", { name: "Committed Factual Work" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    expect(factualAttempts).toBe(3);
    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(
      await screen.findByRole("link", { name: "Committed Factual Page Two" }),
    ).toBeInTheDocument();
    const libraryRequestsBeforeRestore = libraryRequests;
    const factualAttemptsBeforeRestore = factualAttempts;
    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey: factualRouteKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(factualHref, 3, {}));
    expect(screen.getByRole("link", { name: "Committed Factual Work" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Committed Factual Page Two" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more entries" }),
    ).not.toBeInTheDocument();
    expect(libraryRequests).toBe(libraryRequestsBeforeRestore);
    expect(factualAttempts).toBe(factualAttemptsBeforeRestore);
    expect(factualPageTwoRequests).toBe(1);

    resolveSupersededRequest(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-stale",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "Superseded Factual Work",
          ),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );
    await act(async () => {
      await supersededRequest;
      await Promise.resolve();
    });
    expect(screen.queryByText("Superseded Factual Work")).not.toBeInTheDocument();
  });

  it("refetches after an over-budget snapshot while preserving the final raw return clamp", async () => {
    const oversizedBase = seededMediaEntry(
      "entry-oversized",
      "66666666-6666-4666-8666-666666666666",
      "Oversized Work",
    );
    const oversizedEntry = {
      ...oversizedBase,
      media: {
        ...oversizedBase.media,
        canonical_source_url: "x".repeat(MAX_PANE_VISIT_DATA_BYTES + 1),
      },
    };
    let libraryRequests = 0;
    let entriesRequests = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}`) {
        libraryRequests += 1;
        return Response.json({ data: seededLibrary() });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesRequests += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-replacement",
              "77777777-7777-4777-8777-777777777777",
              "Replacement Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/libraries/${LIBRARY_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (resourceGeneration: number) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={
          resourceGeneration === 0
            ? {
                [LIBRARY_ID]: {
                  library: seededLibrary(),
                  entries: [oversizedEntry],
                  entriesPage: { has_more: false, next_cursor: null },
                },
              }
            : {}
        }
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
      >
        {paneWithLectern}
      </PaneReturnJourneyHarness>
    );
    const view = render(journey(0));

    expect(await screen.findByRole("link", { name: "Oversized Work" })).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(sourceScrollport, { "entry-oversized": 120 });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(journey(1));

    const restoredScrollport = screen.getByTestId("return-journey-scrollport");
    definePaneReturnGeometry(restoredScrollport, {});
    expect(await screen.findByRole("link", { name: "Replacement Work" })).toBeInTheDocument();
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    expect(libraryRequests).toBe(1);
    expect(entriesRequests).toBe(1);
    expect(screen.queryByText("Oversized Work")).not.toBeInTheDocument();
  });

  it("loads another page of a factually sorted view with the view query", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-t1",
              "44444444-4444-4444-8444-444444444444",
              "Alpha Work",
            ),
          ],
          page: { has_more: true, next_cursor: "cursor-2" },
        });
      }
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc&cursor=cursor-2`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-t2",
              "55555555-5555-4555-8555-555555555555",
              "Beta Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    // The factual first page comes from the endpoint, not the canonical seed.
    expect(await screen.findByRole("link", { name: "Alpha Work" })).toBeInTheDocument();
    expect(screen.queryByText("Canonical Seed")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    expect(await screen.findByRole("link", { name: "Beta Work" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc&cursor=cursor-2`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects a malformed load-more entry at the shared reading-time boundary", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`
      ) {
        const invalid = mediaEntryWire(
          "entry-2",
          "22222222-2222-4222-8222-222222222222",
          "Invalid Work",
        );
        Reflect.deleteProperty(invalid, "readingTimeEstimate");
        return Response.json({
          data: [invalid],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "Valid Work",
            ),
          ],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Valid Work" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(
      await screen.findByText("Failed to load more entries"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid Work")).not.toBeInTheDocument();
  });

  it("rejects a malformed factual first-page entry at the reading-time boundary", async () => {
    const onDefect = vi.fn<(error: unknown) => void>();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        const invalid = mediaEntryWire(
          "entry-t1",
          "44444444-4444-4444-8444-444444444444",
          "Invalid Work",
        );
        Reflect.deleteProperty(invalid, "readingTimeEstimate");
        return Response.json({
          data: [invalid],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: (
        <DefectBoundary onDefect={onDefect}>
          {paneWithLectern}
        </DefectBoundary>
      ),
    });

    expect(
      await screen.findByText("Library defect boundary"),
    ).toBeInTheDocument();
    expect(onDefect).toHaveBeenCalledWith(
      expect.objectContaining({ code: "E_INVALID_RESPONSE" }),
    );
    expect(screen.queryByText("Invalid Work")).not.toBeInTheDocument();
  });

  it("optimistically shows finished state and restores progress without losing a concurrent page", async () => {
    const user = userEvent.setup();
    let resolveConsumption!: (response: Response) => void;
    const pendingConsumption = new Promise<Response>((resolve) => {
      resolveConsumption = resolve;
    });
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/consumption/commands") {
        return pendingConsumption;
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2`) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-2",
              "22222222-2222-4222-8222-222222222222",
              "Concurrent Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Progressive Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
            }),
          ],
          entriesPage: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );
    expect(await screen.findByText("Finished")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(await screen.findByRole("link", { name: "Concurrent Work" })).toBeInTheDocument();

    resolveConsumption(
      Response.json(
        { error: { code: "E_INVALID", message: "rejected" } },
        { status: 400 },
      ),
    );

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Concurrent Work" })).toBeInTheDocument();
  });

  it("guards same-media read-state re-entry while a command is pending", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let commandCount = 0;
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === "/api/consumption/commands") {
        commandCount += 1;
        return commandCount === 1
          ? firstResponse
          : consumptionSuccessResponse();
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Progressive Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
            }),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Marking..." }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Marking..." }));
    expect(
      fetchCallsForPath(fetchMock, "/api/consumption/commands"),
    ).toHaveLength(1);
    await user.keyboard("{Escape}");

    resolveFirst(
      Response.json(
        { error: { code: "E_INVALID", message: "rejected" } },
        { status: 400 },
      ),
    );

    await waitFor(() =>
      expect(
        fetchCallsForPath(fetchMock, "/api/consumption/commands"),
      ).toHaveLength(1),
    );
    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Progressive Work" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    ).toBeInTheDocument();
  });

  it("suppresses a stale estimate under a factual view after a source refresh", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return Response.json({
          data: [
            mediaEntryWire("entry-t1", ACTION_MEDIA_ID, "Refreshing Work", {
              readState: "in_progress",
              progressFraction: 0.5,
              remainingMinutes: 5,
              capabilities: { can_refresh_source: true },
            }),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === `/api/media/${ACTION_MEDIA_ID}/refresh`) {
        return Response.json({
          data: {
            media_id: ACTION_MEDIA_ID,
            source_attempt_id: "attempt-1",
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "refreshed",
            processing_status: "extracting",
            ingest_enqueued: true,
            capabilities: {
              can_read: false,
              can_highlight: false,
              can_quote: false,
              can_search: false,
              can_play: false,
              can_download_file: false,
              can_delete: true,
              can_retry: false,
              can_refresh_source: false,
              can_retry_metadata: false,
            },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByText("50% · ≈5 min left")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Refreshing Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Refresh source" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("50% · ≈5 min left")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Processing")).toBeInTheDocument();
  });

  it("re-enriches metadata from a capable media row without consuming the server capability", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input, init) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPath(input);
      if (path === "/api/resource-graph/connections/summary") {
        return Response.json({ data: { summaries: [] } });
      }
      if (path === `/api/media/${ACTION_MEDIA_ID}/retry`) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ from_stage: "metadata" }));
        return Response.json({ data: { accepted: true } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "44444444-4444-4444-8444-444444444444",
              ACTION_MEDIA_ID,
              "Metadata Work",
              { capabilities: { can_retry_metadata: true } },
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Metadata Work",
      }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Re-enrich metadata" }),
    );

    await waitFor(() =>
      expect(
        fetchCallsForPath(fetchMock, `/api/media/${ACTION_MEDIA_ID}/retry`),
      ).toHaveLength(1),
    );
    await user.click(
      screen.getByRole("button", {
        name: "More actions for Metadata Work",
      }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Re-enrich metadata" }),
    ).toBeInTheDocument();
  });

  it("opens the shared authors editor from a capable media row", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPath(input);
      if (path === "/api/resource-graph/connections/summary") {
        return Response.json({ data: { summaries: [] } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "55555555-5555-4555-8555-555555555555",
              ACTION_MEDIA_ID,
              "Authored Work",
              { capabilities: { can_edit_authors: true } },
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Authored Work",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit authors…" }));

    expect(
      await screen.findByRole("dialog", { name: "Edit authors" }),
    ).toBeVisible();
  });

  it("keeps the committed collection interactive shell intact until an exact view commits", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    let resolveCreator!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    const pendingCreator = new Promise<Response>((resolve) => {
      resolveCreator = resolve;
    });
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return pendingTitle;
      }
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=creator&direction=asc`
      ) {
        return pendingCreator;
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                ACTION_MEDIA_ID,
                "First Canonical Work",
                { capabilities: { can_delete: true } },
              ),
              seededMediaEntry(
                "entry-2",
                "22222222-2222-4222-8222-222222222223",
                "Second Canonical Work",
                { capabilities: { can_delete: true } },
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByRole("link", { name: "First Canonical Work" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "More actions for First Canonical Work",
      }),
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toBeEnabled();
    expect(
      screen.getByRole("menuitem", { name: "Remove media" }),
    ).toBeEnabled();
    await user.keyboard("{Escape}");

    const sortSelect = screen.getByRole("combobox", { name: "Sort by" });
    const scrollport = screen.getByTestId("library-pane-scrollport");
    scrollport.scrollTop = 180;
    await user.selectOptions(sortSelect, "title-asc");

    expect(sortSelect).toHaveFocus();
    expect(sortSelect).toHaveValue("title-asc");
    expect(screen.getByTestId("library-pane-href")).toHaveTextContent(
      `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
    );
    expect(screen.getByRole("link", { name: "First Canonical Work" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Second Canonical Work" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading All items · Title — A–Z. Showing All items · Custom order.",
    );
    expect(
      screen.getByRole("region", { name: LIBRARY_NAME }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("link", { name: "First Canonical Work" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "More actions for First Canonical Work",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more entries" }),
    ).not.toBeInTheDocument();

    resolveTitle(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-t1",
            "44444444-4444-4444-8444-444444444444",
            "Titled Work",
          ),
        ],
        page: { has_more: true, next_cursor: "cursor-title-2" },
      }),
    );

    expect(await screen.findByRole("link", { name: "Titled Work" })).toBeInTheDocument();
    expect(screen.queryByText("First Canonical Work")).not.toBeInTheDocument();
    expect(sortSelect).toHaveFocus();
    expect(scrollport.scrollTop).toBe(0);
    expect(
      screen.getByRole("button", { name: "Load more entries" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: LIBRARY_NAME }),
    ).not.toHaveAttribute("aria-busy");

    await user.selectOptions(sortSelect, "creator-asc");

    expect(screen.getByRole("link", { name: "Titled Work" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more entries" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading All items · Creator — A–Z. Showing All items · Title — A–Z.",
    );

    resolveCreator(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-c1",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "Creator Work",
          ),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );

    expect(await screen.findByRole("link", { name: "Creator Work" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("keeps an honest failed view visible and retries the exact request", async () => {
    const user = userEvent.setup();
    let titleAttempts = 0;
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        titleAttempts += 1;
        if (titleAttempts === 1) {
          return Response.json(
            {
              error: {
                code: "E_FORBIDDEN",
                message: "The requested view is unavailable",
              },
            },
            { status: 403 },
          );
        }
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-t1",
              "44444444-4444-4444-8444-444444444444",
              "Recovered Title Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by" });
    await user.selectOptions(sortSelect, "title-asc");

    const failedStatus = await screen.findByRole("status");
    expect(failedStatus).toHaveTextContent(
      "Could not load All items · Title — A–Z. Showing All items · Custom order.",
    );
    expect(screen.getByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    expect(sortSelect).toHaveValue("title-asc");
    expect(screen.getByTestId("library-pane-href")).toHaveTextContent(
      `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
    );
    expect(
      screen.getByRole("region", { name: LIBRARY_NAME }),
    ).not.toHaveAttribute("aria-busy");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("link", { name: "Recovered Title Work" })).toBeInTheDocument();
    expect(screen.queryByText("Canonical Seed")).not.toBeInTheDocument();
    expect(
      fetchCallsForPath(fetchMock, `/api/libraries/${LIBRARY_ID}/entries`),
    ).toHaveLength(2);
  });

  it("keeps the current failure honest after a superseded malformed response", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    let titleSignal: AbortSignal | null = null;
    let creatorAttempts = 0;
    const fetchMock = stubFetch(async (input, init) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        titleSignal = init?.signal ?? null;
        return pendingTitle;
      }
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=creator&direction=asc`
      ) {
        creatorAttempts += 1;
        if (creatorAttempts === 1) {
          return Response.json(
            {
              error: {
                code: "E_FORBIDDEN",
                message: "Creator view is unavailable",
              },
            },
            { status: 403 },
          );
        }
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-c1",
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "Recovered Creator Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const resources = {
      [LIBRARY_ID]: {
        library: seededLibrary(),
        entries: [
          seededMediaEntry(
            "entry-1",
            "11111111-1111-4111-8111-111111111112",
            "Canonical Seed",
          ),
        ],
        entriesPage: { has_more: false, next_cursor: null },
      },
    };
    const renderPane = () => (
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={resources}
      />
    );
    const view = render(renderPane());

    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by" });
    await user.selectOptions(sortSelect, "title-asc");
    await waitFor(() => expect(titleSignal).not.toBeNull());
    await user.selectOptions(sortSelect, "creator-asc");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not load All items · Creator — A–Z. Showing All items · Custom order.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect((titleSignal as AbortSignal | null)?.aborted).toBe(true);

    const malformedTitle = mediaEntryWire(
      "entry-t1",
      "44444444-4444-4444-8444-444444444444",
      "Malformed stale title",
    );
    Reflect.deleteProperty(malformedTitle, "readingTimeEstimate");
    await act(async () => {
      resolveTitle(
        Response.json({
          data: [malformedTitle],
          page: { has_more: false, next_cursor: null },
        }),
      );
      await pendingTitle;
      await Promise.resolve();
    });
    view.rerender(renderPane());

    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not load All items · Creator — A–Z. Showing All items · Custom order.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByText("Malformed stale title")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Recovered Creator Work" })).toBeVisible();
    expect(creatorAttempts).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          fetchInputPathWithSearch(input) ===
          `/api/libraries/${LIBRARY_ID}/entries?sort=creator&direction=asc`,
      ),
    ).toHaveLength(2);
  });

  it("fetches canonical truth when a pending factual request returns to the bootstrap view", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    let titleSignal: AbortSignal | null = null;
    const canonicalPath = `/api/libraries/${LIBRARY_ID}/entries`;
    const titlePath = `${canonicalPath}?sort=title&direction=asc`;
    const fetchMock = stubFetch(async (input, init) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === titlePath) {
        titleSignal = init?.signal ?? null;
        return pendingTitle;
      }
      if (path === canonicalPath) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-fresh",
              "99999999-9999-4999-8999-999999999999",
              "Fresh Canonical Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-seed",
                "11111111-1111-4111-8111-111111111112",
                "Bootstrap Canonical Work",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Bootstrap Canonical Work" }),
    ).toBeInTheDocument();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by" });
    await user.selectOptions(sortSelect, "title-asc");
    await waitFor(() =>
      expect(fetchCallsForPath(fetchMock, canonicalPath)).toHaveLength(1),
    );

    await user.selectOptions(sortSelect, "canonical");

    expect(await screen.findByRole("link", { name: "Fresh Canonical Work" })).toBeInTheDocument();
    expect(screen.queryByText("Bootstrap Canonical Work")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => fetchInputPathWithSearch(input) === canonicalPath,
      ),
    ).toHaveLength(1);
    expect((titleSignal as AbortSignal | null)?.aborted).toBe(true);

    resolveTitle(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-stale",
            "44444444-4444-4444-8444-444444444444",
            "Stale Title Work",
          ),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );
    await act(async () => {
      await pendingTitle;
      await Promise.resolve();
    });
    expect(screen.getByRole("link", { name: "Fresh Canonical Work" })).toBeInTheDocument();
    expect(screen.queryByText("Stale Title Work")).not.toBeInTheDocument();
  });

  it("toggles Hide finished, requesting completion=unfinished", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?completion=unfinished`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-u1",
              "88888888-8888-4888-8888-888888888888",
              "Unfinished Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Hide finished" }));

    expect(await screen.findByRole("link", { name: "Unfinished Work" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?completion=unfinished`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("renders the filtered-empty notice with a Show finished recovery", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?completion=unfinished`) {
        return Response.json({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-current",
              "77777777-7777-4777-8777-777777777777",
              "Current Canonical Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}?completion=unfinished`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByText("No unfinished items.")).toBeInTheDocument();
    // The toolbar controls stay visible in the filtered-empty state.
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show finished" }));

    expect(await screen.findByRole("link", { name: "Current Canonical Work" })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) =>
          fetchInputPathWithSearch(input) ===
          `/api/libraries/${LIBRARY_ID}/entries`,
      ),
    ).toHaveLength(1);
    expect(screen.queryByText("No unfinished items.")).not.toBeInTheDocument();
  });

  it("renders the Invalid library view state with a Reset view recovery", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // sort absent + direction present decodes to an Invalid view.
    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}?direction=asc`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByText("Invalid library view")).toBeInTheDocument();
    expect(screen.queryByText("Canonical Seed")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Sort by" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset view" }));

    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    expect(screen.queryByText("Invalid library view")).not.toBeInTheDocument();
  });

  it("shows an Added line under the Added order and not under the canonical order", async () => {
    const addedIso = "2026-03-04T00:00:00Z";
    const expectedAdded = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(addedIso));
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=added&direction=desc`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-a1",
              "99999999-9999-4999-8999-999999999999",
              "Dated Work",
              {
                createdAt: addedIso,
              },
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Canonical order: no Added line.
    const { unmount } = render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
                {
                  createdAt: addedIso,
                },
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );
    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    expect(
      screen.queryByText(`Added ${expectedAdded}`),
    ).not.toBeInTheDocument();
    unmount();

    // Added order: the Added line renders.
    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}?sort=added&direction=desc`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );
    expect(await screen.findByRole("link", { name: "Dated Work" })).toBeInTheDocument();
    expect(screen.getByText(`Added ${expectedAdded}`)).toBeInTheDocument();
  });

  it("hides reorder handles under a factual sort even when reorder is otherwise allowed", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-t1",
              "44444444-4444-4444-8444-444444444444",
              "Alpha Work",
            ),
            mediaEntryWire(
              "entry-t2",
              "55555555-5555-4555-8555-555555555555",
              "Beta Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=title&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-1",
              "11111111-1111-4111-8111-111111111112",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByRole("link", { name: "Alpha Work" })).toBeInTheDocument();
    // Reorder is gated to the canonical/all view, so no per-row Move up/down.
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "More actions for Alpha Work" }),
      );
    expect(
      screen.queryByRole("menuitem", { name: "Move up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move down" }),
    ).not.toBeInTheDocument();
  });

  it("aborts a superseded view and ignores its late response", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    let resolveCreator!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    const pendingCreator = new Promise<Response>((resolve) => {
      resolveCreator = resolve;
    });
    let titleSignal: AbortSignal | null = null;
    const fetchMock = stubFetch(async (input, init) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        titleSignal = init?.signal ?? null;
        return pendingTitle;
      }
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=creator&direction=asc`
      ) {
        return pendingCreator;
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByRole("link", { name: "Canonical Seed" })).toBeInTheDocument();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by" });
    await user.selectOptions(sortSelect, "title-asc");
    await waitFor(() =>
      expect(
        fetchCallsForPath(
          fetchMock,
          `/api/libraries/${LIBRARY_ID}/entries`,
        ),
      ).toHaveLength(1),
    );

    await user.selectOptions(sortSelect, "creator-asc");
    await waitFor(() => expect(titleSignal?.aborted).toBe(true));

    resolveCreator(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-c1",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "Creator Work",
          ),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );

    expect(await screen.findByRole("link", { name: "Creator Work" })).toBeInTheDocument();
    resolveTitle(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-t1",
            "44444444-4444-4444-8444-444444444444",
            "Stale Title Work",
          ),
        ],
        page: { has_more: true, next_cursor: "cursor-title-2" },
      }),
    );

    await act(async () => {
      await pendingTitle;
      await Promise.resolve();
    });
    expect(screen.getByRole("link", { name: "Creator Work" })).toBeInTheDocument();
    expect(screen.queryByText("Stale Title Work")).not.toBeInTheDocument();
    expect(sortSelect).toHaveValue("creator-asc");
  });

  it("offers a named library All items and In Progress, but not Unfiled", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    const viewSelect = await screen.findByRole("combobox", { name: "View" });
    expect(within(viewSelect).getByRole("option", { name: "All items" })).toBeInTheDocument();
    expect(
      within(viewSelect).getByRole("option", { name: "In Progress" }),
    ).toBeInTheDocument();
    expect(
      within(viewSelect).queryByRole("option", { name: "Unfiled" }),
    ).not.toBeInTheDocument();
  });

  it("switches View to In Progress with the projection query, retaining rows and status", async () => {
    const user = userEvent.setup();
    let resolveInProgress!: (response: Response) => void;
    const pendingInProgress = new Promise<Response>((resolve) => {
      resolveInProgress = resolve;
    });
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?projection=in-progress`) {
        return pendingInProgress;
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                ACTION_MEDIA_ID,
                "Canonical Work",
                { readState: "in_progress", progressFraction: 0.4, remainingMinutes: 9 },
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Canonical Work" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "View" }),
      "in-progress",
    );

    // The In Progress projection query is issued; the prior committed row and
    // controls stay; the status announces the retained lifecycle; Hide finished
    // is gone (In Progress carries no completion).
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?projection=in-progress`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(screen.getByTestId("library-pane-href")).toHaveTextContent(
      `/libraries/${LIBRARY_ID}?projection=in-progress`,
    );
    expect(
      screen.getByRole("link", { name: "Canonical Work" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading In Progress · Custom order. Showing All items · Custom order.",
    );
    expect(
      screen.getByRole("region", { name: LIBRARY_NAME }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("checkbox", { name: "Hide finished" }),
    ).not.toBeInTheDocument();

    resolveInProgress(
      Response.json({
        data: [
          mediaEntryWire("entry-p", ACTION_MEDIA_ID, "In Progress Work", {
            readState: "in_progress",
            progressFraction: 0.4,
            remainingMinutes: 9,
          }),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );
    expect(
      await screen.findByRole("link", { name: "In Progress Work" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: LIBRARY_NAME }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("places the polite status node outside the busy region with aria-controls", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`) {
        return pendingTitle;
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Canonical Seed" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort by" }),
      "title-asc",
    );

    const status = screen.getByRole("status");
    const region = screen.getByRole("region", { name: LIBRARY_NAME });
    // The status node points at the busy region and is not nested inside it.
    expect(status).toHaveAttribute("aria-controls", region.id);
    expect(region.id).toBeTruthy();
    expect(region.contains(status)).toBe(false);

    resolveTitle(
      Response.json({
        data: [
          mediaEntryWire(
            "entry-t",
            "44444444-4444-4444-8444-444444444444",
            "Titled Work",
          ),
        ],
        page: { has_more: false, next_cursor: null },
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Titled Work" }),
    ).toBeInTheDocument();
  });

  it("renders the In Progress empty state with a Show all items recovery", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?projection=in-progress`) {
        return Response.json({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-all",
              "77777777-7777-4777-8777-777777777777",
              "All Items Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}?projection=in-progress`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Canonical Seed",
              ),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    expect(await screen.findByText("Nothing in progress.")).toBeInTheDocument();
    // Controls stay visible in the empty state.
    expect(screen.getByRole("combobox", { name: "View" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all items" }));

    expect(
      await screen.findByRole("link", { name: "All Items Work" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries`,
      expect.objectContaining({ method: "GET" }),
    );
    // Recovery focuses the View select after the matching commit.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "View" })).toHaveFocus(),
    );
  });

  it("recovers a stale continuation cursor with Refresh list", async () => {
    const user = userEvent.setup();
    let firstPageReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-stale`) {
        return Response.json(
          { error: { code: "E_INVALID_CURSOR", message: "Invalid cursor" } },
          { status: 400 },
        );
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        firstPageReads += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-fresh",
              "88888888-8888-4888-8888-888888888888",
              "Refreshed Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "11111111-1111-4111-8111-111111111112",
                "Seed Work",
              ),
            ],
            entriesPage: { has_more: true, next_cursor: "cursor-stale" },
          },
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Seed Work" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));

    // The stale cursor is not reinterpreted as an invalid view.
    expect(
      await screen.findByText("This list can no longer continue."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid library view")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh list" }));

    expect(
      await screen.findByRole("link", { name: "Refreshed Work" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Seed Work")).not.toBeInTheDocument();
    expect(firstPageReads).toBe(1);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "View" })).toHaveFocus(),
    );
  });

  it("reconciles a named pane when a change to it is followed by one to another library", async () => {
    let entriesReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesReads += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-new",
              "22222222-2222-4222-8222-222222222291",
              "Newly Filed",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [seededMediaEntry("entry-1", ACTION_MEDIA_ID, "Seed Work")],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Seed Work" }),
    ).toBeInTheDocument();

    // A change affecting THIS library, immediately followed by one affecting a
    // DIFFERENT library (Add-Content publishes per unit synchronously). Judging
    // staleness by the latest scope alone would mask the earlier change; the pane
    // must still reconcile.
    act(() => {
      publishLibraryPlacementChange([LIBRARY_ID]);
      publishLibraryPlacementChange(["some-other-library"]);
    });

    expect(
      await screen.findByRole("link", { name: "Newly Filed" }),
    ).toBeInTheDocument();
    expect(entriesReads).toBe(1);
  });

  it("loads the exact first page through the endpoint when a revision is non-zero at mount", async () => {
    let entriesReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesReads += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-fresh",
              "22222222-2222-4222-8222-222222222292",
              "Endpoint First Page",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // A process revision advanced before this pane mounts: the bootstrap seed can
    // no longer be claimed, so the canonical first page loads through the endpoint.
    publishLibraryPlacementChange(["unrelated-library"]);

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-seed", ACTION_MEDIA_ID, "Bootstrap Seed Row"),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Endpoint First Page" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Bootstrap Seed Row")).not.toBeInTheDocument();
    expect(entriesReads).toBe(1);
  });

  it("reconciles a restored pane whose snapshot revision is behind the advanced store", async () => {
    let entriesReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesReads += 1;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-reconciled",
              "22222222-2222-4222-8222-222222222293",
              "Reconciled Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const routeKey = resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID}`).routeKey;
    const seededResources = {
      [LIBRARY_ID]: {
        library: seededLibrary(),
        entries: [
          seededMediaEntry("entry-existing", ACTION_MEDIA_ID, "Existing Work"),
        ],
        entriesPage: { has_more: false, next_cursor: null },
      },
    };
    const view = render(
      <RestorePane
        resourceGeneration={0}
        isActive
        resources={seededResources}
        publishCommands={publishCommands}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Existing Work" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    // Deactivate the source pane, THEN advance placement affecting this library.
    // An inactive pane never reconciles, so the captured snapshot (at revision
    // zero) survives while the store moves ahead of it.
    view.rerender(
      <RestorePane
        resourceGeneration={0}
        isActive={false}
        resources={seededResources}
        publishCommands={publishCommands}
      />,
    );
    act(() => publishLibraryPlacementChange([LIBRARY_ID]));

    // Return: remount from the snapshot while still inactive, then re-activate
    // (the real Back path). The committed baseline is the snapshot's captured
    // revisions — behind the store — so on activation the pane is stale and
    // reconciles, rather than silently absorbing the advance.
    view.rerender(
      <RestorePane
        resourceGeneration={1}
        isActive={false}
        resources={{}}
        publishCommands={publishCommands}
      />,
    );
    expect(
      await screen.findByRole("link", { name: "Existing Work" }),
    ).toBeInTheDocument();
    view.rerender(
      <RestorePane
        resourceGeneration={1}
        isActive
        resources={{}}
        publishCommands={publishCommands}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Reconciled Work" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Existing Work")).not.toBeInTheDocument();
    expect(entriesReads).toBe(1);
  });

  it("shows the initial pending, then failure, keeps controls, and Retry focuses View", async () => {
    const user = userEvent.setup();
    let resolveTitle!: (response: Response) => void;
    const pendingTitle = new Promise<Response>((resolve) => {
      resolveTitle = resolve;
    });
    let titleAttempts = 0;
    const titlePath = `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPathWithSearch(input) === titlePath) {
        titleAttempts += 1;
        if (titleAttempts === 1) return pendingTitle;
        return Response.json({
          data: [
            mediaEntryWire(
              "entry-ok",
              "22222222-2222-4222-8222-222222222294",
              "Loaded Work",
            ),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}?sort=title&direction=asc`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry("entry-seed", ACTION_MEDIA_ID, "Canonical Seed"),
            ],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      />,
    );

    // Metadata known, no page committed yet: the single polite status node shows
    // EXACTLY "Loading {requested}." (no committed view to "show"), and the
    // View / Sort by / Hide finished controls are rendered around the busy region.
    const pending = await screen.findByRole("status");
    expect(pending).toHaveTextContent("Loading All items · Title — A–Z.");
    expect(pending).not.toHaveTextContent("Showing");
    expect(screen.getByRole("combobox", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Hide finished" }),
    ).toBeInTheDocument();
    const region = screen.getByRole("region", { name: LIBRARY_NAME });
    expect(pending).toHaveAttribute("aria-controls", region.id);
    expect(region.contains(pending)).toBe(false);

    resolveTitle(
      Response.json(
        { error: { code: "E_FORBIDDEN", message: "no access" } },
        { status: 403 },
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not load All items · Title — A–Z.",
      ),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("Showing");
    // Controls survive the failure.
    expect(screen.getByRole("combobox", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("link", { name: "Loaded Work" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "View" })).toHaveFocus(),
    );
  });

  it("retains the stale-cursor recovery when Refresh list fails", async () => {
    const user = userEvent.setup();
    let firstPageReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-stale`) {
        return Response.json(
          { error: { code: "E_INVALID_CURSOR", message: "Invalid cursor" } },
          { status: 400 },
        );
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        firstPageReads += 1;
        return Response.json(
          { error: { code: "E_UPSTREAM", message: "Refresh failed" } },
          { status: 503 },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulLibraryPane
        initialHref={`/libraries/${LIBRARY_ID}`}
        resources={{
          [LIBRARY_ID]: {
            library: seededLibrary(),
            entries: [
              seededMediaEntry(
                "entry-1",
                "22222222-2222-4222-8222-222222222295",
                "Seed Work",
              ),
            ],
            entriesPage: { has_more: true, next_cursor: "cursor-stale" },
          },
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Seed Work" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more entries" }));
    expect(
      await screen.findByText("This list can no longer continue."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh list" }));

    // The replacement first page fails: the SAME recovery notice and button stay
    // mounted (never a generic "Retry" state), and focus remains on Refresh list.
    await waitFor(() => expect(firstPageReads).toBe(1));
    expect(
      screen.getByText("This list can no longer continue."),
    ).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh list" });
    await waitFor(() => expect(refresh).toHaveFocus());
    expect(
      screen.queryByText("Failed to refresh library entries"),
    ).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Consumption-publishing tests (relocated LAST). Each advances the module-global
  // consumption revision, which has no reset export; keeping them below every
  // seed-adoption test keeps those at process revision zero. The reset test runs
  // first here so it adopts its seed before publishing.
  // ---------------------------------------------------------------------------

  it("keeps the local patch and does not refetch an AllItems(all) view on a reset", async () => {
    const user = userEvent.setup();
    const mediaId = "11111111-1111-4111-8111-111111111111";
    const commands: Array<Record<string, unknown>> = [];
    const confirmReset = vi.spyOn(window, "confirm").mockReturnValue(true);
    let entriesRequests = 0;
    stubFetch(async (input, init) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesRequests += 1;
        return Response.json({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (fetchInputPath(input) === "/api/consumption/commands") {
        const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
        commands.push(command);
        return Response.json({
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
                    positionMs: 59_000,
                    durationMs: { kind: "Present", value: 60_000 },
                    playbackSpeed: 1,
                    writeRevision: 1,
                    resetEpoch: 1,
                  },
                },
              },
            },
            completionHandle: { kind: "Absent" },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${fetchInputPath(input)}`);
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-episode", mediaId, "Resettable Episode", {
              kind: "podcast_episode",
              readState: "in_progress",
              progressFraction: 0.5,
              progressResettable: true,
            }),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Resettable Episode" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Reset progress" }),
    );

    await waitFor(() => {
      expect(commands).toEqual([
        expect.objectContaining({ kind: "ResetProgress", mediaId }),
      ]);
    });
    expect(confirmReset).toHaveBeenCalledWith(
      "Reset progress? This starts the item from the beginning. Notes and activity history are kept.",
    );
    expect(await screen.findByText("Progress reset.")).toBeInTheDocument();

    // The consumption revision advanced, but an unfiltered AllItems(all) view is
    // consumption-insensitive: it keeps the immediate local patch and never
    // refetches. The row stays; reset remains available.
    await waitFor(() =>
      expect(screen.getByTestId("lectern-mutation")).toHaveTextContent("Idle"),
    );
    expect(entriesRequests).toBe(0);
    expect(
      screen.getByRole("link", { name: "Resettable Episode" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "More actions for Resettable Episode" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Reset progress" }),
    ).toBeInTheDocument();
  });

  it("moves focus to a sibling row after Mark Finished removes it under the unfinished filter", async () => {
    const user = userEvent.setup();
    let unfinishedReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?completion=unfinished`
      ) {
        unfinishedReads += 1;
        // The consumption reconcile after Mark Finished refetches the unfinished
        // view, which the server now returns without the finished row.
        const rows =
          unfinishedReads === 1
            ? [
                mediaEntryWire("entry-1", ACTION_MEDIA_ID, "First Work", {
                  readState: "in_progress",
                  progressFraction: 0.5,
                  remainingMinutes: 5,
                }),
                mediaEntryWire(
                  "entry-2",
                  "22222222-2222-4222-8222-222222222222",
                  "Second Work",
                ),
              ]
            : [
                mediaEntryWire(
                  "entry-2",
                  "22222222-2222-4222-8222-222222222222",
                  "Second Work",
                ),
              ];
        return Response.json({
          data: rows,
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === "/api/consumption/commands") {
        return consumptionSuccessResponse();
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?completion=unfinished`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-0",
              "00000000-0000-4000-8000-000000000010",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(await screen.findByRole("link", { name: "First Work" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for First Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );

    // The finished row leaves the filtered view and focus lands on the sibling
    // row (its first focusable control).
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "First Work" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "More actions for Second Work" }),
      ).toHaveFocus(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("lectern-mutation")).toHaveTextContent("Idle"),
    );
  });

  // Under the unfinished (consumption-sensitive) view, Mark Finished is a
  // definitive mutation: it removes the row locally AND reconciles the view's
  // first page against fresh server truth (never reinterpreting a continuation
  // cursor), and only shows "No unfinished items." once the server truly returns
  // an empty unfinished page.
  it("reconciles the unfinished view's first page after Mark Finished until empty", async () => {
    const user = userEvent.setup();
    const firstPagePath = `/api/libraries/${LIBRARY_ID}/entries?completion=unfinished`;
    const continuationPath = `${firstPagePath}&cursor=cursor-p2`;
    // parseMediaId requires a canonical UUID; these are the media ids that get
    // a real "Mark as finished" click (which calls lectern.ensureMediaFinished).
    const PAGE1_MEDIA_ID = "11111111-1111-4111-8111-222222222221";
    const PAGE2_MEDIA_ID = "11111111-1111-4111-8111-222222222222";
    let firstPageReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === firstPagePath) {
        firstPageReads += 1;
        // 1: initial page; 2: reconcile after the first row is finished;
        // 3: reconcile after the second row is finished (now empty).
        const data =
          firstPageReads === 1
            ? [mediaEntryWire("entry-p1", PAGE1_MEDIA_ID, "First Unfinished")]
            : firstPageReads === 2
              ? [mediaEntryWire("entry-p2", PAGE2_MEDIA_ID, "Second Unfinished")]
              : [];
        return Response.json({
          data,
          page: {
            has_more: firstPageReads === 1,
            next_cursor: firstPageReads === 1 ? "cursor-p2" : null,
          },
        });
      }
      if (path === continuationPath) {
        // The client may briefly auto-advance on the client-emptied page; the
        // definitive reconcile then cancels it and reloads the first page.
        return Response.json({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (fetchInputPath(input) === "/api/consumption/commands") {
        return consumptionSuccessResponse();
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?completion=unfinished`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry(
              "entry-0",
              "00000000-0000-4000-8000-000000000010",
              "Canonical Seed",
            ),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "First Unfinished" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );

    await user.click(
      screen.getByRole("button", { name: "More actions for First Unfinished" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );

    // The reconcile refetches the unfinished first page, never the continuation
    // cursor, and surfaces the next unfinished row.
    expect(
      await screen.findByRole("link", { name: "Second Unfinished" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "First Unfinished" }),
    ).not.toBeInTheDocument();
    // The reconcile refetched the first page (reads >= 2), not a stale
    // continuation as an authoritative result.
    expect(firstPageReads).toBeGreaterThanOrEqual(2);

    await user.click(
      screen.getByRole("button", { name: "More actions for Second Unfinished" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );

    // The reconcile now returns an empty unfinished page: the real empty state
    // renders with its recovery.
    expect(await screen.findByText("No unfinished items.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show finished" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-mutation")).toHaveTextContent("Idle"),
    );
  });

  // Reset Progress removes the focused row from an In Progress view (read_state ->
  // unread); the removed-row focus chain must land on the sibling. Mark Unread is
  // the same removal + capture path but is unreachable in In Progress (finished
  // rows are filtered out), so Reset Progress exercises it.
  it("moves focus to a sibling row after Reset Progress removes it from the In Progress view", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const RESET_MEDIA_ID = "11111111-1111-4111-8111-333333333331";
    const SIBLING_MEDIA_ID = "11111111-1111-4111-8111-333333333332";
    const inProgressPath = `/api/libraries/${LIBRARY_ID}/entries?projection=in-progress`;
    let inProgressReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === inProgressPath) {
        inProgressReads += 1;
        const rows =
          inProgressReads === 1
            ? [
                mediaEntryWire("entry-1", RESET_MEDIA_ID, "Resettable Row", {
                  readState: "in_progress",
                  progressFraction: 0.5,
                  remainingMinutes: 5,
                  progressResettable: true,
                }),
                mediaEntryWire("entry-2", SIBLING_MEDIA_ID, "Sibling Row", {
                  readState: "in_progress",
                  progressFraction: 0.3,
                  remainingMinutes: 7,
                  progressResettable: true,
                }),
              ]
            : [
                mediaEntryWire("entry-2", SIBLING_MEDIA_ID, "Sibling Row", {
                  readState: "in_progress",
                  progressFraction: 0.3,
                  remainingMinutes: 7,
                  progressResettable: true,
                }),
              ];
        return Response.json({
          data: rows,
          page: { has_more: false, next_cursor: null },
        });
      }
      if (path === "/api/consumption/commands") {
        return Response.json({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            progressState: {
              kind: "Present",
              value: {
                mediaId: RESET_MEDIA_ID,
                readerCursor: { state: "Empty", revision: 1 },
                listeningState: {
                  kind: "Present",
                  value: {
                    positionMs: 0,
                    durationMs: { kind: "Present", value: 60_000 },
                    playbackSpeed: 1,
                    writeRevision: 1,
                    resetEpoch: 1,
                  },
                },
              },
            },
            completionHandle: { kind: "Absent" },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?projection=in-progress`,
      resources: {
        [LIBRARY_ID]: {
          library: seededLibrary(),
          entries: [
            seededMediaEntry("entry-seed", ACTION_MEDIA_ID, "Canonical Seed"),
          ],
          entriesPage: { has_more: false, next_cursor: null },
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Resettable Row" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready"),
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Resettable Row" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Reset progress" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Resettable Row" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "More actions for Sibling Row" }),
      ).toHaveFocus(),
    );
    confirmSpy.mockRestore();
  });
});
