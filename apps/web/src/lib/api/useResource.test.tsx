import { act, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { libraryResource } from "@/lib/api/resource";
import { useResource } from "./useResource";
import { BootstrapHydrationProvider } from "./hydrationCache";

describe("useResource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is idle when cacheKey is null and does not call load", () => {
    const load = vi.fn(async () => "x");
    const { result } = renderHook(() => useResource({ cacheKey: null, load }));
    expect(result.current).toEqual({ status: "idle" });
    expect(load).not.toHaveBeenCalled();
  });

  it("loads on mount and transitions to ready", async () => {
    const load = vi.fn(async () => "hello");
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }));
    expect(result.current.status).toBe("loading");
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "hello" }),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads the path form through apiFetch with a request-owned signal", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: "ok" }));
    const { result } = renderHook(() =>
      useResource<{ data: string }>({
        cacheKey: "library-1",
        path: (key) => `/api/libraries/${key}`,
      }),
    );
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: { data: "ok" } }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries/library-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("loads the descriptor form through apiFetch and derives the cache key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: "ok" }));
    const { result } = renderHook(() =>
      useResource<{ data: string }, { id: string }>({
        descriptor: libraryResource,
        params: { id: "library-1" },
      }),
    );
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: { data: "ok" } }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries/library-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("claims a hydration-cache entry once (consume-once), then fetches", async () => {
    const load = vi.fn(async () => "fetched");
    const seen: string[] = [];
    function Reader({ id }: { id: string }) {
      const r = useResource<string>({ cacheKey: "k1", load });
      if (r.status === "ready") seen.push(`${id}:${r.data}`);
      return null;
    }
    render(
      <BootstrapHydrationProvider value={{ k1: "cached" }}>
        <Reader id="a" />
        <Reader id="b" />
      </BootstrapHydrationProvider>,
    );
    await waitFor(() => expect(seen).toContain("b:fetched"));
    expect(seen).toContain("a:cached");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a fetch that resolves after its effect was aborted (the wedge race)", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const abortedIndices: number[] = [];
    const load = vi.fn(async (signal: AbortSignal): Promise<string> => {
      const idx = resolvers.length;
      signal.addEventListener("abort", () => abortedIndices.push(idx));
      return new Promise<string>((resolve) => resolvers.push(resolve));
    });

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResource({ cacheKey: key, load }),
      { initialProps: { key: "k1" } },
    );
    expect(result.current.status).toBe("loading");

    rerender({ key: "k2" });
    expect(abortedIndices).toEqual([0]);

    await act(async () => {
      resolvers[0]("stale");
    });

    expect(result.current.status).toBe("loading");
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers[1]("fresh");
    });
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "fresh" }),
    );
  });

  it("does not retry a 4xx and surfaces the ApiError", async () => {
    const load = vi.fn(async () => {
      throw new ApiError(404, "E_NOT_FOUND", "missing");
    });
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(load).toHaveBeenCalledTimes(1);
    if (result.current.status === "error") {
      expect(result.current.error.status).toBe(404);
      expect(result.current.error.code).toBe("E_NOT_FOUND");
    }
  });

  it("retry() from error status restarts the load and recovers", async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(400, "E_BAD", "bad");
      return "ok";
    });
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }));
    await waitFor(() => expect(result.current.status).toBe("error"));

    act(() => {
      if (result.current.status === "error") result.current.retry();
    });

    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "ok" }),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx until success without exposing intermediate errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError(503, "E_UPSTREAM", "down");
      return "recovered";
    });
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }));
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "recovered" }),
    );
    expect(load).toHaveBeenCalledTimes(3);
  });
});
