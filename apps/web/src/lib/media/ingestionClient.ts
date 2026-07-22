"use client";

import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  isUnauthenticatedApiError,
  type SameSystemApiDefect,
} from "@/lib/api/client";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { toMediaCaptureFeedback } from "@/lib/media/captureFeedback";
import { type DocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { isRecord } from "@/lib/validation";

export type UploadFileKind = "Pdf" | "Epub";

interface SourceActionResponse {
  data: {
    media_id: string;
    source_attempt_id: string;
    source_type: string;
    source_attempt_status: string;
    idempotency_outcome: "created" | "reused" | "retrying" | "refreshed";
    processing_status: string;
    ingest_enqueued: boolean;
    capabilities: MediaActionCapabilities;
  };
}

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

/**
 * A same-system media-ingest response violated the owned wire contract.
 * Consumers must propagate this defect; it is never product-facing feedback.
 */
export class MediaIngestionContractDefect extends Error {
  constructor(message: string, options?: ErrorOptions) {
    // justify-defect: malformed owned success payloads and impossible post-init
    // confirmation outcomes are code/schema contract violations.
    super(message, options);
    this.name = "MediaIngestionContractDefect";
  }
}

export function isMediaIngestionDefect(
  error: unknown,
): error is MediaIngestionContractDefect | SameSystemApiDefect {
  return (
    error instanceof MediaIngestionContractDefect ||
    isSameSystemApiDefect(error)
  );
}

export type UploadIngestResult =
  | { kind: "Accepted"; result: SourceIngestResult }
  | {
      kind: "AcceptedUncertain";
      mediaId: string;
      sourceAttemptId: string;
      feedback: FeedbackContent;
    };

export interface UploadReferenceProjection {
  mediaId: string;
  warning: FeedbackContent | null;
}

export function projectUploadReference({
  result,
  processingFailureFeedback,
}: {
  result: UploadIngestResult;
  processingFailureFeedback: FeedbackContent;
}): UploadReferenceProjection {
  switch (result.kind) {
    case "Accepted":
      return {
        mediaId: result.result.mediaId,
        warning: isFailedSourceIngest(result.result)
          ? processingFailureFeedback
          : null,
      };
    case "AcceptedUncertain":
      return { mediaId: result.mediaId, warning: result.feedback };
  }
}

export interface AcceptedUploadIdentity {
  mediaId: string;
  sourceAttemptId: string;
}

export function matchesAcceptedUploadIdentity(
  result: UploadIngestResult,
  identity: AcceptedUploadIdentity,
): boolean {
  switch (result.kind) {
    case "Accepted":
      return (
        result.result.mediaId === identity.mediaId &&
        result.result.sourceAttemptId === identity.sourceAttemptId
      );
    case "AcceptedUncertain":
      return (
        result.mediaId === identity.mediaId &&
        result.sourceAttemptId === identity.sourceAttemptId
      );
  }
}

export type UploadInitOutcome =
  | {
      kind: "UploadRequired";
      mediaId: string;
      sourceAttemptId: string;
      uploadUrl: string;
    }
  | UploadIngestResult;

export interface SourceActionResult extends SourceIngestResult {
  capabilities: MediaActionCapabilities;
}

export function isFailedSourceIngest(result: SourceIngestResult): boolean {
  return (
    result.processingStatus === "failed" ||
    result.sourceAttemptStatus === "failed"
  );
}

export function getFileUploadKind(file: File): UploadFileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "Pdf";
  }
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) {
    return "Epub";
  }
  return null;
}

function contentTypeFor(kind: UploadFileKind): string {
  return kind === "Pdf" ? "application/pdf" : "application/epub+zip";
}

export function getFileUploadError(file: File): string | null {
  const kind = getFileUploadKind(file);
  if (!kind) {
    return "Only PDF and EPUB files are supported.";
  }
  if (file.size === 0) {
    return `${kind.toUpperCase()} files must not be empty.`;
  }

  const maxBytes = kind === "Pdf" ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    return `${kind.toUpperCase()} files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`;
  }

  return null;
}

