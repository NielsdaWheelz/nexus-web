import { decodePresence, type Presence } from "@/lib/api/presence";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { isRecord } from "@/lib/validation";

export type ActivityModality = "Reading" | "Listening" | "Viewing";
export type ActivityDeviceClass = "Desktop" | "Mobile";
export type MediaRef = string & { readonly __mediaRef: unique symbol };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMediaRef(value: string): MediaRef {
  const parsed = parseResourceRef(value);
  if (!parsed || parsed.scheme !== "media") {
    throw new Error(`Invalid mediaRef: ${JSON.stringify(value)}`);
  }
  return value as MediaRef;
}

interface ActivitySpanBase {
  occurredAt: string;
  durationMs: number;
}

export interface ReadingActivitySpan extends ActivitySpanBase {
  progressStart: Presence<number>;
  progressEnd: Presence<number>;
  wordStart: Presence<number>;
  wordEnd: Presence<number>;
}

export interface ListeningActivitySpan extends ActivitySpanBase {
  progressStart: Presence<number>;
  progressEnd: Presence<number>;
  mediaPositionStartMs: Presence<number>;
  mediaPositionEndMs: Presence<number>;
}

export type ViewingActivitySpan = ActivitySpanBase;

export type ActivityBatch =
  | { modality: "Reading"; spans: ReadingActivitySpan[] }
  | { modality: "Listening"; spans: ListeningActivitySpan[] }
  | { modality: "Viewing"; spans: ViewingActivitySpan[] };

export interface ActivityRequest {
  clientMutationId: string;
  mediaRef: MediaRef;
  deviceClass: ActivityDeviceClass;
  batch: ActivityBatch;
}

