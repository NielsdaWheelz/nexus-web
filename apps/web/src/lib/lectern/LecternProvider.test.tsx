import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isApiError } from "@/lib/api/client";
import { consumptionProjectionSnapshot } from "@/lib/consumption/projectionRevision";
import { isAbortError } from "@/lib/errors";
import {
  assumeLecternItemId,
  assumeMediaId,
  parseCompletionHandle,
} from "@/lib/lectern/contract";
import {
  LECTERN_COMMAND_DEADLINE_MS,
  LECTERN_REVALIDATE_MIN_INTERVAL_MS,
  LecternProvider,
  useLectern,
  type CanonicalInstallEvent,
  type LecternCapability,
} from "@/lib/lectern/LecternProvider";

// --- Fixtures ----------------------------------------------------------------

const ITEM_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEDIA_A = "a1111111-1111-1111-1111-111111111111";
const ITEM_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEDIA_B = "b1111111-1111-1111-1111-111111111111";
const ITEM_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MEDIA_C = "c1111111-1111-1111-1111-111111111111";

const idA = assumeLecternItemId(ITEM_A);
const idB = assumeLecternItemId(ITEM_B);

function wireItem(itemId: string, mediaId: string, title: string): Record<string, unknown> {
  return {
    itemId,
    mediaId,
    kind: "podcast_episode",
    title,
    subtitle: { kind: "Absent" },
    href: `/media/${mediaId}`,
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
    activation: {
      kind: "FooterAudio",
      streamUrl: `https://cdn.example.com/${mediaId}.mp3`,
      sourceUrl: `https://example.com/${mediaId}`,
      positionMs: 0,
      writeRevision: 1,
      resetEpoch: 0,
      playbackRate: {
        value: 1,
        source: "Product",
        podcastPreference: { kind: "Absent" },
      },
      pauseShorteningMode: { kind: "Absent" },
      consumptionOverrideRevision: { kind: "Absent" },
      durationMs: { kind: "Present", value: 60000 },
      artworkUrl: { kind: "Absent" },
      chapters: [],
    },
  };
}

function wireSnapshot(items: Record<string, unknown>[]): Record<string, unknown> {
  return { items };
}

const ITEMS_AB = [
  wireItem(ITEM_A, MEDIA_A, "Alpha"),
  wireItem(ITEM_B, MEDIA_B, "Bravo"),
];

function lecternRemoved(itemId: string, remaining: Record<string, unknown>[]): Record<string, unknown> {
  return { outcome: { kind: "Removed", itemId }, lectern: wireSnapshot(remaining) };
}

// --- Fetch mock --------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

// A fetch that stays pending until its AbortSignal fires, then rejects with the
// abort reason — mirroring real fetch under an AbortController (deadline/unmount).
function hangUntilAbort(signal: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const onAbort = () =>
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RecordedCall {
  path: string;
  method: string;
  body: string | null;
  cache: RequestCache | undefined;
}

interface LecternFetchMock {
  calls: RecordedCall[];
  handlers: {
    get: (signal: AbortSignal | null) => Promise<Response>;
    postLectern: (body: unknown, signal: AbortSignal | null) => Promise<Response>;
    postConsumption: (body: unknown, signal: AbortSignal | null) => Promise<Response>;
  };
  gets: () => RecordedCall[];
  lecternPosts: () => RecordedCall[];
}

function installLecternFetchMock(): LecternFetchMock {
  const calls: RecordedCall[] = [];
  const handlers: LecternFetchMock["handlers"] = {
    get: async () => jsonResponse({ data: wireSnapshot([]) }),
    postLectern: async () => jsonResponse({ data: lecternRemoved(ITEM_A, []) }),
    postConsumption: async () =>
      jsonResponse({
        data: {
          outcome: { kind: "StateOnly" },
          lectern: wireSnapshot([]),
          nextItem: { kind: "Absent" },
          progressState: { kind: "Absent" },
          completionHandle: { kind: "Absent" },
          libraryEntriesCollectionRevision: 1,
        },
      }),
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ path: url.pathname, method, body, cache: init?.cache });
    const signal = init?.signal ?? null;
    if (url.pathname === "/api/lectern" && method === "GET") return handlers.get(signal);
    if (url.pathname === "/api/lectern/commands" && method === "POST") {
      return handlers.postLectern(body === null ? null : JSON.parse(body), signal);
    }
    if (url.pathname === "/api/consumption/commands" && method === "POST") {
      return handlers.postConsumption(body === null ? null : JSON.parse(body), signal);
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
  });
  return {
    calls,
    handlers,
    gets: () => calls.filter((c) => c.path === "/api/lectern" && c.method === "GET"),
    lecternPosts: () => calls.filter((c) => c.path === "/api/lectern/commands"),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <LecternProvider>{children}</LecternProvider>;
}

