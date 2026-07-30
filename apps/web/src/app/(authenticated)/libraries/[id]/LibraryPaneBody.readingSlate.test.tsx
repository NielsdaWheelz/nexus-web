import { type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaneReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resetLibraryPlacementRevisionForTest } from "@/lib/libraries/placementRevision";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import {
  PaneReturnMementoProvider,
  type PaneReturnMementoCommands,
} from "@/lib/workspace/paneReturnMemento";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import LibraryPaneBody from "./LibraryPaneBody";

const LIBRARY_ID = "00000000-0000-4000-8000-000000000202";
const SECOND_LIBRARY_ID = "00000000-0000-4000-8000-000000000203";
const EXISTING_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const SUGGESTED_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const SUGGESTED_PODCAST_ID = "44444444-4444-4444-8444-444444444444";
const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

function library(id = LIBRARY_ID, name = "Research") {
  return {
    id,
    name,
    color: null,
    isDefault: false,
    role: "admin",
    ownerUserHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
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

function SwitchingHarness({
  children,
  libraryId,
  isActive,
}: {
  children: ReactNode;
  libraryId: string;
  isActive: boolean;
}) {
  const href = `/libraries/${libraryId}`;
  const identity = resolvePaneRouteIdentity(href);
  return withRenderEnvironment(
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <ResourceCacheProvider
        value={{
          [LIBRARY_ID]: {
            library: library(),
            entries: [entry("entry-1", EXISTING_MEDIA_ID, "Existing work")],
            collectionRevision: 1,
nextCursor: { kind: "Absent" },
exhaustion: "Complete",
          },
          [SECOND_LIBRARY_ID]: {
            library: library(SECOND_LIBRARY_ID, "Archive"),
            entries: [entry("entry-3", SECOND_MEDIA_ID, "Archived work")],
            collectionRevision: 1,
nextCursor: { kind: "Absent" },
exhaustion: "Complete",
          },
        }}
        >
          <ShareControllerProvider>
            <LecternProvider>
              <LibraryPlacementControllerProvider>
                <PaneRuntimeProvider
                  paneId="pane-library"
                  visitId={TEST_VISIT_ID}
                  isActive={isActive}
                  href={href}
                  routeId={identity.routeId}
                  routeKey={identity.routeKey}
                  pathParams={{ id: libraryId }}
                  canGoBack={false}
                  canGoForward={false}
                  onNavigatePane={vi.fn()}
                  onReplacePane={vi.fn()}
                  onActivateWorkspaceTarget={vi.fn(() => ({ kind: "Unchanged" as const, paneId: "pane-library" }))}
                  onGoBackPane={vi.fn()}
                  onGoForwardPane={vi.fn()}
                >
                  {children}
                </PaneRuntimeProvider>
              </LibraryPlacementControllerProvider>
            </LecternProvider>
          </ShareControllerProvider>
        </ResourceCacheProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>,
  );
}

function entryWire(
  id: string,
  mediaId: string,
  title: string,
  _presentation: {
    publisher?: string | null;
    image_url?: string | null;
    thumbnail_url?: string | null;
  } = {},
) {
  return {
    kind: "media",
    placement: {
      kind: "Present",
      value: { libraryEntryId: id, position: 0 },
    },
    addedAt: "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: "web_article",
      title,
      contributors: [],
      author_mode: "automatic",
      published_date: null,
      canonical_source_url: null,
      created_at: "2026-01-01T00:00:00Z",
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_resettable: false,
      progress_fraction: null,
      last_engaged_at: null,
      capabilities: {
        can_quote: true,
        can_retry: false,
        can_refresh_source: false,
        can_retry_metadata: false,
        can_edit_authors: false,
        can_delete: false,
      },
    },
    readingTimeEstimate: {
      kind: "Present",
      value: { totalMinutes: 12, remainingMinutes: { kind: "Absent" } },
    },
  };
}

function entry(...args: Parameters<typeof entryWire>) {
  return decodeLibraryReadingTimeEntry(entryWire(...args));
}

function slateItem() {
  return {
    target: {
      kind: "Media",
      ref: `media:${SUGGESTED_MEDIA_ID}`,
      mediaKind: "web_article",
      title: "Suggested work",
      subtitle: { kind: "Present", value: "Worth reading next" },
      imageUrl: { kind: "Absent" },
      href: `/media/${SUGGESTED_MEDIA_ID}`,
    },
    reason: {
      kind: "Connected",
      anchor: { ref: `media:${EXISTING_MEDIA_ID}`, label: "Existing work" },
      edgeOrigin: "citation",
    },
  };
}

function podcastSlateItem() {
  return {
    target: {
      kind: "Podcast",
      ref: `podcast:${SUGGESTED_PODCAST_ID}`,
      title: "Signal Path",
      subtitle: { kind: "Present", value: "A connected podcast" },
      imageUrl: { kind: "Absent" },
      href: `/podcasts/${SUGGESTED_PODCAST_ID}`,
    },
    reason: {
      kind: "Connected",
      anchor: { ref: `media:${EXISTING_MEDIA_ID}`, label: "Existing work" },
      edgeOrigin: "citation",
    },
  };
}

function pathWithSearch(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function Harness({
  children,
  isActive,
  initialEntries = [entry("entry-1", EXISTING_MEDIA_ID, "Existing work")],
  nextCursor = { kind: "Absent" },
  exhaustion = "Complete",
  search = "",
}: {
  children: ReactNode;
  isActive: boolean;
  initialEntries?: ReturnType<typeof entry>[];
  nextCursor?:
    | { kind: "Absent" }
    | { kind: "Present"; value: string };
  exhaustion?: "Partial" | "Complete";
  // Pane URL search (e.g. "sort=title&direction=asc"); empty = canonical view.
  search?: string;
}) {
  const href = `/libraries/${LIBRARY_ID}${search ? `?${search}` : ""}`;
  const identity = resolvePaneRouteIdentity(href);
  return withRenderEnvironment(
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <ResourceCacheProvider
        value={{
          [LIBRARY_ID]: {
            library: library(),
            entries: initialEntries,
            collectionRevision: 1,
            nextCursor,
            exhaustion,
          },
        }}
        >
          <ShareControllerProvider>
            <LecternProvider>
              <LibraryPlacementControllerProvider>
                <PaneRuntimeProvider
                  paneId="pane-library"
                  visitId={TEST_VISIT_ID}
                  isActive={isActive}
                  href={href}
                  routeId={identity.routeId}
                  routeKey={identity.routeKey}
                  pathParams={{ id: LIBRARY_ID }}
                  canGoBack={false}
                  canGoForward={false}
                  onNavigatePane={vi.fn()}
                  onReplacePane={vi.fn()}
                  onActivateWorkspaceTarget={vi.fn(() => ({ kind: "Unchanged" as const, paneId: "pane-library" }))}
                  onGoBackPane={vi.fn()}
                  onGoForwardPane={vi.fn()}
                >
                  {children}
                </PaneRuntimeProvider>
              </LibraryPlacementControllerProvider>
            </LecternProvider>
          </ShareControllerProvider>
        </ResourceCacheProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>,
  );
}

// Reset the module-global placement store between tests: the pane claims the
// bootstrap seed only at process revision zero, and Slate-accept publishes
// placement revisions that would otherwise leak across a file's tests.
beforeEach(() => {
  resetLibraryPlacementRevisionForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LibraryPaneBody Reading Slate host", () => {
  it("does not mount Reading Slate until the entry list is complete", async () => {
    let resolveContinuation!: (response: Response) => void;
    const continuation = new Promise<Response>((resolve) => {
      resolveContinuation = resolve;
    });
    let slateReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathWithSearch(input);
        if (path === "/api/lectern") {
          return response({ data: { items: [] } });
        }
        if (
          path ===
          `/api/libraries/${LIBRARY_ID}/entries?cursor=next&collection_revision=1&limit=100`
        ) {
          return continuation;
        }
        if (path === `/api/libraries/${LIBRARY_ID}/slate`) {
          slateReads += 1;
          return response({ data: { items: [slateItem()] } });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(
      <Harness
        isActive
        nextCursor={{ kind: "Present", value: "next" }}
        exhaustion="Partial"
      >
        <LibraryPaneBody />
      </Harness>,
    );

    expect(
      await screen.findByRole("link", { name: "Existing work" }),
    ).toBeVisible();
    expect(slateReads).toBe(0);
    expect(
      screen.queryByRole("list", { name: "Suggestions for Research" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolveContinuation(
        response({
          data: {
            items: [
              entryWire("entry-2", SECOND_MEDIA_ID, "Second page work"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        }),
      );
      await continuation;
    });

    expect(
      await screen.findByRole("link", { name: "Second page work" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("list", { name: "Suggestions for Research" }),
    ).toBeVisible();
    expect(slateReads).toBe(1);
  });

  it("clears destination-stale reconciliation state when the library id changes", async () => {
    let firstSlateReads = 0;
    let secondEntryReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathWithSearch(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/lectern" && method === "GET") {
        return response({ data: { items: [] } });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/slate` && method === "GET") {
        firstSlateReads += 1;
        return response({
          data: { items: firstSlateReads === 1 ? [slateItem()] : [] },
        });
      }
      if (
        path === `/api/media/${SUGGESTED_MEDIA_ID}/libraries` &&
        method === "POST"
      ) {
        return new Response(null, { status: 204 });
      }
      if (path === `/api/libraries/${SECOND_LIBRARY_ID}` && method === "GET") {
        return response({ data: library(SECOND_LIBRARY_ID, "Archive") });
      }
      if (
        path === `/api/libraries/${SECOND_LIBRARY_ID}/entries` &&
        method === "GET"
      ) {
        secondEntryReads += 1;
        return response({
          data: { items: [entryWire("entry-3", SECOND_MEDIA_ID, "Archived work")], collectionRevision: 1, nextCursor: { kind: "Absent" } },
        });
      }
      if (
        path === `/api/libraries/${SECOND_LIBRARY_ID}/slate` &&
        method === "GET"
      ) {
        return response({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(
      <SwitchingHarness libraryId={LIBRARY_ID} isActive>
        <LibraryPaneBody key={LIBRARY_ID} />
      </SwitchingHarness>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Add Suggested work to Research",
      }),
    );
    await waitFor(() => expect(firstSlateReads).toBe(2));

    view.rerender(
      <SwitchingHarness libraryId={LIBRARY_ID} isActive={false}>
        <LibraryPaneBody key={LIBRARY_ID} />
      </SwitchingHarness>,
    );
    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive>
        <LibraryPaneBody key={SECOND_LIBRARY_ID} />
      </SwitchingHarness>,
    );
    expect(await screen.findByRole("link", { name: "Archived work" })).toBeVisible();
    // The earlier Add advanced the process placement revision, so the SECOND
    // library cannot claim its bootstrap seed: it loads its exact first page once
    // through the entries endpoint (not the FIRST library's stale reconciliation).
    expect(secondEntryReads).toBe(1);

    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive={false}>
        <LibraryPaneBody key={SECOND_LIBRARY_ID} />
      </SwitchingHarness>,
    );
    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive>
        <LibraryPaneBody key={SECOND_LIBRARY_ID} />
      </SwitchingHarness>,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) =>
            pathWithSearch(input as RequestInfo | URL) ===
            `/api/libraries/${SECOND_LIBRARY_ID}/slate`,
        ),
      ).toHaveLength(2),
    );
    // The production visitId + routeKey render key remounts the owner at the
    // destination, so the old library's stale marker cannot trigger a new
    // library reconciliation: SECOND loaded its first page exactly once and never
    // reconciled again.
    expect(secondEntryReads).toBe(1);
  });

  it("renders the main empty notice independently from a non-empty Slate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathWithSearch(input);
        if (path === "/api/lectern") {
          return response({ data: { items: [] } });
        }
        if (path === `/api/libraries/${LIBRARY_ID}/slate`) {
          return response({ data: { items: [slateItem()] } });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(
      <Harness isActive initialEntries={[]}>
        <LibraryPaneBody />
      </Harness>,
    );

    expect(
      await screen.findByText("No podcasts or media in this library yet."),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Suggested work" }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", { name: "Suggestions for Research" }),
    ).toBeVisible();
  });

  it("accepts a podcast from the mixed-media Slate through the library command", async () => {
    let slateReads = 0;
    const podcastBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathWithSearch(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/lectern" && method === "GET") {
        return response({ data: { items: [] } });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/slate` && method === "GET") {
        slateReads += 1;
        return response({
          data: { items: slateReads === 1 ? [podcastSlateItem()] : [] },
        });
      }
      if (
        path === "/api/podcasts/subscriptions" &&
        method === "POST"
      ) {
        podcastBodies.push(String(init?.body));
        return response({
          data: {
            href: `/podcasts/${SUGGESTED_PODCAST_ID}`,
            podcastId: SUGGESTED_PODCAST_ID,
            outcome: "DestinationsAdded",
            destinations: [
              { libraryId: LIBRARY_ID, outcome: "Added" },
            ],
            backfill: {
              id: "backfill-1",
              state: "Running",
              processedCount: 2,
              addedCount: 1,
            },
            collectionRevision: 2,
            libraryEntriesCollectionRevision: 2,
          },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <Harness isActive>
        <LibraryPaneBody />
      </Harness>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Add Signal Path to Research",
      }),
    );

    await waitFor(() => expect(slateReads).toBe(2));
    expect(podcastBodies).toEqual([
      JSON.stringify({
        target: {
          kind: "Canonical",
          podcastId: SUGGESTED_PODCAST_ID,
        },
        namedLibraryIds: [LIBRARY_ID],
        replacementConfirmation: { kind: "Absent" },
      }),
    ]);
    expect(await screen.findByText("Added to Research")).toBeVisible();
  });

  it("keeps the single list compact and complete in a 320px host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathWithSearch(input);
        if (path === "/api/lectern") {
          return response({ data: { items: [] } });
        }
        if (path === `/api/libraries/${LIBRARY_ID}/slate`) {
          return response({ data: { items: [slateItem()] } });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(
      <div
        data-testid="narrow-library-host"
        style={{ width: "320px", maxWidth: "320px" }}
      >
        <Harness isActive>
          <LibraryPaneBody />
        </Harness>
      </div>,
    );

    const host = screen.getByTestId("narrow-library-host");
    const slate = await screen.findByRole("region", {
      name: "Suggestions for Research",
    });
    expect(screen.getByRole("list", { name: "Research" })).toBeVisible();
    expect(within(slate).getByRole("list")).toBeVisible();
    expect(
      within(slate).getByText(
        "Worth reading next · Connected with Existing work",
      ),
    ).toBeVisible();
    expect(
      within(slate).getByRole("button", { name: "Add Suggested work to Research" }),
    ).toBeVisible();
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });

  it("does not render publisher or row imagery from Library media payloads", async () => {
    const publisher = "DISTINCTIVE PUBLISHER CHROME";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathWithSearch(input);
        if (path === "/api/lectern") {
          return response({ data: { items: [] } });
        }
        if (path === `/api/libraries/${LIBRARY_ID}/slate`) {
          return response({ data: { items: [] } });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );
    render(
      <Harness
        isActive
       
        initialEntries={[
          entry("entry-1", EXISTING_MEDIA_ID, "Minimal row", {
            publisher,
            image_url: "https://example.test/distinctive-cover.jpg",
            thumbnail_url: "https://example.test/legacy-thumbnail.jpg",
          }),
        ]}
      >
        <LibraryPaneBody />
      </Harness>,
    );

    expect(await screen.findByRole("link", { name: "Minimal row" })).toBeVisible();
    expect(screen.queryByText(publisher)).not.toBeInTheDocument();
    expect(screen.queryByText("ready_for_reading")).not.toBeInTheDocument();
    expect(screen.queryByText("web_article")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it.each(["after commit", "while refreshing"] as const)(
    "reconciles the current committed view when an earlier-view Add finishes %s",
    async (completionTiming) => {
      let resolveAdd!: (response: Response) => void;
      const pendingAdd = new Promise<Response>((resolve) => {
        resolveAdd = resolve;
      });
      let resolveInitialTitle!: (response: Response) => void;
      const pendingInitialTitle = new Promise<Response>((resolve) => {
        resolveInitialTitle = resolve;
      });
      let slateReads = 0;
      let titleEntryReads = 0;
      const currentTitleResponse = () =>
        response({
          data: { items: [
            entryWire("entry-title", SECOND_MEDIA_ID, "Current title view"),
          ], collectionRevision: 1, nextCursor: { kind: "Absent" } },
        });
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const path = pathWithSearch(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (path === "/api/lectern" && method === "GET") {
            return response({ data: { items: [] } });
          }
          if (
            path === `/api/libraries/${LIBRARY_ID}/slate` &&
            method === "GET"
          ) {
            slateReads += 1;
            return response({
              data: { items: slateReads === 1 ? [slateItem()] : [] },
            });
          }
          if (
            path === `/api/media/${SUGGESTED_MEDIA_ID}/libraries` &&
            method === "POST"
          ) {
            return pendingAdd;
          }
          if (
            path ===
              `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc` &&
            method === "GET"
          ) {
            titleEntryReads += 1;
            if (
              titleEntryReads === 1 &&
              completionTiming === "while refreshing"
            ) {
              return pendingInitialTitle;
            }
            return response({
              data: { items: titleEntryReads === 1
                  ? [
                      entryWire(
                        "entry-title",
                        SECOND_MEDIA_ID,
                        "Current title view",
                      ),
                    ]
                  : [
                      entryWire(
                        "entry-title",
                        SECOND_MEDIA_ID,
                        "Current title view",
                      ),
                      entryWire(
                        "entry-suggested",
                        SUGGESTED_MEDIA_ID,
                        "Suggested work",
                      ),
                    ], collectionRevision: 1, nextCursor: { kind: "Absent" } },
            });
          }
          throw new Error(`Unexpected fetch: ${method} ${path}`);
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      const renderPane = (search = "") => (
        <Harness isActive search={search}>
          <LibraryPaneBody />
        </Harness>
      );
      const view = render(renderPane());

      await user.click(
        await screen.findByRole("button", {
          name: "Add Suggested work to Research",
        }),
      );
      view.rerender(renderPane("sort=title&direction=asc"));

      if (completionTiming === "after commit") {
        expect(await screen.findByRole("link", { name: "Current title view" })).toBeVisible();
      } else {
        await waitFor(() => expect(titleEntryReads).toBe(1));
      }

      await act(async () => {
        resolveAdd(new Response(null, { status: 204 }));
        await pendingAdd;
      });
      if (completionTiming === "while refreshing") {
        expect(titleEntryReads).toBe(1);
        await act(async () => {
          resolveInitialTitle(currentTitleResponse());
          await pendingInitialTitle;
        });
      }

      await waitFor(() => expect(titleEntryReads).toBe(2));
      const libraryEntries = screen.getByRole("list", { name: "Research" });
      expect(
        await within(libraryEntries).findByRole("link", { name: "Suggested work" }),
      ).toBeVisible();
      expect(
        within(libraryEntries).getByRole("link", { name: "Current title view" }),
      ).toBeVisible();
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            pathWithSearch(input as RequestInfo | URL) ===
              `/api/libraries/${LIBRARY_ID}/entries` &&
            (
              (init as RequestInit | undefined)?.method ?? "GET"
            ).toUpperCase() === "GET",
        ),
      ).toBe(false);
    },
  );

  it("retries the exact Add, preserves main rows, and reconciles only the current view", async () => {
    let slateReads = 0;
    let addAttempts = 0;
    let entryReads = 0;
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathWithSearch(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/lectern" && method === "GET") {
        return response({ data: { items: [] } });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/slate` && method === "GET") {
        slateReads += 1;
        return response({
          data: { items: slateReads === 1 ? [slateItem()] : [] },
        });
      }
      if (
        path === `/api/media/${SUGGESTED_MEDIA_ID}/libraries` &&
        method === "POST"
      ) {
        addAttempts += 1;
        requestBodies.push(String(init?.body));
        return addAttempts === 1
          ? response(
              { error: { code: "E_UPSTREAM", message: "Unknown outcome" } },
              503,
            )
          : new Response(null, { status: 204 });
      }
      if (
        path === `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc` &&
        method === "GET"
      ) {
        entryReads += 1;
        if (entryReads === 2) {
          return response(
            { error: { code: "E_UPSTREAM", message: "Refresh failed" } },
            503,
          );
        }
        return response({
          data: { items: entryReads === 1
              ? [entryWire("entry-1", EXISTING_MEDIA_ID, "Existing work")]
              : [
                  entryWire("entry-1", EXISTING_MEDIA_ID, "Existing work"),
                  entryWire("entry-2", SUGGESTED_MEDIA_ID, "Suggested work"),
                ], collectionRevision: 1, nextCursor: { kind: "Absent" } },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const view = render(
      <Harness isActive search="sort=title&direction=asc">
        <LibraryPaneBody />
      </Harness>,
    );

    const rankedList = await screen.findByRole("list", { name: "Research" });
    expect(within(rankedList).getByRole("link", { name: "Existing work" })).toBeVisible();
    await user.click(
      await screen.findByRole("button", {
        name: "Add Suggested work to Research",
      }),
    );
    const unknown = await screen.findByRole("alert");
    expect(unknown).toHaveTextContent("Couldn’t confirm Add");
    expect(within(rankedList).getByRole("link", { name: "Existing work" })).toBeVisible();
    await user.click(within(unknown).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(addAttempts).toBe(2));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0] ?? "")).toEqual({
      library_ids: [LIBRARY_ID],
    });
    expect(within(rankedList).getByRole("link", { name: "Existing work" })).toBeVisible();
    await waitFor(() => expect(entryReads).toBe(2));
    expect(screen.getByText("Failed to refresh library entries")).toBeVisible();

    view.rerender(
      <Harness isActive={false} search="sort=title&direction=asc">
        <LibraryPaneBody />
      </Harness>,
    );
    view.rerender(
      <Harness isActive search="sort=title&direction=asc">
        <LibraryPaneBody />
      </Harness>,
    );
    expect(entryReads).toBe(2);
    expect(within(rankedList).getByRole("link", { name: "Existing work" })).toBeVisible();
    expect(screen.getByText("Failed to refresh library entries")).toBeVisible();
    // Reconciliation used only the current factual view, never the canonical
    // (query-less) entries endpoint.
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          pathWithSearch(input as RequestInfo | URL) ===
          `/api/libraries/${LIBRARY_ID}/entries`,
      ),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(entryReads).toBe(3));
    expect(await within(rankedList).findByRole("link", { name: "Suggested work" })).toBeVisible();
  });

  // Relocated last: this test publishes a consumption revision (Mark finished),
  // which is module-global; running it last keeps every seed-adoption test above
  // it at process revision zero.
  it("does not capture a controller commit while reconciliation is unresolved", async () => {
    const user = userEvent.setup();
    let reconciliationRequests = 0;
    let slateReads = 0;
    const unresolvedReconciliation = new Promise<Response>(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = pathWithSearch(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/lectern" && method === "GET") {
          return response({ data: { items: [] } });
        }
        if (path === `/api/libraries/${LIBRARY_ID}/slate` && method === "GET") {
          slateReads += 1;
          return response({
            data: { items: slateReads === 1 ? [slateItem()] : [] },
          });
        }
        if (
          path === `/api/media/${SUGGESTED_MEDIA_ID}/libraries` &&
          method === "POST"
        ) {
          return new Response(null, { status: 204 });
        }
        if (
          path === `/api/libraries/${LIBRARY_ID}/entries` &&
          method === "GET"
        ) {
          reconciliationRequests += 1;
          // First call: the gen-0 reconcile that stays unresolved while we
          // capture. Second call: the gen-1 remount's exact first page — the Add
          // + Mark-finished advanced both process revisions, so the fresh owner
          // cannot claim its bootstrap seed and loads through the endpoint.
          if (reconciliationRequests === 1) return unresolvedReconciliation;
          return response({
            data: { items: [entryWire("entry-fresh", SECOND_MEDIA_ID, "Fresh server work")], collectionRevision: 1, nextCursor: { kind: "Absent" } },
          });
        }
        if (path === "/api/consumption/commands" && method === "POST") {
          return response({
            data: {
              outcome: { kind: "StateOnly" },
              lectern: { items: [] },
              nextItem: { kind: "Absent" },
              progressState: { kind: "Absent" },
              completionHandle: { kind: "Absent" },
              libraryEntriesCollectionRevision: 2,
            },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${path}`);
      }),
    );

    let commands: PaneReturnMementoCommands | null = null;
    const href = `/libraries/${LIBRARY_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const journey = (
      resourceGeneration: number,
      initialEntries: ReturnType<typeof entry>[],
    ) => (
      <PaneReturnJourneyHarness
        href={href}
        resources={{
          [LIBRARY_ID]: {
            library: library(),
            entries: initialEntries,
            collectionRevision: 1,
nextCursor: { kind: "Absent" },
exhaustion: "Complete",
          },
        }}
        resourceGeneration={resourceGeneration}
        publishCommands={(next) => {
          commands = next;
        }}
      >
        <LecternProvider>
          <LibraryPlacementControllerProvider>
            <LibraryPaneBody />
          </LibraryPlacementControllerProvider>
        </LecternProvider>
      </PaneReturnJourneyHarness>
    );
    const view = render(
      journey(0, [entry("entry-1", EXISTING_MEDIA_ID, "Existing work")]),
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Add Suggested work to Research",
      }),
    );
    await waitFor(() => expect(reconciliationRequests).toBe(1));
    expect(
      screen.getByText("Refreshing library entries…"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "More actions for Existing work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark as finished" }),
    );
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());

    act(() => {
      commands?.capturePane({
        paneId: "pane-return-journey",
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(
      journey(1, [entry("entry-fresh", SECOND_MEDIA_ID, "Fresh server work")]),
    );

    expect(await screen.findByRole("link", { name: "Fresh server work" })).toBeInTheDocument();
    expect(screen.queryByText("Existing work")).not.toBeInTheDocument();
    // The capture during the unresolved reconcile stored no committed snapshot,
    // so gen 1 restored nothing and loaded fresh server truth: exactly the gen-0
    // reconcile plus the gen-1 first page, never a stale restored snapshot.
    expect(reconciliationRequests).toBe(2);
  });
});
