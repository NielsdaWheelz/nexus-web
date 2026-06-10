/**
 * SSE decoder for the library-intelligence revision stream.
 *
 * The backend emits three event kinds over `/stream/library-intelligence/{revision_id}/events`:
 *   - `meta`     once on subscribe: `{revision_id, library_id}`
 *   - `progress` optional human-readable build progress: `{message, stage?}`
 *   - `done`     terminal: `{status, error_code, revision_id}` (`error_code` set on failure)
 *
 * Mirrors `toChatSSEEvent`: each branch validates its payload with field guards
 * (json-values.md) and throws on a malformed payload so the SSE client surfaces
 * a stream error rather than silently dropping the event.
 */

import { isRecord } from "@/lib/validation";
import { isOptionalString } from "@/lib/api/sse/guards";

interface LiMetaEvent {
  type: "meta";
  data: {
    revision_id: string;
    library_id: string;
  };
}

interface LiProgressEvent {
  type: "progress";
  data: {
    message: string;
    stage: string | null;
  };
}

interface LiDoneEvent {
  type: "done";
  data: {
    status: "ready" | "failed";
    /** Set on failure; the error code. */
    error_code: string | null;
    /** The revision this terminal event belongs to. */
    revision_id: string;
  };
}

export type LiStreamEvent = LiMetaEvent | LiProgressEvent | LiDoneEvent;

function parseMetaData(data: unknown): LiMetaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.revision_id !== "string" ||
    typeof data.library_id !== "string"
  ) {
    throw new Error("Invalid SSE payload for meta");
  }
  return { revision_id: data.revision_id, library_id: data.library_id };
}

function parseProgressData(data: unknown): LiProgressEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.message !== "string" ||
    !isOptionalString(data.stage)
  ) {
    throw new Error("Invalid SSE payload for progress");
  }
  return { message: data.message, stage: data.stage ?? null };
}

function parseDoneData(data: unknown): LiDoneEvent["data"] {
  if (
    !isRecord(data) ||
    (data.status !== "ready" && data.status !== "failed") ||
    typeof data.revision_id !== "string" ||
    !isOptionalString(data.error_code)
  ) {
    throw new Error("Invalid SSE payload for done");
  }
  return {
    status: data.status,
    error_code: data.error_code ?? null,
    revision_id: data.revision_id,
  };
}

export function toLibraryIntelligenceEvent(
  eventType: string,
  data: unknown,
): LiStreamEvent {
  switch (eventType) {
    case "meta":
      return { type: "meta", data: parseMetaData(data) };
    case "progress":
      return { type: "progress", data: parseProgressData(data) };
    case "done":
      return { type: "done", data: parseDoneData(data) };
    default:
      throw new Error(`Unknown SSE event type: ${eventType || "message"}`);
  }
}
