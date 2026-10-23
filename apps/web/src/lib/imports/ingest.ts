"use client";

/** Guarded web acquisition. Initial submission freezes reviewed library revisions
 * and the removal revision before provider/storage work. URL replay retains that
 * exact command; receipts are read for current availability. A live upload owner
 * retains its generation, bytes and confirmation; only a known refusal permits
 * reviewed choices with those same bytes. No request identity is persisted. */

import { publishChange } from "@/lib/api/changes";
import { ApiError, apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { placements, readAcquisitionGuard, type AcquisitionGuard } from "@/lib/libraries/api";
import type { BrowsePreview } from "@/lib/browse/api";
import { addEpisodeFromDiscovery } from "@/lib/podcasts/api";
import {
  UploadSessionError,
  publishImportsInvalidation,
  type UploadSessionOutcome,
} from "@/lib/imports/api";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

/** Every accepted acquisition, tagged by its lane. */
export type AcceptedIngest = {
  readonly available: boolean;
  readonly mediaId: string;
  readonly importRef: string;
  readonly href: string;
} & (
  | { readonly kind: "Url"; readonly sourceAttemptId: string;
      readonly processing: "processing" | "ready" | "failed" }
  | { readonly kind: "Upload"; readonly sourceAttemptId: null; readonly processing: null }
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
  const kind = getFileUploadKind(file);
  if (kind === null) return "Only PDF and EPUB files are supported.";
  return file.size === 0
    ? `${kind.toUpperCase()} files must not be empty.`
    : null;
}

/** The actual form/visit owns this memory; it never lives in browser storage. */
export interface UploadAttempt {
  readonly id: string;
  guard: AcquisitionGuard | null;
  session: Schema<"UploadRequired"> | null;
  confirmation: Schema<"ConfirmUploadRequest"> | null;
  bytes_uploaded: boolean;
  review_required: boolean;
  expired: boolean;
}

export function createUploadAttempt(id = crypto.randomUUID()): UploadAttempt {
  return { id, guard: null, session: null, confirmation: null, bytes_uploaded: false, review_required: false, expired: false };
}

/** Explicit review after a known refusal. An unknown confirmation cannot be edited. */
export function reviewUploadAttempt(attempt: UploadAttempt): void {
  if (!attempt.review_required) return;
  attempt.guard = null;
  attempt.confirmation = null;
  attempt.review_required = false;
}

/** A live attempt reuses its staged bytes and exact confirmation after response loss.
 * A revision refusal permits explicit review with the same session/generation.
 * Losing the owner requires file reselection; expired bytes cannot be resumed. */
export async function uploadIngestFile({ file, attempt, guard, signal, onPhaseChange, onImportRef }: {
  file: File;
  attempt: UploadAttempt;
  guard?: AcquisitionGuard;
  signal?: AbortSignal;
  onPhaseChange?: (phase: UploadPhase) => void;
  onImportRef?: (ref: string) => void;
}): Promise<AcceptedIngest> {
  const kind = getFileUploadKind(file);
  if (kind === null || getFileUploadError(file) !== null) throw outcome({ kind: "UnsupportedFileType" });
  if (attempt.expired) throw outcome({ kind: "Expired" });
  if (attempt.review_required) throw new ApiError(409, "E_RESOURCE_CONFLICT", "save needs review");
  attempt.guard ??= guard ?? await readAcquisitionGuard([], signal);
  onPhaseChange?.("Preparing");
  let published: Schema<"Published">;
  if (attempt.session === null) {
    const { data: created } = await call("Create", () => apiFetch<ApiJson<"/media/uploads", "post">>("/api/media/uploads", {
      method: "POST", body: JSON.stringify({ id: attempt.id, kind: kind === "Pdf" ? "pdf" : "epub",
        filename: file.name, content_type: kind === "Pdf" ? "application/pdf" : "application/epub+zip",
        size_bytes: file.size, library_ids: attempt.guard!.destinations.map(destination => destination.library_id) }), signal,
    }));
    onImportRef?.(created.import_ref);
    if (created.kind === "Rejected") throw outcome({ kind: "VerificationRejected", code: created.code });
    if (created.kind === "Published") published = created;
    else { attempt.session = created; published = await transferAndConfirm(); }
  } else {
    onImportRef?.(attempt.session.import_ref);
    published = await transferAndConfirm();
  }
  publishChange("Entries");
  publishImportsInvalidation();
  return { kind: "Upload", available: published.current_placements !== null, mediaId: published.media_id,
    importRef: published.import_ref, href: `/media/${published.media_id}`, sourceAttemptId: null, processing: null };

  async function transferAndConfirm(): Promise<Schema<"Published">> {
    const upload = attempt.session!;
    if (!attempt.bytes_uploaded) {
      onPhaseChange?.("Uploading");
      const remaining = Date.parse(upload.expires_at) - Date.now();
      if (remaining <= 0) { attempt.expired = true; throw outcome({ kind: "Expired" }); }
      let response: Response;
      try {
        const deadline = AbortSignal.timeout(remaining);
        response = await fetch(upload.upload_url, { method: "PUT", headers: { "Content-Type": upload.content_type },
          body: file, signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw outcome({ kind: "BytesMissing" }, error);
      }
      if (!response.ok) throw outcome({ kind: "BytesMissing" });
      attempt.bytes_uploaded = true;
    }
    onPhaseChange?.("Verifying");
    attempt.confirmation ??= { generation: upload.generation, ...attempt.guard! };
    try {
      return (await call("Confirm", () => apiFetch<ApiJson<"/media/uploads/{session_id}/confirm", "post">>(
        `/api/media/uploads/${encodeURIComponent(upload.session_id)}/confirm`,
        { method: "POST", body: JSON.stringify(attempt.confirmation), signal },
      ))).data;
    } catch (error) {
      if (isApiError(error) && error.code === "E_RESOURCE_CONFLICT"
        || error instanceof UploadSessionError && error.outcome.kind === "LibraryForbidden") attempt.review_required = true;
      if (error instanceof UploadSessionError && error.outcome.kind === "Expired") attempt.expired = true;
      if (error instanceof UploadSessionError && error.outcome.kind === "BytesMissing") attempt.bytes_uploaded = false;
      throw error;
    }
  }
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

/** Accept one link as attempt `id`; sending the same id again answers the same acceptance. */
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
  const { data } = await apiFetch<ApiJson<"/media/from-url", "post">>(
    "/api/media/from-url",
    {
      method: "POST",
      body: JSON.stringify({ id, url, ...guard }),
      signal,
    },
  );
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

/** One explicit preview acquisition. URL retries keep id; episode retries dedupe by source. */
export async function acquirePreviewMedia({ preview, guard, id, signal, onAccepted }: {
  readonly preview: BrowsePreview;
  readonly guard: AcquisitionGuard;
  readonly id: string;
  readonly signal?: AbortSignal;
  readonly onAccepted?: (receipt: MediaAcceptance) => void;
}): Promise<AcceptedMediaAcquisition> {
  if (preview.kind === "Episode") {
    const result = await addEpisodeFromDiscovery({ target: preview.target, guard, signal,
      onAccepted: receipt => onAccepted?.({ kind: "Episode", mediaId: receipt.media_id, href: receipt.href }),
    });
    return { kind: "Episode", available: result.available, mediaId: result.media_id, href: result.href };
  }
  if (preview.kind === "Podcast") throw new Error("podcast subscription is not media acquisition");
  return addMediaFromUrl({
    url: preview.kind === "Epub" ? preview.kind_facts.import_href : preview.source_href,
    guard, id, signal, onAccepted,
  });
}
