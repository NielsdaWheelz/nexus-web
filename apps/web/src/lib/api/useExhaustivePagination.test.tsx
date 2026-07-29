import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  decodeCollectionPage,
  type CollectionPage,
} from "@/lib/api/collectionPage";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";

function page(
  items: readonly string[],
  revision: number,
  cursor?: string,
): CollectionPage<string> {
  return decodeCollectionPage(
    {
      data: {
        items,
        collectionRevision: revision,
        nextCursor:
          cursor === undefined
            ? { kind: "Absent" }
            : { kind: "Present", value: cursor },
      },
    },
    String,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("useExhaustivePagination", () => {
  it("completes zero- and single-page collections without a continuation request", () => {
    const empty = page([], 1);
    const loadPage = vi.fn();
    const { result, rerender } = renderHook(
      ({ firstPage }) =>
        useExhaustivePagination({
          active: true,
          chainKey: `chain-${firstPage.collectionRevision}`,
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: firstPage.items.length,
          loadPage,
          commitPage: vi.fn(),
          refresh: vi.fn(),
        }),
      { initialProps: { firstPage: empty } },
    );

    expect(result.current).toEqual({ kind: "Complete", itemCount: 0 });
    rerender({ firstPage: page(["only"], 2) });
    expect(result.current).toEqual({ kind: "Complete", itemCount: 1 });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("loads multiple pages sequentially and reports the committed total", async () => {
    const firstPage = page(["first"], 3, "cursor-1");
    const pages = [
      page(["second"], 3, "cursor-2"),
      page(["third"], 3),
    ];
    let committedCount = firstPage.items.length;
    let inFlight = 0;
    let maxInFlight = 0;
    const loadPage = vi.fn(
      async (
        _cursor: string,
        _revision: number,
        _signal: AbortSignal,
      ) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return pages.shift()!;
      },
    );
    const commitPage = vi.fn((next: CollectionPage<string>) => {
      committedCount += next.items.length;
      return committedCount;
    });

    const { result } = renderHook(() =>
      useExhaustivePagination({
        active: true,
        chainKey: "documents:0",
        cursor: firstPage.nextCursor,
        collectionRevision: firstPage.collectionRevision,
        itemCount: firstPage.items.length,
        loadPage,
        commitPage,
        refresh: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 3 }),
    );
    expect(loadPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      "cursor-1",
      "cursor-2",
    ]);
    expect(commitPage).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it.each([100, 300, 500])(
    "exhausts a %d-row inventory without duplicates or concurrent requests",
    async (total) => {
      const revision = 31;
      const allItems = Array.from({ length: total }, (_, index) => `item-${index}`);
      const committed = new Set(allItems.slice(0, 100));
      let inFlight = 0;
      let maxInFlight = 0;
      const firstCursor = total > 100 ? "100" : undefined;
      const firstPage = page(
        allItems.slice(0, 100),
        revision,
        firstCursor,
      );
      const loadPage = vi.fn(async (cursor: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const start = Number(cursor);
        const items = allItems.slice(start, start + 100);
        await Promise.resolve();
        inFlight -= 1;
        const next = start + items.length;
        return page(
          items,
          revision,
          next < total ? String(next) : undefined,
        );
      });

      const { result } = renderHook(() =>
        useExhaustivePagination({
          active: true,
          chainKey: `inventory:${total}`,
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: committed.size,
          loadPage,
          commitPage: (next) => {
            for (const item of next.items) committed.add(item);
            return committed.size;
          },
          refresh: vi.fn(),
        }),
      );

      await waitFor(() =>
        expect(result.current).toEqual({ kind: "Complete", itemCount: total }),
      );
      expect([...committed]).toEqual(allItems);
      expect(loadPage).toHaveBeenCalledTimes(Math.max(total / 100 - 1, 0));
      expect(maxInFlight).toBeLessThanOrEqual(1);
    },
  );

  it("pauses before starting while inactive and resumes when activated", async () => {
    const firstPage = page(["first"], 4, "cursor-1");
    const loadPage = vi.fn(async () => page(["second"], 4));
    const { result, rerender } = renderHook(
      ({ active }) =>
        useExhaustivePagination({
          active,
          chainKey: "documents:0",
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: 1,
          loadPage,
          commitPage: () => 2,
          refresh: vi.fn(),
        }),
      { initialProps: { active: false } },
    );

    expect(result.current).toEqual({ kind: "Draining", loadedCount: 1 });
    expect(loadPage).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 2 }),
    );
    expect(loadPage).toHaveBeenCalledOnce();
  });

  it("finishes an active request while hidden, then resumes before the next", async () => {
    const firstPage = page(["first"], 5, "cursor-1");
    const first = deferred<CollectionPage<string>>();
    const loadPage = vi
      .fn<(cursor: string) => Promise<CollectionPage<string>>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page(["third"], 5));
    let count = 1;
    const { result } = renderHook(() =>
      useExhaustivePagination({
        active: true,
        chainKey: "documents:0",
        cursor: firstPage.nextCursor,
        collectionRevision: firstPage.collectionRevision,
        itemCount: 1,
        loadPage,
        commitPage: (next) => (count += next.items.length),
        refresh: vi.fn(),
      }),
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledOnce());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    await act(async () => {
      first.resolve(page(["second"], 5, "cursor-2"));
      await first.promise;
    });
    expect(result.current).toEqual({ kind: "Draining", loadedCount: 2 });
    expect(loadPage).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 3 }),
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("finishes an active request after pane deactivation, then pauses", async () => {
    const firstPage = page(["first"], 51, "cursor-1");
    const first = deferred<CollectionPage<string>>();
    const signals: AbortSignal[] = [];
    const loadPage = vi.fn(
      (cursor: string, _revision: number, signal: AbortSignal) => {
        signals.push(signal);
        return cursor === "cursor-1"
          ? first.promise
          : Promise.resolve(page(["third"], 51));
      },
    );
    let count = 1;
    const { result, rerender } = renderHook(
      ({ active }) =>
        useExhaustivePagination({
          active,
          chainKey: "documents:inactive-pause",
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: 1,
          loadPage,
          commitPage: (next) => (count += next.items.length),
          refresh: vi.fn(),
        }),
      { initialProps: { active: true } },
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledOnce());

    rerender({ active: false });
    expect(signals[0].aborted).toBe(false);
    await act(async () => {
      first.resolve(page(["second"], 51, "cursor-2"));
      await first.promise;
    });
    expect(result.current).toEqual({ kind: "Draining", loadedCount: 2 });
    expect(loadPage).toHaveBeenCalledOnce();

    rerender({ active: true });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 3 }),
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("aborts a changed chain and ignores its stale settlement", async () => {
    const oldPage = page(["old"], 6, "old-cursor");
    const newPage = page(["new"], 7, "new-cursor");
    const oldRequest = deferred<CollectionPage<string>>();
    const seenSignals: AbortSignal[] = [];
    const loadPage = vi.fn(
      (
        cursor: string,
        _revision: number,
        signal: AbortSignal,
      ): Promise<CollectionPage<string>> => {
        seenSignals.push(signal);
        return cursor === "old-cursor"
          ? oldRequest.promise
          : Promise.resolve(page(["fresh"], 7));
      },
    );
    const commitPage = vi.fn(() => 2);
    const { result, rerender } = renderHook(
      ({ firstPage, chainKey }) =>
        useExhaustivePagination({
          active: true,
          chainKey,
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: 1,
          loadPage,
          commitPage,
          refresh: vi.fn(),
        }),
      { initialProps: { firstPage: oldPage, chainKey: "documents:0" } },
    );
    await waitFor(() => expect(loadPage).toHaveBeenCalledOnce());

    rerender({ firstPage: newPage, chainKey: "documents:1" });
    expect(seenSignals[0].aborted).toBe(true);
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 2 }),
    );
    await act(async () => {
      oldRequest.resolve(page(["stale"], 6));
      await oldRequest.promise;
    });
    expect(commitPage).toHaveBeenCalledOnce();
  });

  it.each([
    [
      new ApiError(409, "E_COLLECTION_CHANGED", "changed"),
      "CollectionChanged",
    ],
    [new ApiError(400, "E_INVALID_CURSOR", "invalid"), "InvalidCursor"],
  ] as const)(
    "requires refresh for %s",
    async (error, reason) => {
      const firstPage = page(["first"], 8, "cursor-1");
      const refresh = vi.fn();
      const { result } = renderHook(() =>
        useExhaustivePagination({
          active: true,
          chainKey: "documents:0",
          cursor: firstPage.nextCursor,
          collectionRevision: firstPage.collectionRevision,
          itemCount: 1,
          loadPage: async () => {
            throw error;
          },
          commitPage: vi.fn(),
          refresh,
        }),
      );

      await waitFor(() =>
        expect(result.current).toMatchObject({
          kind: "RefreshRequired",
          reason,
          error,
        }),
      );
      if (result.current.kind === "RefreshRequired") {
        const refreshList = result.current.refresh;
        act(() => refreshList());
      }
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it("offers retry after three transient attempts and continues the same cursor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const firstPage = page(["first"], 9, "cursor-1");
    const loadPage = vi
      .fn<() => Promise<CollectionPage<string>>>()
      .mockRejectedValue(new ApiError(503, "E_UPSTREAM", "down"));
    const { result } = renderHook(() =>
      useExhaustivePagination({
        active: true,
        chainKey: "documents:0",
        cursor: firstPage.nextCursor,
        collectionRevision: firstPage.collectionRevision,
        itemCount: 1,
        loadPage,
        commitPage: () => 2,
        refresh: vi.fn(),
      }),
    );

    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() =>
      expect(result.current.kind).toBe("ResumeFailed"),
    );
    expect(loadPage).toHaveBeenCalledTimes(3);
    loadPage.mockResolvedValueOnce(page(["second"], 9));
    if (result.current.kind === "ResumeFailed") {
      const retry = result.current.retry;
      act(() => retry());
    }
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "Complete", itemCount: 2 }),
    );
    expect(loadPage).toHaveBeenLastCalledWith(
      "cursor-1",
      9,
      expect.any(AbortSignal),
    );
  });
});

class DefectBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <p>{this.state.error.message}</p>
    );
  }
}

function CycleHarness() {
  const firstPage = page(["first"], 10, "cursor-1");
  useExhaustivePagination({
    active: true,
    chainKey: "documents:0",
    cursor: firstPage.nextCursor,
    collectionRevision: firstPage.collectionRevision,
    itemCount: 1,
    loadPage: async () => page(["second"], 10, "cursor-1"),
    commitPage: () => 2,
    refresh: vi.fn(),
  });
  return null;
}

it("surfaces a repeated cursor as a same-system defect", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <DefectBoundary>
      <CycleHarness />
    </DefectBoundary>,
  );
  expect(
    await screen.findByText(/Collection cursor cycle/),
  ).toBeVisible();
});
