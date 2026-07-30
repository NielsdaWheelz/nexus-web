import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PodcastRefreshCounts,
  PodcastRefreshProgress,
  PodcastRefreshRunStatus,
} from "./types";
import { runPodcastRefresh } from "./refresh";

const HANDLE = "prr1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const STREAM_URL = `https://stream.example.test/stream/podcast-refresh-runs/${HANDLE}/events`;

interface SnapshotOverrides extends Partial<PodcastRefreshCounts> {
  readonly status?: PodcastRefreshRunStatus;
}

function snapshot(overrides: SnapshotOverrides = {}) {
  const status = overrides.status ?? "Complete";
  return {
    refreshRunHandle: HANDLE,
    status,
    requestedCount: 2,
    finishedCount: status === "Running" ? 1 : 2,
    succeededCount: status === "Running" ? 1 : 2,
    sourceLimitedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    newEpisodeCount: 0,
    startedAt: "2026-07-30T12:00:00Z",
    completedAt:
      status === "Running"
        ? { kind: "Absent" }
        : { kind: "Present", value: "2026-07-30T12:00:01Z" },
    ...overrides,
  };
}

function admission(
  status: PodcastRefreshRunStatus,
  requestedCount: number,
): Response {
  return Response.json({
    data: {
      refreshRunHandle: HANDLE,
      status,
      requestedCount,
    },
  });
}

function runSnapshot(value: ReturnType<typeof snapshot>): Response {
  return Response.json({ data: value });
}

function streamToken(): Response {
  return Response.json({
    data: {
      token: "stream-token",
      stream_base_url: "https://stream.example.test",
      expires_at: "2026-07-30T12:05:00Z",
    },
  });
}

