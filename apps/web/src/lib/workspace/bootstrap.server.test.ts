import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { callFastAPI } from "@/lib/api/server";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ReaderProfile } from "@/lib/reader/types";
import {
  assumePaneVisitId,
  createWorkspaceStateFromPrimaryPanes,
  getWorkspacePrimaryPanes,
  type WorkspacePrimaryPaneState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";
import { loadWorkspaceBootstrap } from "./bootstrap.server";

// server-only is the React/Next marker package; its module body throws on import
// outside a Server Component. Neutralize it so the bootstrap + pane loaders (both
// "server-only") can be exercised under the node test runner.
vi.mock("server-only", () => ({}));

// The two external request-scoped boundaries the server data root reads through:
// headers() for the middleware-stamped request path, and cookies() for the
// server-owned device id that keys the saved workspace session. Settable maps drive
// both; the tests populate them before each call. A missing cookie returns undefined
// (mirroring next/headers' RequestCookie | undefined contract).
const requestHeaders = new Map<string, string>();
const requestCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string): string | null => requestHeaders.get(name) ?? null,
  })),
  cookies: vi.fn(async () => ({
    get: (name: string): { value: string } | undefined => {
      const value = requestCookies.get(name);
      return value === undefined ? undefined : { value };
    },
  })),
}));

// callFastAPI is the only network edge — the bootstrap (reader profile + workspace
// session) and every pane loader fetch through it. A per-path script controls each
// outcome so the tests assert the OBSERVABLE composition the panes' useResource will
// read.
vi.mock("@/lib/api/server", () => ({
  callFastAPI: vi.fn(),
}));

const mockCallFastAPI = vi.mocked(callFastAPI);

type Responder = (path: string) => unknown;

// Route callFastAPI by path; an unmapped path rejects so a loader that depends on
// it is omitted (D-8) rather than silently seeding a partial shape.
function respondWith(routes: Record<string, unknown>): void {
  mockCallFastAPI.mockImplementation(async (path: string) => {
    if (path in routes) {
      return routes[path] as never;
    }
    throw new Error(`unmapped path: ${path}`);
  });
}

function respondWithFn(responder: Responder): void {
  mockCallFastAPI.mockImplementation(
    async (path: string) => responder(path) as never,
  );
}

// The exact seven-field profile the strict decoder accepts; there is no frontend default.
const READER_PROFILE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: "off",
  hyphenation: "auto",
};

function librariesPage(id: string) {
  return {
    items: [
      {
        id,
        name: "Research",
        color: null,
        ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        isDefault: false,
        role: "admin",
        systemKey: null,
        canRename: true,
        canDelete: true,
        canEditEntries: true,
        canManageMembers: true,
        canTransferOwnership: true,
        createdAt: "2026-07-29T10:00:00Z",
        updatedAt: "2026-07-29T10:00:00Z",
      },
    ],
    collectionRevision: 1,
    nextCursor: { kind: "Absent" as const },
  };
}

const EMPTY_COLLECTION_ENVELOPE = {
  data: {
    items: [],
    collectionRevision: 0,
    nextCursor: { kind: "Absent" as const },
  },
};

// A reader-profile responder shared by the resource cases that don't care about it.
const PROFILE_OK = { data: READER_PROFILE };
const NOTE_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_BLOCK_ID = "22222222-2222-4222-8222-222222222222";

// Saved-session builders — the same primary()/workspace() helpers sessionSync.test.ts
// uses, so the raw `own`/`most_recent_elsewhere` states the bootstrap exact-decodes and
// restores are built the way the client store actually persists them.
const emptyHistory = () => ({ back: [], forward: [] });
let nextVisitIndex = 1;

