import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callFastAPI } from "@/lib/api/server";
import { DEVICE_COOKIE_NAME } from "@/lib/auth/deviceCookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import type { ReaderProfile } from "@/lib/reader/types";
import {
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
  mockCallFastAPI.mockImplementation(async (path: string) => responder(path) as never);
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

// A reader-profile responder shared by the resource cases that don't care about it.
const PROFILE_OK = { data: READER_PROFILE };
const NOTE_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_BLOCK_ID = "22222222-2222-4222-8222-222222222222";

// Saved-session builders — the same primary()/workspace() helpers sessionSync.test.ts
// uses, so the raw `own`/`most_recent_elsewhere` states the bootstrap sanitizes and
// restores are built the way the client store actually persists them.
const emptyHistory = () => ({ back: [], forward: [] });

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
  return {
    id,
    href,
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
}): { data: { own: { state: unknown } | null; most_recent_elsewhere: { state: unknown } | null } } {
  return {
    data: {
      own: input.own ? { state: input.own } : null,
      most_recent_elsewhere: input.mostRecentElsewhere
        ? { state: input.mostRecentElsewhere }
        : null,
    },
  };
}

function visibleHrefs(state: WorkspaceState): string[] {
  return getWorkspacePrimaryPanes(state)
    .filter((pane) => pane.visibility === "visible")
    .map((pane) => pane.href);
}

function activeHref(state: WorkspaceState): string | undefined {
  return getWorkspacePrimaryPanes(state).find(
    (pane) => pane.id === state.activePrimaryPaneId,
  )?.href;
}

