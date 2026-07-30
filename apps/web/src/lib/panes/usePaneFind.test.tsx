import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createPaneFindResultKey,
  createPaneFindSourceKey,
} from "./paneSearch";
import {
  usePaneFind,
  type PaneFindAdapter,
  type PaneFindResponse,
} from "./usePaneFind";

type ExpectedError = "Unavailable";

const SOURCE = createPaneFindSourceKey({
  kind: "TestDocument",
  revision: 1,
});
const OTHER_SOURCE = createPaneFindSourceKey({
  kind: "TestDocument",
  revision: 2,
});
const FIRST = createPaneFindResultKey({
  source: { kind: "TestDocument", revision: 1 },
  locator: { unit: "a", start: 1 },
});
const SECOND = createPaneFindResultKey({
  source: { kind: "TestDocument", revision: 1 },
  locator: { unit: "b", start: 2 },
});
const ROWS = [
  {
    key: FIRST,
    context: ["Section one"],
    snippet: [{ text: "first", emphasized: true }],
  },
  {
    key: SECOND,
    context: ["Section two"],
    snippet: [{ text: "second", emphasized: true }],
  },
] as const;

function adapter(
  find: PaneFindAdapter<ExpectedError>["find"] = vi.fn(async (request) => ({
    kind: "Ready",
    sessionId: request.sessionId,
    queryId: request.queryId,
    sourceKey: request.sourceKey,
    completeness: "Complete",
    rows: ROWS,
  }) as const),
  sourceKey = SOURCE,
): PaneFindAdapter<ExpectedError> {
  return {
    sourceKey,
    prepare: vi.fn(async (request) => ({
      sessionId: request.sessionId,
      sourceKey: request.sourceKey,
      scopes: [
        { kind: "EntireResource", id: "all", label: "Entire resource" },
      ],
    }) as const),
    find,
    preview: vi.fn(async (request) => ({
      kind: "Previewed",
      sessionId: request.sessionId,
      queryId: request.queryId,
      sourceKey: request.sourceKey,
      key: request.key,
      returnAvailable: true,
    }) as const),
    clearPresentation: vi.fn(async () => {}),
    returnToReadingPosition: vi.fn(async () => {}),
    errorMessage: (error) =>
      error === "Unavailable" ? "This result is unavailable." : error,
  };
}