export async function uploadIngestFile({
  file,
  libraryIds,
  idempotencyKey = createRandomId("media-upload"),
  signal,
  onAcceptedIdentity,
}: {
  file: File;
  libraryIds: readonly string[];
  idempotencyKey?: string;
  signal?: AbortSignal;
  onAcceptedIdentity?(identity: AcceptedUploadIdentity): void;
}): Promise<UploadIngestResult> {
  const validationError = getFileUploadError(file);
  if (validationError) throw new Error(validationError);
  const kind = getFileUploadKind(file);
  if (kind === null) {
    throw new Error("Only PDF and EPUB files are supported.");
  }

  signal?.throwIfAborted();
  const init = projectUploadInitResponse(
    await apiFetch<unknown>("/api/media/upload/init", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        kind: kind.toLowerCase(),
        filename: file.name,
        content_type: contentTypeFor(kind),
        size_bytes: file.size,
        library_ids: libraryIds,
      }),
      signal,
    }),
  );
  onAcceptedIdentity?.(
    init.kind === "Accepted"
      ? {
          mediaId: init.result.mediaId,
          sourceAttemptId: init.result.sourceAttemptId,
        }
      : { mediaId: init.mediaId, sourceAttemptId: init.sourceAttemptId },
  );
  if (init.kind !== "UploadRequired") return init;

  let upload: Response;
  try {
    upload = await fetch(init.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentTypeFor(kind) },
      body: file,
      signal,
    });
  } catch (error) {
    if (
      signal?.aborted ||
      isAbortError(error) ||
      isUnauthenticatedApiError(error)
    )
      throw error;
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && !isAbortError(error))
    ) {
      return uncertainUpload(init, error);
    }
    throw new MediaIngestionContractDefect(
      "Signed upload failed outside supported transport outcomes.",
      { cause: error },
    );
  }
  if (!upload.ok) {
    // justify-defect: the signed-upload provider returned a definitive HTTP
    // rejection outside the accepted transport-interruption outcomes.
    throw new MediaIngestionContractDefect(
      `Signed upload returned unexpected status ${upload.status}.`,
    );
  }

  let ingestResponse: unknown;
  try {
    ingestResponse = await confirmUploadedMedia(
      init.mediaId,
      libraryIds,
      signal,
    );
  } catch (error) {
    if (
      signal?.aborted ||
      isAbortError(error) ||
      isUnauthenticatedApiError(error) ||
      isSameSystemApiDefect(error)
    ) {
      throw error;
    }
    if (
      error instanceof TypeError ||
      error instanceof DOMException ||
      (isApiError(error) &&
        (error.code === "E_UPSTREAM" || error.code === "E_UPSTREAM_TIMEOUT"))
    ) {
      return uncertainUpload(init, error);
    }
    // justify-defect: decoded upload-init identity is durable; a non-transport,
    // non-upstream confirmation rejection is not an allowed continuation outcome.
    throw new MediaIngestionContractDefect(
      "Upload confirmation violated the accepted-init contract.",
      {
        cause: error,
      },
    );
  }
  const confirmed = decodeIngestResponse(ingestResponse);
  if (
    confirmed.mediaId !== init.mediaId ||
    confirmed.sourceAttemptId !== init.sourceAttemptId
  ) {
    throw new MediaIngestionContractDefect(
      "Upload confirmation changed the accepted upload identity.",
    );
  }
  return { kind: "Accepted", result: confirmed };
}

function uncertainUpload(
  identity: { mediaId: string; sourceAttemptId: string },
  error?: unknown,
): UploadIngestResult {
  const feedback = toMediaCaptureFeedback(
    error,
    "Nexus accepted this file, but its upload status could not be confirmed.",
  );
  return {
    kind: "AcceptedUncertain",
    mediaId: identity.mediaId,
    sourceAttemptId: identity.sourceAttemptId,
    feedback: { ...feedback, severity: "warning" },
  };
}

async function confirmUploadedMedia(
  mediaId: string,
  libraryIds: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return apiFetch<unknown>(`/api/media/${mediaId}/ingest`, {
    method: "POST",
    body: JSON.stringify({ library_ids: libraryIds }),
    signal,
  });
}

function dataRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new MediaIngestionContractDefect(
      `Invalid ${label}: expected a data object.`,
    );
  }
  return raw.data;
}