function primary(
  id: string,
  href: string,
  input: Partial<
    Pick<
      WorkspacePrimaryPaneState,
      "primaryWidthPx" | "visibility" | "history" | "attachedSecondaryPaneId"
    >
  > = {},
): WorkspacePrimaryPaneState {
  const visitIndex = nextVisitIndex;
  nextVisitIndex += 1;
  return {
    id,
    currentVisit: {
      id: assumePaneVisitId(
        `00000000-0000-4000-8000-${String(visitIndex).padStart(12, "0")}`,
      ),
      href,
    },
    primaryWidthPx: input.primaryWidthPx ?? 684,
    visibility: input.visibility ?? "visible",
    history: input.history ?? emptyHistory(),
    attachedSecondaryPaneId: input.attachedSecondaryPaneId ?? null,
  };
}

function workspace(input: {
  activePrimaryPaneId?: string;
  primaryPanes: WorkspacePrimaryPaneState[];
}): WorkspaceState {
  return createWorkspaceStateFromPrimaryPanes({
    activePrimaryPaneId: input.activePrimaryPaneId ?? input.primaryPanes[0]!.id,
    primaryPanes: input.primaryPanes,
  });
}

function sessionEnvelope(input: {
  own?: WorkspaceState | null;
  mostRecentElsewhere?: WorkspaceState | null;
}): {
  data: {
    own: { state: unknown; updated_at: string } | null;
    most_recent_elsewhere: { state: unknown; updated_at: string } | null;
  };
} {
  return {
    data: {
      own: input.own
        ? { state: input.own, updated_at: "2026-01-01T00:00:00Z" }
        : null,
      most_recent_elsewhere: input.mostRecentElsewhere
        ? {
            state: input.mostRecentElsewhere,
            updated_at: "2026-01-01T00:00:00Z",
          }
        : null,
    },
  };
}

function visibleHrefs(state: WorkspaceState): string[] {
  return getWorkspacePrimaryPanes(state)
    .filter((pane) => pane.visibility === "visible")
    .map((pane) => pane.currentVisit.href);
}

function activeHref(state: WorkspaceState): string | undefined {
  return getWorkspacePrimaryPanes(state).find(
    (pane) => pane.id === state.activePrimaryPaneId,
  )?.currentVisit.href;
}

