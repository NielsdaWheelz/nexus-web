/**
 * SSE parser and direct browser -> FastAPI chat-run stream client.
 *
 * Framing rules:
 * 1. Only process `event:` + `data:` lines.
 * 2. Ignore comment lines (`:`) and unknown event types.
 * 3. `data:` payload is JSON, one object per event.
 * 4. Max event size: 256 KB. Exceeding this is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 */

/** Maximum single event payload size (256 KB). */
const MAX_EVENT_SIZE_BYTES = 256 * 1024;
const RECONNECT_DELAY_MS = 1000;

// ============================================================================
// Types
// ============================================================================

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
    status: "complete" | "error" | "cancelled";
    error_code: string | null;
    final_chars?: number;
  };
}

export interface SearchCitationEventData {
  result_type:
    | "media"
    | "podcast"
    | "fragment"
    | "annotation"
    | "message"
    | "transcript_chunk";
  source_id: string;
  title: string;
  source_label: string | null;
  snippet: string;
  deep_link: string;
  context_ref: { type: string; id: string };
  media_id: string | null;
  media_kind: string | null;
  score: number | null;
  selected: boolean;
}

export interface WebCitationEventData {
  assistant_message_id?: string;
  tool_call_id?: string | null;
  tool_call_index?: number | null;
  citation_index?: number;
  index?: number;
  result_ref?: string;
  result_type?: "web" | "news" | "mixed" | string;
  title: string;
  url: string;
  display_url?: string | null;
  source_name?: string | null;
  snippet?: string | null;
  excerpt?: string | null;
  provider?: string | null;
  provider_request_id?: string | null;
  selected?: boolean;
}

export type CitationEventData = SearchCitationEventData | WebCitationEventData;

export interface SSEToolCallEvent {
  type: "tool_call";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: "app_search" | "web_search" | string;
    tool_call_index: number;
    status: "started" | "pending" | "complete" | "error" | string;
    scope?: string;
    types?: string[];
    semantic?: boolean;
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
}

export interface SSEToolResultEvent {
  type: "tool_result";
  data: {
    tool_call_id?: string | null;
    assistant_message_id: string;
    tool_name: "app_search" | "web_search" | string;
    tool_call_index: number;
    status: "complete" | "error" | "skipped" | string;
    error_code?: string | null;
    result_count: number;
    selected_count: number;
    latency_ms: number;
    citations: CitationEventData[];
  };
}

export interface SSECitationEvent {
  type: "citation";
  data: WebCitationEventData;
}

export type SSEEvent =
  | SSEMetaEvent
  | SSEDeltaEvent
  | SSEDoneEvent
  | SSEToolCallEvent
  | SSEToolResultEvent
  | SSECitationEvent;

type SSEEventHandler = (event: SSEEvent) => void;
type SSEErrorHandler = (error: Error) => void;
type SSEEventIdHandler = (id: string) => void;
type SSECompleteHandler = (terminalEventSeen: boolean) => void;
type SSERetryHandler = (milliseconds: number) => void;

// ============================================================================
// Request payload types
// ============================================================================

export interface ContextItem {
  type: "highlight" | "annotation" | "media";
  id: string;
  /** Display fields carried by the caller when available. */
  color?: "yellow" | "green" | "blue" | "pink" | "purple";
  preview?: string;
  mediaId?: string;
  mediaTitle?: string;
  exact?: string;
  prefix?: string;
  suffix?: string;
  annotationBody?: string;
  mediaKind?: string;
}

/**
 * Strip client-side enriched fields from a ContextItem before sending to the API.
 * Only keeps the wire-format fields that the backend expects.
 */
export type ChatRunContext = Pick<
  ContextItem,
  "type" | "id" | "color" | "preview" | "exact" | "mediaId" | "mediaTitle"
>;

export function toWireContextItem(
  item: ContextItem,
): ChatRunContext {
  return {
    type: item.type,
    id: item.id,
    ...(item.color !== undefined && { color: item.color }),
    ...(item.preview !== undefined && { preview: item.preview }),
    ...(item.exact !== undefined && { exact: item.exact }),
    ...(item.mediaId !== undefined && { mediaId: item.mediaId }),
    ...(item.mediaTitle !== undefined && { mediaTitle: item.mediaTitle }),
  };
}