function renderLectern() {
  return renderHook(() => useLectern(), { wrapper });
}

async function drain(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let outcome: { rejected: boolean; value: unknown } = { rejected: false, value: null };
  await promise.then(
    () => {},
    (error) => {
      outcome = { rejected: true, value: error };
    },
  );
  if (!outcome.rejected) throw new Error("expected the promise to reject");
  return outcome.value;
}

function titles(cap: LecternCapability): string[] {
  if (cap.resource.status !== "ready") throw new Error("resource not ready");
  return cap.resource.data.items.map((item) => item.title);
}

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests -------------------------------------------------------------------

describe("LecternProvider initial load", () => {
  it("installs the snapshot and becomes ready", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    expect(titles(result.current)).toEqual(["Alpha", "Bravo"]);
    expect(result.current.mutation.kind).toBe("Idle");
    expect(mock.gets()).toHaveLength(1);
  });

  it("throws (defect) when a mutation is invoked while still loading", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = (signal) => hangUntilAbort(signal); // never resolves → stays loading

    const { result } = renderLectern();
    expect(result.current.resource.status).toBe("loading");
    expect(() => result.current.removeItem(idA)).toThrow(/Ready/);
  });
});

describe("LecternProvider optimistic remove", () => {
  it("renders presentedSnapshot while Pending, then installs the canonical snapshot", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    // The server response drops A and reveals a background addition C that the
    // optimistic snapshot never knew about — it must survive the canonical install.
    mock.handlers.postLectern = async () =>
      jsonResponse({
        data: lecternRemoved(ITEM_A, [
          wireItem(ITEM_B, MEDIA_B, "Bravo"),
          wireItem(ITEM_C, MEDIA_C, "Charlie"),
        ]),
      });

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.removeItem(idA);
    });

    // Synchronously Pending with the locally-computed optimistic snapshot (A gone).
    const pending = result.current.mutation;
    expect(pending.kind).toBe("Pending");
    if (pending.kind !== "Pending") throw new Error("unreachable");
    expect(pending.presentedSnapshot.items.map((i) => i.title)).toEqual(["Bravo"]);
    // The canonical resource is untouched until the server confirms.
    expect(titles(result.current)).toEqual(["Alpha", "Bravo"]);

    await act(async () => {
      await promise;
    });

    expect(result.current.mutation.kind).toBe("Idle");
    expect(titles(result.current)).toEqual(["Bravo", "Charlie"]);
  });

  it("suppresses a double gesture while Pending (one command reaches the network)", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    mock.handlers.postLectern = (_body, signal) => hangUntilAbort(signal); // keep it Pending

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.removeItem(idA);
    });
    first.catch(() => {});
    expect(result.current.mutation.kind).toBe("Pending");

    // The leaf-disable contract: a second gesture only fires while Idle. Pending is
    // synchronous, so the guard sees it and the second removeItem never runs.
    act(() => {
      if (result.current.mutation.kind === "Idle") result.current.removeItem(idB);
    });

    // Exactly one command reaches the network (the first); the second was suppressed.
    await waitFor(() => expect(mock.lecternPosts()).toHaveLength(1));
    expect(result.current.mutation.kind).toBe("Pending");
  });
});