beforeEach(() => {
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
    const librariesEnvelope = {
      data: [{ id: "lib-1" }],
      page: { has_more: false, next_cursor: null },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries": librariesEnvelope,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.initialHref).toBe("/libraries");
    expect(result.resources["libraries:0"]).toEqual(librariesEnvelope);
  });

  it("falls back to the Lectern home when no request-path header is present", async () => {
    const recentEnvelope = { data: { items: [] } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/lectern/recent?limit=50": recentEnvelope,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.initialHref).toBe(WORKSPACE_DEFAULT_FALLBACK_HREF);
    expect(result.initialHref).toBe("/lectern");
    expect(result.resources["lectern:recent:50:0"]).toEqual({ items: [] });
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

    expect(result.resources["abc"]).toEqual({ media, fragments: [fragment] });
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

    expect(result.resources["ep"]).toEqual({ media, fragments: [] });
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      "/media/ep/fragments",
      expect.anything(),
    );
  });

  it("composes the author pane resource with the detail + first works page", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/authors/jane");
    const detail = {
      handle: "jane",
      href: "/authors/jane",
      displayName: "Jane Doe",
      otherNames: ["J. Doe"],
      canRename: true,
    };
    const work = {
      title: "A Book",
      href: "/media/work-1",
      contentKind: "epub",
      date: "2020-01-01",
      roleFacts: [{ creditedName: "Jane Doe", role: "author", rawRole: null }],
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/contributors/jane": { data: detail },
      "/contributors/jane/works?limit=100": { data: { works: [work], nextCursor: null } },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["author:jane"]).toEqual({
      detail: {
        handle: "jane",
        href: "/authors/jane",
        displayName: "Jane Doe",
        otherNames: ["J. Doe"],
        canRename: true,
      },
      works: [work],
      worksNextCursor: null,
    });
  });

  it("composes the library detail resource from library and entries paths", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries/lib-1");
    const library = { id: "lib-1", name: "Seeded Library" };
    const entry = {
      id: "entry-1",
      kind: "media",
      media: {
        id: "media-1",
        kind: "web_article",
        processing_status: "ready_for_reading",
        read_state: "unread",
        progress_fraction: null,
        capabilities: { can_quote: true },
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
        data: [entry],
        page: { has_more: false, next_cursor: null },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["lib-1"]).toEqual({
      library,
      entries: [entry],
      entriesPage: { has_more: false, next_cursor: null },
    });
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
      },
    ]);
  });

  it("normalizes and seeds note block resources", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, `/notes/${NOTE_BLOCK_ID}`);
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      [`/notes/blocks/${NOTE_BLOCK_ID}`]: {
        data: {
          id: NOTE_BLOCK_ID,
          body_text: "Seeded note block",
        },
      },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources[`note-block:${NOTE_BLOCK_ID}`]).toEqual({
      id: NOTE_BLOCK_ID,
      parentBlockId: null,
      orderKey: null,
      bodyPmJson: { type: "paragraph" },
      bodyText: "Seeded note block",
      collapsed: false,
      children: [],
      versionByLane: {},
    });
  });

  it("seeds the initial conversations list resource", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/conversations");
    const conversationsEnvelope = {
      data: [{ id: "conversation-1" }],
      page: { next_cursor: null },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/conversations?limit=50": conversationsEnvelope,
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(result.resources["conversations:list:initial"]).toEqual(
      conversationsEnvelope,
    );
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
      "/libraries": { data: [], page: { has_more: false, next_cursor: null } },
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
      return { data: [], page: { has_more: false, next_cursor: null } };
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow("profile 504");
  });

  it("rejects a malformed profile payload instead of seeding a default", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWith({
      "/me/reader-profile": { data: { ...READER_PROFILE, theme: "sepia" } },
      "/libraries": { data: [], page: { has_more: false, next_cursor: null } },
    });

    await expect(loadWorkspaceBootstrap(false)).rejects.toThrow("Invalid reader profile");
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
      "/libraries": { data: [], page: { has_more: false, next_cursor: null } },
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
    const librariesEnvelope = {
      data: [{ id: "lib-1" }],
      page: { has_more: false, next_cursor: null },
    };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({ own: ownState }),
      "/libraries": librariesEnvelope,
      "/media/123": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState).sort()).toEqual(
      ["/libraries", "/media/123"].sort(),
    );
    // AC-4: both restored visible panes' resources are seeded under their cacheKeys.
    expect(result.resources["123"]).toEqual({ media, fragments: [] });
    expect(result.resources["libraries:0"]).toEqual(librariesEnvelope);
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
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({ own: ownState }),
      "/lectern/recent?limit=50": { data: { items: [] } },
      "/media/123": { data: media },
    });

    const result = await loadWorkspaceBootstrap(false);

    expect(visibleHrefs(result.initialState)).toEqual(["/media/123", "/lectern"]);
    expect(activeHref(result.initialState)).toBe("/lectern");
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
    const librariesEnvelope = {
      data: [{ id: "lib-1" }],
      page: { has_more: false, next_cursor: null },
    };
    let librariesCalls = 0;
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      if (path === "/me/workspace-session?device_id=dev-1") {
        return sessionEnvelope({ own: ownState });
      }
      if (path === "/libraries") {
        librariesCalls += 1;
        if (librariesCalls === 1) {
          throw new Error("libraries 504 (wave 1)");
        }
        return librariesEnvelope;
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
    expect(result.resources["libraries:0"]).toEqual(librariesEnvelope);
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
      "/libraries": { data: [], page: { has_more: false, next_cursor: null } },
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
    expect(panes[0]?.href).toBe(result.initialHref);
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
    expect(panes[0]?.href).toBe(result.initialHref);
    expect(result.resources["solo"]).toEqual({ media, fragments: [] });
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
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({ own: ownState }),
      "/conversations?limit=50": { data: [], page: { next_cursor: null } },
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
      "/me/workspace-session?device_id=dev-1": sessionEnvelope({ own: ownState }),
      "/libraries": { data: [], page: { has_more: false, next_cursor: null } },
      "/billing/account": { data: { billing_plan_tier: "free" } },
    });

    const result = await loadWorkspaceBootstrap(true);

    const hrefs = getWorkspacePrimaryPanes(result.initialState).map(
      (pane) => pane.href,
    );
    expect(hrefs).not.toContain("/settings/local-vault");
  });
});
