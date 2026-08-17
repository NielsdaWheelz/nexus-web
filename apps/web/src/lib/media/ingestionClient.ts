"use client";

import {
  apiCommand204,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type SameSystemApiDefect,
} from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { publishMediaActivityInvalidation } from "@/lib/media/activityClient";
import { type DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { isRecord } from "@/lib/validation";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

// Cross-runtime storage-cleanup contract. The server rejects a cleanup write
// window that is not strictly longer than this bounded browser PUT horizon.
const DIRECT_UPLOAD_PUT_TIMEOUT_MS = 240_000;

export interface MediaActionCapabilities {
  can_read: boolean;
  can_highlight: boolean;
  can_quote: boolean;
  can_search: boolean;
  can_play: boolean;
  can_download_file: boolean;
  can_delete: boolean;
  can_retry: boolean;
  can_refresh_source: boolean;
  can_retry_metadata: boolean;
  can_repair_source: boolean;
  can_repair_search: boolean;
  can_edit_authors: boolean;
  can_read_embeds: boolean;
}

export interface SourceIngestResult {
  mediaId: string;
  sourceAttemptId: string;
  sourceType: string;
  sourceAttemptStatus: SourceAttemptStatus;
  idempotencyOutcome: "created" | "reused" | "retrying" | "refreshed";
  duplicate: boolean;
  processingStatus: DocumentProcessingStatus;
  ingestEnqueued: boolean;
}

export type SourceAttemptStatus =
  | "accepted"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "superseded";

export class MediaIngestionContractDefect extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaIngestionContractDefect";
  }
}

export class UploadNeedsAttentionError extends Error {
  readonly sessionHandle: string;

  constructor(sessionHandle: string) {
    super("This upload needs attention in Import Activity.");
    this.name = "UploadNeedsAttentionError";
    this.sessionHandle = sessionHandle;
  }
}

export function isMediaIngestionDefect(
  error: unknown,
): error is MediaIngestionContractDefect | SameSystemApiDefect {
  return error instanceof MediaIngestionContractDefect || isSameSystemApiDefect(error);
}

export interface PublishedUploadResult {
  mediaId: string;
  sourceAttemptId: string;
  idempotencyOutcome: "created" | "reused";
  duplicate: boolean;
}

export type AcceptedIngestResult = SourceIngestResult | PublishedUploadResult;

export type UploadIngestResult = {
  kind: "Published";
  result: PublishedUploadResult;
};

export function isFailedSourceIngest(result: SourceIngestResult): boolean {
  return (
    result.processingStatus === "failed" ||
    result.sourceAttemptStatus === "failed"
  );
}

type UploadResponse =
  | {
      readonly kind: "UploadRequired";
      readonly sessionHandle: string;
      readonly generation: number;
      readonly method: "PUT";
      readonly uploadUrl: string;
      readonly requiredHeaders: Readonly<Record<string, string>>;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "Published";
      readonly sessionHandle: string;
      readonly mediaId: string;
      readonly sourceAttemptId: string;
      readonly idempotencyOutcome: "Created" | "Reused";
    }
  | {
      readonly kind: "NeedsAttention";
      readonly sessionHandle: string;
      readonly failure: UploadFailure;
      readonly capabilities: { readonly canRetryUpload: boolean; readonly canRemove: boolean };
    };

type UploadFailure =
  | {
      readonly kind: "VerificationFailed";
      readonly code: "E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE";
      readonly failedAt: string;
    }
  | {
      readonly kind: "TransportFailed";
      readonly reason:
        | { readonly kind: "Network" }
        | { readonly kind: "Timeout" }
        | { readonly kind: "Aborted" }
        | { readonly kind: "HttpRejected"; readonly status: number };
      readonly failedAt: string;
    }
  | { readonly kind: "CapabilityExpired"; readonly expiredAt: string };

function dataRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new MediaIngestionContractDefect(`Invalid ${label}: expected a data object.`);
  }
  return raw.data;
}

function stringField(data: Record<string, unknown>, field: string, label: string): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new MediaIngestionContractDefect(`Invalid ${label}: ${field} must be a non-empty string.`);
  }
  return value;
}

