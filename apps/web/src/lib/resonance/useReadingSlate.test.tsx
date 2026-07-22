import { useLayoutEffect } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCallsForPath,
  fetchInputPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import { ApiError } from "@/lib/api/client";
import type { SlateItem, SlateSnapshot } from "@/lib/resonance/contract";
import {
  useReadingSlate,
  type AcceptResult,
  type ReadingSlateAccept,
  type ReadingSlateAddOptions,
} from "@/lib/resonance/useReadingSlate";

const lecternSlateResponse =
  vi.fn<(signal?: AbortSignal) => Promise<SlateSnapshot>>();
const librarySlateResponse =
  vi.fn<(id: string, signal?: AbortSignal) => Promise<SlateSnapshot>>();
let fetchMock: ReturnType<typeof stubFetch>;
const noFocusRepair = {
  isFocusOwned: () => false,
} satisfies ReadingSlateAddOptions;

async function slateHttpResponse(
  response: Promise<SlateSnapshot>,
): Promise<Response> {
  try {
    return jsonResponse({ data: await response });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 200 &&
      error.status <= 599
    ) {
      return jsonResponse(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    throw error;
  }
}

function installSlateFetch() {
  return stubFetch(async (input, init) => {
    const path = fetchInputPath(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/lectern/slate") {
      return slateHttpResponse(lecternSlateResponse(init?.signal ?? undefined));
    }
    const libraryMatch = /^\/api\/libraries\/([^/]+)\/slate$/.exec(path);
    if (method === "GET" && libraryMatch !== null) {
      return slateHttpResponse(
        librarySlateResponse(
          decodeURIComponent(libraryMatch[1]),
          init?.signal ?? undefined,
        ),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(index: number): SlateItem {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    target: {
      kind: "Media",
      ref: `media:${id}` as SlateItem["target"]["ref"],
      mediaKind: "pdf",
      title: `Item ${index}`,
      subtitle: { kind: "Absent" },
      imageUrl: { kind: "Absent" },
      href: `/media/${id}` as SlateItem["target"]["href"],
    },
    reason: {
      kind: "AddedToNexus",
      addedAt: "2026-07-20T12:00:00Z",
    },
  };
}

function snapshot(items: SlateItem[]): SlateSnapshot {
  return { items };
}

function requireReady(
  state: ReturnType<typeof useReadingSlate>["state"],
): Extract<ReturnType<typeof useReadingSlate>["state"], { kind: "Ready" }> {
  if (state.kind !== "Ready")
    throw new Error(`Expected Ready, got ${state.kind}`);
  return state;
}

function renderController(accept: ReadingSlateAccept, active = true) {
  return renderHook(
    ({ isActive }) =>
      useReadingSlate({
        destination: { kind: "Lectern" },
        isActive,
        accept,
      }),
    { initialProps: { isActive: active } },
  );
}

beforeEach(() => {
  lecternSlateResponse.mockReset();
  librarySlateResponse.mockReset();
  fetchMock = installSlateFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("useReadingSlate lane", () => {
  it("suppresses the previous destination synchronously and installs only the new destination", async () => {
    const libraryA = [item(1)];
    const libraryB = [item(2)];
    const bRead = deferred<SlateSnapshot>();
    librarySlateResponse.mockImplementation((id: string) =>
      id === "library-a" ? Promise.resolve(snapshot(libraryA)) : bRead.promise,
    );
    const parkedAccept = deferred<AcceptResult>();
    const accept = vi.fn<ReadingSlateAccept>(() => parkedAccept.promise);
    const renders: Array<{
      destinationId: string;
      kind: string;
      titles: string[];
    }> = [];
    const { result, rerender } = renderHook(
      ({ destinationId }) => {
        const controller = useReadingSlate({
          destination: {
            kind: "Library",
            id: destinationId,
            name: destinationId,
          },
          isActive: true,
          accept,
        });
        const currentItems =
          controller.state.kind === "Ready" ? controller.state.items : [];
        renders.push({
          destinationId,
          kind: controller.state.kind,
          titles: currentItems.map((candidate) => candidate.target.title),
        });
        const add = controller.add;
        useLayoutEffect(() => {
          if (destinationId === "library-b") {
            add(libraryA[0], noFocusRepair);
          }
        }, [add, destinationId]);
        return controller;
      },
      { initialProps: { destinationId: "library-a" } },
    );

    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    renders.length = 0;
    rerender({ destinationId: "library-b" });

    expect(renders[0]).toEqual({
      destinationId: "library-b",
      kind: "InitialLoading",
      titles: [],
    });
    expect(accept).not.toHaveBeenCalled();
    await act(async () => bRead.resolve(snapshot(libraryB)));
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(requireReady(result.current.state).items).toStrictEqual(libraryB);
    expect(
      renders
        .filter((entry) => entry.destinationId === "library-b")
        .some((entry) => entry.titles.includes("Item 1")),
    ).toBe(false);
    expect(
      fetchCallsForPath(fetchMock, "/api/libraries/library-a/slate"),
    ).toHaveLength(1);
    expect(
      fetchCallsForPath(fetchMock, "/api/libraries/library-b/slate"),
    ).toHaveLength(1);
  });

  it("restarts a failed initial read exactly once on reactivation", async () => {
    lecternSlateResponse
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "initial failed"),
      )
      .mockResolvedValueOnce(snapshot([item(1)]));
    const { result, rerender } = renderController(vi.fn<ReadingSlateAccept>());

    await waitFor(() =>
      expect(result.current.state.kind).toBe("InitialFailed"),
    );
    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("issues no Slate read while inactive and starts the initial read on activation", async () => {
    lecternSlateResponse.mockResolvedValueOnce(snapshot([item(1)]));
    const accept = vi.fn<ReadingSlateAccept>();
    const { result, rerender } = renderController(accept, false);

    expect(result.current.state.kind).toBe("InitialLoading");
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(0);
    rerender({ isActive: true });
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(1);
  });

  it("preserves last-good rows and performs one full refresh on later activation", async () => {
    const first = snapshot([item(1), item(2)]);
    const refreshed = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => refreshed.promise);
    const accept = vi.fn<ReadingSlateAccept>();
    const { result, rerender } = renderController(accept);

    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const loadedItems = requireReady(result.current.state).items;
    rerender({ isActive: false });
    expect(result.current.state.kind).toBe("Ready");
    rerender({ isActive: true });

    await waitFor(() => expect(result.current.state.kind).toBe("Refreshing"));
    if (result.current.state.kind !== "Refreshing")
      throw new Error("unreachable");
    expect(result.current.state.items).toBe(loadedItems);

    await act(async () => refreshed.resolve(snapshot([item(3)])));
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(requireReady(result.current.state).items[0].target.title).toBe(
      "Item 3",
    );
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("coalesces activation during Add into one post-commit refill", async () => {
    const initialItems = Array.from({ length: 10 }, (_, index) =>
      item(index + 1),
    );
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockImplementationOnce(() => refill.promise);
    const command = deferred<AcceptResult>();
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const loadedItems = requireReady(result.current.state).items;

    act(() => result.current.add(loadedItems[0], noFocusRepair));
    expect(result.current.state.kind).toBe("Adding");
    rerender({ isActive: false });
    rerender({ isActive: true });

    await act(async () => command.resolve({ kind: "Accepted" }));
    await waitFor(() => expect(result.current.state.kind).toBe("Refilling"));
    if (result.current.state.kind !== "Refilling")
      throw new Error("unreachable");
    expect(result.current.state.survivors).toEqual(loadedItems.slice(1));
    loadedItems
      .slice(1)
      .forEach((survivor, index) =>
        expect(
          result.current.state.kind === "Refilling" &&
            result.current.state.survivors[index],
        ).toBe(survivor),
      );
    await waitFor(() =>
      expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(
        2,
      ),
    );

    const newcomer = item(11);
    await act(async () =>
      refill.resolve(snapshot([...initialItems.slice(1), newcomer])),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const ready = requireReady(result.current.state);
    expect(ready.items.slice(0, 9)).toEqual(loadedItems.slice(1));
    loadedItems
      .slice(1)
      .forEach((survivor, index) => expect(ready.items[index]).toBe(survivor));
    expect(ready.items[9]).toStrictEqual(newcomer);
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("invalidates an old destination Add in the destination-change layout boundary", async () => {
    const libraryA = [item(1)];
    const libraryB = [item(2)];
    librarySlateResponse.mockImplementation((id: string) =>
      Promise.resolve(snapshot(id === "library-a" ? libraryA : libraryB)),
    );
    const command = deferred<AcceptResult>();
    let operationSignal: AbortSignal | null = null;
    const accept = vi.fn<ReadingSlateAccept>((_target, options) => {
      operationSignal = options.signal;
      return command.promise;
    });
    const staleFocusOwnership = vi.fn(() => true);
    const destinationLayoutAbortState: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ destinationId }) => {
        const controller = useReadingSlate({
          destination: {
            kind: "Library",
            id: destinationId,
            name: destinationId,
          },
          isActive: true,
          accept,
        });
        useLayoutEffect(() => {
          if (destinationId === "library-b") {
            destinationLayoutAbortState.push(operationSignal?.aborted === true);
            command.resolve({ kind: "Accepted" });
          }
        }, [destinationId]);
        return controller;
      },
      { initialProps: { destinationId: "library-a" } },
    );
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    act(() =>
      result.current.add(libraryA[0], {
        isFocusOwned: staleFocusOwnership,
      }),
    );
    expect(result.current.state.kind).toBe("Adding");

    rerender({ destinationId: "library-b" });

    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(destinationLayoutAbortState).toStrictEqual([true]);
    expect(requireReady(result.current.state).items).toStrictEqual(libraryB);
    expect(staleFocusOwnership).not.toHaveBeenCalled();
    expect(
      fetchCallsForPath(fetchMock, "/api/libraries/library-a/slate"),
    ).toHaveLength(1);
    expect(
      fetchCallsForPath(fetchMock, "/api/libraries/library-b/slate"),
    ).toHaveLength(1);
  });

  it("lets Add supersede an obsolete refresh and performs no refill after rejection", async () => {
    const initialItems = [item(1), item(2)];
    const refreshCapture: { signal?: AbortSignal } = {};
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockImplementationOnce((signal?: AbortSignal) => {
        if (signal === undefined) throw new Error("Expected an AbortSignal");
        refreshCapture.signal = signal;
        return new Promise<SlateSnapshot>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      });
    const rejected = new ApiError(409, "E_CONFLICT", "Already present");
    const accept = vi.fn<ReadingSlateAccept>(async () => ({
      kind: "Rejected",
      error: rejected,
    }));
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const loadedItems = requireReady(result.current.state).items;

    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() => expect(result.current.state.kind).toBe("Refreshing"));
    act(() => result.current.add(loadedItems[0], noFocusRepair));

    await waitFor(() => expect(result.current.state.kind).toBe("AddFailed"));
    expect(refreshCapture.signal?.aborted).toBe(true);
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
    if (result.current.state.kind !== "AddFailed")
      throw new Error("unreachable");
    expect(result.current.state.items).toBe(loadedItems);
    expect(result.current.state.error).toBe(rejected);
  });

  it("cannot install an obsolete refresh over AddUnknown at the resolution boundary", async () => {
    const initialItems = [item(1), item(2)];
    const refresh = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockImplementationOnce(() => refresh.promise);
    const command = deferred<AcceptResult>();
    let unknown: Parameters<ReadingSlateAccept>[1]["onUnknown"] | null = null;
    const accept = vi.fn<ReadingSlateAccept>((_target, options) => {
      unknown = options.onUnknown;
      return command.promise;
    });
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const loadedItems = requireReady(result.current.state).items;

    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() => expect(result.current.state.kind).toBe("Refreshing"));
    await act(async () => {
      result.current.add(loadedItems[0], noFocusRepair);
      refresh.resolve(snapshot([item(3)]));
      await Promise.resolve();
    });
    expect(result.current.state.kind).toBe("Adding");

    act(() => {
      unknown?.({
        error: new ApiError(0, "E_NETWORK", "Unknown outcome"),
        recovery: { kind: "External", owner: "LecternMutationNotice" },
      });
    });
    expect(result.current.state.kind).toBe("AddUnknown");
    if (result.current.state.kind !== "AddUnknown")
      throw new Error("unreachable");
    expect(result.current.state.items).toBe(loadedItems);
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("parks activation in AddUnknown until the original attempt settles", async () => {
    const initialItems = [item(1), item(2)];
    const refill = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockImplementationOnce(() => refill.promise);
    const command = deferred<AcceptResult>();
    let reportUnknown: Parameters<ReadingSlateAccept>[1]["onUnknown"] | null =
      null;
    const accept = vi.fn<ReadingSlateAccept>((_target, options) => {
      reportUnknown = options.onUnknown;
      return command.promise;
    });
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));

    act(() => result.current.add(initialItems[0], noFocusRepair));
    act(() =>
      reportUnknown?.({
        error: new ApiError(0, "E_NETWORK", "Unknown outcome"),
        recovery: { kind: "External", owner: "LecternMutationNotice" },
      }),
    );
    expect(result.current.state.kind).toBe("AddUnknown");

    rerender({ isActive: false });
    rerender({ isActive: true });
    expect(result.current.state.kind).toBe("AddUnknown");
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(1);

    await act(async () => command.resolve({ kind: "Accepted" }));
    await waitFor(() => expect(result.current.state.kind).toBe("Refilling"));
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("preserves rows across RefreshFailed and retries that canonical read", async () => {
    const initialItems = [item(1), item(2)];
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "refresh failed"),
      )
      .mockResolvedValueOnce(snapshot([item(3)]));
    const { result, rerender } = renderController(vi.fn<ReadingSlateAccept>());
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const loadedItems = requireReady(result.current.state).items;

    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() =>
      expect(result.current.state.kind).toBe("RefreshFailed"),
    );
    if (result.current.state.kind !== "RefreshFailed")
      throw new Error("unreachable");
    expect(result.current.state.items).toBe(loadedItems);
    act(
      () =>
        result.current.state.kind === "RefreshFailed" &&
        result.current.state.retry(),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(3);
  });

  it("ignores a stale refresh Retry after Add synchronously claims the lane", async () => {
    const initialItems = [item(1), item(2)];
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "refresh failed"),
      );
    const command = deferred<AcceptResult>();
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));

    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() =>
      expect(result.current.state.kind).toBe("RefreshFailed"),
    );
    if (result.current.state.kind !== "RefreshFailed") {
      throw new Error("unreachable");
    }
    const staleRetry = result.current.state.retry;

    act(() => {
      result.current.add(initialItems[0], noFocusRepair);
      staleRetry();
    });

    expect(result.current.state.kind).toBe("Adding");
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
    await act(async () =>
      command.resolve({
        kind: "Rejected",
        error: new ApiError(409, "E_CONFLICT", "Already present"),
      }),
    );
    expect(result.current.state.kind).toBe("AddFailed");
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(2);
  });

  it("preserves survivors across RefillFailed and retries without restoring accepted", async () => {
    const initialItems = [item(1), item(2), item(3)];
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "refill failed"),
      )
      .mockResolvedValueOnce(snapshot([item(2), item(3), item(4)]));
    const accept: ReadingSlateAccept = async () => ({ kind: "Accepted" });
    const { result } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));

    act(() => result.current.add(initialItems[0], noFocusRepair));
    await waitFor(() => expect(result.current.state.kind).toBe("RefillFailed"));
    if (result.current.state.kind !== "RefillFailed")
      throw new Error("unreachable");
    expect(result.current.state.survivors).toEqual(initialItems.slice(1));
    const retry = result.current.state.retry;
    act(() => retry());
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    expect(
      requireReady(result.current.state).items.map(
        (candidate) => candidate.target.title,
      ),
    ).toEqual(["Item 2", "Item 3", "Item 4"]);
  });

  it("releases the committed-add guard after activation canonically supersedes RefillFailed", async () => {
    const initialItems = [item(1), item(2)];
    const recovery = deferred<SlateSnapshot>();
    lecternSlateResponse
      .mockResolvedValueOnce(snapshot(initialItems))
      .mockRejectedValueOnce(
        new ApiError(400, "E_INVALID_REQUEST", "refill failed"),
      )
      .mockImplementationOnce(() => recovery.promise);
    const parkedSecond = deferred<AcceptResult>();
    const accept = vi
      .fn<ReadingSlateAccept>()
      .mockResolvedValueOnce({ kind: "Accepted" })
      .mockImplementationOnce(() => parkedSecond.promise);
    const { result, rerender } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    act(() => result.current.add(initialItems[0], noFocusRepair));
    await waitFor(() => expect(result.current.state.kind).toBe("RefillFailed"));

    rerender({ isActive: false });
    rerender({ isActive: true });
    await waitFor(() => expect(result.current.state.kind).toBe("Refreshing"));
    expect(fetchCallsForPath(fetchMock, "/api/lectern/slate")).toHaveLength(3);
    await act(async () => recovery.resolve(snapshot([item(2), item(3)])));
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));
    const recovered = requireReady(result.current.state).items;
    act(() => result.current.add(recovered[0], noFocusRepair));
    expect(accept).toHaveBeenCalledTimes(2);
    expect(result.current.state.kind).toBe("Adding");
  });

  it("suppresses a rapid second Add gesture synchronously", async () => {
    const initialItems = [item(1), item(2)];
    lecternSlateResponse.mockResolvedValueOnce(snapshot(initialItems));
    const command = deferred<AcceptResult>();
    const accept = vi.fn<ReadingSlateAccept>(() => command.promise);
    const { result } = renderController(accept);
    await waitFor(() => expect(result.current.state.kind).toBe("Ready"));

    act(() => {
      result.current.add(initialItems[0], noFocusRepair);
      result.current.add(initialItems[1], noFocusRepair);
    });
    expect(accept).toHaveBeenCalledOnce();
    expect(result.current.state.kind).toBe("Adding");
  });
});
