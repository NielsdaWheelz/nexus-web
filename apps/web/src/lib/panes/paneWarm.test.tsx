import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { ResourceCache, ResourceCacheContext } from "@/lib/api/resourceCache";
import { usePaneWarm } from "./paneWarm";

// preloadPane dynamically imports the real pane body (ProseMirror, the reader stack, …);
// stub that chunk-warm side effect so these tests exercise only the data-prefetch + debounce
// logic. The fetch boundary stays real — the prefetch's apiFetch hits the global fetch spy.
const preloadPane = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/panes/paneRenderRegistry", () => ({ preloadPane }));

function withCache(cache: ResourceCache) {
  return function CacheProvider({ children }: { children: ReactNode }) {
    return createElement(ResourceCacheContext.Provider, { value: cache }, children);
  };
}

describe("usePaneWarm", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    preloadPane.mockClear();
  });

  it("warms the chunk immediately and prefetches data for a route-keyed pane (debounced)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { id: "abc" } }));
    const cache = new ResourceCache({});
    const { result } = renderHook(() => usePaneWarm(), { wrapper: withCache(cache) });

    result.current("/media/abc");
    expect(preloadPane).toHaveBeenCalledWith("media"); // chunk warm is immediate
    expect(cache.peek("abc")).toBeNull(); // data prefetch waits out the debounce

    await vi.advanceTimersByTimeAsync(80);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/media/abc",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(cache.peek("abc")).not.toBeNull();
  });

  it("warms only the chunk for an excluded pane — no data prefetch (AC-8)", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: {} }));
    const cache = new ResourceCache({});
    const { result } = renderHook(() => usePaneWarm(), { wrapper: withCache(cache) });

    result.current("/daily");
    expect(preloadPane).toHaveBeenCalledWith("daily");
    await vi.advanceTimersByTimeAsync(80);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("debounces repeated intent on the same key to a single prefetch", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: {} }));
    const cache = new ResourceCache({});
    const { result } = renderHook(() => usePaneWarm(), { wrapper: withCache(cache) });

    result.current("/libraries/lib-1");
    result.current("/libraries/lib-1");
    result.current("/libraries/lib-1");
    await vi.advanceTimersByTimeAsync(80);

    const libraryCalls = fetchSpy.mock.calls.filter(
      ([url]) => url === "/api/libraries/lib-1",
    );
    expect(libraryCalls).toHaveLength(1);
  });

  it("ignores unsupported hrefs (no chunk, no data)", () => {
    vi.useFakeTimers();
    const cache = new ResourceCache({});
    const { result } = renderHook(() => usePaneWarm(), { wrapper: withCache(cache) });
    result.current("https://example.com/external");
    expect(preloadPane).not.toHaveBeenCalled();
  });
});
