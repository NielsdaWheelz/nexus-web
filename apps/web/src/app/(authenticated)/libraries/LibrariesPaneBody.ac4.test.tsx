import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import LibrariesPaneBody from "./LibrariesPaneBody";
import { stubFetch, wasFetchPathCalled } from "@/__tests__/helpers/fetch";

const OWNER_USER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

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

describe("LibrariesPaneBody (AC-4 hydration hit)", () => {
  it("paints the seeded library and never fetches /api/libraries", async () => {
    const publish = vi.fn();
    const fetchSpy = stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      throw new Error("unexpected client fetch on a hydration hit");
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [
            {
              id: "lib-seed-1",
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
          page: { has_more: false, next_cursor: null },
        },
      },
      children: (
        <PanePrimaryChromeProvider publish={publish}>
          <LibrariesPaneBody />
        </PanePrimaryChromeProvider>
      ),
    });

    // (a) The seeded library's name renders from the hydration cache.
    expect(
      await screen.findByText("Bootstrapped Reading Room"),
    ).toBeInTheDocument();

    // (b) No client fetch to the libraries list endpoint — the seed was the source.
    const fetchedLibraries = wasFetchPathCalled(fetchSpy, "/api/libraries");
    expect(fetchedLibraries).toBe(false);
    await waitFor(() => {
      const update = publish.mock.calls.findLast(
        ([value]) => value.publication !== null,
      )?.[0];
      expect(
        update?.publication?.options?.filter(
          (option: { id: string }) => option.id === "share",
        ) ?? [],
      ).toHaveLength(0);
    });
  });

  it("loads another library page from the hydrated first page cursor", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch(async (input) => {
      if (fetchInputPathWithSearch(input) === "/api/libraries/invites") {
        return Response.json({ data: [] });
      }
      if (fetchInputPathWithSearch(input) === "/api/libraries?cursor=cursor-2") {
        return Response.json({
          data: [
            {
              id: "lib-seed-2",
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
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [
            {
              id: "lib-seed-1",
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
          page: { has_more: true, next_cursor: "cursor-2" },
        },
      },
      children: <LibrariesPaneBody />,
    });

    await user.click(await screen.findByRole("button", { name: "Load more libraries" }));

    expect(await screen.findByText("Second Page Library")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries?cursor=cursor-2",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lets an invitee accept a sealed library invitation from the library inbox", async () => {
    const user = userEvent.setup();
    const invitationHandle =
      "nli1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
    const inviterHandle =
      "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
    const inviteeHandle =
      "nus1.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFF";
    let inviteReads = 0;
    const fetchSpy = stubFetch(async (input, init) => {
      const path = fetchInputPathWithSearch(input);
      if (path === "/api/libraries/invites" && (!init?.method || init.method === "GET")) {
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
                    inviteeEmail: "invitee@example.test",
                    inviteeDisplayName: "Invitee",
                    createdAt: "2026-01-02T00:00:00Z",
                    respondedAt: null,
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
              inviteeEmail: "invitee@example.test",
              inviteeDisplayName: "Invitee",
              createdAt: "2026-01-02T00:00:00Z",
              respondedAt: "2026-01-03T00:00:00Z",
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
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    renderHydratedPane({
      href: "/libraries",
      resources: {
        "libraries:0": {
          data: [],
          page: { has_more: false, next_cursor: null },
        },
      },
      children: <LibrariesPaneBody />,
    });

    expect(
      await screen.findByRole("heading", { name: "Library invitations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Shared Research · Member")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(
      await screen.findByText("Library invitation accepted."),
    ).toBeInTheDocument();
    expect(
      wasFetchPathCalled(
        fetchSpy,
        `/api/libraries/invites/${invitationHandle}/accept`,
      ),
    ).toBe(true);
  });
});
