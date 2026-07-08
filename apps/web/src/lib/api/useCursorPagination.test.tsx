import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import type { AsyncResource } from "@/lib/api/useResource";
import { useCursorPagination, type CursorPage } from "./useCursorPagination";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

function readyPage(data: string[], cursor: string | null): AsyncResource<CursorPage<string>> {
  return {
    status: "ready",
    data: { data, page: { has_more: cursor !== null, next_cursor: cursor } },
  };
}

function deferredPage() {
  let resolve: ((value: CursorPage<string>) => void) | undefined;
  const promise = new Promise<CursorPage<string>>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve: resolve! };
}

describe("useCursorPagination", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("appends cursor pages and resets appended state when page one changes", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: ["second"],
      page: { has_more: false, next_cursor: null },
    });

    const { result, rerender } = renderHook(
      ({ firstPage }) =>
        useCursorPagination({
          firstPage,
          buildMoreHref: (cursor) => `/api/things?cursor=${cursor}`,
        }),
      { initialProps: { firstPage: readyPage(["first"], "cursor-1") } },
    );

    expect(result.current.items).toEqual(["first"]);
    expect(result.current.hasMore).toBe(true);

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.items).toEqual(["first", "second"]));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/things?cursor=cursor-1", {
      signal: expect.any(AbortSignal),
    });

    rerender({ firstPage: readyPage(["replacement"], "cursor-2") });

    expect(result.current.items).toEqual(["replacement"]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignores a stale load-more response after page one changes", async () => {
    const deferred = deferredPage();
    apiFetchMock.mockReturnValueOnce(deferred.promise);

    const { result, rerender } = renderHook(
      ({ firstPage }) =>
        useCursorPagination({
          firstPage,
          buildMoreHref: (cursor) => `/api/things?cursor=${cursor}`,
        }),
      { initialProps: { firstPage: readyPage(["first"], "cursor-1") } },
    );

    act(() => {
      result.current.loadMore();
    });

    rerender({ firstPage: readyPage(["replacement"], "cursor-2") });

    await act(async () => {
      deferred.resolve({
        data: ["stale"],
        page: { has_more: false, next_cursor: null },
      });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.items).toEqual(["replacement"]);
    });
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadingMore).toBe(false);
  });
});
