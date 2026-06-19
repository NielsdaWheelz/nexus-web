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
    data: { data, page: { next_cursor: cursor } },
  };
}

describe("useCursorPagination", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("appends cursor pages and resets appended state when page one changes", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: ["second"],
      page: { next_cursor: null },
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
});
