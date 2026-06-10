import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useGenerationRun,
  type GenerationRunKind,
} from "./useGenerationRun";

const STREAM_BASE = "https://stream.example.test";
const TOKEN_PATH = "/api/stream-token";
const FAST_RECONNECT = { backoff: { baseMs: 1, maxMs: 1, jitterMs: 0 } };

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

function frame(event: { id?: string; type: string; data: unknown }): string {
  const idLine = event.id === undefined ? "" : `id: ${event.id}\n`;
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** An SSE connection the test scripts interactively (emit/close/fail). */
function controlledConnection() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    respond: () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    emit: (event: { id?: string; type: string; data: unknown }) => {
      controller.enqueue(encoder.encode(frame(event)));
    },
    close: () => controller.close(),
    fail: (err: Error) => controller.error(err),
  };
}

function doneConnection(): () => Response {
  const connection = controlledConnection();
  connection.emit({ id: "1", type: "done", data: {} });
  connection.close();
  return connection.respond;
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
            stream_base_url: STREAM_BASE,
            expires_at: "2099-01-01T00:00:00Z",
          },
        });
      }
      if (url.startsWith(STREAM_BASE)) {
        const connection = connections[connects];
        connects += 1;
        if (!connection) {
          throw new Error(`Unexpected stream connect #${connects} to ${url}`);
        }
        return connection();
      }
      throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
    }),
  );
  return {
    requests,
    streamRequests: () =>
      requests.filter((request) => request.url.startsWith(STREAM_BASE)),
    tokenRequests: () =>
      requests.filter((request) => request.url === TOKEN_PATH),
  };
}

interface RunProps {
  kind: GenerationRunKind;
  id: string | null;
  resume?: { lastEventId?: string };
  reconnect?: Parameters<typeof useGenerationRun>[0]["reconnect"];
}

function renderRun(
  initial: Partial<RunProps> = {},
  options: { wrapper?: ({ children }: { children: ReactNode }) => ReactNode } = {},
) {
  const events: TestEvent[] = [];
  const { result, rerender } = renderHook(
    (props: RunProps) =>
      useGenerationRun<TestEvent>({
        kind: props.kind,
        id: props.id,
        decode: (type, data, id) => ({ type, data, id }),
        isTerminal: (event) => event.type === "done",
        onEvent: (event) => events.push(event),
        resume: props.resume,
        reconnect: props.reconnect,
      }),
    {
      initialProps: {
        kind: initial.kind ?? "chat-runs",
        id: initial.id === undefined ? "run-1" : initial.id,
        resume: initial.resume,
        reconnect: initial.reconnect,
      },
      ...(options.wrapper ? { wrapper: options.wrapper } : {}),
    },
  );
  return { events, result, rerender };
}

