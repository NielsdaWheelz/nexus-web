import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Component, createElement, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import UnauthenticatedApiBoundary, {
  __resetUnauthenticatedApiRedirectForTests,
} from "@/lib/auth/UnauthenticatedApiBoundary";
import { libraryResource } from "@/lib/api/resource";
import { useResource } from "./useResource";
import {
  ResourceCache,
  ResourceCacheContext,
  ResourceCacheProvider,
} from "./resourceCache";

// Provide a concrete ResourceCache in context (vs ResourceCacheProvider, which
// builds one from seeds), so a test can pre-deposit a pending prefetch entry.
const cacheWrapper = (cache: ResourceCache) => {
  function CacheProvider({ children }: { children: ReactNode }) {
    return createElement(ResourceCacheContext.Provider, { value: cache }, children);
  }
  return CacheProvider;
};

// Flush microtasks + one macrotask so settled prefetch promises apply.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const redirectToLoginForCurrentLocation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client-return-target", () => ({
  redirectToLoginForCurrentLocation,
}));

class ResourceDefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state = { error: null as unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onDefect(error);
  }

  render() {
    if (this.state.error !== null) {
      return <div role="alert">Resource defect</div>;
    }
    return this.props.children;
  }
}

function ThrowingResource({ error }: { error: unknown }) {
  const resource = useResource<string>({
    cacheKey: "defect-resource",
    load: async () => {
      throw error;
    },
  });
  return <div data-testid="resource-state">{resource.status}</div>;
}

function PrefetchedResource({ load }: { load: () => Promise<string> }) {
  const resource = useResource<string>({ cacheKey: "k1", load });
  return <div data-testid="resource-state">{resource.status}</div>;
}

