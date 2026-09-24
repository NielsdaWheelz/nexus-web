"use client";

import {
  apiCommand204,
  apiFetch,
  decodeApiPayload,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { publishImportsInvalidation } from "@/lib/imports/importsClient";
import {
  requireDocumentProcessingStatus,
  type DocumentProcessingStatus,
} from "@/lib/media/documentReadiness";
import {
  decodeUploadResponse,
  type PublishedUpload,
  type UploadCapability,
  type UploadFailure,
  type UploadResponse,
} from "@/lib/media/uploadSessionContract";
import type {
  UploadTransportFailure,
  UploadVerificationCode,
} from "@/lib/media/uploadVerification";
import {
  expectExactRecord,
  expectNonemptyString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

// Cross-runtime storage-cleanup contract. The server rejects a cleanup write
// window that is not strictly longer than this bounded browser PUT horizon.
const DIRECT_UPLOAD_PUT_TIMEOUT_MS = 240_000;

// Lifecycle vocabularies are declared once as the decoded tuple and the type is
// derived from it, so a variant can never exist in the union without also being
// accepted by the decoder that guards it.
const SOURCE_ATTEMPT_STATUSES = [
  "accepted",
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

type SourceAttemptStatus = (typeof SOURCE_ATTEMPT_STATUSES)[number];

const SOURCE_IDEMPOTENCY_OUTCOMES = [
  "created",
  "reused",
  "retrying",
  "refreshed",
] as const;

type SourceIdempotencyOutcome = (typeof SOURCE_IDEMPOTENCY_OUTCOMES)[number];

export interface SourceIngestResult {
  kind: "SourceIngest";
  mediaId: string;
  sourceAttemptId: string;
  sourceType: string;
  sourceAttemptStatus: SourceAttemptStatus;
  idempotencyOutcome: SourceIdempotencyOutcome;
  duplicate: boolean;
  processingStatus: DocumentProcessingStatus;
  ingestEnqueued: boolean;
}

export interface PublishedUploadResult {
  kind: "PublishedUpload";
  mediaId: string;
  sourceAttemptId: string;
  idempotencyOutcome: "created" | "reused";
  duplicate: boolean;
}

/** Every accepted import, tagged by the lane that produced it. */
export type AcceptedIngestResult = SourceIngestResult | PublishedUploadResult;

export function isFailedSourceIngest(result: SourceIngestResult): boolean {
  return (
    result.processingStatus === "failed" ||
    result.sourceAttemptStatus === "failed"
  );
}

/**
 * The closed set of client outcomes the upload-session endpoint channel can
 * produce. Every error code the API contract declares maps to exactly one of
 * these, so each surface handles the whole channel exhaustively instead of
 * inferring intent from an HTTP status class.
 */
export type UploadSessionOutcome =
  /** Imports owns an unresolved obligation for this session. */
  | { readonly kind: "NeedsAttention" }
  /** Verification rejected the stored bytes. Terminal for this session. */
  | {
      readonly kind: "VerificationRejected";
      readonly code: UploadVerificationCode;
    }
  /** No staged bytes for this generation; the same file must be sent again. */
  | { readonly kind: "BytesMissing" }
  /** This attempt no longer owns the session; Imports is authoritative. */
  | { readonly kind: "Superseded" }
  /** The identity this command named is stale; Imports holds a newer one. */
  | { readonly kind: "Conflicted" }
  /** Acceptance is genuinely unknown; replaying the same intent converges. */
  | { readonly kind: "Unresolved" }
  /** Terminal for this intent; only a new import can succeed. */
  | { readonly kind: "UnsupportedFileType" }
  | { readonly kind: "FileTooLarge" }
  | { readonly kind: "LibraryForbidden" }
  | { readonly kind: "IntentChanged" }
  | { readonly kind: "FileMismatch" }
  /** The request this client composed does not satisfy the endpoint contract. */
  | { readonly kind: "IntentMalformed" };

export class UploadSessionError extends Error {
  readonly outcome: UploadSessionOutcome;

  constructor(outcome: UploadSessionOutcome, options?: ErrorOptions) {
    super(`Upload session ${outcome.kind}`, options);
    this.name = "UploadSessionError";
    this.outcome = outcome;
  }
}

export type UploadSessionEndpoint =
  | "Create"
  | "TransportFailure"
  | "Retry"
  | "Confirm"
  | "Remove";

function createOutcome(code: string): UploadSessionOutcome | null {
  switch (code) {
    case "E_INVALID_REQUEST":
      return { kind: "IntentMalformed" };
    case "E_INVALID_FILE_TYPE":
      return { kind: "UnsupportedFileType" };
    case "E_FILE_TOO_LARGE":
      return { kind: "FileTooLarge" };
    case "E_LIBRARY_FORBIDDEN":
    case "E_FORBIDDEN":
      return { kind: "LibraryForbidden" };
    case "E_UPLOAD_SESSION_NOT_FOUND":
      return { kind: "Superseded" };
    case "E_IDEMPOTENCY_CONFLICT":
      return { kind: "IntentChanged" };
    case "E_UPLOAD_VERIFICATION_IN_PROGRESS":
    case "E_SIGN_UPLOAD_FAILED":
      return { kind: "Unresolved" };
    default:
      return null;
  }
}

function transportFailureOutcome(code: string): UploadSessionOutcome | null {
  switch (code) {
    case "E_INVALID_REQUEST":
      return { kind: "IntentMalformed" };
    case "E_UPLOAD_SESSION_NOT_FOUND":
      return { kind: "Superseded" };
    default:
      return null;
  }
}

function retryOutcome(code: string): UploadSessionOutcome | null {
  switch (code) {
    case "E_INVALID_REQUEST":
      return { kind: "IntentMalformed" };
    case "E_UPLOAD_SESSION_NOT_FOUND":
    case "E_UPLOAD_ALREADY_PUBLISHED":
    case "E_UPLOAD_GENERATION_STALE":
      return { kind: "Superseded" };
    case "E_UPLOAD_INTENT_MISMATCH":
      return { kind: "FileMismatch" };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      return { kind: "IntentChanged" };
    case "E_RESOURCE_CONFLICT":
      return { kind: "Conflicted" };
    case "E_UPLOAD_VERIFICATION_IN_PROGRESS":
    case "E_SIGN_UPLOAD_FAILED":
      return { kind: "Unresolved" };
    default:
      return null;
  }
}

function confirmOutcome(code: string): UploadSessionOutcome | null {
  switch (code) {
    case "E_INVALID_REQUEST":
      return { kind: "IntentMalformed" };
    case "E_LIBRARY_FORBIDDEN":
      return { kind: "LibraryForbidden" };
    case "E_UPLOAD_SESSION_NOT_FOUND":
    case "E_UPLOAD_GENERATION_STALE":
      return { kind: "Superseded" };
    case "E_UPLOAD_VERIFICATION_IN_PROGRESS":
    case "E_STORAGE_ERROR":
      return { kind: "Unresolved" };
    case "E_STORAGE_MISSING":
      return { kind: "BytesMissing" };
    case "E_SOURCE_INTEGRITY":
      return { kind: "VerificationRejected", code: "E_SOURCE_INTEGRITY" };
    case "E_INVALID_FILE_TYPE":
      return { kind: "VerificationRejected", code: "E_INVALID_FILE_TYPE" };
    case "E_FILE_TOO_LARGE":
      return { kind: "VerificationRejected", code: "E_FILE_TOO_LARGE" };
    default:
      return null;
  }
}

function removeOutcome(code: string): UploadSessionOutcome | null {
  switch (code) {
    case "E_UPLOAD_SESSION_NOT_FOUND":
    case "E_UPLOAD_ALREADY_PUBLISHED":
      return { kind: "Superseded" };
    default:
      return null;
  }
}

/**
 * The one owner of the upload-session error contract: the outcome `endpoint`
 * declares for `error`, or `null` when the endpoint declares nothing for that
 * code and the generic API error channel owns it. A code this returns `null`
 * for is never an upload-lane decision.
 */
export function uploadSessionOutcome(
  endpoint: UploadSessionEndpoint,
  error: unknown,
): UploadSessionOutcome | null {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return null;
  switch (endpoint) {
    case "Create":
      return createOutcome(error.code);
    case "TransportFailure":
      return transportFailureOutcome(error.code);
    case "Retry":
      return retryOutcome(error.code);
    case "Confirm":
      return confirmOutcome(error.code);
    case "Remove":
      return removeOutcome(error.code);
  }
}

/** Outcomes that changed what Imports owes this viewer. */
function importsObligationChanged(outcome: UploadSessionOutcome): boolean {
  switch (outcome.kind) {
    case "NeedsAttention":
    case "VerificationRejected":
    case "Superseded":
    case "Conflicted":
      return true;
    case "BytesMissing":
    case "Unresolved":
    case "UnsupportedFileType":
    case "FileTooLarge":
    case "LibraryForbidden":
    case "IntentChanged":
    case "FileMismatch":
    case "IntentMalformed":
      return false;
  }
}

function uploadSessionFailure(
  endpoint: UploadSessionEndpoint,
  error: unknown,
): unknown {
  const outcome = uploadSessionOutcome(endpoint, error);
  if (outcome === null) return error;
  if (importsObligationChanged(outcome)) publishImportsInvalidation();
  return new UploadSessionError(outcome, { cause: error });
}

/** The two variants the retry endpoint declares (contract §4). */
type RetryResponse = Exclude<UploadResponse, { kind: "Published" }>;

function retryResponse(raw: unknown): RetryResponse {
  const response = decodeUploadResponse(raw);
  if (response.kind === "Published") {
    throw new TypeError(
      "upload retry must answer UploadRequired or NeedsAttention",
    );
  }
  return response;
}

function confirmedUpload(raw: unknown): PublishedUpload {
  const response = decodeUploadResponse(raw);
  if (response.kind !== "Published") {
    throw new TypeError("upload confirmation must publish media");
  }
  return response;
}

function contentTypeFor(kind: UploadFileKind): string {
  return kind === "Pdf" ? "application/pdf" : "application/epub+zip";
}

export function getFileUploadKind(file: File): UploadFileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "Pdf";
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) {
    return "Epub";
  }
  return null;
}

export function getFileUploadError(file: File): string | null {
  const kind = getFileUploadKind(file);
  if (!kind) return "Only PDF and EPUB files are supported.";
  if (file.size === 0) return `${kind.toUpperCase()} files must not be empty.`;
  const maxBytes = kind === "Pdf" ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  return file.size > maxBytes
    ? `${kind.toUpperCase()} files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`
    : null;
}

function publishedResult(response: PublishedUpload): PublishedUploadResult {
  const idempotencyOutcome =
    response.idempotencyOutcome === "Created" ? "created" : "reused";
  return {
    kind: "PublishedUpload",
    mediaId: response.mediaId,
    sourceAttemptId: response.sourceAttemptId,
    idempotencyOutcome,
    duplicate: idempotencyOutcome === "reused",
  };
}

function attentionOutcome(failure: UploadFailure): UploadSessionOutcome {
  switch (failure.kind) {
    case "VerificationFailed":
      return { kind: "VerificationRejected", code: failure.code };
    case "TransportFailed":
    case "CapabilityExpired":
      return { kind: "NeedsAttention" };
  }
}

/** Milliseconds of PUT window this capability still authorizes. */
function putWindowMs(capability: UploadCapability): number {
  return Math.min(
    DIRECT_UPLOAD_PUT_TIMEOUT_MS,
    Date.parse(capability.expiresAt) - Date.now(),
  );
}

async function reportTransportFailure(
  capability: UploadCapability,
  durationMs: number,
  reason: UploadTransportFailure,
): Promise<void> {
  try {
    await apiCommand204(
      `/api/media/uploads/${encodeURIComponent(capability.sessionHandle)}/transport-failure`,
      {
        method: "POST",
        body: JSON.stringify({
          ...reason,
          generation: capability.generation,
          duration_ms: durationMs,
          request_id: createRandomId("upload-transport"),
        }),
      },
    );
  } catch (error) {
    throw uploadSessionFailure("TransportFailure", error);
  }
  publishImportsInvalidation();
}

async function putAndConfirm(
  capability: UploadCapability,
  file: File,
  signal?: AbortSignal,
  onPhaseChange?: (phase: UploadPhase) => void,
): Promise<PublishedUploadResult> {
  const startedAt = performance.now();
  const durationMs = () =>
    Math.max(0, Math.round(performance.now() - startedAt));
  onPhaseChange?.("Uploading");

  const putTimeoutMs = putWindowMs(capability);
  if (putTimeoutMs <= 0) {
    // A capability that closed before a byte moved is not a transport fact:
    // nothing was sent, so nothing timed out. Acceptance is simply unknown and
    // replaying the same intent re-signs a live generation.
    throw new UploadSessionError({ kind: "Unresolved" });
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
    putController.abort(
      new DOMException("Direct upload PUT deadline exceeded", "TimeoutError"),
    );
  }, putTimeoutMs);

  let response: Response;
  try {
    response = await fetch(capability.uploadUrl, {
      method: "PUT",
      headers: capability.requiredHeaders,
      body: file,
      signal: putController.signal,
    });
  } catch (error) {
    if (putTimedOut) {
      await reportTransportFailure(capability, durationMs(), {
        kind: "Timeout",
      });
      throw new UploadSessionError({ kind: "NeedsAttention" });
    }
    if (signal?.aborted || isAbortError(error)) {
      await reportTransportFailure(capability, durationMs(), {
        kind: "Aborted",
      });
      throw error;
    }
    await reportTransportFailure(capability, durationMs(), { kind: "Network" });
    throw new UploadSessionError({ kind: "NeedsAttention" });
  } finally {
    globalThis.clearTimeout(putTimeout);
    signal?.removeEventListener("abort", abortForCaller);
  }
  if (!response.ok) {
    await reportTransportFailure(capability, durationMs(), {
      kind: "HttpRejected",
      status: response.status,
    });
    throw new UploadSessionError({ kind: "NeedsAttention" });
  }

  onPhaseChange?.("Verifying");
  try {
    return publishedResult(
      decodeApiPayload(
        await apiFetch<unknown>(
          `/api/media/uploads/${encodeURIComponent(capability.sessionHandle)}/confirm`,
          {
            method: "POST",
            body: JSON.stringify({ generation: capability.generation }),
            signal,
          },
        ),
        confirmedUpload,
        "POST /api/media/uploads/:session/confirm",
      ),
    );
  } catch (error) {
    throw uploadSessionFailure("Confirm", error);
  }
}

