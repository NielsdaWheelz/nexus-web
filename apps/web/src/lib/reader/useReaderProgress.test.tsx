import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { useReaderProgress } from "./useReaderProgress";
import type { ReaderCursorPositioned } from "./readerProgress";
import type { ReaderResumeState } from "./types";

type Options = Parameters<typeof useReaderProgress>[0];
type ApiFetch = NonNullable<Options["apiFetch"]>;

function webLocator(textOffset: number): ReaderResumeState {
  return {
    kind: "web",
    target: { fragment_id: "frag-1" },
    locations: {
      text_offset: textOffset,
      progression: null,
      total_progression: 0.5,
      position: 1,
    },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  };
}

const START = webLocator(0);
const A = webLocator(10);
const B = webLocator(20);
const C = webLocator(30);
const Z = webLocator(40);
const OTHER = webLocator(50);
const OTHER2 = webLocator(60);
const CAP = webLocator(70);

function baseOptions(overrides: Partial<Options> = {}): Options {
  return {
    capability: { state: "Readable", mediaId: "media-1", locatorKind: "web" },
    isPaneActive: true,
    captureCurrentLocator: () => null,
    applyCursor: async () => "applied",
    ...overrides,
  };
}

interface ScriptedCall {
  path: string;
  init?: RequestInit;
}

function isPut(call: ScriptedCall): boolean {
  return call.init?.method === "PUT";
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Fetch fake with independent GET/PUT queues, so a load/revalidate GET can
 * never accidentally consume a response scripted for a save PUT (or vice
 * versa) regardless of real-world race ordering.
 */
function createScriptedFetch() {
  const calls: ScriptedCall[] = [];
  const getQueue: Array<() => Promise<{ data: unknown }>> = [];
  const putQueue: Array<() => Promise<{ data: unknown }>> = [];

  const apiFetch = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const method = init?.method ?? "GET";
    const queue = method === "PUT" ? putQueue : getQueue;
    const next = queue.shift();
    if (!next) {
      return Promise.reject(new Error(`Unscripted ${method} fetch call: ${path}`));
    }
    return next();
  }) as unknown as ApiFetch;

  return {
    apiFetch,
    calls,
    pushGetJson(data: unknown) {
      getQueue.push(() => Promise.resolve({ data }));
    },
    pushGetReject(err: unknown) {
      getQueue.push(() => Promise.reject(err));
    },
    pushPutJson(data: unknown) {
      putQueue.push(() => Promise.resolve({ data }));
    },
    pushPutReject(err: unknown) {
      putQueue.push(() => Promise.reject(err));
    },
    pushPutDeferred() {
      const d = deferred<{ data: unknown }>();
      putQueue.push(() => d.promise);
      return d;
    },
  };
}

function conflictError(current: ReaderCursorPositioned): ApiError {
  return new ApiError(409, "E_READER_STATE_CONFLICT", "conflict", undefined, { current });
}

function putBody(call: ScriptedCall | undefined): unknown {
  if (!call?.init?.body) {
    throw new Error("Expected a PUT call with a body");
  }
  return JSON.parse(String(call.init.body));
}

describe("useReaderProgress: load", () => {
  it("establishes authority from the first load, latches initialSnapshot, and transitions loading -> ready", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 2, locator: A });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );

    expect(result.current.status).toBe("loading");
    expect(result.current.initialSnapshot).toBeUndefined();

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.initialSnapshot).toEqual({
      state: "Positioned",
      revision: 2,
      locator: A,
    });

    // A same-locator revalidation that bumps the authority revision must not
    // disturb the already-latched initial snapshot.
    scripted.pushGetJson({ state: "Positioned", revision: 5, locator: A });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(scripted.calls.filter((c) => !isPut(c))).toHaveLength(2);
    });
    expect(result.current.initialSnapshot).toEqual({
      state: "Positioned",
      revision: 2,
      locator: A,
    });
  });

  it("enters load_failed on failure and recovers via retryLoad without any default write", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetReject(new Error("network down"));

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );

    await waitFor(() => expect(result.current.status).toBe("load_failed"));

    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: A });
    act(() => {
      result.current.retryLoad();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.initialSnapshot).toEqual({
      state: "Positioned",
      revision: 1,
      locator: A,
    });
    expect(scripted.calls.filter(isPut)).toHaveLength(0);
  });
});

