import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  stubFetch,
  wasFetchPathCalled,
} from "@/__tests__/helpers/fetch";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ApiError } from "@/lib/api/client";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { ResolvedPaneBodyMarker } from "@/lib/panes/paneRenderRegistry";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import NotesPaneBody, { notesErrorMessage } from "./NotesPaneBody";

const HYDRATED_PAGE_ID = "22222222-0000-4000-8000-000000000002";
const WORKSPACE_METRICS: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function NotesTestProviders({ children }: { children: ReactNode }) {
  return (
    <MobileChromeProvider>
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        <WorkspaceStoreProvider
          workspacePrimaryMetrics={WORKSPACE_METRICS}
          initialState={createDefaultWorkspaceState(
            "/libraries",
            WORKSPACE_METRICS,
          )}
        >
          {children}
        </WorkspaceStoreProvider>
      </AuthenticatedAccountProvider>
    </MobileChromeProvider>
  );
}

function WorkspaceProbe() {
  const { state, pendingPaneEntryDeliveryByPaneId } = useWorkspaceStore();
  const active = getWorkspacePrimaryPanes(state).find(
    (pane) => pane.id === state.activePrimaryPaneId,
  );
  return (
    <>
      <output aria-label="Active workspace href">
        {active?.currentVisit.href ?? ""}
      </output>
      <output aria-label="Pending daily entry">
        {pendingPaneEntryDeliveryByPaneId.size}
      </output>
    </>
  );
}

// AC-4 hydration-hit guard: when the bootstrap seeds the normalized note-page
// summaries as a BARE array under the cacheKey the pane reads ("notes:pages"),
// NotesPaneBody must paint the page title straight from that seed without making
// a client fetch. This pins the seeded shape in paneResourceLoaders.notes
// (NotePageSummary[]) against what the pane's useResource consumes — if either
// side drifts, this test fails.

describe("NotesPaneBody — Today button", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps only finite expected failures and preserves diagnostics", () => {
    expect(
      notesErrorMessage(
        new ApiError(0, "E_NETWORK", "offline", "req-notes"),
        "Load",
      ),
    ).toMatchObject({ tone: "Danger", requestId: "req-notes" });

    const sameSystem = new ApiError(500, "E_INTERNAL", "broken");
    expect(() => notesErrorMessage(sameSystem, "Load")).toThrow(sameSystem);

    const unknownCode = new ApiError(409, "E_NEW_NOTES_FAILURE", "new");
    expect(() => notesErrorMessage(unknownCode, "CreatePage")).toThrow(
      unknownCode,
    );

    const nonApi = new Error("decoder failed");
    expect(() => notesErrorMessage(nonApi, "Load")).toThrow(nonApi);
  });

  it("opens Today through the current OpenDailyPage view capability", async () => {
    const fetchMock = stubFetch(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/notes/pages") {
        return new Response(JSON.stringify({ data: { pages: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });

    renderHydratedPane({
      href: "/notes",
      resources: {},
      children: (
        <NotesTestProviders>
          <WorkspaceProbe />
          <LibraryPlacementControllerProvider>
            <NotesPaneBody />
          </LibraryPlacementControllerProvider>
        </NotesTestProviders>
      ),
    });

    const todayButton = await screen.findByRole("button", { name: "Today" });
    expect(todayButton).toBeInTheDocument();

    fireEvent.click(todayButton);

    await vi.waitFor(() => {
      expect(screen.getByLabelText("Active workspace href")).toHaveTextContent(
        `/daily/${formatLocalDateInTimeZone(new Date(), "UTC")}`,
      );
    });
    expect(screen.getByLabelText("Pending daily entry")).toHaveTextContent("0");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        fetchInputPath(input).startsWith("/api/notes/daily/"),
      ),
    ).toBe(false);
  });
});

