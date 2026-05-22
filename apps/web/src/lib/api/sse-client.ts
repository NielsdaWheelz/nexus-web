import { isAbortError } from "@/lib/errors";
import { toChatSSEEvent, type SSEEvent } from "./sse";
import { parseSSEJsonStream } from "./sse-stream";

const RECONNECT_DELAY_MS = 1000;
const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

type SSEEventHandler = (event: SSEEvent) => void;
type SSEErrorHandler = (error: Error) => void;
type SSECompleteHandler = (terminalEventSeen: boolean) => void;

/**
 * Streams a chat run's SSE events from the FastAPI backend directly into the
 * caller's handlers. Manages its own AbortController, reconnects on transport
 * errors with the server-provided retry interval, and terminates on a `done`
 * event or external abort.
 *
 * @param streamBaseUrl - Base URL of the FastAPI stream endpoint
 * @param streamToken - Bearer token (or a getter that returns one)
 * @param runId - Chat run ID returned by POST /api/chat-runs
 * @param handlers - Event callbacks
 * @param options - Optional fetch options
 * @returns Cleanup function to abort the stream
 */
export function sseClientDirect(
  streamBaseUrl: string,
  streamToken: string | (() => Promise<string>),
  runId: string,
  handlers: {
    onEvent: SSEEventHandler;
    onError: SSEErrorHandler;
    onComplete?: SSECompleteHandler;
    onLastEventId?: (id: string) => void;
  },
  options?: {
    signal?: AbortSignal;
    lastEventId?: string;
  },
): () => void {
  const controller = new AbortController();
  const combinedSignal = options?.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const url = `${streamBaseUrl}/chat-runs/${runId}/events`;
  let lastEventId = options?.lastEventId ?? "";
  let reconnectDelayMs = RECONNECT_DELAY_MS;

  (async () => {
    let terminalEventSeen = false;

    while (!combinedSignal.aborted && !terminalEventSeen) {
      let response: Response;
      try {
        const token =
          typeof streamToken === "function" ? await streamToken() : streamToken;
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        };
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;

        response = await fetch(url, {
          method: "GET",
          headers,
          signal: combinedSignal,
        });
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted) {
          handlers.onComplete?.(terminalEventSeen);
          return;
        }
        await delay(reconnectDelayMs);
        continue;
      }

      if (!response.ok) {
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorBody = await response.json();
          if (errorBody?.error?.message) {
            errorMessage = errorBody.error.message;
          }
        } catch {
          // justify-ignore-error: error bodies are optional; the HTTP status fallback is enough.
        }
        handlers.onError(new Error(errorMessage));
        return;
      }

      if (!isEventStreamResponse(response)) {
        handlers.onError(new Error("Invalid SSE content type"));
        return;
      }

      if (!response.body) {
        handlers.onError(new Error("Response body is null"));
        return;
      }

      try {
        await parseSSEJsonStream(
          response.body,
          (jsonEvent) => {
            if (jsonEvent.id) {
              lastEventId = jsonEvent.id;
              handlers.onLastEventId?.(lastEventId);
            }
            const event = toChatSSEEvent(jsonEvent.type, jsonEvent.data);
            handlers.onEvent(event);
            if (event.type === "done") terminalEventSeen = true;
          },
          (milliseconds) => {
            reconnectDelayMs = milliseconds;
          },
        );
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted) {
          handlers.onComplete?.(terminalEventSeen);
          return;
        }
        if (
          err instanceof Error &&
          (err.message.startsWith("SSE event exceeds maximum size") ||
            err.message.startsWith("Failed to parse SSE ") ||
            err.message.startsWith("Invalid SSE payload") ||
            err.message.startsWith("Unknown SSE event type"))
        ) {
          handlers.onError(err);
          return;
        }
        await delay(reconnectDelayMs);
        continue;
      }

      break;
    }

    handlers.onComplete?.(terminalEventSeen);
  })().catch((err) => {
    if (isAbortError(err)) {
      handlers.onComplete?.(false);
      return;
    }
    handlers.onError(
      err instanceof Error ? err : new Error("Unknown SSE error"),
    );
  });

  return () => controller.abort();
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() ===
    EVENT_STREAM_CONTENT_TYPE
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Combine two AbortSignals so that aborting either aborts the combined signal.
function combineSignals(
  signal1: AbortSignal,
  signal2: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (signal1.aborted || signal2.aborted) {
    controller.abort();
    return controller.signal;
  }

  signal1.addEventListener("abort", abort, { once: true });
  signal2.addEventListener("abort", abort, { once: true });

  return controller.signal;
}
