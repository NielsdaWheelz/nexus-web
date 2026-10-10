"use client";

/**
 * Acquisition (docs/modules/add-content.md): links through `from-url`, files
 * through the upload-session protocol, and the Imports upload commands. An
 * upload publishes only after the server verifies the bytes; a PUT never starts
 * without a positive window and stops at min(240 s, capability expiry); every
 * transport failure is reported; a lost acknowledgement is settled by replaying
 * the same idempotency key.
 */

import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiCommand204,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  isUnauthenticatedApiError,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import {
  UploadSessionError,
  publishImportsInvalidation,
  type UploadSessionOutcome,
} from "@/lib/imports/api";
import {
  captureErrorFeedback,
  captureStatusLine,
  type CaptureOperation,
} from "@/lib/imports/copy";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

/** Every accepted acquisition, tagged by its lane. */
export interface AcceptedIngest {
  readonly kind: "Url" | "Upload";
  readonly mediaId: string;
  /** The server reused an earlier acceptance of this intent or content. */
  readonly duplicate: boolean;
  /** A link's processing as accepted; `failed` covers a failed attempt too. */
  readonly processing: "processing" | "ready" | "failed" | null;
}

type SourceUrlCaptureResult =
  | { label: string; ok: true; status: string; path: string }
  | { label: string; ok: false; feedback: FeedbackContent };

// Cross-runtime storage-cleanup contract (python/nexus/config.py): the server
// rejects a cleanup window not strictly longer than this browser PUT horizon.
const DIRECT_UPLOAD_PUT_TIMEOUT_MS = 240_000;

type UploadCapability = Schema<"UploadRequired">;
/** What the browser's PUT did, as `POST …/transport-failure` reports it. */
type TransportFailure =
  | { readonly kind: "Network" | "Timeout" | "Aborted" }
  | { readonly kind: "HttpRejected"; readonly status: number };
type Endpoint = "Create" | "TransportFailure" | "Retry" | "Confirm" | "Remove";
type Outcome = UploadSessionOutcome;

/**
 * Each endpoint's declared error codes and the outcome each one means. A code
 * an endpoint does not list stays a plain ApiError for the generic channel.
 */
const OUTCOMES: Readonly<Record<Endpoint, Readonly<Record<string, Outcome>>>> =
  {
    Create: {
      E_INVALID_REQUEST: { kind: "IntentMalformed" },
      E_INVALID_FILE_TYPE: { kind: "UnsupportedFileType" },
      E_FILE_TOO_LARGE: { kind: "FileTooLarge" },
      E_LIBRARY_FORBIDDEN: { kind: "LibraryForbidden" },
      E_FORBIDDEN: { kind: "LibraryForbidden" },
      E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
      E_IDEMPOTENCY_CONFLICT: { kind: "IntentChanged" },
      E_SIGN_UPLOAD_FAILED: { kind: "Unresolved" },
    },
    TransportFailure: {
      E_INVALID_REQUEST: { kind: "IntentMalformed" },
      E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
    },
    Retry: {
      E_INVALID_REQUEST: { kind: "IntentMalformed" },
      E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
      E_UPLOAD_ALREADY_PUBLISHED: { kind: "Superseded" },
      E_UPLOAD_GENERATION_STALE: { kind: "Superseded" },
      E_UPLOAD_INTENT_MISMATCH: { kind: "FileMismatch" },
      E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: { kind: "IntentChanged" },
      E_RESOURCE_CONFLICT: { kind: "Conflicted" },
      E_SIGN_UPLOAD_FAILED: { kind: "Unresolved" },
    },
    Confirm: {
      E_INVALID_REQUEST: { kind: "IntentMalformed" },
      E_LIBRARY_FORBIDDEN: { kind: "LibraryForbidden" },
      E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
      E_UPLOAD_GENERATION_STALE: { kind: "Superseded" },
      E_STORAGE_ERROR: { kind: "Unresolved" },
      E_STORAGE_MISSING: { kind: "BytesMissing" },
      E_SOURCE_INTEGRITY: {
        kind: "VerificationRejected",
        code: "E_SOURCE_INTEGRITY",
      },
      E_INVALID_FILE_TYPE: {
        kind: "VerificationRejected",
        code: "E_INVALID_FILE_TYPE",
      },
      E_FILE_TOO_LARGE: {
        kind: "VerificationRejected",
        code: "E_FILE_TOO_LARGE",
      },
    },
    Remove: {
      E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
      E_UPLOAD_ALREADY_PUBLISHED: { kind: "Superseded" },
    },
  };