function stringField(
  data: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new MediaIngestionContractDefect(
      `Invalid ${label}: ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function booleanField(
  data: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const value = data[field];
  if (typeof value !== "boolean") {
    throw new MediaIngestionContractDefect(
      `Invalid ${label}: ${field} must be a boolean.`,
    );
  }
  return value;
}

function idempotencyOutcome(
  data: Record<string, unknown>,
  label: string,
): SourceIngestResult["idempotencyOutcome"] {
  const value = data.idempotency_outcome;
  if (
    value === "created" ||
    value === "reused" ||
    value === "retrying" ||
    value === "refreshed"
  ) {
    return value;
  }
  throw new MediaIngestionContractDefect(
    `Invalid ${label}: unsupported idempotency_outcome.`,
  );
}

function sourceAttemptStatus(
  data: Record<string, unknown>,
  label: string,
): SourceAttemptStatus {
  const value = data.source_attempt_status;
  if (
    value === "accepted" ||
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "superseded"
  ) {
    return value;
  }
  throw new MediaIngestionContractDefect(
    `Invalid ${label}: unsupported source_attempt_status.`,
  );
}

function processingStatus(
  data: Record<string, unknown>,
  label: string,
): DocumentProcessingStatus {
  const value = data.processing_status;
  if (
    value === "pending" ||
    value === "extracting" ||
    value === "ready_for_reading" ||
    value === "failed"
  ) {
    return value;
  }
  throw new MediaIngestionContractDefect(
    `Invalid ${label}: unsupported processing_status.`,
  );
}

function sourceIngestResult(
  data: Record<string, unknown>,
  label: string,
  duplicate: boolean,
): SourceIngestResult {
  return {
    mediaId: stringField(data, "media_id", label),
    sourceAttemptId: stringField(data, "source_attempt_id", label),
    sourceType: stringField(data, "source_type", label),
    sourceAttemptStatus: sourceAttemptStatus(data, label),
    idempotencyOutcome: idempotencyOutcome(data, label),
    duplicate,
    processingStatus: processingStatus(data, label),
    ingestEnqueued: booleanField(data, "ingest_enqueued", label),
  };
}

export function decodeIngestResponse(raw: unknown): SourceIngestResult {
  const data = dataRecord(raw, "upload ingest response");
  return sourceIngestResult(
    data,
    "upload ingest response",
    booleanField(data, "duplicate", "upload ingest response"),
  );
}

export function decodeFromUrlResponse(raw: unknown): SourceIngestResult {
  const data = dataRecord(raw, "URL ingest response");
  return sourceIngestResult(
    data,
    "URL ingest response",
    data.idempotency_outcome === "reused",
  );
}

export function projectUploadInitResponse(raw: unknown): UploadInitOutcome {
  const data = dataRecord(raw, "upload init response");
  const result = sourceIngestResult(
    data,
    "upload init response",
    data.idempotency_outcome === "reused",
  );
  const uploadUrl = data.upload_url;
  if (typeof uploadUrl === "string" && uploadUrl.length > 0) {
    return {
      kind: "UploadRequired",
      mediaId: result.mediaId,
      sourceAttemptId: result.sourceAttemptId,
      uploadUrl,
    };
  }
  if (uploadUrl !== null) {
    throw new MediaIngestionContractDefect(
      "Invalid upload init response: upload_url must be a string or null.",
    );
  }
  if (
    result.sourceAttemptStatus === "accepted" &&
    result.processingStatus === "pending" &&
    !result.ingestEnqueued
  ) {
    return uncertainUpload(result);
  }
  return { kind: "Accepted", result };
}

export async function addMediaFromUrl({
  url,
  libraryIds,
  idempotencyKey = createRandomId("media-url"),
  signal,
}: {
  url: string;
  libraryIds: readonly string[];
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<SourceIngestResult> {
  const response = await apiFetch<unknown>("/api/media/from-url", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ url, library_ids: libraryIds }),
    signal,
  });

  return decodeFromUrlResponse(response);
}

export async function retryMediaSource(
  mediaId: string,
  {
    idempotencyKey = createRandomId("media-source-retry"),
  }: { idempotencyKey?: string } = {},
): Promise<SourceActionResult> {
  const response = await apiFetch<SourceActionResponse>(
    `/api/media/${mediaId}/retry`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from_stage: "source" }),
    },
  );
  return mapSourceActionResponse(response);
}

export async function refreshMediaSource(
  mediaId: string,
  {
    idempotencyKey = createRandomId("media-source-refresh"),
  }: { idempotencyKey?: string } = {},
): Promise<SourceActionResult> {
  const response = await apiFetch<SourceActionResponse>(
    `/api/media/${mediaId}/refresh`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
  return mapSourceActionResponse(response);
}

export function retryMediaMetadata<T = unknown>(mediaId: string): Promise<T> {
  return apiFetch<T>(`/api/media/${mediaId}/retry`, {
    method: "POST",
    body: JSON.stringify({ from_stage: "metadata" }),
  });
}

function mapSourceActionResponse(
  response: SourceActionResponse,
): SourceActionResult {
  return {
    ...decodeFromUrlResponse(response),
    capabilities: response.data.capabilities,
  };
}