export async function uploadIngestFile({
  file,
  libraryIds,
  idempotencyKey = createRandomId("media-upload"),
  signal,
  onPhaseChange,
}: {
  file: File;
  libraryIds: readonly string[];
  idempotencyKey?: string;
  signal?: AbortSignal;
  onPhaseChange?: (phase: UploadPhase) => void;
}): Promise<PublishedUploadResult> {
  const invalid = getFileUploadError(file);
  if (invalid) throw new Error(invalid);
  const kind = getFileUploadKind(file);
  if (!kind) throw new Error("Only PDF and EPUB files are supported.");
  onPhaseChange?.("Preparing");

  const create = async (): Promise<UploadResponse> => {
    try {
      return decodeApiPayload(
        await apiFetch<unknown>("/api/media/uploads", {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            kind,
            filename: file.name,
            content_type: contentTypeFor(kind),
            size_bytes: file.size,
            library_ids: libraryIds,
          }),
          signal,
        }),
        decodeUploadResponse,
        "POST /api/media/uploads",
      );
    } catch (error) {
      throw uploadSessionFailure("Create", error);
    }
  };

  let started = await create();
  // A capability whose window closed during its own signing round trip never
  // authorized a PUT. Replaying the same key advances the expired generation
  // and re-signs it rather than reporting a transport failure that never was.
  if (started.kind === "UploadRequired" && putWindowMs(started) <= 0) {
    started = await create();
  }
  if (started.kind === "Published") {
    publishLibraryPlacementChange([...libraryIds]);
    publishImportsInvalidation();
    return publishedResult(started);
  }
  if (started.kind === "NeedsAttention") {
    publishImportsInvalidation();
    throw new UploadSessionError(attentionOutcome(started.failure));
  }
  const result = await putAndConfirm(started, file, signal, onPhaseChange);
  publishLibraryPlacementChange([...libraryIds]);
  publishImportsInvalidation();
  return result;
}