/** An outcome that changed what Imports owes this reader invalidates it. */
function session(outcome: Outcome, cause?: unknown): UploadSessionError {
  const kind = outcome.kind;
  if (
    kind === "NeedsAttention" ||
    kind === "VerificationRejected" ||
    kind === "Superseded" ||
    kind === "Conflicted"
  ) {
    publishImportsInvalidation();
  }
  return new UploadSessionError(outcome, { cause });
}

/** Runs one endpoint call, raising its declared codes as session outcomes. */
async function call<T>(
  endpoint: Endpoint,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const outcome =
      isApiError(error) && !isSameSystemApiDefect(error)
        ? OUTCOMES[endpoint][error.code]
        : undefined;
    throw outcome === undefined ? error : session(outcome, error);
  }
}

function attention(response: Schema<"NeedsAttention">): UploadSessionError {
  const failure = response.failure;
  return session(
    failure.kind === "VerificationFailed"
      ? { kind: "VerificationRejected", code: failure.code }
      : { kind: "NeedsAttention" },
  );
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
  const maxMb = kind === "Pdf" ? 100 : 50;
  return file.size > maxMb * 1024 * 1024
    ? `${kind.toUpperCase()} files must be ${maxMb} MB or smaller.`
    : null;
}

const contentType = (kind: UploadFileKind) =>
  kind === "Pdf" ? "application/pdf" : "application/epub+zip";

const uploadPath = (handle: string, verb = "") =>
  `/api/media/uploads/${encodeURIComponent(handle)}${verb}` as const;

/** Milliseconds of PUT window this capability still authorizes. */
function putWindowMs(capability: UploadCapability): number {
  return Math.min(
    DIRECT_UPLOAD_PUT_TIMEOUT_MS,
    Date.parse(capability.expires_at) - Date.now(),
  );
}

function published(response: Schema<"Published">): AcceptedIngest {
  return {
    kind: "Upload",
    mediaId: response.media_id,
    duplicate: response.idempotency_outcome === "Reused",
    processing: null,
  };
}

/**
 * Send the bytes under the capability's window, report any transport failure,
 * then confirm. A caller's abort is reported and rethrown; every other
 * transport failure leaves the session needing attention in Imports.
 */
async function putAndConfirm(
  capability: UploadCapability,
  file: File,
  signal?: AbortSignal,
  onPhaseChange?: (phase: UploadPhase) => void,
): Promise<AcceptedIngest> {
  const handle = capability.session_handle;
  const startedAt = performance.now();
  const report = async (reason: TransportFailure) => {
    await call("TransportFailure", () =>
      apiCommand204(uploadPath(handle, "/transport-failure"), {
        method: "POST",
        body: JSON.stringify({
          ...reason,
          generation: capability.generation,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          request_id: createRandomId("upload-transport"),
        }),
      }),
    );
    publishImportsInvalidation();
  };
  onPhaseChange?.("Uploading");
  const windowMs = putWindowMs(capability);
  // A window that closed before a byte moved is no transport fact: nothing
  // was sent. Replaying the same intent re-signs a live generation.
  if (windowMs <= 0) throw new UploadSessionError({ kind: "Unresolved" });
  const deadline = AbortSignal.timeout(windowMs);
  const put =
    signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  let response: Response;
  try {
    response = await fetch(capability.upload_url, {
      method: "PUT",
      headers: capability.required_headers,
      body: file,
      signal: put,
    });
  } catch (error) {
    if (deadline.aborted) {
      await report({ kind: "Timeout" });
    } else if (signal?.aborted || isAbortError(error)) {
      await report({ kind: "Aborted" });
      throw error;
    } else {
      await report({ kind: "Network" });
    }
    throw new UploadSessionError({ kind: "NeedsAttention" });
  }
  if (!response.ok) {
    await report({ kind: "HttpRejected", status: response.status });
    throw new UploadSessionError({ kind: "NeedsAttention" });
  }
  onPhaseChange?.("Verifying");
  const { data } = await call("Confirm", () =>
    apiFetch<ApiJson<"/media/uploads/{session_handle}/confirm", "post">>(
      uploadPath(handle, "/confirm"),
      {
        method: "POST",
        body: JSON.stringify({ generation: capability.generation }),
        signal,
      },
    ),
  );
  return published(data);
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
}): Promise<AcceptedIngest> {
  const invalid = getFileUploadError(file);
  const kind = getFileUploadKind(file);
  if (invalid !== null || kind === null) throw new Error(invalid ?? "");
  onPhaseChange?.("Preparing");
  const create = () =>
    call("Create", async () => {
      const { data } = await apiFetch<ApiJson<"/media/uploads", "post">>(
        "/api/media/uploads",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            kind,
            filename: file.name,
            content_type: contentType(kind),
            size_bytes: file.size,
            library_ids: libraryIds,
          }),
          signal,
        },
      );
      return data;
    });
  let started = await create();
  // A capability whose window closed during its own signing round trip never
  // authorized a PUT: replaying the key advances the generation and re-signs.
  if (started.kind === "UploadRequired" && putWindowMs(started) <= 0) {
    started = await create();
  }
  if (started.kind === "NeedsAttention") throw attention(started);
  const result =
    started.kind === "Published"
      ? published(started)
      : await putAndConfirm(started, file, signal, onPhaseChange);
  publishLibraryPlacementChange([...libraryIds]);
  publishImportsInvalidation();
  return result;
}

