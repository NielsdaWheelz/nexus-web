import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPaneFindResultKey, createPaneFindSourceKey } from "./paneSearch";
import {
  usePaneFind,
  type PaneFindAdapter,
  type PaneFindController,
  type PaneFindPreviewReceipt,
  type PaneFindPreviewRequest,
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

function previewReceipt(
  request: PaneFindPreviewRequest,
  kind: "Previewed" | "Rejected",
): PaneFindPreviewReceipt<ExpectedError> {
  return kind === "Previewed"
    ? {
        kind,
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      }
    : {
        kind,
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        error: "Unavailable",
      };
}

function adapter(
  find: PaneFindAdapter<ExpectedError>["find"] = vi.fn(
    async (request) =>
      ({
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows: ROWS,
        initialActiveKey: FIRST,
      }) as const,
  ),
  sourceKey = SOURCE,
): PaneFindAdapter<ExpectedError> {
  return {
    sourceKey,
    prepare: vi.fn(
      async (request) =>
        ({
          sessionId: request.sessionId,
          sourceKey: request.sourceKey,
          scopes: [
            { kind: "EntireResource", id: "all", label: "Entire resource" },
          ],
        }) as const,
    ),
    find,
    preview: vi.fn(
      async (request) =>
        ({
          kind: "Previewed",
          sessionId: request.sessionId,
          queryId: request.queryId,
          sourceKey: request.sourceKey,
          key: request.key,
          returnAvailable: true,
        }) as const,
    ),
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

function useAvailablePaneFind(
  owner: PaneFindAdapter<ExpectedError>,
): PaneFindController {
  const paneFind = usePaneFind({
    capability: { kind: "Available", adapter: owner },
  });
  if (paneFind.kind !== "Available") {
    throw new Error("Expected an available Pane Find controller.");
  }
  return paneFind.controller;
}

describe("usePaneFind", () => {
  it("keeps its controller identity stable across owner-only rerenders", async () => {
    const owner = adapter();
    const { result, rerender } = renderHook(() => useAvailablePaneFind(owner));
    await settlePreparation();
    const controller = result.current;

    rerender();

    expect(result.current).toBe(controller);
  });

  it("reprepares from the live position when Find opens without a Return origin", async () => {
    const owner = adapter();
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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

  it("finds, previews the nominated result, wraps, and returns once", async () => {
    const owner = adapter();
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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

  it("preserves row order while previewing the adapter-nominated initial result", async () => {
    const owner = adapter(async (request) => ({
      kind: "Ready",
      sessionId: request.sessionId,
      queryId: request.queryId,
      sourceKey: request.sourceKey,
      completeness: "Complete",
      rows: ROWS,
      initialActiveKey: SECOND,
    }));
    const { result } = renderHook(() => useAvailablePaneFind(owner));
    await settlePreparation();

    act(() => result.current.onQueryChange("needle"));

    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
    expect(result.current.result).toMatchObject({
      kind: "Ready",
      rows: ROWS,
      activeKey: SECOND,
    });
    expect(owner.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: SECOND }),
    );
  });

  it("does no adapter work while the capability is unavailable", async () => {
    const owner = adapter();
    const { result, rerender } = renderHook(
      ({ available }: { available: boolean }) =>
        usePaneFind<ExpectedError>({
          capability: available
            ? { kind: "Available", adapter: owner }
            : { kind: "Unavailable" },
        }),
      { initialProps: { available: false } },
    );

    await settlePreparation();
    expect(result.current).toEqual({ kind: "Unavailable" });
    expect(owner.prepare).not.toHaveBeenCalled();
    expect(owner.find).not.toHaveBeenCalled();
    expect(owner.preview).not.toHaveBeenCalled();

    rerender({ available: true });
    await waitFor(() => expect(owner.prepare).toHaveBeenCalledTimes(1));
    expect(result.current.kind).toBe("Available");

    rerender({ available: false });
    await waitFor(() => expect(result.current.kind).toBe("Unavailable"));
    expect(owner.find).not.toHaveBeenCalled();
    expect(owner.preview).not.toHaveBeenCalled();
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
      ((response: PaneFindResponse<ExpectedError>) => void) | undefined;
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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

  it("retries a failed query with the exact query contract", async () => {
    const find = vi
      .fn<PaneFindAdapter<ExpectedError>["find"]>()
      .mockImplementationOnce(async (request) => ({
        kind: "Failed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        error: "Unavailable",
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "Ready",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
        rows: ROWS,
        initialActiveKey: FIRST,
      }));
    const owner = adapter(find);
    const { result } = renderHook(() => useAvailablePaneFind(owner));
    await settlePreparation();

    act(() => {
      result.current.onMatchCaseChange(true);
      result.current.onWholeWordChange(true);
      result.current.onQueryChange("needle");
    });
    await waitFor(() => expect(result.current.result.kind).toBe("Failed"));

    act(() => {
      if (result.current.result.kind === "Failed") {
        result.current.result.onRetry();
      }
    });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(find.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        query: "needle",
        scopeId: "all",
        matchCase: true,
        wholeWord: true,
      }),
      expect.objectContaining({
        query: "needle",
        scopeId: "all",
        matchCase: true,
        wholeWord: true,
      }),
    ]);
    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
  });

  it("retries an auto-preview rejection through the exact query and nominated key", async () => {
    const owner = adapter();
    vi.mocked(owner.preview)
      .mockImplementationOnce(async (request) => ({
        kind: "Rejected",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        error: "Unavailable",
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      }));
    const { result } = renderHook(() => useAvailablePaneFind(owner));
    await settlePreparation();
    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(result.current.result.kind).toBe("Failed"));

    act(() => {
      if (result.current.result.kind === "Failed") {
        result.current.result.onRetry();
      }
    });

    await waitFor(() => expect(owner.find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(owner.preview).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(owner.preview).mock.calls.map(([request]) => request.key),
    ).toEqual([FIRST, FIRST]);
    await waitFor(() =>
      expect(result.current.returnToReadingPosition.kind).toBe("Available"),
    );
  });

  it("retries an explicit preview rejection against the same result key", async () => {
    const owner = adapter();
    vi.mocked(owner.preview)
      .mockImplementationOnce(async (request) => ({
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "Rejected",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        error: "Unavailable",
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "Previewed",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        key: request.key,
        returnAvailable: true,
      }));
    const { result } = renderHook(() => useAvailablePaneFind(owner));
    await settlePreparation();
    act(() => result.current.onQueryChange("needle"));
    await waitFor(() => expect(owner.preview).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.onActivate(SECOND);
    });
    expect(result.current.result.kind).toBe("Failed");

    act(() => {
      if (result.current.result.kind === "Failed") {
        result.current.result.onRetry();
      }
    });

    await waitFor(() => expect(owner.preview).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(owner.preview).mock.calls.map(([request]) => request.key),
    ).toEqual([FIRST, SECOND, SECOND]);
    await waitFor(() => expect(result.current.result.kind).toBe("Ready"));
  });

  it.each(["Rejected", "Previewed"] as const)(
    "ignores a late %s receipt from a superseded auto-preview",
    async (lateKind) => {
      let settleAutoPreview:
        ((receipt: PaneFindPreviewReceipt<ExpectedError>) => void) | undefined;
      const owner = adapter();
      vi.mocked(owner.preview).mockImplementation((request) => {
        if (!settleAutoPreview) {
          return new Promise((resolve) => {
            settleAutoPreview = resolve;
          });
        }
        return Promise.resolve(previewReceipt(request, "Previewed"));
      });
      const { result } = renderHook(() => useAvailablePaneFind(owner));
      await settlePreparation();
      act(() => result.current.onQueryChange("needle"));
      await waitFor(() => {
        expect(owner.preview).toHaveBeenCalledTimes(1);
        expect(result.current.result).toMatchObject({
          kind: "Ready",
          activeKey: FIRST,
        });
      });

      await act(async () => {
        await result.current.onActivate(SECOND);
      });
      expect(result.current.result).toMatchObject({
        kind: "Ready",
        activeKey: SECOND,
      });
      expect(result.current.returnToReadingPosition.kind).toBe("Available");

      const autoRequest = vi.mocked(owner.preview).mock.calls[0]?.[0];
      if (!autoRequest || !settleAutoPreview) {
        throw new Error("Expected a pending auto-preview.");
      }
      await act(async () => {
        settleAutoPreview(previewReceipt(autoRequest, lateKind));
        await Promise.resolve();
      });

      expect(result.current.result).toMatchObject({
        kind: "Ready",
        activeKey: SECOND,
      });
      expect(result.current.returnToReadingPosition.kind).toBe("Available");
    },
  );

  it.each(["Rejected", "Previewed"] as const)(
    "ignores a late %s receipt from a superseded explicit preview",
    async (lateKind) => {
      let settleExplicitPreview:
        ((receipt: PaneFindPreviewReceipt<ExpectedError>) => void) | undefined;
      let previewCount = 0;
      const owner = adapter();
      vi.mocked(owner.preview).mockImplementation((request) => {
        previewCount += 1;
        if (previewCount === 2) {
          return new Promise((resolve) => {
            settleExplicitPreview = resolve;
          });
        }
        return Promise.resolve(previewReceipt(request, "Previewed"));
      });
      const { result } = renderHook(() => useAvailablePaneFind(owner));
      await settlePreparation();
      act(() => result.current.onQueryChange("needle"));
      await waitFor(() => expect(owner.preview).toHaveBeenCalledTimes(1));

      let firstActivation: Promise<boolean> | undefined;
      act(() => {
        firstActivation = result.current.onActivate(SECOND);
      });
      await waitFor(() => {
        expect(owner.preview).toHaveBeenCalledTimes(2);
        expect(result.current.result).toMatchObject({
          kind: "Ready",
          activeKey: SECOND,
        });
      });

      await act(async () => {
        await result.current.onActivate(FIRST);
      });
      expect(result.current.result).toMatchObject({
        kind: "Ready",
        activeKey: FIRST,
      });

      const explicitRequest = vi.mocked(owner.preview).mock.calls[1]?.[0];
      if (!explicitRequest || !settleExplicitPreview || !firstActivation) {
        throw new Error("Expected a pending explicit preview.");
      }
      await act(async () => {
        settleExplicitPreview(previewReceipt(explicitRequest, lateKind));
        await firstActivation;
      });

      expect(result.current.result).toMatchObject({
        kind: "Ready",
        activeKey: FIRST,
      });
      expect(result.current.returnToReadingPosition.kind).toBe("Available");
    },
  );

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
        initialActiveKey: FIRST,
      }))
      .mockImplementationOnce(async (request) => ({
        kind: "NoMatches",
        sessionId: request.sessionId,
        queryId: request.queryId,
        sourceKey: request.sourceKey,
        completeness: "Complete",
      }));
    const owner = adapter(find);
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
    const { result } = renderHook(() => useAvailablePaneFind(owner));
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
      ({ owner }) => useAvailablePaneFind(owner),
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