describe("useResource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    redirectToLoginForCurrentLocation.mockReset();
    __resetUnauthenticatedApiRedirectForTests();
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

  it("claims a hydration-cache entry through commit, then consumes it for later mounts", async () => {
    const load = vi.fn(async () => "fetched");
    const seen: string[] = [];
    function Reader({ id }: { id: string }) {
      const r = useResource<string>({ cacheKey: "k1", load });
      if (r.status === "ready") seen.push(`${id}:${r.data}`);
      return null;
    }
    let showLateReader = () => {};
    function Harness() {
      const [late, setLate] = useState(false);
      showLateReader = () => setLate(true);
      return (
        <ResourceCacheProvider value={{ k1: "cached" }}>
          {late ? (
            <Reader key="c" id="c" />
          ) : (
            <>
              <Reader key="a" id="a" />
              <Reader key="b" id="b" />
            </>
          )}
        </ResourceCacheProvider>
      );
    }

    render(<Harness />);

    await waitFor(() => expect(seen).toContain("b:cached"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen).toContain("a:cached");
    expect(load).not.toHaveBeenCalled();

    await act(async () => showLateReader());

    await waitFor(() => expect(seen).toContain("c:fetched"));
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

  it("hides ready data from the previous key during a key transition", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const load = vi.fn(
      async (): Promise<string> =>
        new Promise<string>((resolve) => resolvers.push(resolve)),
    );
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useResource({ cacheKey: key, load }),
      { initialProps: { key: "k1" } },
    );

    await act(async () => resolvers[0]("first"));
    expect(result.current).toEqual({ status: "ready", data: "first" });

    rerender({ key: "k2" });
    expect(result.current).toEqual({ status: "loading" });

    await act(async () => resolvers[1]("second"));
    expect(result.current).toEqual({ status: "ready", data: "second" });
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

  it.each([
    ["a non-ApiError", new Error("Resource invariant failed")],
    [
      "a same-system ApiError",
      new ApiError(500, "E_INTERNAL", "Internal service detail"),
    ],
  ])("throws %s during render for the nearest boundary", async (_label, defect) => {
    const onDefect = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(
        <ResourceDefectBoundary onDefect={onDefect}>
          <ThrowingResource error={defect} />
        </ResourceDefectBoundary>,
      );

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Resource defect"),
      );
      expect(onDefect).toHaveBeenCalledWith(defect);
      expect(screen.queryByTestId("resource-state")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("hands unauthenticated API errors to the auth boundary", async () => {
    redirectToLoginForCurrentLocation.mockReturnValue(true);
    const load = vi.fn(async () => {
      throw new ApiError(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required"
      );
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <UnauthenticatedApiBoundary>{children}</UnauthenticatedApiBoundary>
    );

    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }), {
      wrapper,
    });

    await waitFor(() =>
      expect(redirectToLoginForCurrentLocation).toHaveBeenCalledTimes(1)
    );
    expect(result.current.status).toBe("loading");
    expect(load).toHaveBeenCalledTimes(1);
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

  it("adopts a pending prefetch without issuing a second fetch (dedup)", async () => {
    const cache = new ResourceCache({});
    let resolvePrefetch!: (value: unknown) => void;
    cache.prefetch(
      "k1",
      () =>
        new Promise<unknown>((resolve) => {
          resolvePrefetch = resolve;
        }),
    );
    expect(cache.peek("k1")?.status).toBe("pending");

    const load = vi.fn(async () => "from-load");
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }), {
      wrapper: cacheWrapper(cache),
    });

    // The in-flight prefetch is adopted: paint stays "loading" while it resolves.
    expect(result.current.status).toBe("loading");

    await act(async () => {
      resolvePrefetch("warmed");
    });

    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "warmed" }),
    );
    // The prefetch was the sole network op — the mount never fetched.
    expect(load).not.toHaveBeenCalled();
  });

  it("paints synchronously from a settled (ready) prefetch with no fetch", () => {
    const cache = new ResourceCache({ k1: "warmed" });
    const load = vi.fn(async () => "from-load");
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }), {
      wrapper: cacheWrapper(cache),
    });

    // A ready entry paints on the first render, before any effect runs.
    expect(result.current).toEqual({ status: "ready", data: "warmed" });
    expect(load).not.toHaveBeenCalled();
  });

  it("falls back to its own load when the pending prefetch rejects with a modeled ApiError", async () => {
    const cache = new ResourceCache({});
    let rejectPrefetch!: (reason: unknown) => void;
    cache.prefetch(
      "k1",
      () =>
        new Promise<unknown>((_, reject) => {
          rejectPrefetch = reject;
        }),
    );
    expect(cache.peek("k1")?.status).toBe("pending");

    const load = vi.fn(async () => "fresh");
    const { result } = renderHook(() => useResource({ cacheKey: "k1", load }), {
      wrapper: cacheWrapper(cache),
    });

    expect(result.current.status).toBe("loading");

    await act(async () => {
      rejectPrefetch(new ApiError(404, "E_NOT_FOUND", "prefetch missing"));
      await flush();
    });

    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "fresh" }),
    );
    // The hook recovered by issuing its own fetch after the prefetch rejected.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-ApiError", new Error("prefetch invariant failed")],
    [
      "a same-system ApiError",
      new ApiError(500, "E_INTERNAL", "Internal prefetch detail"),
    ],
  ])(
    "throws pending-prefetch %s during render instead of retrying it",
    async (_label, defect) => {
      const cache = new ResourceCache({});
      let rejectPrefetch!: (reason: unknown) => void;
      cache.prefetch(
        "k1",
        () =>
          new Promise<unknown>((_, reject) => {
            rejectPrefetch = reject;
          }),
      );
      const load = vi.fn(async () => "fresh");
      const onDefect = vi.fn();
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        render(
          <ResourceDefectBoundary onDefect={onDefect}>
            <PrefetchedResource load={load} />
          </ResourceDefectBoundary>,
          { wrapper: cacheWrapper(cache) },
        );

        await act(async () => {
          rejectPrefetch(defect);
          await flush();
        });

        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent("Resource defect"),
        );
        expect(onDefect).toHaveBeenCalledWith(defect);
        expect(load).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});