function sse(
  events: ReadonlyArray<{
    readonly type: string;
    readonly data: unknown;
  }>,
): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPodcastRefresh", () => {
  it("returns an empty terminal admission without opening SSE or reading the run", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(admission("Complete", 0));
    const progress: PodcastRefreshProgress[] = [];

    await expect(
      runPodcastRefresh(
        { kind: "Podcasts" },
        {
          signal: new AbortController().signal,
          onProgress: (value) => progress.push(value),
        },
      ),
    ).resolves.toEqual({
      kind: "Complete",
      requestedCount: 0,
      finishedCount: 0,
      succeededCount: 0,
      sourceLimitedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      newEpisodeCount: 0,
      announcement: "Nothing to refresh",
    });

    expect(progress).toEqual([{ finishedCount: 0, requestedCount: 0 }]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("hydrates a nonempty terminal admission with one GET and no SSE", async () => {
    const durable = snapshot({
      status: "Partial",
      requestedCount: 4,
      finishedCount: 4,
      succeededCount: 1,
      sourceLimitedCount: 1,
      failedCount: 1,
      skippedCount: 1,
      newEpisodeCount: 3,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(admission("Partial", 4))
      .mockResolvedValueOnce(runSnapshot(durable));
    const progress: PodcastRefreshProgress[] = [];

    await expect(
      runPodcastRefresh(
        { kind: "Library", libraryId: "library-1" },
        {
          signal: new AbortController().signal,
          onProgress: (value) => progress.push(value),
        },
      ),
    ).resolves.toMatchObject({
      kind: "Partial",
      requestedCount: 4,
      finishedCount: 4,
      succeededCount: 1,
      sourceLimitedCount: 1,
      failedCount: 1,
      skippedCount: 1,
      newEpisodeCount: 3,
      announcement:
        "3 new episodes; 4 checked; 1 feed source-limited; 1 feed failed; 1 subscription no longer active",
    });

    expect(progress).toEqual([
      { finishedCount: 0, requestedCount: 4 },
      { finishedCount: 4, requestedCount: 4 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchSpy.mock.calls[1][0])).toBe(
      `/api/podcasts/refresh-runs/${HANDLE}`,
    );
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({
      cache: "no-store",
      method: "GET",
    });
    expect(
      fetchSpy.mock.calls.some(([input]) => requestUrl(input) === STREAM_URL),
    ).toBe(false);
    expect(
      fetchSpy.mock.calls.some(
        ([input]) => requestUrl(input) === "/api/stream-token",
      ),
    ).toBe(false);
  });

  it("observes state and done snapshots over direct SSE", async () => {
    const running = snapshot({ status: "Running" });
    const done = snapshot({
      status: "Complete",
      requestedCount: 2,
      finishedCount: 2,
      succeededCount: 2,
      newEpisodeCount: 3,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        switch (requestUrl(input)) {
          case "/api/podcasts/refresh-runs":
            return admission("Running", 2);
          case "/api/stream-token":
            return streamToken();
          case STREAM_URL:
            return sse([
              { type: "state", data: running },
              { type: "state", data: done },
              { type: "done", data: done },
            ]);
          default:
            throw new Error(`Unexpected request: ${requestUrl(input)}`);
        }
      });
    const progress: PodcastRefreshProgress[] = [];

    await expect(
      runPodcastRefresh(
        { kind: "Podcast", podcastId: "podcast-1" },
        {
          signal: new AbortController().signal,
          onProgress: (value) => progress.push(value),
        },
      ),
    ).resolves.toMatchObject({
      kind: "Complete",
      requestedCount: 2,
      finishedCount: 2,
      newEpisodeCount: 3,
      announcement: "3 new episodes",
    });

    expect(progress).toEqual([
      { finishedCount: 0, requestedCount: 2 },
      { finishedCount: 1, requestedCount: 2 },
      { finishedCount: 2, requestedCount: 2 },
      { finishedCount: 2, requestedCount: 2 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const post = fetchSpy.mock.calls[0];
    expect(post[1]?.method).toBe("POST");
    expect(post[1]?.body).toBe(
      JSON.stringify({ kind: "Podcast", podcastId: "podcast-1" }),
    );
    expect(new Headers(post[1]?.headers).get("Idempotency-Key")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });

  it("performs one GET after a fatal stream event and uses its terminal result", async () => {
    const running = snapshot({ status: "Running" });
    const durable = snapshot({
      status: "Complete",
      newEpisodeCount: 1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        switch (requestUrl(input)) {
          case "/api/podcasts/refresh-runs":
            return admission("Running", 2);
          case "/api/stream-token":
            return streamToken();
          case STREAM_URL:
            return sse([
              { type: "state", data: running },
              { type: "unexpected", data: running },
            ]);
          case `/api/podcasts/refresh-runs/${HANDLE}`:
            return runSnapshot(durable);
          default:
            throw new Error(`Unexpected request: ${requestUrl(input)}`);
        }
      });

    await expect(
      runPodcastRefresh(
        { kind: "Podcasts" },
        {
          signal: new AbortController().signal,
          onProgress: () => {},
        },
      ),
    ).resolves.toMatchObject({
      kind: "Complete",
      newEpisodeCount: 1,
      announcement: "1 new episode",
    });
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) =>
          requestUrl(input) === `/api/podcasts/refresh-runs/${HANDLE}`,
      ),
    ).toHaveLength(1);
  });

  it("returns ObservationLost when reconciliation still finds a running run", async () => {
    const durable = snapshot({
      status: "Running",
      requestedCount: 5,
      finishedCount: 2,
      succeededCount: 1,
      sourceLimitedCount: 1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        switch (requestUrl(input)) {
          case "/api/podcasts/refresh-runs":
            return admission("Running", 5);
          case "/api/stream-token":
            return streamToken();
          case STREAM_URL:
            return new Response(null, { status: 403 });
          case `/api/podcasts/refresh-runs/${HANDLE}`:
            return runSnapshot(durable);
          default:
            throw new Error(`Unexpected request: ${requestUrl(input)}`);
        }
      });

    await expect(
      runPodcastRefresh(
        { kind: "Podcasts" },
        {
          signal: new AbortController().signal,
          onProgress: () => {},
        },
      ),
    ).resolves.toEqual({
      kind: "ObservationLost",
      requestedCount: 5,
      finishedCount: 2,
      succeededCount: 1,
      sourceLimitedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      newEpisodeCount: 0,
      announcement:
        "Refresh is still running; showing the latest available data",
    });
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) =>
          requestUrl(input) === `/api/podcasts/refresh-runs/${HANDLE}`,
      ),
    ).toHaveLength(1);
  });

  it("returns ObservationLost from the latest counts when the one GET fails", async () => {
    const running = snapshot({
      status: "Running",
      finishedCount: 1,
      succeededCount: 1,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        switch (requestUrl(input)) {
          case "/api/podcasts/refresh-runs":
            return admission("Running", 2);
          case "/api/stream-token":
            return streamToken();
          case STREAM_URL:
            return sse([
              { type: "state", data: running },
              { type: "unexpected", data: running },
            ]);
          case `/api/podcasts/refresh-runs/${HANDLE}`:
            return Response.json(
              {
                error: {
                  code: "E_UNAVAILABLE",
                  message: "temporarily unavailable",
                },
              },
              { status: 503 },
            );
          default:
            throw new Error(`Unexpected request: ${requestUrl(input)}`);
        }
      });

    await expect(
      runPodcastRefresh(
        { kind: "Podcasts" },
        {
          signal: new AbortController().signal,
          onProgress: () => {},
        },
      ),
    ).resolves.toEqual({
      kind: "ObservationLost",
      requestedCount: 2,
      finishedCount: 1,
      succeededCount: 1,
      sourceLimitedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      newEpisodeCount: 0,
      announcement:
        "Refresh is still running; showing the latest available data",
    });
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) =>
          requestUrl(input) === `/api/podcasts/refresh-runs/${HANDLE}`,
      ),
    ).toHaveLength(1);
  });

  it("aborts quietly before admission", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort(new DOMException("replaced", "AbortError"));

    await expect(
      runPodcastRefresh(
        { kind: "Podcasts" },
        { signal: controller.signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts active observation without reconciliation", async () => {
    let resolveToken!: (response: Response) => void;
    let markTokenStarted!: () => void;
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        switch (requestUrl(input)) {
          case "/api/podcasts/refresh-runs":
            return admission("Running", 2);
          case "/api/stream-token":
            return new Promise<Response>((resolve) => {
              resolveToken = resolve;
              markTokenStarted();
            });
          default:
            throw new Error(`Unexpected request: ${requestUrl(input)}`);
        }
      });
    const controller = new AbortController();
    const progress = vi.fn();
    const result = runPodcastRefresh(
      { kind: "Podcasts" },
      { signal: controller.signal, onProgress: progress },
    );
    await tokenStarted;

    controller.abort(new DOMException("source replaced", "AbortError"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    resolveToken(streamToken());
    await Promise.resolve();

    expect(progress).toHaveBeenCalledOnce();
    expect(
      fetchSpy.mock.calls.some(
        ([input]) =>
          requestUrl(input) === `/api/podcasts/refresh-runs/${HANDLE}`,
      ),
    ).toBe(false);
    expect(
      fetchSpy.mock.calls.some(([input]) => requestUrl(input) === STREAM_URL),
    ).toBe(false);
  });
});
