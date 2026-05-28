import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { useAsyncResource } from "./useAsyncResource";

describe("useAsyncResource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is idle when cacheKey is null and does not call load", () => {
    const load = vi.fn(async () => "x");
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: null, load }),
    );
    expect(result.current).toEqual({ status: "idle" });
    expect(load).not.toHaveBeenCalled();
  });

  it("loads on mount and transitions to ready", async () => {
    const load = vi.fn(async () => "hello");
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: "k1", load }),
    );
    expect(result.current.status).toBe("loading");
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "hello" }),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts ready with initialData and skips the first fetch", async () => {
    const load = vi.fn(async () => "fetched");
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: "k1", load, initialData: "seeded" }),
    );
    expect(result.current).toEqual({ status: "ready", data: "seeded" });
    await new Promise((r) => setTimeout(r, 10));
    expect(load).not.toHaveBeenCalled();
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
      ({ key }: { key: string }) => useAsyncResource({ cacheKey: key, load }),
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
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: "k1", load }),
    );
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
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: "k1", load }),
    );
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
    const { result } = renderHook(() =>
      useAsyncResource({ cacheKey: "k1", load }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", data: "recovered" }),
    );
    expect(load).toHaveBeenCalledTimes(3);
  });
});
