/**
 * SSE wire-framing parser.
 *
 * Reads a `text/event-stream` body, splits it into events per the SSE spec
 * (blank-line-separated, `event:` and `data:` fields), parses each event's
 * `data:` payload as JSON, and dispatches it. Knows nothing about the
 * application's event shapes — that lives in sse.ts's `toChatSSEEvent`.
 *
 * Framing rules:
 * 1. Only `event:` + `data:` lines are interpreted; `id:` and `retry:` are also honored.
 * 2. Comment lines (starting with `:`) are ignored.
 * 3. `data:` payload is JSON; one object per event.
 * 4. Max event size: 256 KB. Exceeding it is a stream error.
 * 5. If JSON parse fails on a `data:` line: stream error.
 */

/** Maximum single event payload size (256 KB). */
const MAX_EVENT_SIZE_BYTES = 256 * 1024;

export interface SSEJsonEvent {
  id: string;
  type: string;
  data: unknown;
}

type SSEJsonEventHandler = (event: SSEJsonEvent) => void;
type SSERetryHandler = (milliseconds: number) => void;

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 *
 * Follows the SSE spec: events are separated by blank lines.
 * Each event has optional `event:` and required `data:` fields.
 */
export async function parseSSEJsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SSEJsonEventHandler,
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
      processJsonEvent(
        currentEvent,
        currentDataLines.join("\n"),
        currentId,
        onEvent,
      );
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
            `SSE event exceeds maximum size of ${MAX_EVENT_SIZE_BYTES} bytes`,
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

function processJsonEvent(
  eventType: string,
  data: string,
  id: string,
  onEvent: SSEJsonEventHandler,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(
      `Failed to parse SSE ${eventType || "message"} event (${data.length} bytes)`,
    );
  }

  onEvent({ id, type: eventType, data: parsed });
}