/**
 * Re-admit a failed upload session at the generation the reader's offer named,
 * then send the bytes again. The server answers `UploadRequired` with a fresh
 * capability for exactly that generation, or `NeedsAttention` when the session
 * still owes the reader something a retry cannot settle; both are modeled
 * outcomes, and only a raised `UploadSessionError` reports one.
 */
export async function retryUploadSession({
  sessionHandle,
  file,
  expectedGeneration,
  clientMutationId,
  signal,
}: {
  readonly sessionHandle: string;
  readonly file: File;
  readonly expectedGeneration: number;
  readonly clientMutationId: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const kind = getFileUploadKind(file);
  // A file this client cannot upload at all can never match the session intent
  // the server holds, so it is the same modeled mismatch the server reports.
  if (!kind || getFileUploadError(file)) {
    throw new UploadSessionError({ kind: "FileMismatch" });
  }
  const request = async (): Promise<RetryResponse> => {
    try {
      return decodeApiPayload(
        await apiFetch<unknown>(
          `/api/media/uploads/${encodeURIComponent(sessionHandle)}/retry`,
          {
            method: "POST",
            body: JSON.stringify({
              filename: file.name,
              content_type: contentTypeFor(kind),
              size_bytes: file.size,
              client_mutation_id: clientMutationId,
              expected_generation: expectedGeneration,
            }),
            signal,
          },
        ),
        retryResponse,
        "POST /api/media/uploads/:session/retry",
      );
    } catch (error) {
      throw uploadSessionFailure("Retry", error);
    }
  };

  try {
    const admitted = await request();
    if (admitted.kind === "NeedsAttention") {
      publishImportsInvalidation();
      throw new UploadSessionError(attentionOutcome(admitted.failure));
    }
    if (putWindowMs(admitted) <= 0) {
      // The server memoized this generation's expiry and mints its capability
      // without extending it, so a second retry cannot widen the window: the
      // window has closed and another renewal needs a fresh explicit command
      // (spec, API and recovery admission). That is the same answer the server
      // gives once the memoized expiry has passed.
      publishImportsInvalidation();
      throw new UploadSessionError({ kind: "NeedsAttention" });
    }
    await putAndConfirm(admitted, file, signal);
  } catch (error) {
    // A session that is already published, or already gone, is the obligation
    // discharged rather than a failed action: Imports drops the row.
    if (
      error instanceof UploadSessionError &&
      error.outcome.kind === "Superseded"
    ) {
      return;
    }
    throw error;
  }
  publishLibraryPlacementChange("Unknown");
  publishImportsInvalidation();
}

export async function removeUploadSession(
  sessionHandle: string,
): Promise<void> {
  try {
    await apiCommand204(
      `/api/media/uploads/${encodeURIComponent(sessionHandle)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    const failure = uploadSessionFailure("Remove", error);
    // Removal is idempotent: a session that is already gone, or that published
    // while this row was stale, leaves nothing left to remove.
    if (
      !(
        failure instanceof UploadSessionError &&
        failure.outcome.kind === "Superseded"
      )
    ) {
      throw failure;
    }
    return;
  }
  publishImportsInvalidation();
}

function sourceIngestResult(
  data: Record<string, unknown>,
  name: string,
): SourceIngestResult {
  const idempotencyOutcome = expectOneOf(
    data.idempotency_outcome,
    SOURCE_IDEMPOTENCY_OUTCOMES,
    `${name}.idempotency_outcome`,
  );
  return {
    kind: "SourceIngest",
    mediaId: expectNonemptyString(data.media_id, `${name}.media_id`),
    sourceAttemptId: expectNonemptyString(
      data.source_attempt_id,
      `${name}.source_attempt_id`,
    ),
    sourceType: expectNonemptyString(data.source_type, `${name}.source_type`),
    sourceAttemptStatus: expectOneOf(
      data.source_attempt_status,
      SOURCE_ATTEMPT_STATUSES,
      `${name}.source_attempt_status`,
    ),
    idempotencyOutcome,
    duplicate: idempotencyOutcome === "reused",
    processingStatus: requireDocumentProcessingStatus(
      expectString(data.processing_status, `${name}.processing_status`),
    ),
    ingestEnqueued: data.ingest_enqueued === true,
  };
}

function fromUrlResponse(raw: unknown): SourceIngestResult {
  const name = "URL ingest response";
  const envelope = expectExactRecord(raw, ["data"], name);
  return sourceIngestResult(expectRecord(envelope.data, `${name}.data`), name);
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
  const result = decodeApiPayload(
    await apiFetch<unknown>("/api/media/from-url", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ url, library_ids: libraryIds }),
      signal,
    }),
    fromUrlResponse,
    "POST /api/media/from-url",
  );
  publishLibraryPlacementChange([...libraryIds]);
  publishImportsInvalidation();
  return result;
}

/** Re-fetch a media's source. The refreshed facts arrive through Imports. */
export async function refreshMediaSource(mediaId: string): Promise<void> {
  await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/refresh`,
    { method: "POST" },
  );
  publishImportsInvalidation();
}

export async function retryMediaMetadata(mediaId: string): Promise<void> {
  await apiFetch<unknown>(`/api/media/${encodeURIComponent(mediaId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ from_stage: "metadata" }),
  });
}