describe("NotesPaneBody (AC-4 hydration hit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the seeded page title and never fetches /api/notes/pages", async () => {
    const fetchSpy = stubFetch(async () => {
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/notes",
      resources: {
        "notes:pages": [
          {
            id: HYDRATED_PAGE_ID,
            title: "Hydrated Note Page",
            description: null,
            updatedAt: "2026-06-02T12:00:00.000Z",
            actionTarget: routeResourceActionSubject({
              scheme: "page",
              id: HYDRATED_PAGE_ID,
              href: `/pages/${HYDRATED_PAGE_ID}`,
            }),
          },
        ],
      },
      children: (
        <NotesTestProviders>
          <ResolvedPaneBodyMarker>
            <LibraryPlacementControllerProvider>
              <NotesPaneBody />
            </LibraryPlacementControllerProvider>
          </ResolvedPaneBodyMarker>
        </NotesTestProviders>
      ),
    });

    // (a) The seeded page's title renders from the hydration cache.
    const pageLink = await screen.findByRole("link", {
      name: "Hydrated Note Page",
    });
    expect(pageLink).toBeInTheDocument();
    expect(pageLink).toHaveAttribute("data-row-focusable");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: pane-return row identity is a DOM data contract with no semantic query
    expect(pageLink.closest("[data-collection-row-id]")).toHaveAttribute(
      "data-collection-row-id",
      HYDRATED_PAGE_ID,
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: pane-return scope is a DOM data contract with no semantic query
    expect(pageLink.closest("[data-pane-return-scope]")).toHaveAttribute(
      "data-pane-return-scope",
      "Notes.Pages",
    );

    // (b) No client fetch to the notes pages endpoint — the seed was the source.
    const fetchedPages = wasFetchPathCalled(fetchSpy, "/api/notes/pages");
    expect(fetchedPages).toBe(false);
  });

  it("keeps the folio pending and count-free until page loading completes", async () => {
    let resolvePages!: (response: Response) => void;
    const pendingPages = new Promise<Response>((resolve) => {
      resolvePages = resolve;
    });
    const publish = vi.fn();
    stubFetch(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/notes/pages") return pendingPages;
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });

    renderHydratedPane({
      href: "/notes",
      resources: {},
      children: (
        <NotesTestProviders>
          <PanePrimaryChromeProvider publish={publish}>
            <NotesPaneBody />
          </PanePrimaryChromeProvider>
        </NotesTestProviders>
      ),
    });

    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.header)
          .find(
            (header) => header?.kind === "section" && header.pending === true,
          ),
      ).toEqual({
        kind: "section",
        folio: { kind: "none" },
        pending: true,
      }),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected NotesPaneBody to publish FilterRows.");
    }
    act(() => search.onQueryChange("missing"));
    expect(
      await screen.findByText("No matching page found so far."),
    ).toBeVisible();
    act(() => search.onQueryChange(""));

    resolvePages(
      Response.json({
        data: {
          pages: [
            {
              id: HYDRATED_PAGE_ID,
              title: "Loaded Note Page",
              updated_at: "2026-06-02T12:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(
      await screen.findByRole("link", { name: "Loaded Note Page" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.header)
          .find(
            (header) =>
              header?.kind === "section" &&
              header.pending === false &&
              header.folio.kind === "count",
          ),
      ).toEqual({
        kind: "section",
        folio: { kind: "count", value: 1, unit: "page" },
        pending: false,
      }),
    );
  });
});

describe("NotesPaneBody create replay identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retains an id across a response-loss retry and rotates it when the draft changes", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = stubFetch(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/notes/pages" && init?.method === "POST") {
        if (typeof init.body !== "string") {
          throw new Error("Expected a JSON create body");
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        createBodies.push(body);
        if (createBodies.length < 3) {
          return new Response(
            JSON.stringify({
              error: { code: "E_NETWORK", message: "Response lost" },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return Response.json(
          {
            data: {
              id: body.page_id,
              title: body.title,
              updatedAt: "2026-07-27T12:00:00Z",
              dailyPage: null,
            },
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });

    renderHydratedPane({
      href: "/notes",
      resources: { "notes:pages": [] },
      children: (
        <NotesTestProviders>
          <ResolvedPaneBodyMarker>
            <LibraryPlacementControllerProvider>
              <NotesPaneBody />
            </LibraryPlacementControllerProvider>
          </ResolvedPaneBodyMarker>
        </NotesTestProviders>
      ),
    });

    const title = screen.getByRole("textbox", { name: "New page title" });
    const create = screen.getByRole("button", { name: "Create page" });
    fireEvent.change(title, { target: { value: "First draft" } });
    fireEvent.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(1));

    fireEvent.change(title, { target: { value: "Changed draft" } });
    fireEvent.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(2));
    fireEvent.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(3));

    expect(createBodies.map((body) => body.title)).toEqual([
      "First draft",
      "Changed draft",
      "Changed draft",
    ]);
    expect(createBodies[0]?.page_id).not.toBe(createBodies[1]?.page_id);
    expect(createBodies[1]?.page_id).toBe(createBodies[2]?.page_id);
    expect(createBodies[2]?.page_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    void fetchMock;
  });

  it("does not replay validation failure and mints a new create intent after editing", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    stubFetch(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/notes/pages" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createBodies.push(body);
        if (createBodies.length === 1) {
          return Response.json(
            {
              error: {
                code: "E_BAD_REQUEST",
                message: "Invalid title",
                request_id: "req-invalid-page",
              },
            },
            { status: 400 },
          );
        }
        return Response.json(
          {
            data: {
              id: body.page_id,
              title: body.title,
              updatedAt: "2026-07-27T12:00:00Z",
              dailyPage: null,
            },
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    });
    renderHydratedPane({
      href: "/notes",
      resources: { "notes:pages": [] },
      children: (
        <NotesTestProviders>
          <ResolvedPaneBodyMarker>
            <LibraryPlacementControllerProvider>
              <NotesPaneBody />
            </LibraryPlacementControllerProvider>
          </ResolvedPaneBodyMarker>
        </NotesTestProviders>
      ),
    });

    const title = screen.getByRole("textbox", { name: "New page title" });
    fireEvent.change(title, { target: { value: "Invalid draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Change the page title, then submit it again",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.change(title, { target: { value: "Valid draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(createBodies).toHaveLength(2));
    expect(createBodies[1]?.page_id).not.toBe(createBodies[0]?.page_id);
  });
});