beforeEach(() => {
  nextVisitIndex = 1;
  requestHeaders.clear();
  requestCookies.clear();
  mockCallFastAPI.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadWorkspaceBootstrap", () => {
  it("seeds the libraries pane resource keyed exactly as its useResource reads it", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    const page = librariesPage("lib-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries?limit=100": { data: page },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["libraries:0"]).toEqual(page);
  });

  it("defects when the required request-path header is missing", async () => {
    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "Missing required workspace request path",
    );
    expect(mockCallFastAPI).not.toHaveBeenCalled();
  });

  it("defects when the request-path header is malformed or non-canonical", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/lectern/../libraries");

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "Request path must be a canonical pathname and search",
    );
    expect(mockCallFastAPI).not.toHaveBeenCalled();
  });

  it("resumes a saved root workspace unchanged without creating or seeding a root pane", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-notes",
      primaryPanes: [
        primary("pane-notes", "/notes"),
        primary("pane-media", "/media/123"),
      ],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/notes/pages": { data: { pages: [] } },
      "/media/123": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.initialState).toEqual(ownState);
    expect(result.initialState.activePrimaryPaneId).toBe("pane-notes");
    expect(visibleHrefs(result.initialState)).toEqual(["/notes", "/media/123"]);
    expect(visibleHrefs(result.initialState)).not.toContain("/lectern");
    expect(mockCallFastAPI).not.toHaveBeenCalledWith("/", expect.anything());
  });

  it("treats a root shell query as Resume instead of a pane href", async () => {
    requestHeaders.set(
      REQUEST_PATH_HEADER,
      "/?nexus=1&intent=WebSearch&q=kafka",
    );
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      primaryPanes: [primary("pane-notes", "/notes")],
    });
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/notes/pages": { data: { pages: [] } },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState)).toEqual(["/notes"]);
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      "/?nexus=1&intent=WebSearch&q=kafka",
      expect.anything(),
    );
  });

  it("uses the Lectern default only when root Resume has no usable session", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/");
    const slateEnvelope = { data: { items: [] } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/lectern/slate": slateEnvelope,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState)).toEqual([
      WORKSPACE_DEFAULT_FALLBACK_HREF,
    ]);
    expect(activeHref(result.initialState)).toBe(
      WORKSPACE_DEFAULT_FALLBACK_HREF,
    );
    expect(result.resources["lectern:slate:0"]).toEqual({ items: [] });
  });

  it("loads fragments for a readable media kind and composes the media pane resource", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/abc");
    const media = { kind: "podcast_episode", capabilities: { can_read: true } };
    const fragment = { id: "frag-1", text: "hello" };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/media/abc": { data: media },
      "/media/abc/fragments": { data: [fragment] },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["abc"]).toEqual({
      media,
      fragments: { status: "ready", data: [fragment] },
    });
    expect(mockCallFastAPI).toHaveBeenCalledWith(
      "/media/abc/fragments",
      expect.anything(),
    );
  });

  it("skips the fragments fetch for an epub and seeds empty fragments", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/ep");
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/media/ep": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["ep"]).toEqual({
      media,
      fragments: { status: "ready", data: [] },
    });
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      "/media/ep/fragments",
      expect.anything(),
    );
  });

  it("composes the author pane resource with the detail + first works page", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/authors/jane");
    const contributorId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "22222222-2222-4222-8222-222222222222";
    const detail = {
      handle: "jane",
      href: "/authors/jane",
      displayName: "Jane Doe",
      otherNames: ["J. Doe"],
      canRename: true,
      actionTarget: {
        kind: "Resource",
        ref: `contributor:${contributorId}`,
        activation: {
          resourceRef: `contributor:${contributorId}`,
          kind: "route",
          href: "/authors/jane",
          unresolvedReason: null,
        },
        missing: false,
      },
    };
    const work = {
      title: "A Book",
      href: "/media/work-1",
      contentKind: "epub",
      date: "2020-01-01",
      roleFacts: [{ creditedName: "Jane Doe", role: "author", rawRole: null }],
      actionTarget: {
        kind: "Resource",
        ref: `media:${mediaId}`,
        activation: {
          resourceRef: `media:${mediaId}`,
          kind: "route",
          href: "/media/work-1",
          unresolvedReason: null,
        },
        missing: false,
      },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/contributors/jane": { data: detail },
      "/contributors/jane/works?limit=100": {
        data: {
          items: [work],
          collectionRevision: 4,
          nextCursor: { kind: "Absent" },
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["author:jane"]).toEqual({
      detail: {
        handle: "jane",
        href: "/authors/jane",
        displayName: "Jane Doe",
        otherNames: ["J. Doe"],
        canRename: true,
        actionTarget: detail.actionTarget,
      },
      works: [
        {
          ...work,
          date: { kind: "Present", value: "2020-01-01" },
        },
      ],
      collectionRevision: 4,
      nextCursor: { kind: "Absent" },
      exhaustion: "Complete",
    });
  });

  it("composes the library detail resource from library and entries paths", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries/lib-1");
    const library = {
      id: "lib-1",
      name: "Seeded Library",
      color: null,
      ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
      isDefault: false,
      role: "admin",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
      createdAt: "2026-07-24T10:00:00Z",
      updatedAt: "2026-07-24T10:30:00Z",
    };
    const entry = {
      kind: "media",
      placement: {
        kind: "Present",
        value: { libraryEntryId: "entry-1", position: 0 },
      },
      addedAt: "2026-07-24T10:15:00Z",
      media: {
        id: "media-1",
        kind: "web_article",
        title: "A compact list item",
        created_at: "2026-07-24T10:00:00Z",
        contributors: [],
        author_mode: "automatic",
        processing_status: "ready_for_reading",
        read_state: "unread",
        progress_resettable: false,
        progress_fraction: null,
        last_engaged_at: null,
        published_date: null,
        canonical_source_url: "https://example.test/article",
        capabilities: {
          can_quote: true,
          can_retry: false,
          can_refresh_source: true,
          can_retry_metadata: false,
          can_edit_authors: true,
          can_delete: true,
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
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries/lib-1": { data: library },
      "/libraries/lib-1/entries": {
        data: {
          items: [entry],
          collectionRevision: 3,
          nextCursor: { kind: "Absent" },
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["lib-1"]).toEqual({
      library,
      entries: [
        {
          ...entry,
          media: {
            ...entry.media,
            progressFraction: { kind: "Absent" },
            publicationDate: { kind: "Absent" },
            sourceHost: { kind: "Present", value: "example.test" },
          },
          readingTimeEstimate: {
            kind: "Present",
            value: {
              totalMinutes: { value: 15 },
              remainingMinutes: { kind: "Absent" },
            },
          },
        },
      ],
      collectionRevision: 3,
      nextCursor: { kind: "Absent" },
      exhaustion: "Complete",
    });
  });

  it("does not seed a mismatched Library projection into bootstrap state", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries/lib-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries/lib-1": {
        data: {
          id: "lib-other",
          name: "Wrong Library",
          color: null,
          ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
          isDefault: false,
          role: "admin",
          systemKey: null,
          canRename: true,
          canDelete: true,
          canEditEntries: true,
          canManageMembers: true,
          canTransferOwnership: true,
          createdAt: "2026-07-24T10:00:00Z",
          updatedAt: "2026-07-24T10:30:00Z",
        },
      },
      "/libraries/lib-1/entries": {
        data: {
          items: [],
          collectionRevision: 0,
          nextCursor: { kind: "Absent" },
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources).not.toHaveProperty("lib-1");
  });

  it("does not seed a malformed Library projection into bootstrap state", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries/lib-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries/lib-1": {
        data: {
          id: "lib-1",
          name: "Malformed Library",
          color: null,
          ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
          isDefault: false,
          role: "admin",
          systemKey: null,
          canRename: true,
          canDelete: true,
          canEditEntries: true,
          canManageMembers: "yes",
          canTransferOwnership: true,
          createdAt: "2026-07-24T10:00:00Z",
          updatedAt: "2026-07-24T10:30:00Z",
        },
      },
      "/libraries/lib-1/entries": {
        data: {
          items: [],
          collectionRevision: 0,
          nextCursor: { kind: "Absent" },
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources).not.toHaveProperty("lib-1");
  });

  it("normalizes and seeds the note pages resource", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/notes");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/notes/pages": {
        data: {
          pages: [
            {
              id: NOTE_PAGE_ID,
              title: "Seeded page",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["notes:pages"]).toEqual([
      {
        id: NOTE_PAGE_ID,
        title: "Seeded page",
        updatedAt: "2026-01-01T00:00:00Z",
        actionTarget: routeResourceActionSubject({
          scheme: "page",
          id: NOTE_PAGE_ID,
          href: `/pages/${NOTE_PAGE_ID}`,
        }),
      },
    ]);
  });

  it("does not seed the deleted note-block resource path", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, `/notes/${NOTE_BLOCK_ID}`);
    respondWith({
      "/me/reader-profile": PROFILE_OK,
    });

    const result = await loadWorkspaceBootstrap(false);

    // A note pane owns a canonical client-side resource-surface read. The
    // bootstrap must never revive the deleted `/notes/blocks/:id` seed shape.
    expect(result.resources).not.toHaveProperty(`note-block:${NOTE_BLOCK_ID}`);
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      `/notes/blocks/${NOTE_BLOCK_ID}`,
      expect.anything(),
    );
  });

  it("seeds the initial conversations list resource", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/conversations");
    const conversationsPage = {
      items: [
        {
          id: "conversation-1",
          title: "Seeded chat",
          message_count: 2,
          updated_at: "2026-07-29T10:00:00Z",
        },
      ],
      collectionRevision: 5,
      nextCursor: { kind: "Absent" as const },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/conversations?limit=100": { data: conversationsPage },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["conversations:list:initial"]).toEqual({
      conversations: conversationsPage.items,
      collectionRevision: 5,
      nextCursor: { kind: "Absent" },
      exhaustion: "Complete",
    });
  });

  it("seeds settings account and billing resources with their pane keys", async () => {
    const cases = [
      {
        href: "/settings/account",
        path: "/me",
        key: "settings-account:me",
        body: { data: { email: "seed@example.com", display_name: "Seed" } },
      },
      {
        href: "/settings/billing",
        path: "/billing/account",
        key: "billing-account:0",
        body: { data: { billing_plan_tier: "free" } },
      },
    ] as const;

    for (const { href, path, key, body } of cases) {
      requestHeaders.set(REQUEST_PATH_HEADER, href);
      respondWith({
        "/me/reader-profile": PROFILE_OK,
        [path]: body,
      });

      const result = await loadWorkspaceBootstrap(false);

      expect(result.resources[key]).toEqual(body);
    }
  });

  it("returns the fetched reader profile when /me/reader-profile resolves", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    const profile = { ...READER_PROFILE, theme: "dark" as const };
    respondWith({
      "/me/reader-profile": { data: profile },
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.readerProfile).toEqual(profile);
  });

  it("rejects the whole bootstrap when the required /me/reader-profile read fails", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        throw new Error("profile 504");
      }
      return EMPTY_COLLECTION_ENVELOPE;
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow("profile 504");
  });

  it("rejects a malformed profile payload instead of seeding a default", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWith({
      "/me/reader-profile": { data: { ...READER_PROFILE, theme: "sepia" } },
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "Invalid reader profile",
    );
  });

  it("omits the pane resource when its loader fails (D-8) without throwing", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      throw new Error("libraries 500");
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources).toEqual({});
  });

  it("bounds best-effort prefetches with the 500ms deadline; the required profile rides the normal deadline", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({ own: null }),
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
    });

    await loadWorkspaceBootstrap(false);

    const profileCalls = mockCallFastAPI.mock.calls.filter(
      ([path]) => path === "/me/reader-profile",
    );
    expect(profileCalls).toEqual([["/me/reader-profile"]]);
    for (const [path, options] of mockCallFastAPI.mock.calls) {
      if (path !== "/me/reader-profile") {
        expect(options).toEqual({ timeoutMs: 500 });
      }
    }
  });

  it("seeds nothing for an unprefetched route without throwing", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/chat/new");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources).toEqual({});
  });

  it("restores this device's own saved session into initialState and seeds every visible pane (AC-4)", async () => {
    // Device cookie present → the bootstrap fetches this device's saved session and
    // restores its panes. The explicit /libraries deep link reuses the matching
    // restored pane, so initialState reflects the restored panes and wave 2
    // seeds BOTH visible panes' resources, not just the URL pane.
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        primary("pane-media", "/media/123"),
        primary("pane-libs", "/libraries"),
      ],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    const librariesPageData = librariesPage("lib-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/libraries?limit=100": { data: librariesPageData },
      "/media/123": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState).sort()).toEqual(
      ["/libraries", "/media/123"].sort(),
    );
    // AC-4: both restored visible panes' resources are seeded under their cacheKeys.
    expect(result.resources["123"]).toEqual({
      media,
      fragments: { status: "ready", data: [] },
    });
    expect(result.resources["libraries:0"]).toEqual(librariesPageData);
  });

  it("honors Lectern home intent while preserving restored panes", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/lectern");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [primary("pane-media", "/media/123")],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/lectern/slate": { data: { items: [] } },
      "/media/123": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState)).toEqual([
      "/media/123",
      "/lectern",
    ]);
    expect(activeHref(result.initialState)).toBe("/lectern");
  });

  it("prefetches an inactive visible Lectern as its first read", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/123");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        primary("pane-media", "/media/123"),
        primary("pane-lectern", "/lectern"),
      ],
    });
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/media/123": {
        data: { kind: "epub", capabilities: { can_read: true } },
      },
      "/lectern/slate": { data: { items: [] } },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(activeHref(result.initialState)).toBe("/media/123");
    expect(result.resources["lectern:slate:0"]).toEqual({ items: [] });
    expect(
      mockCallFastAPI.mock.calls.filter(([path]) => path === "/lectern/slate"),
    ).toHaveLength(1);
  });

  it("does not prefetch a minimized Lectern", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/123");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        primary("pane-media", "/media/123"),
        primary("pane-lectern", "/lectern", { visibility: "minimized" }),
      ],
    });
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/media/123": {
        data: { kind: "epub", capabilities: { can_read: true } },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["lectern:slate:0"]).toBeUndefined();
    expect(
      mockCallFastAPI.mock.calls.filter(([path]) => path === "/lectern/slate"),
    ).toHaveLength(0);
  });

  it("retries the URL pane in wave 2 when its wave-1 seed failed, so the active pane is still seeded (AC-4)", async () => {
    // The URL pane is seeded speculatively in wave 1, but that attempt can fail transiently
    // (timeout/throw). Because the URL pane is also a restored visible pane, wave 2 must still
    // attempt it — a single flaky first attempt must not cost the active pane its seed. Here the
    // libraries loader throws on the wave-1 call and succeeds on the wave-2 retry.
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-libs",
      primaryPanes: [
        primary("pane-libs", "/libraries"),
        primary("pane-media", "/media/123"),
      ],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    const librariesPageData = librariesPage("lib-1");
    let librariesCalls = 0;
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      if (path === "/me/workspace-session?device_id=dev-1") {
        return sessionEnvelope({ own: ownState });
      }
      if (path === "/libraries?limit=100") {
        librariesCalls += 1;
        if (librariesCalls === 1) {
          throw new Error("libraries 504 (wave 1)");
        }
        return { data: librariesPageData };
      }
      if (path === "/media/123") {
        return { data: media };
      }
      throw new Error(`unmapped path: ${path}`);
    });

    const result = await loadWorkspaceBootstrap(false);

    // Wave 1 attempted /libraries (and failed); wave 2 retried it (success) — so the active
    // pane's resource is seeded despite the flaky first attempt.
    expect(librariesCalls).toBe(2);
    expect(result.resources["libraries:0"]).toEqual(librariesPageData);
  });

  it("falls back to most_recent_elsewhere when own is trivial/absent (AC-7)", async () => {
    // own null, a non-trivial session from another device → that layout is restored.
    // The explicit /libraries deep link reuses its matching restored pane.
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const elsewhere = workspace({
      activePrimaryPaneId: "pane-media",
      primaryPanes: [
        primary("pane-media", "/media/789"),
        primary("pane-libs", "/libraries"),
      ],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: null,
        mostRecentElsewhere: elsewhere,
      }),
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
      "/media/789": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState).sort()).toEqual(
      ["/libraries", "/media/789"].sort(),
    );
  });

  it("ignores the saved session when no device cookie is present", async () => {
    // No device cookie → no session fetch → initialState is the single URL pane.
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/solo");
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/media/solo": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    const panes = getWorkspacePrimaryPanes(result.initialState);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.currentVisit.href).toBe("/media/solo");
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      expect.stringContaining("/me/workspace-session"),
      expect.anything(),
    );
  });

  it("degrades to the deep-link pane when the session fetch throws (AC-10)", async () => {
    // Device cookie set, but the workspace-session fetch fails → best-effort restore
    // yields nothing and the deep-link pane stands; no crash.
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/solo");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWithFn((path) => {
      if (path === "/me/workspace-session?device_id=dev-1") {
        throw new Error("session 504");
      }
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      if (path === "/media/solo") {
        return { data: media };
      }
      throw new Error(`unmapped path: ${path}`);
    });

    const result = await loadWorkspaceBootstrap(false);

    const panes = getWorkspacePrimaryPanes(result.initialState);
    expect(panes).toHaveLength(1);
    expect(panes[0]?.currentVisit.href).toBe("/media/solo");
    expect(result.resources["solo"]).toEqual({
      media,
      fragments: { status: "ready", data: [] },
    });
  });

  it("defects when trusted persisted PaneVisit ids are duplicated", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const exactState = workspace({
      primaryPanes: [primary("pane-1", "/libraries")],
    });
    const exactPane = exactState.primaryPanesById["pane-1"]!;
    const malformedState = {
      ...exactState,
      primaryPanesById: {
        "pane-1": {
          ...exactPane,
          history: {
            back: [exactPane.currentVisit],
            forward: [],
          },
        },
      },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": {
        data: {
          own: {
            state: malformedState,
            updated_at: "2026-01-01T00:00:00Z",
          },
          most_recent_elsewhere: null,
        },
      },
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "duplicates another PaneVisit id",
    );
  });

  it("defects when a successful trusted session response is malformed", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": {
        data: {
          own: { updated_at: "2026-01-01T00:00:00Z" },
          most_recent_elsewhere: null,
        },
      },
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "workspace session response.data.own must contain exactly [state, updated_at]",
    );
  });

  it("defects when a successful trusted session response is non-JSON", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    respondWithFn((path) => {
      if (path === "/me/workspace-session?device_id=dev-1") {
        throw new ApiError(
          200,
          "E_INVALID_RESPONSE",
          "API returned a non-JSON response",
        );
      }
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      if (path === "/libraries?limit=100") {
        return EMPTY_COLLECTION_ENVELOPE;
      }
      throw new Error(`unmapped path: ${path}`);
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow(
      "API returned a non-JSON response",
    );
  });

  it("merges the deep-link pane into the restored layout", async () => {
    // Restored layout does NOT contain the deep-link resource → the deep-link pane is
    // appended and made active, alongside the restored pane. The restored session must
    // be non-trivial to be selected (only a lone /lectern pane is trivial), so
    // the saved layout is a single /conversations pane.
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/xyz");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      primaryPanes: [primary("pane-convos", "/conversations")],
    });
    const media = { kind: "epub", capabilities: { can_read: true } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/conversations?limit=100": EMPTY_COLLECTION_ENVELOPE,
      "/media/xyz": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState).sort()).toEqual(
      ["/conversations", "/media/xyz"].sort(),
    );
    expect(activeHref(result.initialState)).toBe("/media/xyz");
  });

  it("filters Android-restricted panes from the restored session when androidShell is true", async () => {
    // androidShell=true → Local Vault is dropped from the restored layout.
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    requestCookies.set(DEVICE_COOKIE_NAME, "dev-1");
    const ownState = workspace({
      activePrimaryPaneId: "pane-billing",
      primaryPanes: [
        primary("pane-vault", "/settings/local-vault"),
        primary("pane-billing", "/settings/billing"),
      ],
    });
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({
        own: ownState,
      }),
      "/libraries?limit=100": EMPTY_COLLECTION_ENVELOPE,
      "/billing/account": { data: { billing_plan_tier: "free" } },
    });

    const result = await loadWorkspaceBootstrap(true);

    const hrefs = getWorkspacePrimaryPanes(result.initialState).map(
      (pane) => pane.currentVisit.href,
    );
    expect(hrefs).not.toContain("/settings/local-vault");
  });
});
