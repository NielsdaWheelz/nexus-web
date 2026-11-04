"use client";

/** Guarded web acquisition. Initial submission freezes the chosen library ids
 * and the removal revision before provider/storage work. URL replay retains that
 * exact command; receipts are read for current availability. A live upload owner
 * retains its generation, bytes and confirmation; only a known refusal permits
 * reviewed choices with those same bytes. No request identity is persisted.
 * An upload's create and confirm answer within 30 s, its put within the upload window. */

import { publishChange } from "@/lib/api/changes";
import { ApiError, apiFetch, isApiError, isRefusal, requestWithDeadline, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { placements, type AcquisitionGuard } from "@/lib/libraries/api";
import type { BrowsePreview } from "@/lib/browse/api";
import { resolvePodcastEpisode } from "@/lib/podcasts/api";
import {
  UploadSessionError,
  publishImportsInvalidation,
  type UploadSessionOutcome,
} from "@/lib/imports/api";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

/** apiFetch has no deadline of its own. */
const ANSWER_MS = 30_000;

/** Every accepted acquisition, tagged by its lane. An upload's `created` is false when
 * its bytes published to media that already existed. */
export type AcceptedIngest = {
  readonly available: boolean;
  readonly mediaId: string;
  readonly importRef: string;
  readonly href: string;
} & (
  | { readonly kind: "Url"; readonly sourceAttemptId: string;
      readonly processing: "processing" | "ready" | "failed" }
  | { readonly kind: "Upload"; readonly created: boolean; readonly sourceAttemptId: null; readonly processing: null }
);

/** A discovery episode acknowledges canonical media, not an upload/import session. */
export type AcceptedMediaAcquisition = Extract<AcceptedIngest, { kind: "Url" }> | {
  readonly kind: "Episode";
  readonly available: boolean;
  readonly mediaId: string;
  readonly href: string;
};

/** An admission receipt precedes reads of its current availability. */
export type MediaAcceptance = Omit<Extract<AcceptedMediaAcquisition, { kind: "Url" }>, "available">
  | Omit<Extract<AcceptedMediaAcquisition, { kind: "Episode" }>, "available">;

/** Each upload endpoint's declared refusals and what they mean; anything else
    stays a plain ApiError for the generic channel. */
const OUTCOMES: Record<
  "Create" | "Confirm" | "Remove",
  Readonly<Record<string, UploadSessionOutcome>>
> = {
  Create: {
    E_INVALID_REQUEST: { kind: "IntentMalformed" },
    E_INVALID_FILE_TYPE: { kind: "UnsupportedFileType" },
    E_FILE_TOO_LARGE: { kind: "FileTooLarge" },
    E_LIBRARY_FORBIDDEN: { kind: "LibraryForbidden" },
    E_FORBIDDEN: { kind: "LibraryForbidden" },
    E_UPLOAD_INTENT_MISMATCH: { kind: "FileMismatch" },
    E_SIGN_UPLOAD_FAILED: { kind: "Unresolved" },
  },
  Confirm: {
    E_LIBRARY_FORBIDDEN: { kind: "LibraryForbidden" },
    E_UPLOAD_SESSION_NOT_FOUND: { kind: "Superseded" },
    E_UPLOAD_GENERATION_STALE: { kind: "Superseded" },
    E_STORAGE_ERROR: { kind: "Unresolved" },
    E_STORAGE_MISSING: { kind: "BytesMissing" },
    E_UPLOAD_CAPABILITY_EXPIRED: { kind: "Expired" },
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
  Remove: { E_UPLOAD_ALREADY_PUBLISHED: { kind: "Superseded" } },
};

/** An outcome after the session exists changes what Imports owes the reader. */
function outcome(value: UploadSessionOutcome, cause?: unknown) {
  if (value.kind !== "Unresolved" && value.kind !== "IntentMalformed") {
    publishImportsInvalidation();
  }
  return new UploadSessionError(value, { cause });
}

async function call<T>(
  endpoint: keyof typeof OUTCOMES,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const declared =
      isApiError(error) && !isSameSystemApiDefect(error)
        ? OUTCOMES[endpoint][error.code]
        : undefined;
    throw declared === undefined ? error : outcome(declared, error);
  }
}

export function getFileUploadKind(file: File): UploadFileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "Pdf";
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) {
    return "Epub";
  }
  return null;
}

