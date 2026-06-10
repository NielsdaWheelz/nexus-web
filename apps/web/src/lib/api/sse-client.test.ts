import { afterEach, describe, expect, it, vi } from "vitest";
import { sseClientDirect, type SseBackoffConfig } from "./sse-client";

const STREAM_URL = "https://stream.example.test/chat-runs/run-1/events";
const TOKEN_PATH = "/api/stream-token";
const FAST_BACKOFF: SseBackoffConfig = { baseMs: 1, maxMs: 1, jitterMs: 0 };

interface TestEvent {
  type: string;
  data: unknown;
  id: string;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function sseFrames(events: Array<{ id?: string; type: string; data: unknown }>): string {
  return events
    .map((event) => {
      const idLine = event.id === undefined ? "" : `id: ${event.id}\n`;
      return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    })
    .join("");
}

function sseConnection(
  events: Array<{ id?: string; type: string; data: unknown }>,
  options: { failAfter?: Error } = {},
): () => Response {
  return () => {
    const encoder = new TextEncoder();
    // Pull-based so the framed events are read before the close/error —
    // erroring a ReadableStream discards chunks still in its queue.
    let framesSent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!framesSent) {
          framesSent = true;
          controller.enqueue(encoder.encode(sseFrames(events)));
          return;
        }
        if (options.failAfter) controller.error(options.failAfter);
        else controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function errorConnection(status: number, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ error: { code: "E_TEST", message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/**
 * Fetch-boundary stub: serves the stream-token POST with counted minted
 * tokens and plays one scripted connection per stream GET.
 */
function installFetch(connections: Array<() => Response>) {
  const requests: RecordedRequest[] = [];
  let mintedTokens = 0;
  let connects = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      if (url === TOKEN_PATH) {
        mintedTokens += 1;
        return Response.json({
          data: {
            token: `minted-${mintedTokens}`,
            stream_base_url: "https://stream.example.test",
            expires_at: "2099-01-01T00:00:00Z",
          },
        });
      }
      const connection = connections[connects];
      connects += 1;
      if (!connection) {
        throw new Error(`Unexpected stream connect #${connects} to ${url}`);
      }
      return connection();
    }),
  );
  return {
    requests,
    streamRequests: () => requests.filter((request) => request.url === STREAM_URL),
    tokenRequests: () => requests.filter((request) => request.url === TOKEN_PATH),
  };
}

function startClient(
  overrides: Partial<Parameters<typeof sseClientDirect<TestEvent>>[0]> = {},
) {
  const seen: TestEvent[] = [];
  const errors: string[] = [];
  const completions: boolean[] = [];
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const abort = sseClientDirect<TestEvent>({
    url: STREAM_URL,
    initialToken: "initial-token",
    backoff: FAST_BACKOFF,
    decode: (type, data, id) => ({ type, data, id }),
    isTerminal: (event) => event.type === "done",
    onEvent: (event) => seen.push(event),
    onError: (err) => {
      errors.push(err.message);
      settle();
    },
    onComplete: (terminalEventSeen) => {
      completions.push(terminalEventSeen);
      settle();
    },
    ...overrides,
  });
  return { seen, errors, completions, settled, abort };
}

describe("sseClientDirect", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the initial token for the first connect and mints fresh tokens per reconnect", async () => {
    const fetchBoundary = installFetch([
      sseConnection([{ id: "1", type: "delta", data: { delta: "a" } }]),
      sseConnection([{ id: "2", type: "done", data: {} }]),
    ]);

    const client = startClient();
    await client.settled;

    expect(fetchBoundary.requests[0].url, "first request must be the stream connect, not a token mint").toBe(STREAM_URL);
    const streams = fetchBoundary.streamRequests();
    expect(streams).toHaveLength(2);
    expect(streams[0].headers.authorization).toBe("Bearer initial-token");
    expect(fetchBoundary.tokenRequests()).toHaveLength(1);
    expect(streams[1].headers.authorization).toBe("Bearer minted-1");
    expect(streams[1].headers["last-event-id"]).toBe("1");
    expect(client.completions).toEqual([true]);
    expect(client.errors).toEqual([]);
  });

  it("passes the wire event id through to decode", async () => {
    installFetch([
      sseConnection([
        { id: "7", type: "delta", data: { delta: "x" } },
        { id: "8", type: "done", data: {} },
      ]),
    ]);

    const client = startClient();
    await client.settled;

    expect(client.seen).toEqual([
      { type: "delta", data: { delta: "x" }, id: "7" },
      { type: "done", data: {}, id: "8" },
    ]);
  });

  it("completes without reconnecting when the stream closes after the terminal event", async () => {
    const fetchBoundary = installFetch([
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const client = startClient();
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(fetchBoundary.tokenRequests()).toHaveLength(0);
    expect(client.completions).toEqual([true]);
  });

  it("reconnects when the stream ends cleanly without a terminal event", async () => {
    const fetchBoundary = installFetch([
      sseConnection([]),
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const client = startClient();
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(2);
    expect(client.completions).toEqual([true]);
    expect(client.errors).toEqual([]);
  });

  it("treats a clean EOF as fatal once maxReconnects is exhausted", async () => {
    const fetchBoundary = installFetch([sseConnection([])]);

    const client = startClient({ maxReconnects: 0 });
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(client.errors).toEqual(["SSE stream ended before terminal event"]);
    expect(client.completions).toEqual([]);
  });

  it("fires onReconnect with the attempt number before reconnecting", async () => {
    const fetchBoundary = installFetch([
      errorConnection(500, "boom"),
      errorConnection(500, "boom"),
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const connectsWhenCalled: Array<{ attempt: number; connects: number }> = [];
    const client = startClient({
      onReconnect: async (attempt) => {
        connectsWhenCalled.push({
          attempt,
          connects: fetchBoundary.streamRequests().length,
        });
        return "continue";
      },
    });
    await client.settled;

    expect(connectsWhenCalled).toEqual([
      { attempt: 1, connects: 1 },
      { attempt: 2, connects: 2 },
    ]);
    expect(client.completions).toEqual([true]);
  });

  it("stops cleanly when onReconnect resolves stop", async () => {
    const fetchBoundary = installFetch([errorConnection(500, "boom")]);

    const client = startClient({ onReconnect: async () => "stop" });
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(client.completions).toEqual([false]);
    expect(client.errors).toEqual([]);
  });

  it.each([401, 500, 503])("reconnects after an HTTP %d response", async (status) => {
    const fetchBoundary = installFetch([
      errorConnection(status, "transient"),
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const client = startClient();
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(2);
    expect(client.completions).toEqual([true]);
    expect(client.errors).toEqual([]);
  });

  it("reconnects after a network error", async () => {
    let first = true;
    installFetch([
      () => {
        if (first) {
          first = false;
          throw new TypeError("fetch failed");
        }
        return sseConnection([{ id: "1", type: "done", data: {} }])();
      },
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const client = startClient();
    await client.settled;

    expect(client.completions).toEqual([true]);
    expect(client.errors).toEqual([]);
  });

  it.each([400, 403, 404])("fails fast on an HTTP %d response", async (status) => {
    const fetchBoundary = installFetch([errorConnection(status, "addressing bug")]);

    const client = startClient();
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(client.errors).toEqual(["addressing bug"]);
    expect(client.completions).toEqual([]);
  });

  it("fails fast on a decoder error without reconnecting", async () => {
    const fetchBoundary = installFetch([
      sseConnection([{ id: "1", type: "mystery", data: {} }]),
    ]);

    const client = startClient({
      decode: (type, data, id) => {
        if (type === "mystery") throw new Error(`Unknown SSE event type: ${type}`);
        return { type, data, id };
      },
    });
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(client.errors).toEqual(["Unknown SSE event type: mystery"]);
  });

  it("surfaces the failure after maxReconnects consecutive failures", async () => {
    const fetchBoundary = installFetch([
      errorConnection(500, "boom 1"),
      errorConnection(500, "boom 2"),
      errorConnection(500, "boom 3"),
    ]);

    const client = startClient({ maxReconnects: 2 });
    await client.settled;

    expect(fetchBoundary.streamRequests()).toHaveLength(3);
    expect(client.errors).toEqual(["boom 3"]);
    expect(client.completions).toEqual([]);
  });

  it("delivers events in order across a reconnect and resumes from the last event id", async () => {
    const fetchBoundary = installFetch([
      sseConnection(
        [
          { id: "1", type: "delta", data: { delta: "a" } },
          { id: "2", type: "delta", data: { delta: "b" } },
        ],
        { failAfter: new Error("connection reset") },
      ),
      sseConnection([
        { id: "3", type: "delta", data: { delta: "c" } },
        { id: "4", type: "done", data: {} },
      ]),
    ]);

    const client = startClient();
    await client.settled;

    expect(client.seen.map((event) => event.id)).toEqual(["1", "2", "3", "4"]);
    expect(fetchBoundary.streamRequests()[1].headers["last-event-id"]).toBe("2");
    expect(client.completions).toEqual([true]);
    expect(client.errors).toEqual([]);
  });

  it("applies the backoff override and doubles it up to maxMs", async () => {
    vi.useFakeTimers();
    const fetchBoundary = installFetch([
      errorConnection(500, "boom"),
      errorConnection(500, "boom"),
      sseConnection([{ id: "1", type: "done", data: {} }]),
    ]);

    const client = startClient({
      backoff: { baseMs: 5000, maxMs: 60000, jitterMs: 0 },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBoundary.streamRequests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchBoundary.streamRequests(), "must hold the full 5000ms base backoff").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBoundary.streamRequests()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchBoundary.streamRequests(), "second backoff must double to 10000ms").toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchBoundary.streamRequests()).toHaveLength(3);

    await client.settled;
    expect(client.completions).toEqual([true]);
  });
});
