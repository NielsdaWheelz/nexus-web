import { type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { decodeLibraryReadingTimeEntry } from "@/lib/libraries/readingTime";
import LibraryPaneBody from "./LibraryPaneBody";

const LIBRARY_ID = "reading-slate-library";
const SECOND_LIBRARY_ID = "reading-slate-library-b";
const EXISTING_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const SUGGESTED_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const SUGGESTED_PODCAST_ID = "44444444-4444-4444-8444-444444444444";

function library(id = LIBRARY_ID, name = "Research") {
  return {
    id,
    name,
    is_default: false,
    role: "admin",
    owner_user_id: "user-1",
    system_key: null,
    can_rename: true,
    can_delete: true,
    can_edit_entries: true,
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
    <FeedbackProvider>
      <ResourceCacheProvider
        value={{
          [LIBRARY_ID]: {
            library: library(),
            entries: [entry("entry-1", EXISTING_MEDIA_ID, "Existing work")],
            entriesPage: { has_more: false, next_cursor: null },
          },
          [SECOND_LIBRARY_ID]: {
            library: library(SECOND_LIBRARY_ID, "Archive"),
            entries: [entry("entry-3", SECOND_MEDIA_ID, "Archived work")],
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      >
        <LecternProvider>
          <PaneRuntimeProvider
            paneId="pane-library"
            isActive={isActive}
            href={href}
            routeId={identity.routeId}
            routeKey={identity.routeKey}
            pathParams={{ id: libraryId }}
            canGoBack={false}
            canGoForward={false}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onOpenInNewPane={vi.fn()}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
          >
            {children}
          </PaneRuntimeProvider>
        </LecternProvider>
      </ResourceCacheProvider>
    </FeedbackProvider>,
  );
}

function entryWire(
  id: string,
  mediaId: string,
  title: string,
  presentation: {
    publisher?: string | null;
    image_url?: string | null;
    thumbnail_url?: string | null;
  } = {},
) {
  return {
    id,
    kind: "media",
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    media: {
      id: mediaId,
      kind: "web_article",
      title,
      contributors: [],
      published_date: null,
      publisher: presentation.publisher ?? null,
      image_url: presentation.image_url ?? null,
      thumbnail_url: presentation.thumbnail_url ?? null,
      canonical_source_url: null,
      processing_status: "ready_for_reading",
      read_state: "unread",
      progress_fraction: null,
      capabilities: { can_quote: true },
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
  search = "",
}: {
  children: ReactNode;
  isActive: boolean;
  initialEntries?: ReturnType<typeof entry>[];
  // Pane URL search (e.g. "sort=title&direction=asc"); empty = canonical view.
  search?: string;
}) {
  const href = `/libraries/${LIBRARY_ID}${search ? `?${search}` : ""}`;
  const identity = resolvePaneRouteIdentity(href);
  return withRenderEnvironment(
    <FeedbackProvider>
      <ResourceCacheProvider
        value={{
          [LIBRARY_ID]: {
            library: library(),
            entries: initialEntries,
            entriesPage: { has_more: false, next_cursor: null },
          },
        }}
      >
        <LecternProvider>
          <PaneRuntimeProvider
            paneId="pane-library"
            isActive={isActive}
            href={href}
            routeId={identity.routeId}
            routeKey={identity.routeKey}
            pathParams={{ id: LIBRARY_ID }}
            canGoBack={false}
            canGoForward={false}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onOpenInNewPane={vi.fn()}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
          >
            {children}
          </PaneRuntimeProvider>
        </LecternProvider>
      </ResourceCacheProvider>
    </FeedbackProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LibraryPaneBody Reading Slate host", () => {
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
          data: [entryWire("entry-3", SECOND_MEDIA_ID, "Archived work")],
          page: { has_more: false, next_cursor: null },
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
        <LibraryPaneBody />
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
        <LibraryPaneBody />
      </SwitchingHarness>,
    );
    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive>
        <LibraryPaneBody />
      </SwitchingHarness>,
    );
    expect(await screen.findByText("Archived work")).toBeVisible();
    await waitFor(() => expect(secondEntryReads).toBe(1));

    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive={false}>
        <LibraryPaneBody />
      </SwitchingHarness>,
    );
    view.rerender(
      <SwitchingHarness libraryId={SECOND_LIBRARY_ID} isActive>
        <LibraryPaneBody />
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
    expect(await screen.findByText("Suggested work")).toBeVisible();
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
        path === `/api/libraries/${LIBRARY_ID}/podcasts` &&
        method === "POST"
      ) {
        podcastBodies.push(String(init?.body));
        return response({ data: {} });
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
      JSON.stringify({ podcast_id: SUGGESTED_PODCAST_ID }),
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
    expect(screen.getByRole("list", { name: "Library entries" })).toBeVisible();
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

    expect(await screen.findByText("Minimal row")).toBeVisible();
    expect(screen.queryByText(publisher)).not.toBeInTheDocument();
    expect(screen.queryByText("ready_for_reading")).not.toBeInTheDocument();
    expect(screen.queryByText("web_article")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

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
          data:
            entryReads === 1
              ? [entryWire("entry-1", EXISTING_MEDIA_ID, "Existing work")]
              : [
                  entryWire("entry-1", EXISTING_MEDIA_ID, "Existing work"),
                  entryWire("entry-2", SUGGESTED_MEDIA_ID, "Suggested work"),
                ],
          page: { has_more: false, next_cursor: null },
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

    const rankedList = await screen.findByRole("list", {
      name: "Library entries",
    });
    expect(within(rankedList).getByText("Existing work")).toBeVisible();
    await user.click(
      await screen.findByRole("button", {
        name: "Add Suggested work to Research",
      }),
    );
    const unknown = await screen.findByRole("alert");
    expect(unknown).toHaveTextContent("Couldn’t confirm Add");
    expect(within(rankedList).getByText("Existing work")).toBeVisible();
    await user.click(within(unknown).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(addAttempts).toBe(2));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0] ?? "")).toEqual({
      library_ids: [LIBRARY_ID],
    });
    expect(within(rankedList).getByText("Existing work")).toBeVisible();
    expect(entryReads).toBe(1);

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
    await waitFor(() => expect(entryReads).toBe(2));
    expect(within(rankedList).getByText("Existing work")).toBeVisible();
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
    expect(await within(rankedList).findByText("Suggested work")).toBeVisible();
  });
});