export type ActivityUploadOutcome =
  | { kind: "Accepted" }
  | { kind: "Retryable" }
  | { kind: "VisibilityLost" }
  | { kind: "AuthenticationLost" }
  | { kind: "Defect" };

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => key in value)) {
    throw new Error(`${name} has an invalid shape`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} is out of range`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const decoded = number(value, name, min, max);
  if (!Number.isInteger(decoded)) throw new Error(`${name} must be an integer`);
  return decoded;
}

function isoTime(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error("occurredAt must be canonical ISO time");
  }
  return value;
}

function optionalNumber(value: unknown, name: string, max: number): Presence<number> {
  return decodePresence(value, (inner) => integer(inner, name, 0, max));
}

function decodeReadingSpan(raw: unknown): ReadingActivitySpan {
  const value = object(raw, "ReadingSpan");
  exact(value, ["occurredAt", "durationMs", "progressStart", "progressEnd", "wordStart", "wordEnd"], "ReadingSpan");
  const progressStart = decodePresence(value.progressStart, (inner) => number(inner, "progressStart", 0, 1));
  const progressEnd = decodePresence(value.progressEnd, (inner) => number(inner, "progressEnd", 0, 1));
  const wordStart = optionalNumber(value.wordStart, "wordStart", Number.MAX_SAFE_INTEGER);
  const wordEnd = optionalNumber(value.wordEnd, "wordEnd", Number.MAX_SAFE_INTEGER);
  if (progressStart.kind !== progressEnd.kind || wordStart.kind !== wordEnd.kind) {
    throw new Error("ReadingSpan paired fields must share Presence");
  }
  return { occurredAt: isoTime(value.occurredAt), durationMs: integer(value.durationMs, "durationMs", 1, 30_000), progressStart, progressEnd, wordStart, wordEnd };
}

function decodeListeningSpan(raw: unknown): ListeningActivitySpan {
  const value = object(raw, "ListeningSpan");
  exact(value, ["occurredAt", "durationMs", "progressStart", "progressEnd", "mediaPositionStartMs", "mediaPositionEndMs"], "ListeningSpan");
  const progressStart = decodePresence(value.progressStart, (inner) => number(inner, "progressStart", 0, 1));
  const progressEnd = decodePresence(value.progressEnd, (inner) => number(inner, "progressEnd", 0, 1));
  const mediaPositionStartMs = optionalNumber(value.mediaPositionStartMs, "mediaPositionStartMs", Number.MAX_SAFE_INTEGER);
  const mediaPositionEndMs = optionalNumber(value.mediaPositionEndMs, "mediaPositionEndMs", Number.MAX_SAFE_INTEGER);
  if (progressStart.kind !== progressEnd.kind || mediaPositionStartMs.kind !== mediaPositionEndMs.kind) {
    throw new Error("ListeningSpan paired fields must share Presence");
  }
  return { occurredAt: isoTime(value.occurredAt), durationMs: integer(value.durationMs, "durationMs", 1, 30_000), progressStart, progressEnd, mediaPositionStartMs, mediaPositionEndMs };
}

function decodeViewingSpan(raw: unknown): ViewingActivitySpan {
  const value = object(raw, "ViewingSpan");
  exact(value, ["occurredAt", "durationMs"], "ViewingSpan");
  return { occurredAt: isoTime(value.occurredAt), durationMs: integer(value.durationMs, "durationMs", 1, 30_000) };
}

/** Strict request decoder shared by the browser transport and BFF ingress. */
export function decodeActivityRequest(raw: unknown): ActivityRequest {
  const value = object(raw, "ActivityRequest");
  exact(value, ["clientMutationId", "mediaRef", "deviceClass", "batch"], "ActivityRequest");
  if (typeof value.clientMutationId !== "string" || !UUID_RE.test(value.clientMutationId)) {
    throw new Error("clientMutationId must be a canonical UUID");
  }
  if (typeof value.deviceClass !== "string" || (value.deviceClass !== "Desktop" && value.deviceClass !== "Mobile")) {
    throw new Error("deviceClass is invalid");
  }
  const batch = object(value.batch, "ActivityBatch");
  exact(batch, ["modality", "spans"], "ActivityBatch");
  if (!Array.isArray(batch.spans) || batch.spans.length < 1 || batch.spans.length > 120) {
    throw new Error("ActivityBatch.spans must contain 1..120 spans");
  }
  const decodedBatch: ActivityBatch =
    batch.modality === "Reading"
      ? { modality: "Reading", spans: batch.spans.map(decodeReadingSpan) }
      : batch.modality === "Listening"
        ? { modality: "Listening", spans: batch.spans.map(decodeListeningSpan) }
        : batch.modality === "Viewing"
          ? { modality: "Viewing", spans: batch.spans.map(decodeViewingSpan) }
          : (() => { throw new Error("ActivityBatch.modality is invalid"); })();
  return {
    clientMutationId: value.clientMutationId,
    mediaRef: parseMediaRef(typeof value.mediaRef === "string" ? value.mediaRef : ""),
    deviceClass: value.deviceClass,
    batch: decodedBatch,
  };
}

async function responseCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "code" in body.error &&
      typeof body.error.code === "string"
    ) {
      return body.error.code;
    }
  } catch {
    // A malformed same-system error response is classified as a recorder defect below.
  }
  return undefined;
}

/** The sole browser transport boundary for ephemeral Consumption capture. */
export async function postActivityBatch(input: {
  body: string;
  keepalive: boolean;
  signal?: AbortSignal;
}): Promise<ActivityUploadOutcome> {
  try {
    const response = await fetch("/api/consumption/activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input.body,
      keepalive: input.keepalive,
      signal: input.signal,
      cache: "no-store",
    });
    if (response.status === 204) return { kind: "Accepted" };
    const code = await responseCode(response);
    if (
      (response.status === 403 || response.status === 404) &&
      (code === "E_MEDIA_NOT_VISIBLE" || code === "E_MEDIA_NOT_FOUND")
    ) {
      return { kind: "VisibilityLost" };
    }
    if (response.status === 401) {
      return { kind: "AuthenticationLost" };
    }
    if (response.status === 429 || response.status >= 500) return { kind: "Retryable" };
    return { kind: "Defect" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { kind: "Retryable" };
    }
    return { kind: "Retryable" };
  }
}