async function settlePreparation(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("usePaneFind", () => {
  it("keeps its controller identity stable across owner-only rerenders", async () => {
    const owner = adapter();
    const { result, rerender } = renderHook(() =>
      usePaneFind({ adapter: owner }),
    );
    await settlePreparation();
    const controller = result.current;

    rerender();

    expect(result.current).toBe(controller);
  });

  it("reprepares from the live position when Find opens without a Return origin", async () => {
    const owner = adapter();
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();
    expect(owner.prepare).toHaveBeenCalledTimes(1);

    act(() => result.current.onOpen());

    await waitFor(() => expect(owner.prepare).toHaveBeenCalledTimes(2));
    expect(owner.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 2, sourceKey: SOURCE }),
    );
  });

  it("retains the prepared session while Return exists and reprepares after Return", async () => {
    const owner = adapter();
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("needle"));
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Available"),
    );
    vi.mocked(owner.prepare).mockClear();

    act(() => {
      result.current.onDismiss();
      result.current.onOpen();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(owner.prepare).not.toHaveBeenCalled();
    expect(result.current.returnToReadingPosition.kind).toBe("Available");

    act(() => {
      if (result.current.returnToReadingPosition.kind === "Available") {
        result.current.returnToReadingPosition.onReturn();
      }
    });
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Unavailable"),
    );

    act(() => result.current.onOpen());
    await waitFor(() => expect(owner.prepare).toHaveBeenCalledTimes(1));
  });

  it("retains the session when close and reopen follow Previewed before React commits", async () => {
    let settlePreview: (() => void) | undefined;
    const owner: PaneFindAdapter<ExpectedError> = {
      ...adapter(),
      preview: vi.fn<PaneFindAdapter<ExpectedError>["preview"]>(
        (request) =>
          new Promise((resolve) => {
            settlePreview = () =>
              resolve({
                kind: "Previewed",
                sessionId: request.sessionId,
                queryId: request.queryId,
                sourceKey: request.sourceKey,
                key: request.key,
                returnAvailable: true,
              });
          }),
      ),
    };
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();
    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(settlePreview).toBeTypeOf("function"));

    await act(async () => {
      settlePreview?.();
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          result.current.onDismiss();
          result.current.onOpen();
          resolve();
        });
      });
    });

    expect(owner.prepare).toHaveBeenCalledTimes(1);
    expect(result.current.returnToReadingPosition.kind).toBe("Available");
  });

  it("defers reprepare while an aborted preview can still establish Return", async () => {
    let settlePreview: (() => void) | undefined;
    const owner: PaneFindAdapter<ExpectedError> = {
      ...adapter(),
      preview: vi.fn<PaneFindAdapter<ExpectedError>["preview"]>(
        (request) =>
          new Promise((resolve) => {
            settlePreview = () =>
              resolve({
                kind: "Previewed",
                sessionId: request.sessionId,
                queryId: request.queryId,
                sourceKey: request.sourceKey,
                key: request.key,
                returnAvailable: true,
              });
          }),
      ),
    };
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();
    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(settlePreview).toBeTypeOf("function"));

    act(() => {
      result.current.onDismiss();
      result.current.onOpen();
    });
    expect(owner.prepare).toHaveBeenCalledTimes(1);

    await act(async () => {
      settlePreview?.();
      await Promise.resolve();
    });

    expect(owner.prepare).toHaveBeenCalledTimes(1);
    expect(result.current.returnToReadingPosition.kind).toBe("Available");
  });

  it("finds, previews the first result, wraps, and returns once", async () => {
    const owner = adapter();
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("needle"));

    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
    expect(owner.find).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "needle",
        scopeId: "all",
        matchCase: false,
        wholeWord: false,
      }),
    );
    expect(owner.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: FIRST }),
    );
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Available"),
    );

    act(() => result.current.onStep("Previous"));
    await waitFor(() =>
      expect(owner.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: SECOND }),
      ),
    );

    act(() => {
      if (result.current.returnToReadingPosition.kind === "Available") {
        result.current.returnToReadingPosition.onReturn();
        result.current.returnToReadingPosition.onReturn();
      }
    });
    await waitFor(() =>
      expect(owner.returnToReadingPosition).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Unavailable"),
    );
  });

  it("serializes query and preview commands while Return restores", async () => {
    let finishReturn: (() => void) | undefined;
    const owner = adapter();
    vi.mocked(owner.returnToReadingPosition).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishReturn = resolve;
        }),
    );
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("needle"));
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Available"),
    );
    const previewCalls = vi.mocked(owner.preview).mock.calls.length;

    act(() => {
      if (result.current.returnToReadingPosition.kind === "Available") {
        result.current.returnToReadingPosition.onReturn();
      }
    });
    await waitFor(() => expect(finishReturn).toBeTypeOf("function"));

    let activated = true;
    await act(async () => {
      activated = await result.current.onActivate(SECOND);
      result.current.onStep("Next");
      result.current.onQueryChange("replacement");
      result.current.onMatchCaseChange(true);
      result.current.onWholeWordChange(true);
      result.current.onDismiss();
    });

    expect(activated).toBe(false);
    expect(owner.preview).toHaveBeenCalledTimes(previewCalls);
    expect(result.current.query).toBe("needle");
    expect(result.current.matchCase).toBe(false);
    expect(result.current.wholeWord).toBe(false);

    await act(async () => {
      finishReturn?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Unavailable"),
    );

    act(() => result.current.onStep("Next"));
    await waitFor(() =>
      expect(owner.preview).toHaveBeenCalledTimes(previewCalls + 1),
    );
  });

  it("discards stale query settlement without surfacing a failure", async () => {
    let settleFirst:
      | ((response: PaneFindResponse<ExpectedError>) => void)
      | undefined;
    const find = vi
      .fn<PaneFindAdapter<ExpectedError>["find"]>()
      .mockImplementationOnce(
        (_request) =>
          new Promise((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockImplementationOnce(async (request) => ({
        kind: "NoMatches",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
      }));
    const owner = adapter(find);
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("first"));
    await waitFor(() => expect(owner.find).toHaveBeenCalledTimes(1));
    act(() => result.current.onQueryChange("second"));
    await waitFor(() => expect(owner.find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.result.kind).toBe("NoMatches"));

    await act(async () => {
      settleFirst?.({
        kind: "Failed",
        sessionId: 1,
        queryId: 1,
        sourceKey: SOURCE,
        error: "Unavailable",
      });
      await Promise.resolve();
    });
    expect(result.current.result.kind).toBe("NoMatches");
  });

  it("maps expected adapter failure and clears marks on dismiss", async () => {
    const owner = adapter(async (request) => ({
      kind: "Failed",
      sessionId: request.sessionId,
      queryId: request.queryId,
      sourceKey: request.sourceKey,
      error: "Unavailable",
    }));
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(result.current.result.kind).toBe("Failed"));
    expect(
      result.current.result.kind === "Failed"
        ? result.current.result.message
        : "",
    ).toBe("This result is unavailable.");

    act(() => result.current.onDismiss());
    await waitFor(() => expect(owner.clearPresentation).toHaveBeenCalled());
    expect(result.current.query).toBe("");
    expect(result.current.result.kind).toBe("Idle");
  });

  it("clears the prior presentation before a replacement query settles empty", async () => {
    const find = vi
      .fn<PaneFindAdapter<ExpectedError>["find"]>()
      .mockImplementationOnce(async (request) => ({
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows: ROWS,
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "NoMatches",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
      }));
    const owner = adapter(find);
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange("first"));
    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
    await waitFor(() => expect(owner.preview).toHaveBeenCalled());
    vi.mocked(owner.clearPresentation).mockClear();

    act(() => result.current.onQueryChange("missing"));
    expect(owner.clearPresentation).toHaveBeenCalled();
    await waitFor(() => expect(result.current.result.kind).toBe("NoMatches"));
    expect(owner.clearPresentation).toHaveBeenCalled();
  });

  it("treats one whitespace codepoint as literal query data", async () => {
    const owner = adapter();
    const { result } = renderHook(() => usePaneFind({ adapter: owner }));
    await settlePreparation();

    act(() => result.current.onQueryChange(" "));
    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
    expect(owner.find).toHaveBeenCalledWith(
      expect.objectContaining({ query: " " }),
    );
  });

  it("retires all hook-owned state when the source revision changes", async () => {
    const firstOwner = adapter();
    const secondOwner = adapter(undefined, OTHER_SOURCE);
    const { result, rerender } = renderHook(
      ({ owner }) => usePaneFind({ adapter: owner }),
      { initialProps: { owner: firstOwner } },
    );
    await settlePreparation();
    act(() => result.current.onQueryChange("needle"));
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Available"),
    );

    rerender({ owner: secondOwner });

    await waitFor(() => expect(secondOwner.prepare).toHaveBeenCalled());
    expect(result.current.query).toBe("");
    expect(result.current.result.kind).toBe("Idle");
    expect(result.current.matchCase).toBe(false);
    expect(result.current.wholeWord).toBe(false);
    expect(result.current.returnToReadingPosition.kind).toBe("Unavailable");
  });
});