/**
 * Re-admit a failed upload session at the generation the reader's offer named,
 * then send the bytes again. A session already published or gone is the
 * obligation discharged, so Superseded counts as success.
 */
export async function retryUploadSession({
  sessionHandle,
  file,
  expectedGeneration,
}: {
  readonly sessionHandle: string;
  readonly file: File;
  readonly expectedGeneration: number;
}): Promise<void> {
  const kind = getFileUploadKind(file);
  // A file this client cannot upload can never match the session's intent.
  if (!kind || getFileUploadError(file)) {
    throw new UploadSessionError({ kind: "FileMismatch" });
  }
  try {
    const { data: admitted } = await call("Retry", () =>
      apiFetch<ApiJson<"/media/uploads/{session_handle}/retry", "post">>(
        uploadPath(sessionHandle, "/retry"),
        {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            content_type: contentType(kind),
            size_bytes: file.size,
            client_mutation_id: crypto.randomUUID(),
            expected_generation: expectedGeneration,
          }),
        },
      ),
    );
    if (admitted.kind === "NeedsAttention") throw attention(admitted);
    // The server memoizes this generation's expiry, so a closed window cannot
    // be widened by retrying again: it needs a fresh command.
    if (putWindowMs(admitted) <= 0) throw session({ kind: "NeedsAttention" });
    await putAndConfirm(admitted, file);
  } catch (error) {
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

/** Removal is idempotent: a session already gone or published is removed. */
export async function removeUploadSession(
  sessionHandle: string,
): Promise<void> {
  try {
    await call("Remove", () =>
      apiCommand204(uploadPath(sessionHandle), { method: "DELETE" }),
    );
  } catch (error) {
    if (
      error instanceof UploadSessionError &&
      error.outcome.kind === "Superseded"
    ) {
      return;
    }
    throw error;
  }
  publishImportsInvalidation();
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
}): Promise<AcceptedIngest> {
  const { data } = await apiFetch<ApiJson<"/media/from_url", "post">>(
    "/api/media/from-url",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ url, library_ids: libraryIds }),
      signal,
    },
  );
  publishLibraryPlacementChange([...libraryIds]);
  publishImportsInvalidation();
  const status = data.processing_status;
  return {
    kind: "Url",
    mediaId: data.media_id,
    duplicate: data.idempotency_outcome === "reused",
    processing:
      status === "failed" || data.source_attempt_status === "failed"
        ? "failed"
        : status === "ready_for_reading"
          ? "ready"
          : "processing",
  };
}

/**
 * Save one link for a capture surface (the share sheet): its status line and
 * reader path, or the refusal's feedback. Sign-in, aborts and defects throw.
 */
export async function captureSourceUrl({
  url,
  libraryIds,
  idempotencyKey,
  operation,
  signal,
}: {
  url: string;
  libraryIds: readonly string[];
  idempotencyKey?: string;
  operation: CaptureOperation;
  signal?: AbortSignal;
}): Promise<SourceUrlCaptureResult> {
  try {
    const result = await addMediaFromUrl({
      url,
      libraryIds,
      idempotencyKey,
      signal,
    });
    return {
      label: url,
      ok: true,
      status: captureStatusLine(result),
      path: `/media/${result.mediaId}`,
    };
  } catch (error) {
    if (
      isUnauthenticatedApiError(error) ||
      signal?.aborted ||
      isAbortError(error)
    ) {
      throw error;
    }
    const feedback = captureErrorFeedback(error, operation);
    return { label: url, ok: false, feedback };
  }
}
