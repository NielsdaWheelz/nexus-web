import { isAbortError } from "@/lib/errors";
import { parseSSEJsonStream } from "./sse-stream";

const RECONNECT_DELAY_MS = 1000;
const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

/**
 * Generic browser→FastAPI SSE client. Owns reconnect, token-getter, abort,
 * content-type validation, and `Last-Event-ID` resumption. Caller supplies
 * the URL, a fresh-token getter, and a typed event decoder.
 *
 * The token getter is called every connect (including reconnects). Stream
 * tokens are single-use JTI — reusing one returns E_STREAM_TOKEN_REPLAYED, so
 * the getter must mint a fresh token each call.
 */
export function sseClientDirect<TEvent>(args: {
  url: string;
  streamToken: () => Promise<string>;
  decode: (type: string, data: unknown) => TEvent;
  isTerminal: (event: TEvent) => boolean;
  onEvent: (event: TEvent) => void;
  onError: (err: Error) => void;
  onComplete?: (terminalEventSeen: boolean) => void;
  onLastEventId?: (id: string) => void;
  signal?: AbortSignal;
  lastEventId?: string;
}): () => void {
  const {
    url,
    streamToken,
    decode,
    isTerminal,
    onEvent,
    onError,
    onComplete,
    onLastEventId,
    signal,
    lastEventId: initialLastEventId,
  } = args;

  const controller = new AbortController();
  const combinedSignal = signal
    ? combineSignals(signal, controller.signal)
    : controller.signal;

  let lastEventId = initialLastEventId ?? "";
  let reconnectDelayMs = RECONNECT_DELAY_MS;

  (async () => {
    let terminalEventSeen = false;

    while (!combinedSignal.aborted && !terminalEventSeen) {
      let response: Response;
      try {
        const token = await streamToken();
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
          onComplete?.(terminalEventSeen);
          return;
        }
        // Exponential backoff with ±20% jitter, capped at 30s. Transport
        // failures (fetch throws) are the runaway-retry surface — e.g. CORS
        // misconfigs that fail every attempt — so each consecutive failure
        // doubles the base before the next try. The base is reset on a
        // successful open below; server `retry:` directives override the base
        // and exponential growth resumes from that value.
        await delay(
          Math.round(reconnectDelayMs * (0.8 + Math.random() * 0.4)),
        );
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
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
        onError(new Error(errorMessage));
        return;
      }

      if (!isEventStreamResponse(response)) {
        onError(new Error("Invalid SSE content type"));
        return;
      }

      if (!response.body) {
        onError(new Error("Response body is null"));
        return;
      }

      // Stream is open with a valid content-type; reset the transport-failure
      // backoff baseline so the next consecutive transport failure starts at
      // 1s again. A server-side `retry:` directive may overwrite this during
      // streaming via the callback below.
      reconnectDelayMs = RECONNECT_DELAY_MS;

      try {
        await parseSSEJsonStream(
          response.body,
          (jsonEvent) => {
            if (jsonEvent.id) {
              lastEventId = jsonEvent.id;
              onLastEventId?.(lastEventId);
            }
            const event = decode(jsonEvent.type, jsonEvent.data);
            onEvent(event);
            if (isTerminal(event)) terminalEventSeen = true;
          },
          (milliseconds) => {
            reconnectDelayMs = milliseconds;
          },
        );
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted) {
          onComplete?.(terminalEventSeen);
          return;
        }
        if (
          err instanceof Error &&
          (err.message.startsWith("SSE event exceeds maximum size") ||
            err.message.startsWith("Failed to parse SSE ") ||
            err.message.startsWith("Invalid SSE payload") ||
            err.message.startsWith("Unknown SSE event type"))
        ) {
          onError(err);
          return;
        }
        // Mid-stream failure: honor the current base exactly (it may be a
        // server `retry:` override that the server expects us to respect to
        // the millisecond), then grow it so a subsequent failure backs off.
        await delay(reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
        continue;
      }

      break;
    }

    onComplete?.(terminalEventSeen);
  })().catch((err) => {
    if (isAbortError(err)) {
      onComplete?.(false);
      return;
    }
    onError(err instanceof Error ? err : new Error("Unknown SSE error"));
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