/** What the browser can tell before sending; the size limit is the server's. */
export function getFileUploadError(file: File): string | null {
  if (getFileUploadKind(file) === null) return "pdf or epub only";
  return file.size === 0 ? "this file is empty" : null;
}

const MIB = 1024 * 1024;
/** `max_pdf_bytes` and `max_epub_bytes` in python/nexus/config.py. */
const UPLOAD_LIMIT_BYTES: Readonly<Record<UploadFileKind, number>> = { Pdf: 100 * MIB, Epub: 50 * MIB };

/** Why create would refuse this file, read before any request: create's own name rule
 * (trimmed, last path segment, trimmed, then 1 to 255 code points) and the limits above. */
export function uploadFileRefusal(file: File): "WrongType" | "Empty" | "TooBig" | "Nameless" | "NameTooLong" | null {
  const kind = getFileUploadKind(file);
  if (kind === null) return "WrongType";
  if (file.size === 0) return "Empty";
  if (file.size > UPLOAD_LIMIT_BYTES[kind]) return "TooBig";
  const name = file.name.trim().replaceAll("\\", "/").split("/").pop()!.trim();
  if (name === "") return "Nameless";
  return [...name].length > 255 ? "NameTooLong" : null;
}

/** The actual form/visit owns this memory; it never lives in browser storage. */
export interface UploadAttempt {
  readonly id: string;
  guard: AcquisitionGuard | null;
  session: Schema<"UploadRequired"> | null;
  confirmation: Schema<"ConfirmUploadRequest"> | null;
  confirmation_unsettled: boolean;
  bytes_uploaded: boolean;
  review_required: boolean;
  expired: boolean;
}

export function createUploadAttempt(id = crypto.randomUUID()): UploadAttempt {
  return { id, guard: null, session: null, confirmation: null, confirmation_unsettled: false, bytes_uploaded: false, review_required: false, expired: false };
}

/** Explicit review after a known refusal. An unknown confirmation cannot be edited. */
export function reviewUploadAttempt(attempt: UploadAttempt): void {
  if (!attempt.review_required || attempt.confirmation_unsettled) return;
  attempt.guard = null;
  attempt.confirmation = null;
  attempt.review_required = false;
}

/** A live attempt reuses its staged bytes and exact confirmation after response loss.
 * A fence or authority refusal permits explicit review with the same session/generation;
 * a refused create forgets its guard, so the next create names the reviewed libraries.
 * Losing the owner requires file reselection; expired bytes cannot be resumed.
 * `exclusive` runs the confirm, the one step serializable under the viewer lock, in the
 * caller's one-at-a-time acquisition slot (docs/issues/concurrent-acquisitions-exhaust-retry.md). */
