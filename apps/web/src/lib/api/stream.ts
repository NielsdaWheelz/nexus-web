// Live streams (docs/modules/api-edge.md): one GET under /api/stream/ through
// the bff, resumed from the last accepted cursor after any cut (a network drop,
// the bff's planned cut before the platform's function limit). The server's
// committed state is the truth: a reconnect replays what was missed (cursor
// streams) or re-sends the whole snapshot (snapshot streams).
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  ApiError,
  isApiError,
  readResponse,
  WIRE_HEADER,
  type ApiPath,
} from "./client";
import { WIRE_REVISION } from "./wire.gen";

const MAX_EVENT_CHARS = 256 * 1024;
const PLANNED_CUT_RESUME_MS = 250;

export interface StreamOptions<E, P = unknown> {
  /** A route under /api/stream/. */
  readonly path: ApiPath;
  /** Resume after this event id (cursor streams). */
  readonly after?: string;
  /** `data` is the server's payload for `type`, as the same deploy wrote it. */
  readonly decode: (type: string, data: P, id: string) => E;
  readonly isTerminal: (event: E) => boolean;
  readonly onEvent: (event: E) => void;
  /**
   * Once, final: a refusal, a bad event, a throwing consumer, or reconnects
   * spent. A 401 sends the tab to login instead.
   */
  readonly onError: (error: Error) => void;
  /** Once, final: the terminal event arrived. */
  readonly onComplete?: () => void;
  /** Before each wait after a failed connection (not after a planned cut). */
  readonly onReconnect?: (attempt: number) => void;
  readonly signal?: AbortSignal;
  /** Consecutive failed connections before onError; a delivered event resets the count. */
  readonly maxReconnects?: number;
  readonly maxBackoffMs?: number;
}

/** A failure no reconnect can mend. */
class Fatal extends Error {
  constructor(readonly reason: Error) {
    super(reason.message);
  }
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const jittered = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms * (0.75 + Math.random() * 0.5)),
  );

/**
 * Opens one stream. 401 (the tab goes to login) and every other 4xx but 429,
 * a non-event-stream answer, a malformed or oversized event and a throwing
 * decode or onEvent are final. Network failures, 5xx and 429 back off and
 * reconnect. A clean end after an event (the planned cut) resumes at once; one
 * without an event counts as a failure. The cursor advances only after decode
 * and onEvent returned (I6). The returned function stops it; nothing fires
 * after a stop.
 */
export function openStream<E, P = unknown>(
  options: StreamOptions<E, P>,
): () => void {
  const stop = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stop.signal])
    : stop.signal;
  const maxReconnects = options.maxReconnects ?? 8;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let cursor = options.after ?? "";
  let terminal = false;
  let failures = 0;

  // One connection; true when it delivered an event.
  const connect = async (): Promise<boolean> => {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${options.path}${query}`, {
      headers: {
        Accept: "text/event-stream",
        [WIRE_HEADER]: String(WIRE_REVISION),
      },
      signal,
    });
    if (!response.ok) {
      const error = await readResponse<never>(response).catch(asError);
      const transient =
        isApiError(error) && (error.status >= 500 || error.status === 429);
      throw transient ? error : new Fatal(error);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("text/event-stream") || !response.body) {
      throw new Fatal(new Error("Not an event stream"));
    }
    let delivered = false;
    await readEvents(response.body, (id, type, data) => {
      if (signal.aborted) return true;
      try {
        // justify-type-assertion: the same deploy wrote this event's payload.
        const event = options.decode(type, data as P, id);
        options.onEvent(event);
        terminal = options.isTerminal(event);
      } catch (error) {
        throw new Fatal(asError(error));
      }
      if (id) cursor = id;
      delivered = true;
      failures = 0;
      return terminal;
    });
    return delivered;
  };

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        const delivered = await connect();
        if (terminal) return options.onComplete?.();
        if (delivered) {
          await jittered(PLANNED_CUT_RESUME_MS);
          continue;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Fatal) {
          if (handleUnauthenticatedApiError(error.reason)) return;
          return options.onError(error.reason);
        }
        if (!isApiError(error) && !(error instanceof TypeError)) {
          return options.onError(asError(error));
        }
      }
      if (failures >= maxReconnects) {
        return options.onError(new ApiError(0, "E_NETWORK", "Stream lost"));
      }
      failures += 1;
      options.onReconnect?.(failures);
      await jittered(Math.min(1000 * 2 ** (failures - 1), maxBackoffMs));
    }
  };
  // a final callback closes any connection still open
  void run().finally(() => stop.abort());
  return () => stop.abort();
}

/**
 * The text/event-stream framing: `id:`, `event:` and `data:` (json, at most
 * 256 K characters per event); comments and other fields are ignored.
 * `onEvent` answers true to stop reading.
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (id: string, type: string, data: unknown) => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let type = "";
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const text = buffer + decoder.decode(value, { stream: true });
      const lines = text.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      if (buffer.length > MAX_EVENT_CHARS) throw tooLarge();
      for (const line of lines) {
        if (line === "") {
          const stopReading =
            data.length > 0 && onEvent(id, type, parse(data.join("\n"), type));
          [id, type, data, size] = ["", "", [], 0];
          if (stopReading) return;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const content =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = content;
        else if (field === "event") type = content;
        else if (field === "data") {
          size += content.length + 1;
          if (size > MAX_EVENT_CHARS) throw tooLarge();
          data.push(content);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const tooLarge = () => new Fatal(new Error("Stream event too large"));

function parse(json: string, type: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Fatal(new Error(`Malformed ${type || "message"} event`));
  }
}
