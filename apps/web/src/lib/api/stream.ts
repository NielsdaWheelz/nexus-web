// Live streams (docs/modules/api-edge.md): one GET under /api/stream/ through
// the bff, resumed from the last accepted cursor after any cut (a network drop,
// the bff's planned cut before the platform's function limit). The server's
// committed state is the truth: a reconnect replays what was missed (cursor
// streams) or re-sends the whole snapshot (snapshot streams).
import { installedApp, remoteAdmission, remoteReady, subscribeAdmission } from "@/lib/native/admission";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  ApiError,
  captureApiAccount,
  isCurrentApiAccount,
  observeApiFailure,
  isApiError,
  isSameSystemApiDefect,
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
  /** `data` is the payload for `type`, validated by the same deploy before emission. */
  readonly decode: (type: string, data: P, id: string) => E;
  readonly isTerminal: (event: E) => boolean;
  readonly onEvent: (event: E) => void;
  /**
   * Once, final: a refusal, a bad event, a throwing consumer, or reconnects
   * spent. Installed admission failures pause this owner; hosted 401 also starts sign-in.
   */
  readonly onError: (error: Error) => void;
  /** Installed owners may show the real failure while the same cursor waits for admission. */
  readonly onSuspended: (error: ApiError) => void;
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
 * Opens one stream. Hosted 401 and every other 4xx but 429,
 * a non-event-stream answer, a malformed or oversized event and a throwing
 * decode or onEvent, and same-system api defects are final. Network failures,
 * modeled 5xx and 429 back off and reconnect; exhaustion retains the last
 * attempt's error. A clean end after an event (the planned cut) resumes at once; one
 * without an event counts as a failure. The cursor advances only after decode
 * and onEvent returned (I6). The returned function stops it; nothing fires
 * after a stop.
 */
export function openStream<E, P = unknown>(
  options: StreamOptions<E, P>,
): () => void {
  const account = captureApiAccount();
  const stop = new AbortController();
  const signal = stop.signal;
  const abort = () => stop.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const close = () => {
    options.signal?.removeEventListener("abort", abort);
    stop.abort();
  };
  const maxReconnects = options.maxReconnects ?? 8;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  let cursor = options.after ?? "";
  let terminal = false;
  let failures = 0;

  let suspended: ApiError | null = null;

  // Admission waits retain this stream's cursor and owner. They spend no
  // reconnect budget and submit no application command.
  const admitted = () => new Promise<void>(resolve => {
    if (remoteReady() || signal.aborted) return resolve();
    const show = () => {
      const admission = remoteAdmission();
      if (admission === "Checking" || admission === "Ready") return;
      if (suspended === null) {
        suspended = new ApiError(admission === "SignInRequired" ? 401 : admission === "UpdateRequired" ? 426 : 0,
          admission === "SignInRequired" ? "E_UNAUTHENTICATED" : admission === "UpdateRequired" ? "E_WIRE_MISMATCH" : "E_NETWORK",
          "live updates need a connection");
        options.onSuspended(suspended);
      }
    };
    const done = () => { unsubscribe(); signal.removeEventListener("abort", done); resolve(); };
    const unsubscribe = subscribeAdmission(() => { if (remoteReady()) done(); else show(); });
    signal.addEventListener("abort", done, { once: true });
    show();
  });

  // One connection; null after delivery, otherwise the detected empty-stream failure.
  const connect = async (): Promise<ApiError | null> => {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${options.path}${query}`, {
      headers: {
        Accept: "text/event-stream",
        [WIRE_HEADER]: String(WIRE_REVISION),
        ...(account === null ? {} : { "X-Nexus-Account": account.accountId }),
      },
      signal,
    });
    if (!response.ok) {
      const error = await readResponse<never>(response).catch(asError);
      observeApiFailure(error, account);
      const transient =
        isApiError(error) && !isSameSystemApiDefect(error) &&
        (error.status === 0 || error.status >= 500 || error.status === 429);
      throw transient ? error : new Fatal(error);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("text/event-stream") || !response.body) {
      throw new Fatal(new Error("Not an event stream"));
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    let delivered = false;
    try {
      await readEvents(response.body, (id, type, data) => {
        if (signal.aborted || !isCurrentApiAccount(account)) return true;
        try {
          // justify-type-assertion: the same deploy validated this event's public payload.
          const event = options.decode(type, data as P, id);
          suspended = null;
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
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ApiError(0, "E_NETWORK", "Stream lost", requestId);
      }
      throw error;
    }
    return delivered ? null : new ApiError(0, "E_NETWORK", "Stream lost", requestId);
  };

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      let failure: ApiError;
      try {
        await admitted();
        if (signal.aborted || !isCurrentApiAccount(account)) return;
        const empty = await connect();
        if (terminal) return options.onComplete?.();
        if (empty === null) {
          await jittered(PLANNED_CUT_RESUME_MS);
          continue;
        }
        failure = empty;
      } catch (error) {
        if (signal.aborted || !isCurrentApiAccount(account)) return;
        if (error instanceof Fatal) {
          const reason = error.reason;
          if (installedApp && isApiError(reason) && (reason.status === 401 || reason.status === 426)) {
            handleUnauthenticatedApiError(reason);
            suspended = reason;
            options.onSuspended(reason);
            continue;
          }
          handleUnauthenticatedApiError(reason);
          return options.onError(reason);
        }
        if (!isApiError(error) && !(error instanceof TypeError)) {
          return options.onError(asError(error));
        }
        failure = isApiError(error) ? error : new ApiError(0, "E_NETWORK", "Stream lost");
        if (installedApp && failure.status === 0) {
          observeApiFailure(failure, account);
          suspended = failure;
          options.onSuspended(failure);
          continue;
        }
      }
      if (failures >= maxReconnects) {
        return options.onError(failure);
      }
      failures += 1;
      options.onReconnect?.(failures);
      await jittered(Math.min(1000 * 2 ** (failures - 1), maxBackoffMs));
    }
  };
  // a final callback closes any connection still open
  void run().finally(close);
  return close;
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