describe("useGenerationRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays idle and opens nothing while id is null", async () => {
    const fetchBoundary = installFetch([]);

    const { result } = renderRun({ id: null });

    expect(result.current.phase).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchBoundary.requests).toHaveLength(0);
  });

  it.each<[GenerationRunKind, string]>([
    ["chat-runs", `${STREAM_BASE}/stream/chat-runs/run-1/events`],
    ["oracle-readings", `${STREAM_BASE}/stream/oracle-readings/run-1/events`],
    ["library-intelligence", `${STREAM_BASE}/stream/library-intelligence/run-1/events`],
    ["media", `${STREAM_BASE}/stream/media/run-1/events`],
  ])("streams %s from its current stream path", async (kind, expectedUrl) => {
    const fetchBoundary = installFetch([doneConnection()]);

    const { result } = renderRun({ kind });
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(fetchBoundary.streamRequests().map((request) => request.url)).toEqual([
      expectedUrl,
    ]);
    expect(fetchBoundary.streamRequests()[0].headers.authorization).toBe(
      "Bearer minted-1",
    );
  });

  it("moves connecting → streaming → done and delivers events in order", async () => {
    const connection = controlledConnection();
    installFetch([connection.respond]);

    const { events, result } = renderRun();
    expect(result.current.phase).toBe("connecting");

    connection.emit({ id: "1", type: "delta", data: { delta: "a" } });
    await waitFor(() => expect(result.current.phase).toBe("streaming"));

    connection.emit({ id: "2", type: "done", data: {} });
    connection.close();
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(events).toEqual([
      { type: "delta", data: { delta: "a" }, id: "1" },
      { type: "done", data: {}, id: "2" },
    ]);
  });

  it("fails on a fatal HTTP error and retry() re-subscribes from scratch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchBoundary = installFetch([
      errorConnection(404, "gone"),
      doneConnection(),
    ]);

    const { result } = renderRun();
    await waitFor(() => expect(result.current.phase).toBe("failed"));
    expect(fetchBoundary.streamRequests()).toHaveLength(1);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(fetchBoundary.streamRequests()).toHaveLength(2);
    expect(fetchBoundary.tokenRequests()).toHaveLength(2);
    expect(fetchBoundary.streamRequests()[1].headers.authorization).toBe(
      "Bearer minted-2",
    );
  });

  it("abort() detaches cleanly and stops delivering events", async () => {
    const connection = controlledConnection();
    installFetch([connection.respond]);

    const { events, result } = renderRun();
    connection.emit({ id: "1", type: "delta", data: { delta: "a" } });
    await waitFor(() => expect(result.current.phase).toBe("streaming"));

    act(() => result.current.abort());
    await waitFor(() => expect(result.current.phase).toBe("idle"));

    connection.emit({ id: "2", type: "delta", data: { delta: "b" } });
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(1);
  });

  it("survives a strict-mode double mount with one live subscription", async () => {
    const connection = controlledConnection();
    const fetchBoundary = installFetch([connection.respond]);

    const { events, result } = renderRun(
      {},
      { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> },
    );

    connection.emit({ id: "1", type: "delta", data: { delta: "a" } });
    await waitFor(() => expect(result.current.phase).toBe("streaming"));
    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(events).toEqual([{ type: "delta", data: { delta: "a" }, id: "1" }]);

    connection.emit({ id: "2", type: "done", data: {} });
    connection.close();
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(events).toHaveLength(2);
  });

  it("keeps delivery ordered across a reconnect and resumes from the cursor", async () => {
    const first = controlledConnection();
    const second = controlledConnection();
    const fetchBoundary = installFetch([first.respond, second.respond]);

    const { events, result } = renderRun({ reconnect: FAST_RECONNECT });
    first.emit({ id: "1", type: "delta", data: { delta: "a" } });
    first.emit({ id: "2", type: "delta", data: { delta: "b" } });
    await waitFor(() => expect(events).toHaveLength(2));

    first.fail(new Error("connection reset"));
    await waitFor(() => expect(fetchBoundary.streamRequests()).toHaveLength(2));
    expect(fetchBoundary.streamRequests()[1].headers["last-event-id"]).toBe("2");

    second.emit({ id: "3", type: "delta", data: { delta: "c" } });
    second.emit({ id: "4", type: "done", data: {} });
    second.close();
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(events.map((event) => event.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("passes resume.lastEventId on the first connect", async () => {
    const fetchBoundary = installFetch([doneConnection()]);

    const { result } = renderRun({ resume: { lastEventId: "5" } });
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(fetchBoundary.streamRequests()[0].headers["last-event-id"]).toBe("5");
  });

  it("ends as done when onReconnect stops the stream cleanly", async () => {
    const connection = controlledConnection();
    connection.close();
    const fetchBoundary = installFetch([connection.respond]);

    const { events, result } = renderRun({
      reconnect: { ...FAST_RECONNECT, onReconnect: async () => "stop" },
    });
    await waitFor(() => expect(result.current.phase).toBe("done"));

    expect(fetchBoundary.streamRequests()).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it("returns to idle when the id becomes null", async () => {
    const connection = controlledConnection();
    installFetch([connection.respond]);

    const { result, rerender } = renderRun();
    connection.emit({ id: "1", type: "delta", data: { delta: "a" } });
    await waitFor(() => expect(result.current.phase).toBe("streaming"));

    rerender({ kind: "chat-runs", id: null, resume: undefined, reconnect: undefined });
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });
});