describe("LecternProvider deadline and retry", () => {
  it("times out to RetryableFailure, blocks the lane, and reuses the same id/body on retry", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });

    let postCount = 0;
    mock.handlers.postLectern = (_body, signal) => {
      postCount += 1;
      if (postCount === 1) return hangUntilAbort(signal); // first attempt hits the deadline
      return Promise.resolve(
        jsonResponse({ data: lecternRemoved(ITEM_A, [wireItem(ITEM_B, MEDIA_B, "Bravo")]) }),
      );
    };

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    vi.useFakeTimers();
    let removeA!: Promise<unknown>;
    act(() => {
      removeA = result.current.removeItem(idA);
    });
    removeA.catch(() => {});
    await drain(); // let the first POST reach the network (and hang)
    expect(postCount).toBe(1);
    expect(result.current.mutation.kind).toBe("Pending");

    // Cross the 35s browser deadline → unknown outcome → provider-owned Retry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LECTERN_COMMAND_DEADLINE_MS);
    });
    expect(result.current.mutation.kind).toBe("RetryableFailure");

    // A second command enqueued now is visibly blocked: the lane is parked, so it
    // does not reach the network, and it does not clobber the failure display.
    let removeB!: Promise<unknown>;
    act(() => {
      removeB = result.current.removeItem(idB);
    });
    removeB.catch(() => {});
    await drain();
    expect(postCount).toBe(1);
    expect(result.current.mutation.kind).toBe("RetryableFailure");

    // Retry re-sends the exact frozen body (same clientMutationId); then the
    // previously-blocked B command finally runs.
    act(() => {
      const state = result.current.mutation;
      if (state.kind === "RetryableFailure") state.retry();
    });
    await act(async () => {
      await removeA;
      await removeB;
    });

    const bodies = mock.lecternPosts().map((call) => call.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).not.toBeNull();
    expect(bodies[0]).toBe(bodies[1]); // hang + retry are byte-identical
    expect(bodies[1]).not.toBe(bodies[2]); // the follow-up B command is a different body
  });

  it("reports a parked unknown to the narrow place observer without transferring Retry ownership", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    let postCount = 0;
    mock.handlers.postLectern = (_body, signal) => {
      postCount += 1;
      if (postCount === 1) return hangUntilAbort(signal);
      return Promise.resolve(
        jsonResponse({
          data: {
            outcome: { kind: "Placed", itemIds: [ITEM_C] },
            lectern: wireSnapshot([
              ...ITEMS_AB,
              wireItem(ITEM_C, MEDIA_C, "Charlie"),
            ]),
          },
        }),
      );
    };
    const observation = new AbortController();
    const onUnknown = vi.fn();
    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    vi.useFakeTimers();
    let placement!: Promise<unknown>;
    act(() => {
      placement = result.current.placeItems({
        mediaIds: [assumeMediaId(MEDIA_C)],
        placement: { kind: "Last" },
        unknownObservation: { signal: observation.signal, onUnknown },
      });
    });
    await drain();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LECTERN_COMMAND_DEADLINE_MS);
    });

    expect(result.current.mutation.kind).toBe("RetryableFailure");
    expect(onUnknown).toHaveBeenCalledOnce();
    expect(onUnknown.mock.calls[0][0]).toBeInstanceOf(ApiError);

    observation.abort();
    act(() => {
      const state = result.current.mutation;
      if (state.kind === "RetryableFailure") state.retry();
    });
    await act(async () => placement);

    expect(onUnknown).toHaveBeenCalledOnce();
    expect(result.current.mutation.kind).toBe("Idle");
    expect(titles(result.current)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});

