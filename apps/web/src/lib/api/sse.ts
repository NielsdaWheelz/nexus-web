/**
 * SSE client parser for streaming LLM responses.
 *
 * Framing rules (binding per s3_pr07 §5.3):
 * 1. Only process `event:` + `data:` lines (standard SSE format).
 * 2. Ignore comment lines (`:`) and unknown event types.
 * 3. `data:` payload is JSON, one object per event. No multi-line JSON.
 * 4. Max event size: 256 KB. Exceeding this is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 * 6. Backend uses `event:` field to distinguish event types (meta, delta, done).
 * 7. Sets `Accept: text/event-stream` request header.
 *
 * Security:
 * - Never logs API key material from events.
 * - Fails fast on malformed events.
 */

/** Maximum single event payload size (256 KB). */
const MAX_EVENT_SIZE_BYTES = 256 * 1024;

// ============================================================================
// Types
// ============================================================================

/** SSE event types from the backend streaming protocol. */
export type SSEEventType = "meta" | "delta" | "done";

/** Meta event: initial IDs and model info. */
export interface SSEMetaEvent {
  type: "meta";
  data: {
    conversation_id: string;
    user_message_id: string;
    assistant_message_id: string;
    model_id: string;
    provider: string;
  };
}

/** Delta event: incremental content chunk. */
export interface SSEDeltaEvent {
  type: "delta";
  data: {
    delta: string;
  };
}

/** Done event: stream completion. */
export interface SSEDoneEvent {
  type: "done";
  data: {
    status: "complete" | "error";
    error_code: string | null;
  };
}

export type SSEEvent = SSEMetaEvent | SSEDeltaEvent | SSEDoneEvent;

/** Callback invoked for each parsed SSE event. */
export type SSEEventHandler = (event: SSEEvent) => void;

/** Error callback invoked on stream failures. */
export type SSEErrorHandler = (error: Error) => void;

// ============================================================================
// Request payload types
// ============================================================================

export interface ContextItem {
  type: "highlight" | "annotation" | "media";
  id: string;
}

export interface SendMessageRequest {
  content: string;
  model_id: string;
  key_mode?: "auto" | "byok_only" | "platform_only";
  contexts?: ContextItem[];
}

// ============================================================================
// SSE Client
// ============================================================================

/**
 * Send a message and parse the SSE response stream.
 *
 * @param url - The BFF endpoint URL (e.g., `/api/conversations/{id}/messages/stream`)
 * @param body - The send message request body
 * @param handlers - Event callbacks
 * @param options - Optional fetch options (signal for abort, idempotency key)
 * @returns Cleanup function to abort the stream
 */
export function sseClient(
  url: string,
  body: SendMessageRequest,
  handlers: {
    onEvent: SSEEventHandler;
    onError: SSEErrorHandler;
    onComplete?: () => void;
  },
  options?: {
    signal?: AbortSignal;
    idempotencyKey?: string;
  }
): () => void {
  const controller = new AbortController();
  const combinedSignal = options?.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  // Start the fetch + parse pipeline
  (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok) {
        // Non-streaming error — parse the JSON error body
        let errorMessage = `Request failed with status ${response.status}`;
        try {
          const errorBody = await response.json();
          if (errorBody?.error?.message) {
            errorMessage = errorBody.error.message;
          }
        } catch {
          // ignore parse failures on error body
        }
        handlers.onError(new Error(errorMessage));
        return;
      }

      if (!response.body) {
        handlers.onError(new Error("Response body is null"));
        return;
      }

      await parseSSEStream(response.body, handlers.onEvent, handlers.onError);
      handlers.onComplete?.();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Expected on user-initiated abort
        handlers.onComplete?.();
        return;
      }
      handlers.onError(
        err instanceof Error ? err : new Error("Unknown SSE error")
      );
    }
  })();

  // Return cleanup function
  return () => controller.abort();
}

// ============================================================================
// SSE Parser
// ============================================================================

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 *
 * Follows the SSE spec: events are separated by blank lines.
 * Each event has optional `event:` and required `data:` fields.
 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SSEEventHandler,
  onError: SSEErrorHandler
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          // Blank line = end of event
          if (currentData) {
            processEvent(currentEvent, currentData, onEvent, onError);
          }
          currentEvent = "";
          currentData = "";
          continue;
        }

        if (line.startsWith(":")) {
          // Comment line — ignore
          continue;
        }

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith("data:")) {
          const dataPayload = line.slice(5);
          // Trim leading space per SSE spec (one optional space after colon)
          currentData = dataPayload.startsWith(" ")
            ? dataPayload.slice(1)
            : dataPayload;

          // Enforce max event size
          if (currentData.length > MAX_EVENT_SIZE_BYTES) {
            onError(
              new Error(
                `SSE event exceeds maximum size of ${MAX_EVENT_SIZE_BYTES} bytes`
              )
            );
            reader.cancel();
            return;
          }
          continue;
        }

        // Unknown field — ignore per SSE spec
      }
    }

    // Process any remaining buffered event
    if (currentData) {
      processEvent(currentEvent, currentData, onEvent, onError);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Process a single SSE event: parse JSON data and dispatch typed event.
 */
function processEvent(
  eventType: string,
  data: string,
  onEvent: SSEEventHandler,
  onError: SSEErrorHandler
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    onError(new Error(`Failed to parse SSE data as JSON: ${data.slice(0, 100)}`));
    return;
  }

  switch (eventType) {
    case "meta":
      onEvent({ type: "meta", data: parsed as SSEMetaEvent["data"] });
      break;
    case "delta":
      onEvent({ type: "delta", data: parsed as SSEDeltaEvent["data"] });
      break;
    case "done":
      onEvent({ type: "done", data: parsed as SSEDoneEvent["data"] });
      break;
    default:
      // Unknown event type — ignore per spec
      break;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Combine two AbortSignals so that aborting either aborts the combined signal.
 */
function combineSignals(
  signal1: AbortSignal,
  signal2: AbortSignal
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
