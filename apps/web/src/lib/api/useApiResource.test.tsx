import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApiResource } from "./useApiResource";

describe("useApiResource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is idle without a cache key", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useApiResource({
        cacheKey: null,
        path: (key) => `/api/libraries/${key}`,
      }),
    );

    expect(result.current).toEqual({ status: "idle" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads through apiFetch with a request-owned signal", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: "ok" }));

    const { result } = renderHook(() =>
      useApiResource<{ data: string }>({
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
});
