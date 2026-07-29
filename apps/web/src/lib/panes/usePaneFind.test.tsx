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