export async function uploadIngestFile({ file, attempt, guard, signal = new AbortController().signal, exclusive = run => run(), onPhaseChange, onProgress }: {
  file: File;
  attempt: UploadAttempt;
  guard: AcquisitionGuard;
  signal?: AbortSignal;
  exclusive?: <T>(run: () => Promise<T>) => Promise<T>;
  onPhaseChange?: (phase: UploadPhase) => void;
  /** Bytes the put has sent so far. */
  onProgress?: (sentBytes: number) => void;
}): Promise<Extract<AcceptedIngest, { kind: "Upload" }>> {
  const kind = getFileUploadKind(file);
  if (kind === null || getFileUploadError(file) !== null) throw outcome({ kind: "UnsupportedFileType" });
  if (attempt.expired) throw outcome({ kind: "Expired" });
  if (attempt.review_required) throw new ApiError(409, "E_RESOURCE_CONFLICT", "save needs review");
  attempt.guard ??= guard;
  onPhaseChange?.("Preparing");
  let published: Schema<"Published">;
  if (attempt.session === null) {
    let answer: Schema<"UploadRequired"> | Schema<"Published"> | Schema<"Rejected">;
    try {
      answer = (await call("Create", () => requestWithDeadline({ signal, timeoutMs: ANSWER_MS, request: signal =>
        apiFetch<ApiJson<"/media/uploads", "post">>("/api/media/uploads", {
          method: "POST", body: JSON.stringify({ id: attempt.id, kind: kind === "Pdf" ? "pdf" : "epub",
            filename: file.name, content_type: kind === "Pdf" ? "application/pdf" : "application/epub+zip",
            size_bytes: file.size, library_ids: attempt.guard!.destinations }), signal,
        }) }))).data;
    } catch (error) {
      if (isRefusal(error instanceof UploadSessionError ? error.cause : error)) attempt.guard = null;
      throw error;
    }
    if (answer.kind === "Rejected") throw outcome({ kind: "VerificationRejected", code: answer.code });
    if (answer.kind === "Published") published = answer;
    else { attempt.session = answer; published = await transferAndConfirm(); }
  } else published = await transferAndConfirm();
  publishChange("Entries");
  publishImportsInvalidation();
  return { kind: "Upload", available: published.current_placements !== null, created: published.created, mediaId: published.media_id,
    importRef: published.import_ref, href: `/media/${published.media_id}`, sourceAttemptId: null, processing: null };

  async function transferAndConfirm(): Promise<Schema<"Published">> {
    const upload = attempt.session!;
    if (!attempt.bytes_uploaded) {
      onPhaseChange?.("Uploading");
      const remaining = Date.parse(upload.expires_at) - Date.now();
      if (remaining <= 0) { attempt.expired = true; throw outcome({ kind: "Expired" }); }
      let status: number;
      try {
        status = await requestWithDeadline({ signal, timeoutMs: remaining, request: signal => put(upload, file, signal, onProgress) });
      } catch (error) {
        if (signal.aborted) throw error;
        throw outcome({ kind: "BytesMissing" }, error);
      }
      if (status < 200 || status >= 300) throw outcome({ kind: "BytesMissing" });
      attempt.bytes_uploaded = true;
    }
    attempt.confirmation ??= { generation: upload.generation, ...attempt.guard! };
    const confirmation = attempt.confirmation;
    const unsettled = attempt.confirmation_unsettled;
    try {
      return await exclusive(async () => {
        signal.throwIfAborted();
        onPhaseChange?.("Verifying");
        attempt.confirmation_unsettled = true;
        const published = (await call("Confirm", () => requestWithDeadline({ signal, timeoutMs: ANSWER_MS, request: signal =>
          apiFetch<ApiJson<"/media/uploads/{session_id}/confirm", "post">>(
            `/api/media/uploads/${encodeURIComponent(upload.session_id)}/confirm`,
            { method: "POST", body: JSON.stringify(confirmation), signal },
          ) }))).data;
        attempt.confirmation_unsettled = false;
        return published;
      });
    } catch (error) {
      if (isRefusal(error) || error instanceof UploadSessionError) attempt.confirmation_unsettled = unsettled;
      if (error instanceof UploadSessionError && (error.outcome.kind === "Superseded"
        || error.outcome.kind === "Expired" || error.outcome.kind === "VerificationRejected")) attempt.confirmation_unsettled = false;
      if (isApiError(error) && ["E_RESOURCE_CONFLICT", "E_FORBIDDEN", "E_LIBRARY_NOT_FOUND"].includes(error.code)
        || error instanceof UploadSessionError && error.outcome.kind === "LibraryForbidden") {
        // Confirmation and auth bootstrap report technical contention as busy, not a filing refusal.
        attempt.confirmation_unsettled = false;
        attempt.review_required = true;
      }
      if (error instanceof UploadSessionError && error.outcome.kind === "Expired") attempt.expired = true;
      if (error instanceof UploadSessionError && error.outcome.kind === "BytesMissing") attempt.bytes_uploaded = false;
      throw error;
    }
  }
}

/** The put goes through xhr because fetch reports no upload progress. It resolves with the
 * status once the whole answer arrived, and rejects as an abort when `signal` aborts. */
