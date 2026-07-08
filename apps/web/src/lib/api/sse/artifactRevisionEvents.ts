/**
 * SSE decoder for the artifact-revision stream (library dossier + conversation
 * distillate share it).
 *
 * The backend emits three event kinds over `/stream/artifact-revisions/{revision_id}/events`:
 *   - `meta`     once on subscribe: `{revision_id, subject_scheme?, subject_id?}`
 *   - `progress` optional human-readable build progress: `{message, stage?}`
 *   - `done`     terminal: `{status, error_code, revision_id}` (`error_code` set on failure)
 *
 * Mirrors `toChatSSEEvent`: each branch validates its payload with field guards
 * (json-values.md) and throws on a malformed payload so the SSE client surfaces
 * a stream error rather than silently dropping the event.
 */

import { isRecord } from "@/lib/validation";
import { isOptionalString } from "@/lib/api/sse/guards";

interface ArtifactMetaEvent {
  type: "meta";
  data: {
    revision_id: string;
    subject_scheme: string | null;
    subject_id: string | null;
  };
}

interface ArtifactProgressEvent {
  type: "progress";
  data: {
    message: string;
    stage: string | null;
  };
}

interface ArtifactDoneEvent {
  type: "done";
  data: {
    status: "ready" | "failed";
    /** Set on failure; the error code. */
    error_code: string | null;
    /** The revision this terminal event belongs to. */
    revision_id: string;
  };
}

export type ArtifactStreamEvent =
  | ArtifactMetaEvent
  | ArtifactProgressEvent
  | ArtifactDoneEvent;

function parseMetaData(data: unknown): ArtifactMetaEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.revision_id !== "string" ||
    !isOptionalString(data.subject_scheme) ||
    !isOptionalString(data.subject_id)
  ) {
    throw new Error("Invalid SSE payload for meta");
  }
  return {
    revision_id: data.revision_id,
    subject_scheme: data.subject_scheme ?? null,
    subject_id: data.subject_id ?? null,
  };
}

function parseProgressData(data: unknown): ArtifactProgressEvent["data"] {
  if (
    !isRecord(data) ||
    typeof data.message !== "string" ||
    !isOptionalString(data.stage)
  ) {
    throw new Error("Invalid SSE payload for progress");
  }
  return { message: data.message, stage: data.stage ?? null };
}

function parseDoneData(data: unknown): ArtifactDoneEvent["data"] {
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

export function toArtifactRevisionEvent(
  eventType: string,
  data: unknown,
): ArtifactStreamEvent {
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
