import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";

const OWNER_USER_HANDLE = "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

// AC-4 hydration-hit guard: when the bootstrap seeds the raw /libraries envelope
// under the cacheKey the pane reads ("libraries:0"), LibrariesPaneBody must paint
// from that seed without making a client fetch. This pins the seeded shape in
// paneResourceLoaders ({ data: Library[] }) against what the pane consumes
// (librariesResource.data.data) — if either drifts, this test fails.

afterEach(() => {
  vi.restoreAllMocks();
});

function fetchInputPathWithSearch(input: unknown): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

function librariesPage<T>(
  items: T[],
  nextCursor?: string,
  collectionRevision = 1,
) {
  return {
    items,
    collectionRevision,
    nextCursor:
      nextCursor === undefined
        ? { kind: "Absent" as const }
        : { kind: "Present" as const, value: nextCursor },
  };
}

describe("LibrariesPaneBody (AC-4 hydration hit)", () => {
  it("paints the seeded library and never fetches /api/libraries", async () => {
    const user = userEvent.setup();
    const publish = vi.fn();
    const library = {
            id: "00000000-0000-4000-8000-000000000201",
            name: "Bootstrapped Reading Room",
            color: null,
            ownerUserHandle: OWNER_USER_HANDLE,
            isDefault: false,
            role: "admin",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            systemKey: null,
            canRename: true,
            canDelete: true,
            canEditEntries: true,
            canManageMembers: true,
            canTransferOwnership: true,
    };
    const neighbor = {
      ...library,
      id: "00000000-0000-4000-8000-000000000202",
      name: "Neighbor Reading Room",
    };
    const fetchSpy = stubFetch(async (input, init) => {
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (
        path === `/api/libraries/${library.id}` &&
        init?.method === "PATCH"
      ) {
        return Response.json({
          data: {
            library: { ...library, name: "Renamed" },
            collectionRevision: 2,
          },
        });
      }
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([library, neighbor]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <PanePrimaryChromeProvider publish={publish}>
            <div data-pane-id="pane-1">
            <LibrariesPaneBody />
            </div>
          </PanePrimaryChromeProvider>
        </LibraryPlacementControllerProvider>
      ),
    });

    // (a) The seeded library's name renders from the hydration cache.
    expect(
      await screen.findByRole("link", { name: "Bootstrapped Reading Room" }),
    ).toBeInTheDocument();

    // (b) No client fetch to the libraries list endpoint — the seed was the source.
    const fetchedLibraries = wasFetchPathCalled(fetchSpy, "/api/libraries");
    expect(fetchedLibraries).toBe(false);

    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search?.kind === "FilterRows"),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate?.kind === "FilterRows");
    if (search?.kind !== "FilterRows") {
      throw new Error("Expected LibrariesPaneBody to publish FilterRows.");
    }
    act(() => search.onQueryChange("reading room"));
    await user.click(
      screen.getByRole("button", {
        name: "More actions for Bootstrapped Reading Room",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
    const name = screen.getByLabelText("Library name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("link", { name: "Neighbor Reading Room" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Bootstrapped Reading Room" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Neighbor Reading Room" }),
      ).toHaveFocus(),
    );
  });

  it("retains the committed rows and resolves an exact failure announcement when owner revalidation fails", async () => {
    const publish = vi.fn();
    const library = {
      id: "00000000-0000-4000-8000-000000000211",
      name: "Retained Reading Room",
      color: null,
      ownerUserHandle: OWNER_USER_HANDLE,
      isDefault: false,
      role: "admin",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
    };
    stubFetch(async (input) => {
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (new URL(path, "http://localhost").pathname === "/api/libraries") {
        return Response.json(
          { error: { code: "E_BAD_REQUEST", message: "Refresh failed" } },
          { status: 400 },
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([library]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <PanePrimaryChromeProvider publish={publish}>
            <LibrariesPaneBody />
          </PanePrimaryChromeProvider>
        </LibraryPlacementControllerProvider>
      ),
    });
    expect(
      await screen.findByRole("link", { name: "Retained Reading Room" }),
    ).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.refresh)
          .findLast(Boolean),
      ).toBeDefined(),
    );
    const refresh = publish.mock.calls
      .map(([update]) => update.publication?.refresh)
      .findLast(Boolean);
    if (!refresh) throw new Error("Expected Libraries refresh publication");

    let refreshPromise!: ReturnType<typeof refresh.execute>;
    act(() => {
      refreshPromise = refresh.execute({
        signal: new AbortController().signal,
        reportProgress: vi.fn(),
      });
    });
    await expect(refreshPromise).resolves.toEqual({
      kind: "Failed",
      announcement: "Libraries failed to refresh",
    });
    expect(
      screen.getByRole("link", { name: "Retained Reading Room" }),
    ).toBeInTheDocument();
  });

  it("rejects an aborted owner refresh, ignores its late first page, and retains the committed index", async () => {
    const publish = vi.fn();
    const stableLibrary = {
      id: "00000000-0000-4000-8000-000000000212",
      name: "Stable Reading Room",
      color: null,
      ownerUserHandle: OWNER_USER_HANDLE,
      isDefault: false,
      role: "admin",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
    };
    let resolveLatePage!: (response: Response) => void;
    const latePage = new Promise<Response>((resolve) => {
      resolveLatePage = resolve;
    });
    let libraryRequests = 0;
    stubFetch(async (input) => {
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (new URL(path, "http://localhost").pathname === "/api/libraries") {
        libraryRequests += 1;
        return latePage;
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([stableLibrary]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <PanePrimaryChromeProvider publish={publish}>
            <LibrariesPaneBody />
          </PanePrimaryChromeProvider>
        </LibraryPlacementControllerProvider>
      ),
    });
    expect(
      await screen.findByRole("link", { name: "Stable Reading Room" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.refresh)
          .findLast(Boolean),
      ).toBeDefined(),
    );
    const refresh = publish.mock.calls
      .map(([update]) => update.publication?.refresh)
      .findLast(Boolean);
    if (!refresh) throw new Error("Expected Libraries refresh publication");

    const owner = new AbortController();
    const refreshPromise = refresh.execute({
      signal: owner.signal,
      reportProgress: vi.fn(),
    });
    const expectedAbort = expect(refreshPromise).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(libraryRequests).toBe(1));
    owner.abort(new DOMException("Source replaced.", "AbortError"));
    await expectedAbort;

    act(() => {
      resolveLatePage(
        Response.json({
          data: librariesPage([
            { ...stableLibrary, name: "Late stale Reading Room" },
          ]),
        }),
      );
    });
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Late stale Reading Room" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("link", { name: "Stable Reading Room" }),
    ).toBeVisible();
  });

  it("retains an id across a response-loss retry and rotates it when the draft changes", async () => {
    const user = userEvent.setup();
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = stubFetch(async (input, init) => {
      const path = fetchInputPathWithSearch(input);
      const url = new URL(path, "http://localhost");
      if (path === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (url.pathname === "/api/libraries" && init?.method === "POST") {
        if (typeof init.body !== "string") {
          throw new Error("Expected a JSON create body");
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        createBodies.push(body);
        if (createBodies.length < 3) {
          return Response.json(
            { error: { code: "E_UPSTREAM", message: "Response lost" } },
            { status: 500 },
          );
        }
        return Response.json(
          {
            data: {
              id: body.library_id,
              name: body.name,
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
              createdAt: "2026-07-27T12:00:00Z",
              updatedAt: "2026-07-27T12:00:00Z",
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/libraries") {
        return Response.json({
          data: librariesPage([]),
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <LibrariesPaneBody />
        </LibraryPlacementControllerProvider>
      ),
    });

    const name = screen.getByPlaceholderText("New library name...");
    const create = screen.getByRole("button", { name: "Create" });
    await user.type(name, "First draft");
    await user.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(1));
    await vi.waitFor(() => expect(create).toBeEnabled());

    await user.clear(name);
    await user.type(name, "Changed draft");
    await user.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(2));
    await vi.waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await vi.waitFor(() => expect(createBodies).toHaveLength(3));

    expect(createBodies.map((body) => body.name)).toEqual([
      "First draft",
      "Changed draft",
      "Changed draft",
    ]);
    expect(createBodies[0]?.library_id).not.toBe(createBodies[1]?.library_id);
    expect(createBodies[1]?.library_id).toBe(createBodies[2]?.library_id);
    expect(createBodies[2]?.library_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    void fetchSpy;
  });

  it("presents the default library as the All view", async () => {
    const publish = vi.fn();
    stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([
          {
            id: "00000000-0000-4000-8000-000000000200",
            name: "My Library",
            color: null,
            ownerUserHandle: OWNER_USER_HANDLE,
            isDefault: true,
            role: "admin",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            systemKey: null,
            canRename: false,
            canDelete: false,
            canEditEntries: true,
            canManageMembers: true,
            canTransferOwnership: true,
          },
        ]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <PanePrimaryChromeProvider publish={publish}>
          <LibrariesPaneBody />
          </PanePrimaryChromeProvider>
        </LibraryPlacementControllerProvider>
      ),
    });

    // The default library surfaces as the "All" view with its cross-library
    // secondary; the stored seed name "My Library" never reaches the surface.
    expect(
      await screen.findByRole("link", { name: "All" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Across your libraries")).toBeInTheDocument();
    expect(screen.queryByText("My Library")).not.toBeInTheDocument();

    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.search)
          .findLast((search) => search !== undefined),
      ).toBeDefined(),
    );
    const search = publish.mock.calls
      .map(([update]) => update.publication?.search)
      .findLast((candidate) => candidate !== undefined);
    act(() => search?.onQueryChange("all"));
    expect(
      await screen.findByRole("link", { name: "All" }),
    ).toBeInTheDocument();
    await vi.waitFor(() => {
      const updatedSearch = publish.mock.calls
        .map(([update]) => update.publication?.search)
        .findLast((candidate) => candidate !== undefined);
      expect(updatedSearch?.rowStatus).toEqual({
        kind: "Complete",
        visibleCount: 1,
        totalCount: 1,
        unit: { singular: "library", plural: "libraries" },
      });
    });
  });

  it("blocks creating a library named All and explains why", async () => {
    const user = userEvent.setup();
    stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      throw new Error("unexpected client fetch; the create must be suppressed");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <LibrariesPaneBody />
        </LibraryPlacementControllerProvider>
      ),
    });

    // Casing is irrelevant: "All" is reserved for the All view regardless of case.
    await user.type(
      await screen.findByPlaceholderText("New library name..."),
      "aLL",
    );

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByText("All is reserved for the All view."),
    ).toBeInTheDocument();
  });

  it("automatically exhausts another library page from the hydrated cursor", async () => {
    let resolveContinuation!: (response: Response) => void;
    const continuation = new Promise<Response>((resolve) => {
      resolveContinuation = resolve;
    });
    const publish = vi.fn();
    const fetchSpy = stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (
        fetchInputPathWithSearch(input) ===
        "/api/libraries?cursor=cursor-2&collection_revision=1&limit=100"
      ) {
        return continuation;
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage(
          [
            {
              id: "00000000-0000-4000-8000-000000000201",
              name: "Bootstrapped Reading Room",
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
            },
          ],
          "cursor-2",
        ),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <PanePrimaryChromeProvider publish={publish}>
          <LibrariesPaneBody />
          </PanePrimaryChromeProvider>
        </LibraryPlacementControllerProvider>
      ),
    });

    expect(
      await screen.findByRole("link", { name: "Bootstrapped Reading Room" }),
    ).toBeVisible();
    await vi.waitFor(() =>
      expect(
        publish.mock.calls
          .map(([update]) => update.publication?.header)
          .findLast((header) => header?.kind === "section"),
      ).toEqual({
        kind: "section",
        folio: { kind: "none" },
        pending: true,
      }),
    );
    resolveContinuation(
      Response.json({
        data: librariesPage([
          {
            id: "00000000-0000-4000-8000-000000000202",
            name: "Second Page Library",
            color: null,
            ownerUserHandle: OWNER_USER_HANDLE,
            isDefault: false,
            role: "admin",
            createdAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            systemKey: null,
            canRename: true,
            canDelete: true,
            canEditEntries: true,
            canManageMembers: true,
            canTransferOwnership: true,
          },
        ]),
      }),
    );
    expect(
      await screen.findByRole("link", { name: "Second Page Library" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more libraries" }),
    ).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries?cursor=cursor-2&collection_revision=1&limit=100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rebases a safe deletion onto the same continuation cursor without a page-one refresh", async () => {
    const user = userEvent.setup();
    const deletedId = "00000000-0000-4000-8000-000000000201";
    const retainedId = "00000000-0000-4000-8000-000000000202";
    const continuedId = "00000000-0000-4000-8000-000000000203";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = stubFetch(async (input, init) => {
      const path = fetchInputPathWithSearch(input);
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (
        url.pathname === `/api/libraries/${deletedId}` &&
        init?.method === "DELETE"
      ) {
        return Response.json({
          data: { libraryId: deletedId, collectionRevision: 2 },
        });
      }
      if (
        path ===
        "/api/libraries?cursor=cursor-2&collection_revision=1&limit=100"
      ) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (
        path ===
        "/api/libraries?cursor=cursor-2&collection_revision=2&limit=100"
      ) {
        return Response.json({
          data: librariesPage(
            [
              {
                id: continuedId,
                name: "Continued Library",
                color: null,
                ownerUserHandle: OWNER_USER_HANDLE,
                isDefault: false,
                role: "admin",
                createdAt: "2026-01-03T00:00:00Z",
                updatedAt: "2026-01-03T00:00:00Z",
                systemKey: null,
                canRename: true,
                canDelete: true,
                canEditEntries: true,
                canManageMembers: true,
                canTransferOwnership: true,
              },
            ],
            undefined,
            2,
          ),
        });
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method ?? "GET"}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage(
          [
            {
              id: deletedId,
              name: "Delete Me",
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
            },
            {
              id: retainedId,
              name: "Keep Me",
              color: null,
              ownerUserHandle: OWNER_USER_HANDLE,
              isDefault: false,
              role: "admin",
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
              systemKey: null,
              canRename: true,
              canDelete: true,
              canEditEntries: true,
              canManageMembers: true,
              canTransferOwnership: true,
            },
          ],
          "cursor-2",
        ),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <div data-pane-id="pane-1">
          <LibrariesPaneBody />
          </div>
        </LibraryPlacementControllerProvider>
      ),
    });

    await user.click(
      await screen.findByRole("button", {
        name: "More actions for Delete Me",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete library" }),
    );

    await vi.waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/libraries?cursor=cursor-2&collection_revision=2&limit=100",
        expect.objectContaining({ method: "GET" }),
      ),
    );
    expect(
      await screen.findByRole("link", { name: "Continued Library" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Delete Me" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Keep Me" })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "Keep Me" })).toHaveFocus(),
    );
    expect(
      fetchSpy.mock.calls.some(([input, init]) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        return (
          url.pathname === "/api/libraries" &&
          url.search === "" &&
          (!init?.method || init.method === "GET")
        );
      }),
    ).toBe(false);
  });

  it("lets an invitee accept a sealed library invitation from the library inbox", async () => {
    const user = userEvent.setup();
    const invitationHandle =
      "nli1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
    const inviterHandle = "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
    const inviteeHandle = "nus1.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFF";
    let inviteReads = 0;
    const fetchSpy = stubFetch(async (input, init) => {
      const path = fetchInputPathWithSearch(input);
      if (
        path === "/api/libraries/invites" &&
        (!init?.method || init.method === "GET")
      ) {
        inviteReads += 1;
        return Response.json({
          data:
            inviteReads === 1
              ? [
                  {
                    invitationHandle,
                    libraryId: "22222222-2222-4222-8222-222222222222",
                    libraryName: "Shared Research",
                    inviterUserHandle: inviterHandle,
                    inviteeUserHandle: inviteeHandle,
                    role: "member",
                    status: "pending",
                    inviteeEmail: {
                      kind: "Present",
                      value: "invitee@example.test",
                    },
                    inviteeDisplayName: {
                      kind: "Present",
                      value: "Invitee",
                    },
                    createdAt: "2026-01-02T00:00:00Z",
                    respondedAt: { kind: "Absent" },
                  },
                ]
              : [],
        });
      }
      if (
        path === `/api/libraries/invites/${invitationHandle}/accept` &&
        init?.method === "POST"
      ) {
        return Response.json({
          data: {
            invite: {
              invitationHandle,
              libraryId: "22222222-2222-4222-8222-222222222222",
              inviterUserHandle: inviterHandle,
              inviteeUserHandle: inviteeHandle,
              role: "member",
              status: "accepted",
              inviteeEmail: {
                kind: "Present",
                value: "invitee@example.test",
              },
              inviteeDisplayName: {
                kind: "Present",
                value: "Invitee",
              },
              createdAt: "2026-01-02T00:00:00Z",
              respondedAt: {
                kind: "Present",
                value: "2026-01-03T00:00:00Z",
              },
            },
            membership: {
              libraryId: "22222222-2222-4222-8222-222222222222",
              userHandle: inviteeHandle,
              role: "member",
            },
            idempotent: false,
          },
        });
      }
      if (new URL(path, "http://localhost").pathname === "/api/libraries") {
        return Response.json({
          data: librariesPage([], undefined, 2),
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": librariesPage([]),
      },
      children: (
        <LibraryPlacementControllerProvider>
          <LibrariesPaneBody />
        </LibraryPlacementControllerProvider>
      ),
    });

    expect(
      await screen.findByRole("heading", { name: "Library invitations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Shared Research · Member")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await vi.waitFor(() =>
      expect(screen.queryByText("Shared Research · Member")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Library invitation accepted.")).not.toBeInTheDocument();
    expect(
      wasFetchPathCalled(
        fetchSpy,
        `/api/libraries/invites/${invitationHandle}/accept`,
      ),
    ).toBe(true);
  });
});