function put(upload: Schema<"UploadRequired">, file: File, signal: AbortSignal, onProgress?: (sentBytes: number) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", upload.upload_url);
    xhr.setRequestHeader("Content-Type", upload.content_type);
    if (onProgress) xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onload = () => { signal.removeEventListener("abort", abort); resolve(xhr.status); };
    xhr.onerror = () => { signal.removeEventListener("abort", abort); reject(new TypeError("upload put failed")); };
    xhr.onabort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

/** Removal is idempotent; a session already published counts as removed. */
export async function removeUploadSession(sessionId: string): Promise<void> {
  try {
    await call("Remove", () =>
      apiFetch<void>(`/api/media/uploads/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }),
    );
  } catch (error) {
    if (
      !(error instanceof UploadSessionError) ||
      error.outcome.kind !== "Superseded"
    ) {
      throw error;
    }
  }
  publishImportsInvalidation();
}

/** Accept one link as attempt `id`, and only that: no invalidation and no availability
 * read, which the caller owns. Sending the same id again answers the same acceptance. */
export async function acceptUrl({ url, guard, id, signal }: {
  url: string;
  guard: AcquisitionGuard;
  id: string;
  signal?: AbortSignal;
}): Promise<Schema<"FromUrlOut">> {
  const { data } = await apiFetch<ApiJson<"/media/from-url", "post">>("/api/media/from-url", {
    method: "POST", body: JSON.stringify({ id, url, ...guard }), signal,
  });
  return data;
}

/** Accept one link as attempt `id`, then read where it landed and whether it is still there. */
export async function addMediaFromUrl({
  url,
  guard,
  id,
  signal,
  onAccepted,
}: {
  url: string;
  guard: AcquisitionGuard;
  id: string;
  signal?: AbortSignal;
  onAccepted?: (receipt: Extract<MediaAcceptance, { kind: "Url" }>) => void;
}): Promise<Extract<AcceptedIngest, { kind: "Url" }>> {
  const data = await acceptUrl({ url, guard, id, signal });
  publishChange("Entries");
  publishImportsInvalidation();
  const status = data.processing_status;
  const receipt: Extract<MediaAcceptance, { kind: "Url" }> = {
    kind: "Url", mediaId: data.media_id, importRef: data.import_ref,
    href: `/media/${data.media_id}?source_attempt_id=${encodeURIComponent(data.source_attempt_id)}`,
    sourceAttemptId: data.source_attempt_id,
    processing: status === "failed" ? "failed" : status === "ready_for_reading" ? "ready" : "processing",
  };
  onAccepted?.(receipt);
  let available: boolean;
  let currentMediaId = receipt.mediaId;
  let currentImportRef = receipt.importRef;
  try {
    const current = await fetchAcceptedSource(data.source_attempt_id, signal);
    currentMediaId = current.media_id;
    currentImportRef = current.import_ref;
    available = await mediaAcquisitionAvailable(current.media_id, signal);
  } catch (error) {
    if (isApiError(error) && error.status === 404) available = false;
    else throw error;
  }
  return { ...receipt, mediaId: currentMediaId, importRef: currentImportRef,
    href: `/media/${currentMediaId}?source_attempt_id=${encodeURIComponent(receipt.sourceAttemptId)}`, available };
}

/** A receipt proves acceptance; current media and placement reads prove availability. */
export async function mediaAcquisitionAvailable(mediaId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${mediaId}`, { signal });
    await placements({ kind: "Media", id: mediaId }, signal);
    return true;
  } catch (error) {
    if (isApiError(error) && error.status === 404) return false;
    throw error;
  }
}

/** Resolve an accepted source through its durable attempt, including after deduplication. */
export async function fetchAcceptedSource(sourceAttemptId: string, signal?: AbortSignal) {
  const { data } = await apiFetch<ApiJson<"/media/source-attempts/{source_attempt_id}", "get">>(
    `/api/media/source-attempts/${encodeURIComponent(sourceAttemptId)}`,
    { signal },
  );
  return data;
}

/** Explicit URL acquisition or catalogue-only episode resolution. Filing stays with the caller. */
export async function acquirePreviewMedia({ preview, guard, id, signal, onAccepted }: {
  readonly preview: BrowsePreview;
  readonly guard: AcquisitionGuard;
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly onAccepted?: (receipt: MediaAcceptance) => void;
}): Promise<AcceptedMediaAcquisition> {
  if (preview.kind === "Episode") {
    const result = await resolvePodcastEpisode(preview.target, signal);
    const receipt = { kind: "Episode" as const, mediaId: result.media_id, href: result.href };
    onAccepted?.(receipt);
    return { ...receipt, available: await mediaAcquisitionAvailable(result.media_id, signal) };
  }
  if (preview.kind === "Podcast") throw new Error("podcast subscription is not media acquisition");
  return addMediaFromUrl({
    url: preview.kind === "Epub" ? preview.kind_facts.import_href : preview.source_href,
    guard, id, signal, onAccepted,
  });
}