describe("useReaderProgress: save scheduling", () => {
  it("schedules exactly one PUT 500ms after the last movement, with cursor + acknowledged base revision", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutJson({ state: "Positioned", revision: 2, locator: A });

    act(() => {
      result.current.reportMovement(A);
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(scripted.calls.filter(isPut)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(scripted.calls.filter(isPut)).toHaveLength(1);
    expect(putBody(scripted.calls.find(isPut))).toEqual({
      locator: A,
      base_revision: 1,
    });

    vi.useRealTimers();
  });
});

describe("useReaderProgress: single-flight write ordering", () => {
  it("serializes A/B/C as A then C, with C carrying A's acknowledged revision", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    const putA = scripted.pushPutDeferred();

    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(scripted.calls.filter(isPut)).toHaveLength(1);
    expect(putBody(scripted.calls.find(isPut))).toEqual({
      locator: A,
      base_revision: 1,
    });

    // B then C arrive while A is still in flight: only the latest survives,
    // and no second PUT is fired yet.
    act(() => {
      result.current.reportMovement(B);
    });
    act(() => {
      result.current.reportMovement(C);
    });
    expect(scripted.calls.filter(isPut)).toHaveLength(1);

    scripted.pushPutJson({ state: "Positioned", revision: 3, locator: C });
    await act(async () => {
      putA.resolve({ data: { state: "Positioned", revision: 2, locator: A } });
      await putA.promise;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.calls.filter(isPut)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    const putCalls = scripted.calls.filter(isPut);
    expect(putCalls).toHaveLength(2);
    expect(putBody(putCalls[1])).toEqual({
      locator: C,
      base_revision: 2,
    });

    vi.useRealTimers();
  });
});

describe("useReaderProgress: save conflict (409)", () => {
  it("opens the handoff with the server's current snapshot and stops auto-saving", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const conflictSnapshot: ReaderCursorPositioned = { state: "Positioned", revision: 5, locator: Z };
    vi.useFakeTimers();
    scripted.pushPutReject(conflictError(conflictSnapshot));

    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.handoff).not.toBeNull());
    expect(result.current.handoff?.snapshot).toEqual(conflictSnapshot);
    expect(result.current.saveFailed).toBe(false);

    const putCountAfterConflict = scripted.calls.filter(isPut).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scripted.calls.filter(isPut)).toHaveLength(putCountAfterConflict);
  });
});

describe("useReaderProgress: stayAtLocalPosition", () => {
  it("captures the current locator, saves at the candidate revision, and clears the handoff on success", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const conflictSnapshot: ReaderCursorPositioned = { state: "Positioned", revision: 5, locator: Z };

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({ apiFetch: scripted.apiFetch, captureCurrentLocator: () => CAP }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(conflictError(conflictSnapshot));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.handoff).not.toBeNull());

    scripted.pushPutJson({ state: "Positioned", revision: 6, locator: CAP });
    act(() => {
      result.current.stayAtLocalPosition();
    });

    await waitFor(() => expect(scripted.calls.filter(isPut)).toHaveLength(2));
    const stayPut = scripted.calls.filter(isPut).at(-1);
    expect(putBody(stayPut)).toEqual({
      locator: CAP,
      base_revision: 5,
    });

    await waitFor(() => expect(result.current.handoff).toBeNull());
  });

  it("surfaces captureUnavailable when the synchronous capture returns null", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const conflictSnapshot: ReaderCursorPositioned = { state: "Positioned", revision: 5, locator: Z };

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({ apiFetch: scripted.apiFetch, captureCurrentLocator: () => null }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(conflictError(conflictSnapshot));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.handoff).not.toBeNull());

    const putCountBeforeStay = scripted.calls.filter(isPut).length;
    act(() => {
      result.current.stayAtLocalPosition();
    });

    await waitFor(() => expect(result.current.handoff?.captureUnavailable).toBe(true));
    expect(scripted.calls.filter(isPut)).toHaveLength(putCountBeforeStay);
  });
});

describe("useReaderProgress: acceptRemoteCursor", () => {
  it("applies the candidate locator via applyCursor and clears the handoff without any PUT", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const conflictSnapshot: ReaderCursorPositioned = { state: "Positioned", revision: 5, locator: Z };
    const applyCursor = vi.fn(async () => "applied" as const);

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch, applyCursor })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(conflictError(conflictSnapshot));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.handoff).not.toBeNull());

    const putCountBeforeAccept = scripted.calls.filter(isPut).length;
    act(() => {
      result.current.acceptRemoteCursor();
    });

    await waitFor(() => {
      expect(applyCursor).toHaveBeenCalledWith(
        expect.objectContaining({ source: "remote", locator: Z }),
      );
    });
    await waitFor(() => expect(result.current.handoff).toBeNull());
    expect(scripted.calls.filter(isPut)).toHaveLength(putCountBeforeAccept);
  });
});

describe("useReaderProgress: save failure and retry", () => {
  it("retrySave resolves clean without a retry PUT when the GET shows the write already committed", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(new Error("network down"));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.saveFailed).toBe(true));

    // The GET reveals the failed write actually committed (ambiguous
    // request that succeeded server-side despite the client-visible error).
    scripted.pushGetJson({ state: "Positioned", revision: 2, locator: A });
    const putCountBeforeRetry = scripted.calls.filter(isPut).length;
    act(() => {
      result.current.retrySave();
    });

    await waitFor(() => expect(result.current.saveFailed).toBe(false));
    expect(scripted.calls.filter(isPut)).toHaveLength(putCountBeforeRetry);
  });

  it("retrySave re-PUTs with the fresh revision when the write did not commit", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(new Error("network down"));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.saveFailed).toBe(true));

    // The GET shows the locator unchanged (our write to A never landed) but
    // at a fresher revision than the stale authority.
    scripted.pushGetJson({ state: "Positioned", revision: 3, locator: START });
    scripted.pushPutJson({ state: "Positioned", revision: 4, locator: A });
    act(() => {
      result.current.retrySave();
    });

    await waitFor(() => expect(scripted.calls.filter(isPut)).toHaveLength(2));
    expect(putBody(scripted.calls.filter(isPut).at(-1))).toEqual({
      locator: A,
      base_revision: 3,
    });
    await waitFor(() => expect(result.current.saveFailed).toBe(false));
  });
});

