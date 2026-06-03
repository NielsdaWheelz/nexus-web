import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callFastAPI } from "@/lib/api/server";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import { DEFAULT_READER_PROFILE } from "@/lib/reader/types";
import { WORKSPACE_DEFAULT_FALLBACK_HREF } from "@/lib/workspace/workspaceHref";
import { loadWorkspaceBootstrap } from "./bootstrap.server";

// server-only is the React/Next marker package; its module body throws on import
// outside a Server Component. Neutralize it so the bootstrap + pane loaders (both
// "server-only") can be exercised under the node test runner.
vi.mock("server-only", () => ({}));

// The single external boundary the server data root reads the request path
// through. A settable header map drives headers().get(name); the tests set the
// stamped request-path header before each call.
const requestHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string): string | null => requestHeaders.get(name) ?? null,
  })),
}));

// callFastAPI is the only network edge — both the bootstrap (reader profile) and
// every pane loader fetch through it. A per-path script controls each outcome so
// the tests assert the OBSERVABLE composition the panes' useResource will read.
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

// A reader-profile responder shared by the resource cases that don't care about it.
const PROFILE_OK = { data: DEFAULT_READER_PROFILE };

beforeEach(() => {
  requestHeaders.clear();
  mockCallFastAPI.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadWorkspaceBootstrap", () => {
  it("seeds the libraries pane resource keyed exactly as its useResource reads it", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    const librariesEnvelope = { data: [{ id: "lib-1" }] };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries": librariesEnvelope,
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.initialHref).toBe("/libraries");
    expect(result.resources["libraries:0"]).toEqual(librariesEnvelope);
  });

  it("falls back to the default href and runs that route's loader when no request-path header is present", async () => {
    // No REQUEST_PATH_HEADER set — bootstrap must use the default fallback href,
    // which resolves to the libraries pane (a prefetched route).
    const librariesEnvelope = { data: [{ id: "lib-1" }] };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries": librariesEnvelope,
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.initialHref).toBe(WORKSPACE_DEFAULT_FALLBACK_HREF);
    expect(result.resources["libraries:0"]).toEqual(librariesEnvelope);
  });

  it("loads fragments for a readable media kind and composes the media pane resource", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/media/abc");
    const media = { kind: "audiobook", capabilities: { can_read: true } };
    const fragment = { id: "frag-1", text: "hello" };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/media/abc": { data: media },
      "/media/abc/fragments": { data: [fragment] },
    });

    const result = await loadWorkspaceBootstrap();

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

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["ep"]).toEqual({ media, fragments: [] });
    expect(mockCallFastAPI).not.toHaveBeenCalledWith(
      "/media/ep/fragments",
      expect.anything(),
    );
  });

  it("composes the author pane resource with snake-to-camel mapping", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/authors/jane");
    const alias = { name: "J. Doe" };
    const externalId = { provider: "isni", value: "0000" };
    const work = { id: "work-1", title: "A Book" };
    const contributor = { aliases: [alias], external_ids: [externalId] };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/contributors/jane": { data: contributor },
      "/contributors/jane/works?limit=100": { data: { works: [work] } },
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["author:jane"]).toEqual({
      contributor,
      aliases: [alias],
      externalIds: [externalId],
      works: [work],
      workFilterOptions: [work],
    });
  });

  it("composes the library detail resource from library and entries paths", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries/lib-1");
    const library = { id: "lib-1", name: "Seeded Library" };
    const entry = { id: "entry-1", media: { id: "media-1" } };
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries/lib-1": { data: library },
      "/libraries/lib-1/entries": { data: [entry] },
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["lib-1"]).toEqual({
      library,
      entries: [entry],
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
              id: "page-1",
              title: "Seeded page",
              description: "",
              revision: "7",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["notes:pages"]).toEqual([
      {
        id: "page-1",
        title: "Seeded page",
        description: null,
        revision: 7,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("normalizes and seeds note block to page resolution", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/notes/block-1");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/notes/blocks/block-1": {
        data: {
          id: "block-1",
          page_id: "page-9",
          revision: 1,
        },
      },
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["note-block:block-1"]).toEqual({
      blockId: "block-1",
      pageId: "page-9",
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

    const result = await loadWorkspaceBootstrap();

    expect(result.resources["conversations:list:initial"]).toEqual(
      conversationsEnvelope,
    );
  });

  it("seeds settings account, keys, and billing resources with their pane keys", async () => {
    const cases = [
      {
        href: "/settings/account",
        path: "/me",
        key: "settings-account:me",
        body: { data: { email: "seed@example.com", display_name: "Seed" } },
      },
      {
        href: "/settings/keys",
        path: "/keys",
        key: "settings-keys:0",
        body: { data: [] },
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

      const result = await loadWorkspaceBootstrap();

      expect(result.resources[key]).toEqual(body);
    }
  });

  it("returns the fetched reader profile when /me/reader-profile resolves", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    const profile = { ...DEFAULT_READER_PROFILE, theme: "dark" as const };
    respondWith({
      "/me/reader-profile": { data: profile },
      "/libraries": { data: [] },
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.readerProfile).toEqual(profile);
  });

  it("falls back to the default reader profile when /me/reader-profile rejects", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        throw new Error("profile 504");
      }
      return { data: [] };
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.readerProfile).toEqual(DEFAULT_READER_PROFILE);
  });

  it("omits the pane resource when its loader fails (D-8) without throwing", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWithFn((path) => {
      if (path === "/me/reader-profile") {
        return PROFILE_OK;
      }
      throw new Error("libraries 500");
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources).toEqual({});
  });

  it("bounds every prefetch fetch with the 500ms deadline (AC-10)", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/libraries");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
      "/libraries": { data: [] },
    });

    await loadWorkspaceBootstrap();

    for (const [, options] of mockCallFastAPI.mock.calls) {
      expect(options).toEqual({ timeoutMs: 500 });
    }
  });

  it("seeds nothing for an unprefetched route without throwing", async () => {
    requestHeaders.set(REQUEST_PATH_HEADER, "/daily");
    respondWith({
      "/me/reader-profile": PROFILE_OK,
    });

    const result = await loadWorkspaceBootstrap();

    expect(result.resources).toEqual({});
  });
});
