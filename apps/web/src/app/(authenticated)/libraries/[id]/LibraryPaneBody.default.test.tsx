import { useCallback, useState, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchCallsForPath,
  fetchInputPath,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import PaneSearchBar from "@/components/workspace/PaneSearchBar";
import type { PaneSearchPublication } from "@/lib/panes/paneSearch";
import {
  publishLibraryPlacementChange,
  resetLibraryPlacementRevisionForTest,
} from "@/lib/libraries/placementRevision";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import LibraryPaneBody from "./LibraryPaneBody";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000005");

function ExpandedPaneSearchHarness({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState<PaneSearchPublication>();
  const publish = useCallback(
    (update: { publication: { search?: PaneSearchPublication } | null }) =>
      setSearch(update.publication?.search),
    [],
  );
  return (
    <PanePrimaryChromeProvider publish={publish}>
      {search ? (
        <PaneSearchBar publication={search} onClose={() => {}} />
      ) : null}
      {children}
    </PanePrimaryChromeProvider>
  );
}

// A pane host whose href is real state, so a pane-router replace re-decodes the
// view and drives the entries endpoint exactly as production does.
function StatefulDefaultPane({
  initialHref,
  resources,
}: {
  initialHref: string;
  resources: Record<string, unknown>;
}) {
  const [href, setHref] = useState(initialHref);
  const identity = resolvePaneRouteIdentity(href);
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <ResourceCacheProvider value={resources}>
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
              onActivateWorkspaceTarget={vi.fn(() => ({
                kind: "Unchanged" as const,
                paneId: "pane-1",
              }))}
              onGoBackPane={vi.fn()}
              onGoForwardPane={vi.fn()}
            >
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <div data-testid="default-pane-href" hidden>
                    {href}
                  </div>
                  <ExpandedPaneSearchHarness>
                    <LibraryPaneBody />
                  </ExpandedPaneSearchHarness>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </PaneRuntimeProvider>
          </ShareControllerProvider>
        </ResourceCacheProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}

// Default-library coverage per the default-library-virtualization
// cutover contract: no reorder UX (no drag handles, no reorder PATCH), no
// resonance sort offered/forced, and pagination merges are deduped by media id
// (the server may hand back a different representative entry id for the same
// media across pages). Every existing LibraryPaneBody fixture uses
// `isDefault: false`; this file is the only isDefault:true coverage.

const LIBRARY_ID = "00000000-0000-4000-8000-000000000204";
const LIBRARY_NAME = "My Library";
const FIRST_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const TITLED_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const OLDEST_MEDIA_ID = "44444444-4444-4444-8444-444444444444";

function seededDefaultLibrary() {
  return {
    id: LIBRARY_ID,
    name: LIBRARY_NAME,
    color: null,
    isDefault: true,
    role: "admin",
    ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    systemKey: null,
    canRename: false,
    canDelete: false,
    canEditEntries: true,
    canManageMembers: false,
    canTransferOwnership: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mediaEntryWire(
  id: string,
  mediaId: string,
  title: string,
  options: {
    createdAt?: string;
    mediaCreatedAt?: string;
    contributors?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    kind: "media",
    placement: { kind: "Absent" },
    addedAt:
      options.mediaCreatedAt ??
      options.createdAt ??
      "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: "web_article",
      title,
      contributors: options.contributors ?? [],
      author_mode: "automatic",
      published_date: null,
      canonical_source_url: null,
      created_at:
        options.mediaCreatedAt ?? options.createdAt ?? "2026-01-01T00:00:00Z",
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
      value: {
        totalMinutes: 15,
        remainingMinutes: { kind: "Absent" },
      },
    },
  };
}

function seededMediaEntry(...args: Parameters<typeof mediaEntryWire>) {
  return decodeLibraryReadingTimeEntry(mediaEntryWire(...args));
}

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

// LibraryPaneBody consumes the Lectern capability (mark-finished / mark-unread /
// add-to-lectern), so it must render under a LecternProvider. The provider issues
// an initial GET /api/lectern on mount; `lecternGetResponse` answers it with an
// empty snapshot envelope so the provider settles to Ready without console noise.
const paneWithLectern = (
  <LecternProvider>
    <LibraryPlacementControllerProvider>
      <ExpandedPaneSearchHarness>
        <LibraryPaneBody />
      </ExpandedPaneSearchHarness>
    </LibraryPlacementControllerProvider>
  </LecternProvider>
);

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

// The placement/consumption revision stores are module-global and vitest shares
// module state across a file's tests, so reset placement before each test: the
// pane only claims the bootstrap seed at process revision zero.
beforeEach(() => {
  resetLibraryPlacementRevisionForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LibraryPaneBody (Default library)", () => {
  it("filters locally by title and contributor credit fields only", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      throw new Error(`Unexpected fetch: ${fetchInputPathWithSearch(input)}`);
    });
    const contributor = {
      contributor_handle: "ursula-le-guin",
      contributor_display_name: "Ursula K. Le Guin",
      credited_name: "Pen Name",
      role: "author",
      raw_role: null,
      href: "/authors/ursula-le-guin",
      ordinal: 0,
    };
    const view = renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Alpha Work"),
            seededMediaEntry("entry-2", SECOND_MEDIA_ID, "Beta Work", {
              contributors: [contributor],
            }),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    const filter = await screen.findByRole("searchbox", {
      name: "Filter library entries",
    });
    await user.type(filter, "ursula");
    expect(
      screen.queryByRole("link", { name: "Alpha Work" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Beta Work" })).toBeVisible();

    await user.clear(filter);
    await user.type(filter, "PEN NAME");
    expect(screen.getByRole("link", { name: "Beta Work" })).toBeVisible();

    await user.clear(filter);
    await user.type(filter, "2026");
    expect(await screen.findByText("No entries match this filter.")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Beta Work" }),
    ).not.toBeInTheDocument();
    expect(
      fetchCallsForPath(fetchSpy, `/api/libraries/${LIBRARY_ID}/entries`),
    ).toHaveLength(0);
    expect(view.onReplacePane).not.toHaveBeenCalled();
  });

  it("shows no drag handles and omits Custom order and the Added — newest duplicate", async () => {
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
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "First Default Work"),
            seededMediaEntry("entry-2", SECOND_MEDIA_ID, "Second Default Work"),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "First Default Work" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "Second Default Work" }),
    ).toBeInTheDocument();

    // The default library presents as "All" — the stored "My Library" name is
    // never displayed. ("Across your libraries" is the Libraries list row, not
    // here.)
    expect(
      screen.getByRole("heading", { name: "All", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByText("My Library")).not.toBeInTheDocument();
    expect(screen.queryByText("Across your libraries")).not.toBeInTheDocument();

    // The View select offers All's three projections; every other library omits
    // Unfiled.
    expect(screen.getByRole("combobox", { name: "View" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "All items" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Unfiled" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "In Progress" }),
    ).toBeInTheDocument();

    // No reorder UX: reorder is gated to editable non-default Canonical +
    // AllItems(all), so no per-row Move up/down renders even though
    // canEditEntries is true here.
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "More actions for First Default Work",
      }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Move up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Move down" }),
    ).not.toBeInTheDocument();

    // The Sort-by control offers Default's baseline ("Recently added"), never a
    // "Custom order" (reorder is Default-forbidden) and never an "Added — newest"
    // duplicate of that baseline. The dead "Resonance" option is gone entirely.
    expect(
      screen.getByRole("combobox", { name: "Sort by" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Recently added" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Added — oldest" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Custom order" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Added — newest" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Resonance" }),
    ).not.toBeInTheDocument();
  });

  it("sorts the default library by a factual view via the entries endpoint", async () => {
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=title&direction=asc`
      ) {
        return Response.json({
          data: {
            items: [
              mediaEntryWire(
                "entry-t1",
                TITLED_MEDIA_ID,
                "Titled Default Work",
              ),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
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
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed"),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Titled Default Work" }),
    ).toBeInTheDocument();
    expect(
      fetchCallsForPath(fetchMock, `/api/libraries/${LIBRARY_ID}/entries`),
    ).toHaveLength(1);
  });

  it("loads the default library's Unfiled projection via the projection query", async () => {
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?projection=unfiled`
      ) {
        return Response.json({
          data: {
            items: [
              mediaEntryWire("entry-uf", TITLED_MEDIA_ID, "Unfiled Work"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?projection=unfiled`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed"),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    // The Unfiled first page comes from the endpoint, not the canonical seed.
    expect(
      await screen.findByRole("link", { name: "Unfiled Work" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Canonical Seed")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "View" })).toHaveValue(
      "unfiled",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries?projection=unfiled`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("dedupes an appended 00000000-0000-4000-8000-000000000204 page by media id, not entry id", async () => {
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?cursor=cursor-2&collection_revision=1&limit=100`
      ) {
        // The server hands back a *different* representative entry id
        // ("entry-1b") for the same underlying media ("media-1") already
        // present on the first page, alongside one genuinely new entry.
        return Response.json({
          data: {
            items: [
              mediaEntryWire("entry-1b", FIRST_MEDIA_ID, "First Default Work"),
              mediaEntryWire("entry-2", SECOND_MEDIA_ID, "Second Default Work"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
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
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "First Default Work"),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Present", value: String("cursor-2") },
          exhaustion: "Partial",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "First Default Work" }),
    ).toBeInTheDocument();

    expect(
      await screen.findByRole("link", { name: "Second Default Work" }),
    ).toBeInTheDocument();

    // Exactly one row for media-1: the media-keyed dedupe collapsed
    // entry-1/entry-1b into a single row rather than rendering both.
    expect(
      screen.getAllByRole("link", { name: "First Default Work" }),
    ).toHaveLength(1);
  });

  // Regression: the default library's "Added" row line must be dated by
  // media.created_at (the underlying media's Nexus-entry instant), not the
  // physical library entry's created_at — the two can differ once the same
  // media is deduped across representative entries. Previously untested.
  it("shows Added to Nexus dated by media.created_at under Added — oldest, absent under Recently added", async () => {
    const mediaCreatedIso = "2025-11-02T08:15:00Z";
    const entryCreatedIso = "2026-04-10T00:00:00Z";
    const expectedAddedToNexus = `Added to Nexus ${new Intl.DateTimeFormat(
      undefined,
      { year: "numeric", month: "short", day: "numeric" },
    ).format(new Date(mediaCreatedIso))}`;

    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (
        fetchInputPathWithSearch(input) ===
        `/api/libraries/${LIBRARY_ID}/entries?sort=added&direction=asc`
      ) {
        return Response.json({
          data: {
            items: [
              mediaEntryWire(
                "entry-a1",
                OLDEST_MEDIA_ID,
                "Oldest Default Work",
                {
                  createdAt: entryCreatedIso,
                  mediaCreatedAt: mediaCreatedIso,
                },
              ),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { unmount } = renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}?sort=added&direction=asc`,
      resources: {
        [LIBRARY_ID]: {
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed"),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Oldest Default Work" }),
    ).toBeInTheDocument();
    expect(screen.getByText(expectedAddedToNexus)).toBeInTheDocument();
    unmount();

    // Canonical ("Recently added") view: no Added to Nexus line at all, even
    // though the same media carries the same media.created_at.
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
          library: seededDefaultLibrary(),
          entries: [
            seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed", {
              mediaCreatedAt: mediaCreatedIso,
            }),
          ],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Canonical Seed" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Added to Nexus/)).not.toBeInTheDocument();
  });

  it("reconciles the All pane on every placement revision advance", async () => {
    let entriesReads = 0;
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/entries`) {
        entriesReads += 1;
        return Response.json({
          data: {
            items: [
              mediaEntryWire("entry-new", SECOND_MEDIA_ID, "Newly Filed"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
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
          library: seededDefaultLibrary(),
          entries: [seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Seed Work")],
          collectionRevision: 1,
          nextCursor: { kind: "Absent" },
          exhaustion: "Complete",
        },
      },
      children: paneWithLectern,
    });

    expect(
      await screen.findByRole("link", { name: "Seed Work" }),
    ).toBeInTheDocument();

    // The All pane reacts to every placement advance, even one scoped to a
    // different library, and reconciles its current view.
    act(() => publishLibraryPlacementChange(["some-other-library"]));

    expect(
      await screen.findByRole("link", { name: "Newly Filed" }),
    ).toBeInTheDocument();
    expect(entriesReads).toBe(1);
  });

  it("renders the Unfiled empty state with a Show all items recovery", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (path === `/api/libraries/${LIBRARY_ID}/entries?projection=unfiled`) {
        return Response.json({
          data: {
            items: [],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        return Response.json({
          data: {
            items: [
              mediaEntryWire("entry-all", TITLED_MEDIA_ID, "All Items Work"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulDefaultPane
        initialHref={`/libraries/${LIBRARY_ID}?projection=unfiled`}
        resources={{
          [LIBRARY_ID]: {
            library: seededDefaultLibrary(),
            entries: [
              seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
            exhaustion: "Complete",
          },
        }}
      />,
    );

    expect(await screen.findByText("Everything is filed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all items" }));

    expect(
      await screen.findByRole("link", { name: "All Items Work" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/libraries/${LIBRARY_ID}/entries`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(screen.getByRole("combobox", { name: "View" })).toHaveValue(
      "all-items",
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "View" })).toHaveFocus(),
    );
  });

  it("renders the Unfiled unfinished empty state with a Clear filters recovery", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      const lectern = lecternGetResponse(input);
      if (lectern) return lectern;
      const path = fetchInputPathWithSearch(input);
      if (
        path ===
        `/api/libraries/${LIBRARY_ID}/entries?projection=unfiled&completion=unfinished`
      ) {
        return Response.json({
          data: {
            items: [],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      if (path === `/api/libraries/${LIBRARY_ID}/entries`) {
        return Response.json({
          data: {
            items: [
              mediaEntryWire("entry-all", TITLED_MEDIA_ID, "All Items Work"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
          },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(
      <StatefulDefaultPane
        initialHref={`/libraries/${LIBRARY_ID}?projection=unfiled&completion=unfinished`}
        resources={{
          [LIBRARY_ID]: {
            library: seededDefaultLibrary(),
            entries: [
              seededMediaEntry("entry-1", FIRST_MEDIA_ID, "Canonical Seed"),
            ],
            collectionRevision: 1,
            nextCursor: { kind: "Absent" },
            exhaustion: "Complete",
          },
        }}
      />,
    );

    await screen.findByText("No unfinished unfiled items.");
    const emptyNotice = screen
      .getAllByRole("status")
      .find((status) =>
        within(status).queryByText("No unfinished unfiled items."),
      );
    if (!emptyNotice) {
      throw new Error("Expected the Unfiled unfinished empty-state notice.");
    }
    await user.click(
      within(emptyNotice).getByRole("button", { name: "Clear filters" }),
    );

    expect(
      await screen.findByRole("link", { name: "All Items Work" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "View" })).toHaveValue(
      "all-items",
    );
  });
});