describe("useReaderProgress: revalidation on focus", () => {
  it("auto-adopts a greater-revision, different-locator snapshot when local is clean and dormant", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const applyCursor = vi.fn(async () => "applied" as const);

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch, applyCursor })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    scripted.pushGetJson({ state: "Positioned", revision: 2, locator: OTHER });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(applyCursor).toHaveBeenCalledWith(
        expect.objectContaining({ source: "remote", locator: OTHER }),
      );
    });
    await waitFor(() => {
      expect(result.current.announcement).toBe("Resumed from your most recent position.");
    });
    expect(result.current.handoff).toBeNull();
  });

  it("does not auto-adopt while local is dirty; the handoff appears instead", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const applyCursor = vi.fn(async () => "applied" as const);

    const { result } = renderHook(() =>
      useReaderProgress(baseOptions({ apiFetch: scripted.apiFetch, applyCursor })),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.reportMovement(A);
    });

    scripted.pushGetJson({ state: "Positioned", revision: 2, locator: OTHER2 });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.handoff).not.toBeNull());
    expect(result.current.handoff?.snapshot).toEqual({
      state: "Positioned",
      revision: 2,
      locator: OTHER2,
    });
    expect(applyCursor).not.toHaveBeenCalled();
    expect(result.current.announcement).not.toBe("Resumed from your most recent position.");
  });
});

describe("useReaderProgress: capability Unavailable", () => {
  it("performs no fetches at all", async () => {
    const scripted = createScriptedFetch();

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({ apiFetch: scripted.apiFetch, capability: { state: "Unavailable" } }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scripted.calls).toHaveLength(0);
    expect(result.current.status).toBe("loading");
    expect(result.current.handoff).toBeNull();
    expect(result.current.saveFailed).toBe(false);
  });
});

describe("useReaderProgress: lifecycle capture", () => {
  it("promotes the freshest synchronously captured locator on pagehide with keepalive", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({
          apiFetch: scripted.apiFetch,
          captureCurrentLocator: () => CAP,
        }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.reportMovement(A);
    });
    scripted.pushPutJson({ state: "Positioned", revision: 2, locator: CAP });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => expect(scripted.calls.filter(isPut)).toHaveLength(1));
    const call = scripted.calls.find(isPut);
    const body = putBody(call) as { locator: unknown; base_revision: number };
    // Not the stale reported locator A: the synchronous capture wins.
    expect(body.locator).toEqual(CAP);
    expect(body.base_revision).toBe(1);
    expect(call?.init?.keepalive).toBe(true);

    // The still-armed idle timer must not double-send after the flush.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(scripted.calls.filter(isPut)).toHaveLength(1);
  });

  it("sends a same-locator cursor write on a clean lifecycle flush, so engagement still advances", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({
          apiFetch: scripted.apiFetch,
          captureCurrentLocator: () => CAP,
        }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    scripted.pushPutJson({ state: "Positioned", revision: 2, locator: CAP });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => expect(scripted.calls.filter(isPut)).toHaveLength(1));
    const call = scripted.calls.find(isPut);
    const body = putBody(call) as { locator: unknown; base_revision: number };
    expect(body.locator).toEqual(CAP);
    expect(body.base_revision).toBe(1);
    expect(call?.init?.keepalive).toBe(true);
  });

  it("does not flush when the synchronous capture returns null", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({
          apiFetch: scripted.apiFetch,
          captureCurrentLocator: () => null,
        }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scripted.calls.filter(isPut)).toHaveLength(0);
  });

  it("does not flush while a remote candidate handoff is open", async () => {
    const scripted = createScriptedFetch();
    scripted.pushGetJson({ state: "Positioned", revision: 1, locator: START });
    const conflictSnapshot: ReaderCursorPositioned = { state: "Positioned", revision: 5, locator: Z };

    const { result } = renderHook(() =>
      useReaderProgress(
        baseOptions({
          apiFetch: scripted.apiFetch,
          captureCurrentLocator: () => CAP,
        }),
      ),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    vi.useFakeTimers();
    scripted.pushPutReject(conflictError(conflictSnapshot));
    act(() => {
      result.current.reportMovement(A);
    });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    await waitFor(() => expect(result.current.handoff).not.toBeNull());

    const putCountAfterConflict = scripted.calls.filter(isPut).length;
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scripted.calls.filter(isPut)).toHaveLength(putCountAfterConflict);
  });
});