function integerField(data: Record<string, unknown>, field: string, label: string): number {
  const value = data[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MediaIngestionContractDefect(`Invalid ${label}: ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function exactKeys(data: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(data).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MediaIngestionContractDefect(`Invalid ${label}: unexpected response shape.`);
  }
}

function isoInstantField(
  data: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = stringField(data, field, label);
  if (!Number.isFinite(Date.parse(value)) || !value.includes("T")) {
    throw new MediaIngestionContractDefect(
      `Invalid ${label}: ${field} must be an ISO instant.`,
    );
  }
  return value;
}

function decodeUploadFailure(raw: unknown): UploadFailure {
  if (!isRecord(raw)) {
    throw new MediaIngestionContractDefect(
      "Invalid upload response: failure must be an object.",
    );
  }
  const kind = stringField(raw, "kind", "upload failure");
  if (kind === "VerificationFailed") {
    exactKeys(raw, ["kind", "code", "failed_at"], "upload failure");
    const code = stringField(raw, "code", "upload failure");
    if (
      code !== "E_SOURCE_INTEGRITY" &&
      code !== "E_INVALID_FILE_TYPE" &&
      code !== "E_FILE_TOO_LARGE"
    ) {
      throw new MediaIngestionContractDefect(
        "Invalid upload response: unsupported verification failure.",
      );
    }
    return {
      kind,
      code,
      failedAt: isoInstantField(raw, "failed_at", "upload failure"),
    };
  }
  if (kind === "CapabilityExpired") {
    exactKeys(raw, ["kind", "expired_at"], "upload failure");
    return {
      kind,
      expiredAt: isoInstantField(raw, "expired_at", "upload failure"),
    };
  }
  if (kind === "TransportFailed") {
    exactKeys(raw, ["kind", "reason", "failed_at"], "upload failure");
    if (!isRecord(raw.reason)) {
      throw new MediaIngestionContractDefect(
        "Invalid upload response: transport reason must be an object.",
      );
    }
    const reasonKind = stringField(raw.reason, "kind", "upload transport reason");
    let reason: Extract<UploadFailure, { kind: "TransportFailed" }>["reason"];
    if (reasonKind === "HttpRejected") {
      exactKeys(raw.reason, ["kind", "status"], "upload transport reason");
      const status = integerField(raw.reason, "status", "upload transport reason");
      if (status < 100 || status > 599) {
        throw new MediaIngestionContractDefect(
          "Invalid upload response: transport status must be an HTTP status.",
        );
      }
      reason = { kind: reasonKind, status };
    } else if (
      reasonKind === "Network" ||
      reasonKind === "Timeout" ||
      reasonKind === "Aborted"
    ) {
      exactKeys(raw.reason, ["kind"], "upload transport reason");
      reason = { kind: reasonKind };
    } else {
      throw new MediaIngestionContractDefect(
        "Invalid upload response: unsupported transport failure.",
      );
    }
    return {
      kind,
      reason,
      failedAt: isoInstantField(raw, "failed_at", "upload failure"),
    };
  }
  throw new MediaIngestionContractDefect(
    "Invalid upload response: unsupported failure kind.",
  );
}

function browserSettableHeaders(raw: unknown): Readonly<Record<string, string>> {
  if (!isRecord(raw)) {
    throw new MediaIngestionContractDefect(
      "Invalid upload response: required_headers must be an object.",
    );
  }
  exactKeys(raw, ["Content-Type"], "upload required headers");
  const contentType = raw["Content-Type"];
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw new MediaIngestionContractDefect(
      "Invalid upload response: Content-Type must be a non-empty string.",
    );
  }
  return { "Content-Type": contentType };
}

export function decodeUploadResponse(raw: unknown): UploadResponse {
  const data = dataRecord(raw, "upload response");
  const kind = stringField(data, "kind", "upload response");
  if (kind === "UploadRequired") {
    exactKeys(data, ["kind", "session_handle", "generation", "method", "upload_url", "required_headers", "expires_at", "idempotency_outcome"], "upload response");
    if (data.method !== "PUT" || (data.idempotency_outcome !== "Created" && data.idempotency_outcome !== "Reused")) {
      throw new MediaIngestionContractDefect("Invalid upload response: unsupported upload capability.");
    }
    const expiresAt = isoInstantField(data, "expires_at", "upload response");
    const generation = integerField(data, "generation", "upload response");
    if (generation < 1) {
      throw new MediaIngestionContractDefect(
        "Invalid upload response: generation must be positive.",
      );
    }
    return { kind, sessionHandle: stringField(data, "session_handle", "upload response"), generation, method: "PUT", uploadUrl: stringField(data, "upload_url", "upload response"), requiredHeaders: browserSettableHeaders(data.required_headers), expiresAt };
  }
  if (kind === "Published") {
    exactKeys(data, ["kind", "session_handle", "media_id", "source_attempt_id", "idempotency_outcome"], "upload response");
    const outcome = data.idempotency_outcome;
    if (outcome !== "Created" && outcome !== "Reused") throw new MediaIngestionContractDefect("Invalid upload response: unsupported idempotency outcome.");
    return { kind, sessionHandle: stringField(data, "session_handle", "upload response"), mediaId: stringField(data, "media_id", "upload response"), sourceAttemptId: stringField(data, "source_attempt_id", "upload response"), idempotencyOutcome: outcome };
  }
  if (kind === "NeedsAttention") {
    exactKeys(data, ["kind", "session_handle", "failure", "capabilities"], "upload response");
    if (!isRecord(data.capabilities)) throw new MediaIngestionContractDefect("Invalid upload response: invalid capabilities.");
    exactKeys(data.capabilities, ["can_retry_upload", "can_remove"], "upload capabilities");
    if (typeof data.capabilities.can_retry_upload !== "boolean" || typeof data.capabilities.can_remove !== "boolean") throw new MediaIngestionContractDefect("Invalid upload response: invalid capabilities.");
    return { kind, sessionHandle: stringField(data, "session_handle", "upload response"), failure: decodeUploadFailure(data.failure), capabilities: { canRetryUpload: data.capabilities.can_retry_upload, canRemove: data.capabilities.can_remove } };
  }
  throw new MediaIngestionContractDefect("Invalid upload response: unsupported kind.");
}

function contentTypeFor(kind: UploadFileKind): string {
  return kind === "Pdf" ? "application/pdf" : "application/epub+zip";
}

export function getFileUploadKind(file: File): UploadFileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "Pdf";
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) return "Epub";
  return null;
}

export function getFileUploadError(file: File): string | null {
  const kind = getFileUploadKind(file);
  if (!kind) return "Only PDF and EPUB files are supported.";
  if (file.size === 0) return `${kind.toUpperCase()} files must not be empty.`;
  const maxBytes = kind === "Pdf" ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  return file.size > maxBytes ? `${kind.toUpperCase()} files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.` : null;
}

function publishedResult(response: Extract<UploadResponse, { kind: "Published" }>): UploadIngestResult {
  const idempotencyOutcome =
    response.idempotencyOutcome === "Created" ? "created" : "reused";
  return {
    kind: "Published",
    result: {
      mediaId: response.mediaId,
      sourceAttemptId: response.sourceAttemptId,
      idempotencyOutcome,
      duplicate: idempotencyOutcome === "reused",
    },
  };
}

async function transportFailure(sessionHandle: string, generation: number, durationMs: number, body: Record<string, unknown>): Promise<void> {
  await apiCommand204(`/api/media/uploads/${encodeURIComponent(sessionHandle)}/transport-failure`, { method: "POST", body: JSON.stringify({ ...body, generation, duration_ms: durationMs, request_id: createRandomId("upload-transport") }) });
  publishMediaActivityInvalidation();
}

async function putAndConfirm(
  upload: Extract<UploadResponse, { kind: "UploadRequired" }>,
  file: File,
  signal?: AbortSignal,
  onPhaseChange?: (phase: UploadPhase) => void,
): Promise<UploadIngestResult> {
  const startedAt = performance.now();
  const durationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  onPhaseChange?.("Uploading");

  const putTimeoutMs = Math.max(
    0,
    Math.min(
      DIRECT_UPLOAD_PUT_TIMEOUT_MS,
      Date.parse(upload.expiresAt) - Date.now(),
    ),
  );
  if (putTimeoutMs === 0) {
    await transportFailure(upload.sessionHandle, upload.generation, durationMs(), {
      kind: "Timeout",
    });
    throw new UploadNeedsAttentionError(upload.sessionHandle);
  }

  const putController = new AbortController();
  let putTimedOut = false;
  const abortForCaller = () => putController.abort(signal?.reason);
  if (signal?.aborted) {
    abortForCaller();
  } else {
    signal?.addEventListener("abort", abortForCaller, { once: true });
  }
  const putTimeout = globalThis.setTimeout(() => {
    putTimedOut = true;
    putController.abort(new DOMException("Direct upload PUT deadline exceeded", "TimeoutError"));
  }, putTimeoutMs);

  let response: Response;
  try {
    response = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.requiredHeaders, body: file, signal: putController.signal });
  } catch (error) {
    if (putTimedOut) {
      await transportFailure(upload.sessionHandle, upload.generation, durationMs(), {
        kind: "Timeout",
      });
      throw new UploadNeedsAttentionError(upload.sessionHandle);
    }
    if (signal?.aborted || isAbortError(error)) {
      await transportFailure(upload.sessionHandle, upload.generation, durationMs(), { kind: "Aborted" });
      throw error;
    }
    if (error instanceof UploadNeedsAttentionError) throw error;
    await transportFailure(upload.sessionHandle, upload.generation, durationMs(), { kind: "Network" });
    throw new UploadNeedsAttentionError(upload.sessionHandle);
  } finally {
    globalThis.clearTimeout(putTimeout);
    signal?.removeEventListener("abort", abortForCaller);
  }
  if (!response.ok) {
    await transportFailure(upload.sessionHandle, upload.generation, durationMs(), { kind: "HttpRejected", status: response.status });
    throw new UploadNeedsAttentionError(upload.sessionHandle);
  }
  let confirmed: UploadResponse;
  try {
    onPhaseChange?.("Verifying");
    confirmed = decodeUploadResponse(await apiFetch<unknown>(`/api/media/uploads/${encodeURIComponent(upload.sessionHandle)}/confirm`, { method: "POST", body: JSON.stringify({ generation: upload.generation }), signal }));
  } catch (error) {
    if (
      isApiError(error) &&
      ["E_SOURCE_INTEGRITY", "E_INVALID_FILE_TYPE", "E_FILE_TOO_LARGE"].includes(
        error.code,
      )
    ) {
      throw new UploadNeedsAttentionError(upload.sessionHandle);
    }
    throw error;
  }
  if (confirmed.kind !== "Published") throw new MediaIngestionContractDefect("Upload confirmation must publish media or fail through the canonical error envelope.");
  return publishedResult(confirmed);
}

export async function uploadIngestFile({ file, libraryIds, idempotencyKey = createRandomId("media-upload"), signal, onPhaseChange }: { file: File; libraryIds: readonly string[]; idempotencyKey?: string; signal?: AbortSignal; onPhaseChange?: (phase: UploadPhase) => void }): Promise<UploadIngestResult> {
  const error = getFileUploadError(file);
  if (error) throw new Error(error);
  const kind = getFileUploadKind(file);
  if (!kind) throw new Error("Only PDF and EPUB files are supported.");
  onPhaseChange?.("Preparing");
  const started = decodeUploadResponse(await apiFetch<unknown>("/api/media/uploads", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ kind, filename: file.name, content_type: contentTypeFor(kind), size_bytes: file.size, library_ids: libraryIds }), signal }));
  if (started.kind === "Published") {
    publishLibraryPlacementChange([...libraryIds]);
    publishMediaActivityInvalidation();
    return publishedResult(started);
  }
  if (started.kind === "NeedsAttention") {
    publishMediaActivityInvalidation();
    throw new UploadNeedsAttentionError(started.sessionHandle);
  }
  const result = await putAndConfirm(started, file, signal, onPhaseChange);
  publishLibraryPlacementChange([...libraryIds]);
  publishMediaActivityInvalidation();
  return result;
}

export async function retryUploadSession(sessionHandle: string, file: File, signal?: AbortSignal): Promise<UploadIngestResult> {
  const kind = getFileUploadKind(file);
  if (!kind || getFileUploadError(file)) throw new Error("Choose the original PDF or EPUB file to retry this upload.");
  const retry = decodeUploadResponse(await apiFetch<unknown>(`/api/media/uploads/${encodeURIComponent(sessionHandle)}/retry`, { method: "POST", body: JSON.stringify({ filename: file.name, content_type: contentTypeFor(kind), size_bytes: file.size }), signal }));
  if (retry.kind !== "UploadRequired") throw new MediaIngestionContractDefect("Upload retry must return a fresh upload capability.");
  const result = await putAndConfirm(retry, file, signal);
  publishLibraryPlacementChange("Unknown");
  publishMediaActivityInvalidation();
  return result;
}

export async function removeUploadSession(sessionHandle: string): Promise<void> {
  await apiCommand204(`/api/media/uploads/${encodeURIComponent(sessionHandle)}`, { method: "DELETE" });
  publishMediaActivityInvalidation();
}

export interface SourceActionResult extends SourceIngestResult { capabilities: MediaActionCapabilities; }

function sourceIngestResult(data: Record<string, unknown>, label: string, duplicate: boolean): SourceIngestResult {
  const sourceAttemptStatus = stringField(data, "source_attempt_status", label) as SourceAttemptStatus;
  const processingStatus = stringField(data, "processing_status", label) as DocumentProcessingStatus;
  const outcome = stringField(data, "idempotency_outcome", label) as SourceIngestResult["idempotencyOutcome"];
  if (!["accepted", "queued", "running", "succeeded", "failed", "superseded"].includes(sourceAttemptStatus) || !["pending", "extracting", "ready_for_reading", "failed"].includes(processingStatus) || !["created", "reused", "retrying", "refreshed"].includes(outcome)) throw new MediaIngestionContractDefect(`Invalid ${label}: unsupported lifecycle value.`);
  return { mediaId: stringField(data, "media_id", label), sourceAttemptId: stringField(data, "source_attempt_id", label), sourceType: stringField(data, "source_type", label), sourceAttemptStatus, idempotencyOutcome: outcome, duplicate, processingStatus, ingestEnqueued: data.ingest_enqueued === true };
}

export function decodeFromUrlResponse(raw: unknown): SourceIngestResult {
  const data = dataRecord(raw, "URL ingest response");
  return sourceIngestResult(data, "URL ingest response", data.idempotency_outcome === "reused");
}

export async function addMediaFromUrl({ url, libraryIds, idempotencyKey = createRandomId("media-url"), signal }: { url: string; libraryIds: readonly string[]; idempotencyKey?: string; signal?: AbortSignal }): Promise<SourceIngestResult> {
  const result = decodeFromUrlResponse(await apiFetch<unknown>("/api/media/from-url", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ url, library_ids: libraryIds }), signal }));
  publishLibraryPlacementChange([...libraryIds]);
  publishMediaActivityInvalidation();
  return result;
}

async function sourceAction(mediaId: string, path: "retry" | "refresh", body?: unknown): Promise<SourceActionResult> {
  const raw = await apiFetch<unknown>(`/api/media/${mediaId}/${path}`, { method: "POST", headers: path === "retry" ? { "Idempotency-Key": createRandomId("media-source-retry") } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = dataRecord(raw, `media ${path} response`);
  if (!isRecord(data.capabilities)) throw new MediaIngestionContractDefect(`Invalid media ${path} response: capabilities missing.`);
  const capabilityKeys = [
    "can_read",
    "can_highlight",
    "can_quote",
    "can_search",
    "can_play",
    "can_download_file",
    "can_delete",
    "can_retry",
    "can_refresh_source",
    "can_retry_metadata",
    "can_repair_source",
    "can_repair_search",
    "can_edit_authors",
    "can_read_embeds",
  ] as const;
  exactKeys(data.capabilities, capabilityKeys, `media ${path} capabilities`);
  for (const key of capabilityKeys) {
    if (typeof data.capabilities[key] !== "boolean") {
      throw new MediaIngestionContractDefect(
        `Invalid media ${path} response: ${key} must be boolean.`,
      );
    }
  }
  return {
    ...sourceIngestResult(
      data,
      `media ${path} response`,
      data.idempotency_outcome === "reused",
    ),
    capabilities: data.capabilities as unknown as MediaActionCapabilities,
  };
}

export async function retryMediaSource(mediaId: string): Promise<SourceActionResult> { const result = await sourceAction(mediaId, "retry", { from_stage: "source" }); publishMediaActivityInvalidation(); return result; }
export async function refreshMediaSource(mediaId: string): Promise<SourceActionResult> { const result = await sourceAction(mediaId, "refresh"); publishMediaActivityInvalidation(); return result; }
export function retryMediaMetadata<T = unknown>(mediaId: string): Promise<T> { return apiFetch<T>(`/api/media/${mediaId}/retry`, { method: "POST", body: JSON.stringify({ from_stage: "metadata" }) }); }