describe("LecternProvider definitive failure and reconciliation", () => {
  it("runs one reconciliation GET, returns to Idle, and rejects with the ApiError", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    mock.handlers.postLectern = async () => errorResponse(404, "E_NOT_FOUND", "item gone");

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    expect(mock.gets()).toHaveLength(1);

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.removeItem(idA);
    });

    let error: unknown;
    await act(async () => {
      error = await captureRejection(promise);
    });
    expect(isApiError(error)).toBe(true);
    expect((error as ApiError).code).toBe("E_NOT_FOUND");
    expect(result.current.mutation.kind).toBe("Idle");
    // Exactly one reconciliation GET followed the definitive failure; the row that
    // the failed Remove never dropped is restored from the canonical snapshot.
    expect(mock.gets()).toHaveLength(2);
    expect(titles(result.current)).toEqual(["Alpha", "Bravo"]);
  });

  it("parks on ReconciliationFailed, keeps the command promise pending, then rejects with the ORIGINAL error after retryGet", async () => {
    const mock = installLecternFetchMock();
    let getCount = 0;
    mock.handlers.get = async () => {
      getCount += 1;
      if (getCount === 2) return errorResponse(503, "E_UPSTREAM", "reconcile boom");
      return jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    };
    mock.handlers.postLectern = async () => errorResponse(404, "E_NOT_FOUND", "item gone");

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let promise!: Promise<unknown>;
    let settled = false;
    act(() => {
      promise = result.current.removeItem(idA);
    });
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await waitFor(() => expect(result.current.mutation.kind).toBe("ReconciliationFailed"));
    expect(settled).toBe(false); // the logical command promise is still pending

    // GET-only retry succeeds → resolves the flow by rejecting with the original
    // definitive error (never the reconciliation GET's error, never a re-run command).
    act(() => {
      const state = result.current.mutation;
      if (state.kind === "ReconciliationFailed") state.retryGet();
    });

    let error: unknown;
    await act(async () => {
      error = await captureRejection(promise);
    });
    expect((error as ApiError).code).toBe("E_NOT_FOUND");
    expect(result.current.mutation.kind).toBe("Idle");
    expect(getCount).toBe(3); // initial + failed reconcile + successful retryGet
  });
});