export interface ChatRunCreateRequest {
  content: string;
  model_id: string;
  reasoning: "default" | "none" | "minimal" | "low" | "medium" | "high" | "max";
  key_mode?: "auto" | "byok_only" | "platform_only";
  contexts?: ChatRunContext[];
  web_search: {
    mode: "off" | "auto" | "required";
    freshness_days?: number | null;
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
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
  onError: SSEErrorHandler,
  onEventId: SSEEventIdHandler,
  onRetry: SSERetryHandler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentId = "";
  let currentEvent = "";
  let currentDataLines: string[] = [];
  let currentDataBytes = 0;
  const textEncoder = new TextEncoder();

  const dispatchEvent = () => {
    if (currentDataLines.length > 0) {
      processEvent(currentEvent, currentDataLines.join("\n"), onEvent, onError);
      if (currentId) onEventId(currentId);
    }
    currentId = "";
    currentEvent = "";
    currentDataLines = [];
    currentDataBytes = 0;
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatchEvent();
      return;
    }

    if (line.startsWith(":")) {
      // Comment line — ignore
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "id":
        currentId = value;
        break;
      case "event":
        currentEvent = value;
        break;
      case "data": {
        const valueBytes = textEncoder.encode(value).byteLength;
        const newlineBytes = currentDataLines.length > 0 ? 1 : 0;
        currentDataBytes += valueBytes + newlineBytes;
        if (currentDataBytes > MAX_EVENT_SIZE_BYTES) {
          throw new Error(
            `SSE event exceeds maximum size of ${MAX_EVENT_SIZE_BYTES} bytes`
          );
        }
        currentDataLines.push(value);
        break;
      }
      case "retry":
        if (/^\d+$/.test(value)) {
          onRetry(Number(value));
        }
        break;
      default:
        // Unknown field — ignore per SSE spec
        break;
    }
  };

  const processBufferedLines = (flush: boolean) => {
    let start = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];
      if (char !== "\n" && char !== "\r") continue;

      if (char === "\r" && i + 1 === buffer.length && !flush) {
        break;
      }

      processLine(buffer.slice(start, i));

      if (char === "\r" && buffer[i + 1] === "\n") {
        i += 1;
      }
      start = i + 1;
    }

    buffer = buffer.slice(start);

    if (flush && buffer !== "") {
      processLine(buffer);
      buffer = "";
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      processBufferedLines(false);
    }

    buffer += decoder.decode();
    processBufferedLines(true);
    dispatchEvent();
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
    case "tool_call":
      onEvent({ type: "tool_call", data: parsed as SSEToolCallEvent["data"] });
      break;
    case "tool_result":
      onEvent({ type: "tool_result", data: parsed as SSEToolResultEvent["data"] });
      break;
    case "citation":
      onEvent({ type: "citation", data: parsed as SSECitationEvent["data"] });
      break;
    default:
      // Unknown event type — ignore per spec
      break;
  }
}

// ============================================================================
// Direct-to-FastAPI Chat Run SSE Client
// ============================================================================

/**
 * Tail a durable chat run via direct browser -> FastAPI SSE using a stream token.
 *
 * @param streamBaseUrl - The fastapi base URL for streaming
 * @param streamToken - The short-lived stream JWT, or a supplier that mints one per reconnect
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
  },
  options?: {
    signal?: AbortSignal;
    lastEventId?: string;
  }
): () => void {
  const controller = new AbortController();
  const combinedSignal = options?.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  const url = `${streamBaseUrl}/stream/chat-runs/${runId}/events`;
  let lastEventId = options?.lastEventId ?? "";
  let reconnectDelayMs = RECONNECT_DELAY_MS;

  // Start the fetch + parse pipeline
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
          // ignore parse failures
        }
        handlers.onError(new Error(errorMessage));
        return;
      }

      if (!response.body) {
        handlers.onError(new Error("Response body is null"));
        return;
      }

      let streamError: Error | null = null;
      try {
        await parseSSEStream(
          response.body,
          (event) => {
            handlers.onEvent(event);
            if (event.type === "done") terminalEventSeen = true;
          },
          (error) => {
            streamError = error;
          },
          (id) => {
            lastEventId = id;
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
          err.message.startsWith("SSE event exceeds maximum size")
        ) {
          handlers.onError(err);
          return;
        }
        await delay(reconnectDelayMs);
        continue;
      }

      if (streamError) {
        handlers.onError(streamError);
        return;
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
        err instanceof Error ? err : new Error("Unknown SSE error")
      );
    });

  return () => controller.abort();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
