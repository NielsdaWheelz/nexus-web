import { ApiError } from "./client";
import { isAbortError } from "@/lib/errors";

/** The caller validates status and media type; allocation never exceeds its byte budget. */
export async function readBoundedResponseBytes(response: Response, signal: AbortSignal, maxBytes: number, expectedBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Response byte budget must be configured");
  const invalid = (message: string) => new ApiError(response.status, "E_INVALID_RESPONSE", message, response.headers.get("x-request-id") ?? undefined);
  const lengthText = response.headers.get("content-length");
  const length = lengthText !== null && /^(0|[1-9][0-9]*)$/.test(lengthText) ? Number(lengthText) : NaN;
  if (!Number.isSafeInteger(length) || length > maxBytes || response.body === null ||
      (expectedBytes !== undefined && expectedBytes !== length)) {
    await response.body?.cancel().catch(() => undefined);
    throw invalid("Response violates its byte-length contract");
  }
  if (signal.aborted) {
    await response.body.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  const bytes = new Uint8Array(length);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ApiError(0, "E_NETWORK", "Response stream failed");
      }
      if (part.done) break;
      if (offset + part.value.byteLength > length) throw invalid("Response exceeds its declared byte length");
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== length) throw invalid("Response is incomplete");
  } finally {
    // A failed stream can also reject cancellation; retain its original failure.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return bytes;
}