describe("LecternProvider revalidation", () => {
  it("revalidates on focus only past the 60s minimum interval and coalesces triggers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });

    const { result } = renderLectern();
    await drain();
    expect(result.current.resource.status).toBe("ready");
    expect(mock.gets()).toHaveLength(1);

    // A focus within the interval does nothing.
    act(() => window.dispatchEvent(new Event("focus")));
    await drain();
    expect(mock.gets()).toHaveLength(1);

    // Past 60s, two rapid focus events coalesce into exactly one revalidation GET.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await drain();
    expect(mock.gets()).toHaveLength(2);
  });

  it("forces one no-store FIFO refresh after earlier mutation work", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => {
      return jsonResponse({
        data: wireSnapshot(ITEMS_AB),
      });
    };
    mock.handlers.postLectern = async () =>
      jsonResponse({
        data: lecternRemoved(ITEM_A, [wireItem(ITEM_B, MEDIA_B, "Bravo")]),
      });

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let removal!: Promise<unknown>;
    act(() => {
      removal = result.current.removeItem(idA);
      result.current.revalidate();
      result.current.revalidate();
    });
    await act(async () => {
      await removal;
    });
    // The forced GET captures install ordering when it starts after the
    // mutation, so it installs its own current response rather than skipping
    // itself based on the counter from its original enqueue point.
    await waitFor(() => expect(titles(result.current)).toEqual(["Alpha", "Bravo"]));
    expect(mock.gets()).toHaveLength(2);
    expect(mock.gets()[1]?.cache).toBe("no-store");
  });

  it("queues one forced refresh while loading and recovers an initial GET failure", async () => {
    vi.useFakeTimers();
    const mock = installLecternFetchMock();
    let getCount = 0;
    mock.handlers.get = (signal) => {
      getCount += 1;
      return getCount === 1
        ? hangUntilAbort(signal)
        : Promise.resolve(jsonResponse({ data: wireSnapshot(ITEMS_AB) }));
    };

    const { result } = renderLectern();
    act(() => {
      result.current.revalidate();
      result.current.revalidate();
    });
    await drain();
    expect(mock.gets()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LECTERN_COMMAND_DEADLINE_MS);
    });
    await drain();

    expect(result.current.resource.status).toBe("ready");
    expect(mock.gets()).toHaveLength(2);
    expect(mock.gets()[1]?.cache).toBe("no-store");
  });

  it("queues a forced refresh behind an in-flight lifecycle refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const mock = installLecternFetchMock();
    let getCount = 0;
    let resolveLifecycleGet!: (response: Response) => void;
    mock.handlers.get = () => {
      getCount += 1;
      if (getCount === 2) {
        return new Promise<Response>((resolve) => {
          resolveLifecycleGet = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ data: wireSnapshot(ITEMS_AB) }));
    };

    const { result } = renderLectern();
    await drain();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LECTERN_REVALIDATE_MIN_INTERVAL_MS);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await drain();
    expect(mock.gets()).toHaveLength(2);

    act(() => {
      result.current.revalidate();
      result.current.revalidate();
      resolveLifecycleGet(jsonResponse({ data: wireSnapshot(ITEMS_AB) }));
    });
    await drain();
    expect(mock.gets()).toHaveLength(3);

    expect(mock.gets()[1]?.cache).toBeUndefined();
    expect(mock.gets()[2]?.cache).toBe("no-store");
  });

  it("keeps the last good snapshot when a forced refresh fails", async () => {
    const mock = installLecternFetchMock();
    let getCount = 0;
    mock.handlers.get = async () => {
      getCount += 1;
      return getCount === 1
        ? jsonResponse({ data: wireSnapshot(ITEMS_AB) })
        : errorResponse(503, "E_UPSTREAM", "refresh unavailable");
    };

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    act(() => {
      result.current.revalidate();
    });
    await waitFor(() => expect(mock.gets()).toHaveLength(2));
    await waitFor(() => expect(titles(result.current)).toEqual(["Alpha", "Bravo"]));
    expect(result.current.mutation.kind).toBe("Idle");
  });
});

