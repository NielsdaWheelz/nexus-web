import { isAbortError } from "@/lib/errors";
import { parseSSEJsonStream } from "./sse-stream";
import { fetchStreamToken } from "./streamToken";

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";

/** Reconnect backoff shape: jittered exponential from baseMs, capped at maxMs. */
export interface SseBackoffConfig {
  baseMs: number;
  maxMs: number;
  jitterMs: number;
}

const DEFAULT_BACKOFF: SseBackoffConfig = {
  baseMs: 1000,
  maxMs: 30000,
  jitterMs: 250,
};

/**
 * Generic browser→FastAPI SSE client. Owns connect/reconnect, the stream-token
 * flow, abort, content-type validation, and `Last-Event-ID` resumption. Caller
 * supplies the URL and a typed event decoder.
 *
 * Token flow: stream tokens are single-use JTI — reusing one returns
 * E_STREAM_TOKEN_REPLAYED — so every connect needs a fresh token. The client
 * mints them itself via `fetchStreamToken`; `initialToken` hands over an
 * already-minted token for the first connect (the stream-token POST also
 * carries the stream base URL, so callers mint once while building `url`).
 *
 * Reconnect policy: network failures, HTTP 401/5xx, mid-stream interruptions,
 * and a clean EOF without a terminal event all reconnect with backoff, capped
 * at `maxReconnects` consecutive failures (any delivered event resets the
 * count). Other HTTP errors and malformed-stream errors are fatal (`onError`,
 * no retry). `onReconnect` fires before each backoff; resolving `"stop"` ends
 * the stream cleanly (`onComplete`, no error).
 */
export function sseClientDirect<TEvent>(args: {
  url: string;
  /** Already-minted token for the first connect; later connects mint fresh ones. */
  initialToken?: string;
  /** Token source override; defaults to the stream-token POST. */
  streamToken?: () => Promise<string>;
  decode: (type: string, data: unknown, id: string) => TEvent;
  isTerminal: (event: TEvent) => boolean;
  onEvent: (event: TEvent) => void;
  onError: (err: Error) => void;
  onComplete?: (terminalEventSeen: boolean) => void;
  onLastEventId?: (id: string) => void;
  /** Fired before each reconnect backoff; resolve "stop" to end cleanly. */
  onReconnect?: (attempt: number) => Promise<"continue" | "stop">;
  signal?: AbortSignal;
  lastEventId?: string;
  maxReconnects?: number;
  backoff?: SseBackoffConfig;
}): () => void {
  const {
    url,
    initialToken,
    streamToken = async () => (await fetchStreamToken()).token,
    decode,
    isTerminal,
    onEvent,
    onError,
    onComplete,
    onLastEventId,
    onReconnect,
    signal,
    lastEventId: initialLastEventId,
    maxReconnects = 8,
    backoff = DEFAULT_BACKOFF,
  } = args;

  const controller = new AbortController();
  const combinedSignal = signal
    ? combineSignals(signal, controller.signal)
    : controller.signal;

  let lastEventId = initialLastEventId ?? "";
  let reconnectDelayMs = backoff.baseMs;
  let reconnects = 0;
  let pendingInitialToken = initialToken ?? null;

  const nextToken = async (): Promise<string> => {
    if (pendingInitialToken !== null) {
      const token = pendingInitialToken;
      pendingInitialToken = null;
      return token;
    }
    return streamToken();
  };

  (async () => {
    let terminalEventSeen = false;

    // Recoverable-failure funnel: count the failure against `maxReconnects`,
    // consult `onReconnect`, then sleep the jittered backoff. Returns true
    // when the connect loop should retry; on false the run is over and
    // exactly one of onError/onComplete has fired.
    const scheduleReconnect = async (err: Error): Promise<boolean> => {
      if (reconnects >= maxReconnects) {
        onError(err);
        return false;
      }
      reconnects += 1;
      if (onReconnect) {
        let decision: "continue" | "stop";
        try {
          decision = await onReconnect(reconnects);
        } catch (callbackErr) {
          onError(
            callbackErr instanceof Error
              ? callbackErr
              : new Error("SSE onReconnect callback failed"),
          );
          return false;
        }
        if (decision === "stop") {
          onComplete?.(terminalEventSeen);
          return false;
        }
      }
      await delay(
        Math.max(
          0,
          Math.round(
            reconnectDelayMs + (Math.random() * 2 - 1) * backoff.jitterMs,
          ),
        ),
      );
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, backoff.maxMs);
      return true;
    };

    while (!combinedSignal.aborted && !terminalEventSeen) {
      let response: Response;
      try {
        const token = await nextToken();
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
        if (isAbortError(err) || combinedSignal.aborted) break;
        if (
          await scheduleReconnect(
            err instanceof Error ? err : new Error("SSE connection failed"),
          )
        ) {
          continue;
        }
        return;
      }

      if (!response.ok) {
        const failure = new Error(await errorResponseMessage(response));
        // 401 means the single-use token was replayed or expired — a fresh
        // token clears it — and 5xx is transient by definition. Every other
        // status (400/403/404/…) is an addressing or permission bug: fatal.
        if (response.status === 401 || response.status >= 500) {
          if (await scheduleReconnect(failure)) continue;
          return;
        }
        onError(failure);
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

      try {
        await parseSSEJsonStream(
          response.body,
          (jsonEvent) => {
            if (jsonEvent.id) {
              lastEventId = jsonEvent.id;
              onLastEventId?.(lastEventId);
            }
            const event = decode(jsonEvent.type, jsonEvent.data, jsonEvent.id);
            onEvent(event);
            reconnects = 0;
            reconnectDelayMs = backoff.baseMs;
            if (isTerminal(event)) terminalEventSeen = true;
          },
          (milliseconds) => {
            // Server `retry:` directive: it becomes the next backoff base and
            // exponential growth resumes from there.
            reconnectDelayMs = milliseconds;
          },
        );
      } catch (err) {
        if (isAbortError(err) || combinedSignal.aborted || terminalEventSeen) {
          break;
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
        if (
          await scheduleReconnect(
            err instanceof Error ? err : new Error("SSE stream interrupted"),
          )
        ) {
          continue;
        }
        return;
      }

      if (terminalEventSeen) break;

      // Clean EOF without a terminal event: the server (or a proxy) closed
      // the stream early. Resume from lastEventId instead of stalling.
      if (
        await scheduleReconnect(
          new Error("SSE stream ended before terminal event"),
        )
      ) {
        continue;
      }
      return;
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

async function errorResponseMessage(response: Response): Promise<string> {
  try {
    const errorBody = await response.json();
    if (errorBody?.error?.message) return errorBody.error.message;
  } catch {
    // justify-ignore-error: error bodies are optional; the HTTP status fallback is enough.
  }
  return `Request failed with status ${response.status}`;
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
