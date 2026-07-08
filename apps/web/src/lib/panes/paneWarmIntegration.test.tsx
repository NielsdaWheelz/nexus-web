import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceCache, ResourceCacheContext } from "@/lib/api/resourceCache";
import { mediaResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
import { paneResourceLoaders } from "@/lib/panes/paneResourceLoaders";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { usePaneWarm } from "./paneWarm";

// preloadPane dynamically imports the real pane body (the reader stack, ProseMirror,
// …); stub that chunk-warm side effect so these tests exercise only the data-prefetch
// path. The fetch boundary stays REAL — usePaneWarm's prefetch and the pane's
// useResource mount both hit the global fetch spy, which is the whole point: it proves
// warm→open agreement end-to-end through the same apiFetch boundary, not via a mock.
const preloadPane = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/panes/paneRenderRegistry", () => ({ preloadPane }));

function withCache(cache: ResourceCache) {
  return function CacheProvider({ children }: { children: ReactNode }) {
    return createElement(ResourceCacheContext.Provider, { value: cache }, children);
  };
}

// The EXACT useResource call MediaPaneBody issues on mount (MediaPaneBody.tsx,
// `initialMediaResource`): descriptor + params + the loader-composed load. Rendering
// this under the same cache that usePaneWarm warmed proves the open's cacheKey
// (descriptor.cacheKey(params)) === the warm's cacheKey (loader.cacheKey(params)) —
// the drift AC-4 exists to catch.
function useMediaPaneResource(id: string) {
  return useResource({
    descriptor: mediaResource,
    params: { id },
    load: (params, signal) =>
      paneResourceLoaders.media!.load(clientResourceFetcher(signal), params),
  });
}

// kind "epub" → shouldLoadInitialMediaFragments is false → the media loader issues
// EXACTLY ONE fetch (mediaResource only, no /fragments), making the count unambiguous.
const MEDIA_BODY = { data: { kind: "epub", capabilities: { can_read: true } } };

function callsForUrl(spy: ReturnType<typeof vi.fn>, url: string) {
  return spy.mock.calls.filter(([input]) => input === url);
}

// Settle a warmed key to "ready" under fake timers: await the prefetch's own promise
// (draining the fetch → response.json → loader-compose microtask chain), then advance 0
// so the cache's settling `.then` flips the entry pending → ready.
async function settlePrefetch(cache: ResourceCache, key: string): Promise<void> {
  const entry = cache.peek(key);
  if (entry?.status === "pending") {
    await entry.promise.catch(() => {});
  }
  await vi.advanceTimersByTimeAsync(0);
}

describe("paneWarm integration (warm → open, real fetch boundary)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    preloadPane.mockClear();
  });

  // AC-4: a warmed pane opens as a cache HIT with zero mount fetch — proving the warm
  // loader and the pane's useResource agree on the cacheKey end-to-end (any drift would
  // fall through to a second fetch and fail the count).
  it("warm → open is a hit with no mount fetch (cacheKey agreement, AC-4)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(MEDIA_BODY));
    const cache = new ResourceCache({});

    // 1) Warm /media/m1: chunk preload is immediate, data prefetch waits the debounce.
    const { result: warm } = renderHook(() => usePaneWarm(), {
      wrapper: withCache(cache),
    });
    warm.current("/media/m1");
    expect(preloadPane).toHaveBeenCalledWith("media");
    expect(cache.peek("m1")).toBeNull(); // not yet — still debouncing

    await vi.advanceTimersByTimeAsync(80); // past the 70ms debounce → prefetch starts
    await settlePrefetch(cache, "m1"); // drain fetch → response.json → loader compose
    expect(cache.peek("m1")?.status).toBe("ready");
    expect(callsForUrl(fetchSpy, "/api/media/m1")).toHaveLength(1);

    // 2) Open the pane under the SAME cache: MediaPaneBody's exact useResource call.
    // A ready cache entry paints on the first render (the useState initializer), so the
    // pane is ready immediately and issues NO mount fetch.
    const { result: open } = renderHook(() => useMediaPaneResource("m1"), {
      wrapper: withCache(cache),
    });
    expect(open.current.status).toBe("ready");

    // The open was a pure cache hit: still exactly one network fetch in total.
    expect(callsForUrl(fetchSpy, "/api/media/m1")).toHaveLength(1);
  });

  // AC-5: a warm still in flight when the pane opens is ADOPTED, not raced — the mount
  // attaches to the pending prefetch promise and never issues a second network fetch.
  it("warm in flight → open adopts it, exactly one network fetch (AC-5)", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }));
    const cache = new ResourceCache({});

    // Warm /media/m2 and advance past the debounce so the prefetch STARTS (but the
    // controlled fetch has not resolved): the entry is pending, fetch fired once.
    const { result: warm } = renderHook(() => usePaneWarm(), {
      wrapper: withCache(cache),
    });
    warm.current("/media/m2");
    await vi.advanceTimersByTimeAsync(80);
    expect(cache.peek("m2")?.status).toBe("pending");
    expect(callsForUrl(fetchSpy, "/api/media/m2")).toHaveLength(1);

    // Open the pane under the same cache while the prefetch is still pending. It adopts
    // the in-flight promise: paint stays loading, and NO second fetch is issued.
    const { result: open } = renderHook(() => useMediaPaneResource("m2"), {
      wrapper: withCache(cache),
    });
    expect(open.current.status).toBe("loading");
    expect(callsForUrl(fetchSpy, "/api/media/m2")).toHaveLength(1);

    // Resolve the single shared fetch, then drain the chained microtasks (response.json
    // → loader compose → the adopted promise's .then → setResource) inside act so the
    // pane's state update is applied. The adopted mount becomes ready off the prefetch.
    await act(async () => {
      resolveFetch(Response.json(MEDIA_BODY));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(open.current.status).toBe("ready");

    // The prefetch was the sole network op — the open never fetched.
    expect(callsForUrl(fetchSpy, "/api/media/m2")).toHaveLength(1);
  });

  // AC-8: excluded panes warm their JS chunk on intent but have NO data loader, so the
  // prefetch deposits nothing and never touches the network. The error-prone case is the
  // conversation DETAIL (no loader) vs the conversations LIST (a loader) split.
  it("excluded panes warm the chunk but deposit no data (AC-8)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: {} }));
    const cache = new ResourceCache({});
    const { result: warm } = renderHook(() => usePaneWarm(), {
      wrapper: withCache(cache),
    });

    // Confirm the route ids before relying on them: /conversations is the warmable LIST,
    // /conversations/<id> is the EXCLUDED detail (and must NOT match the list pattern).
    expect(resolvePaneRouteModel("/conversations").id).toBe("conversations");
    const conversationDetailHref = "/conversations/conv-detail-1";
    expect(resolvePaneRouteModel(conversationDetailHref).id).toBe("conversation");

    // The error-prone exclusion: the detail id has NO loader entry, the list id DOES.
    expect(paneResourceLoaders.conversation).toBeUndefined();
    expect(paneResourceLoaders.conversations).toBeDefined();

    const excluded: Array<{ href: string; id: string }> = [
      { href: "/search", id: "search" },
      { href: conversationDetailHref, id: "conversation" },
    ];

    for (const { href, id } of excluded) {
      warm.current(href);
      expect(preloadPane).toHaveBeenCalledWith(id); // chunk warmed
    }

    await vi.advanceTimersByTimeAsync(80); // give any (non-existent) prefetch its window
    expect(fetchSpy).not.toHaveBeenCalled(); // no data loader → no network at all
  });
});