describe("LecternProvider ResetProgress install", () => {
  it("drains registered consumers before enqueue, then emits the canonical progress state", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot([]) });
    mock.handlers.postConsumption = async (body) => {
      expect(body).toMatchObject({ kind: "ResetProgress", mediaId: MEDIA_A });
      return jsonResponse({
        data: {
          outcome: { kind: "StateOnly" },
          lectern: wireSnapshot([]),
          nextItem: { kind: "Absent" },
          progressState: {
            kind: "Present",
            value: {
              mediaId: MEDIA_A,
              readerCursor: { state: "Empty", revision: 4 },
              listeningState: {
                kind: "Present",
                value: {
                  positionMs: 0,
                  durationMs: { kind: "Present", value: 60_000 },
                  episodePlaybackRate: { kind: "Present", value: 1 },
                  writeRevision: 8,
                  resetEpoch: 2,
                },
              },
            },
          },
          completionHandle: { kind: "Absent" },
          libraryEntriesCollectionRevision: 2,
        },
      });
    };

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let hookMediaId: string | null = null;
    const installs: CanonicalInstallEvent[] = [];
    const unregister = result.current.registerBeforeProgressReset(async (mediaId) => {
      hookMediaId = mediaId;
      await hookGate;
    });
    const unsubscribe = result.current.onCanonicalInstall((event) => installs.push(event));

    const consumptionPosts = () =>
      mock.calls.filter((c) => c.path === "/api/consumption/commands");

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.resetProgress(assumeMediaId(MEDIA_A));
    });
    promise.catch(() => {});

    // The hook is invoked with the target media; the reset command is NOT
    // enqueued while the drain hook is still pending.
    await waitFor(() => expect(hookMediaId).toBe(MEDIA_A));
    expect(consumptionPosts()).toHaveLength(0);

    // Once the drain completes, ResetProgress reaches the FIFO/network and its
    // one canonical state is emitted after the Lectern snapshot is installed.
    releaseHook();
    await act(async () => {
      await promise;
    });
    expect(consumptionPosts()).toHaveLength(1);
    expect(installs.at(-1)).toEqual({
      kind: "progressState",
      state: {
        mediaId: MEDIA_A,
        readerCursor: { state: "Empty", revision: 4 },
        listeningState: {
          kind: "Present",
          value: {
            positionMs: 0,
            durationMs: { kind: "Present", value: 60_000 },
            episodePlaybackRate: { kind: "Present", value: 1 },
            writeRevision: 8,
            resetEpoch: 2,
          },
        },
      },
    });

    unregister();
    unsubscribe();
  });

  it("does not invoke reset drains for status-only Mark Unread", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot([]) });
    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const resetDrain = vi.fn(async () => {});
    const unregister = result.current.registerBeforeProgressReset(resetDrain);
    const beforeRevision = consumptionProjectionSnapshot().revision;

    await act(async () => {
      await result.current.setUnread(assumeMediaId(MEDIA_A));
    });

    expect(resetDrain).not.toHaveBeenCalled();
    const post = mock.calls.find((call) => call.path === "/api/consumption/commands");
    expect(post?.body).toContain('"kind":"SetUnread"');
    // The consumption install callback publishes exactly one projection revision.
    expect(consumptionProjectionSnapshot().revision).toBe(beforeRevision + 1);
    unregister();
  });

  it("annotates only successful status-only Unread targets, including batch and undo", async () => {
    // The empty canonical snapshot proves these ids are direct/non-Lectern
    // media. Installation must preserve their exact command-target order.
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot([]) });
    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const installs: CanonicalInstallEvent[] = [];
    const unsubscribe = result.current.onCanonicalInstall((event) => installs.push(event));

    await act(async () => {
      await result.current.setUnread(assumeMediaId(MEDIA_A));
      await result.current.setBatchState({
        mediaIds: [assumeMediaId(MEDIA_B), assumeMediaId(MEDIA_C)],
        state: "Unread",
      });
      await result.current.undoCompletion(
        parseCompletionHandle("ncc1.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv"),
        { unreadMediaId: assumeMediaId(MEDIA_C) },
      );
    });

    expect(installs).toEqual([
      { kind: "snapshot", snapshot: { items: [] }, unreadMediaIds: [assumeMediaId(MEDIA_A)] },
      {
        kind: "snapshot",
        snapshot: { items: [] },
        unreadMediaIds: [assumeMediaId(MEDIA_B), assumeMediaId(MEDIA_C)],
      },
      { kind: "snapshot", snapshot: { items: [] }, unreadMediaIds: [assumeMediaId(MEDIA_C)] },
    ]);
    unsubscribe();
  });
});

describe("LecternProvider getCanonicalSnapshot", () => {
  it("exposes the live canonical snapshot (undefined until Ready)", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });

    const { result } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const snapshot = result.current.getCanonicalSnapshot();
    expect(snapshot?.items.map((item) => item.title)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("LecternProvider unmount", () => {
  it("aborts an in-flight command and rejects its promise with an abort error", async () => {
    const mock = installLecternFetchMock();
    mock.handlers.get = async () => jsonResponse({ data: wireSnapshot(ITEMS_AB) });
    mock.handlers.postLectern = (_body, signal) => hangUntilAbort(signal);

    const { result, unmount } = renderLectern();
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.removeItem(idA);
    });
    const rejection = captureRejection(promise);
    await waitFor(() => expect(mock.lecternPosts()).toHaveLength(1)); // POST in flight (hanging)

    unmount();

    const error = await rejection;
    expect(isAbortError(error)).toBe(true);
  });
});
