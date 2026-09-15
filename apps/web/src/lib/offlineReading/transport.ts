import type { ReadingCommand } from "./contract";
import { parseStrictJsonValue } from "./packageContract";

interface WebKitReadingPort {
  postMessage(message: string): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

type OfflineReadingWindow = Window & {
  nexusOfflineReading?: WebKitReadingPort;
};

/** Both bridge halves enforce the same 64-KiB frame bound. */
const OFFLINE_READING_MAX_FRAME_BYTES = 64 * 1024;

export interface OfflineReadingTransport {
  /**
   * `onDefect` receives every framing failure the transport cannot deliver as a
   * message: a non-string frame, an oversized frame, or JSON the strict parser
   * rejects. A framing failure is never swallowed and never delivered as if it
   * were a message.
   */
  readonly start: (
    listener: (message: unknown) => void,
    onDefect: (error: Error) => void,
  ) => () => void;
  readonly send: (command: ReadingCommand) => void;
}

function frameByteLength(frame: string): number {
  return new TextEncoder().encode(frame).length;
}

export function createWebKitOfflineReadingTransport(
  target: Pick<OfflineReadingWindow, "nexusOfflineReading"> | undefined =
    typeof window === "undefined" ? undefined : (window as OfflineReadingWindow),
): OfflineReadingTransport | null {
  const port = target?.nexusOfflineReading;
  if (port === undefined) return null;
  return {
    start(listener, onDefect) {
      const receive = (event: { readonly data: unknown }) => {
        if (typeof event.data !== "string") {
          onDefect(new TypeError("Offline reading frame is not strict JSON text"));
          return;
        }
        if (frameByteLength(event.data) > OFFLINE_READING_MAX_FRAME_BYTES) {
          onDefect(new TypeError("Offline reading frame exceeds the 64-KiB bound"));
          return;
        }
        let parsed: unknown;
        try {
          parsed = parseStrictJsonValue(event.data);
        } catch (error) {
          onDefect(
            error instanceof Error
              ? error
              : new TypeError("Offline reading frame is not strict JSON"),
          );
          return;
        }
        listener(parsed);
      };
      port.onmessage = receive;
      return () => {
        if (port.onmessage === receive) port.onmessage = null;
      };
    },
    send(command) {
      const frame = JSON.stringify(command);
      if (frameByteLength(frame) > OFFLINE_READING_MAX_FRAME_BYTES) {
        throw new TypeError("Offline reading command exceeds the 64-KiB bound");
      }
      port.postMessage(frame);
    },
  };
}
