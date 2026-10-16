"use client";

/**
 * Acquisition from the web (docs/modules/ingest.md): links through `from-url`,
 * files through upload sessions (create -> PUT the bytes to the signed url ->
 * confirm). Every call carries the caller's id, so sending it again is the
 * retry: a link answers its own acceptance; an upload advances its session, or
 * answers what it published. The server owns every limit; this module refuses
 * only what it cannot send.
 */

import type { FeedbackContextValue } from "@/components/feedback/Feedback";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  UploadSessionError,
  publishImportsInvalidation,
  type UploadSessionOutcome,
} from "@/lib/imports/api";

export type UploadFileKind = "Pdf" | "Epub";
export type UploadPhase = "Preparing" | "Uploading" | "Verifying";

/** Every accepted acquisition, tagged by its lane. */
export interface AcceptedIngest {
  readonly kind: "Url" | "Upload";
  readonly mediaId: string;
  readonly importRef: string;
  /** A link's processing as accepted; `failed` covers a failed attempt too. */
  readonly processing: "processing" | "ready" | "failed" | null;
}

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

/**
 * Upload one file as session `id`: fresh for a new import, the import's own id
 * to retry it from Imports. Throws UploadSessionError for every declared outcome.
 */
export async function uploadIngestFile({
  file,
  libraryIds,
  id,
  signal,
  onPhaseChange,
  onImportRef,
}: {
  file: File;
  libraryIds: readonly string[];
  id: string;
  signal?: AbortSignal;
  onPhaseChange?: (phase: UploadPhase) => void;
  /** The server's import ref, as soon as the session exists. */
  onImportRef?: (ref: string) => void;
}): Promise<AcceptedIngest> {
  const kind = getFileUploadKind(file);
  if (kind === null || getFileUploadError(file) !== null) {
    throw outcome({ kind: "UnsupportedFileType" });
  }
  onPhaseChange?.("Preparing");
  const { data: created } = await call("Create", () =>
    apiFetch<ApiJson<"/media/uploads", "post">>("/api/media/uploads", {
      method: "POST",
      body: JSON.stringify({
        id,
        kind: kind === "Pdf" ? "pdf" : "epub",
        filename: file.name,
        content_type:
          kind === "Pdf" ? "application/pdf" : "application/epub+zip",
        size_bytes: file.size,
        library_ids: libraryIds,
      }),
      signal,
    }),
  );
  onImportRef?.(created.import_ref);
  if (created.kind === "Rejected") {
    throw outcome({ kind: "VerificationRejected", code: created.code });
  }
  const published =
    created.kind === "Published"
      ? created
      : await putAndConfirm(created, file, signal, onPhaseChange);
  publishChange("Entries");
  publishImportsInvalidation();
  return {
    kind: "Upload",
    mediaId: published.media_id,
    importRef: published.import_ref,
    processing: null,
  };
}

/** The bytes go only to the signed url, before it expires. A PUT that fails
    leaves the session awaiting bytes, which sending `id` again re-opens. */
async function putAndConfirm(
  upload: Schema<"UploadRequired">,
  file: File,
  signal: AbortSignal | undefined,
  onPhaseChange: ((phase: UploadPhase) => void) | undefined,
): Promise<Schema<"Published">> {
  onPhaseChange?.("Uploading");
  const remaining = Date.parse(upload.expires_at) - Date.now();
  if (remaining <= 0) throw outcome({ kind: "BytesMissing" });
  const deadline = AbortSignal.timeout(remaining);
  let response: Response;
  try {
    response = await fetch(upload.upload_url, {
      method: "PUT",
      headers: { "Content-Type": upload.content_type },
      body: file,
      signal:
        signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw outcome({ kind: "BytesMissing" }, error);
  }
  if (!response.ok) throw outcome({ kind: "BytesMissing" });
  onPhaseChange?.("Verifying");
  const { data } = await call("Confirm", () =>
    apiFetch<ApiJson<"/media/uploads/{session_id}/confirm", "post">>(
      `/api/media/uploads/${encodeURIComponent(upload.session_id)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ generation: upload.generation }),
        signal,
      },
    ),
  );
  return data;
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
  libraryIds,
  id,
  signal,
}: {
  url: string;
  libraryIds: readonly string[];
  id: string;
  signal?: AbortSignal;
}): Promise<AcceptedIngest> {
  const { data } = await apiFetch<ApiJson<"/media/from-url", "post">>(
    "/api/media/from-url",
    {
      method: "POST",
      body: JSON.stringify({ id, url, library_ids: libraryIds }),
      signal,
    },
  );
  publishChange("Entries");
  publishImportsInvalidation();
  const status = data.processing_status;
  return {
    kind: "Url",
    mediaId: data.media_id,
    importRef: data.import_ref,
    processing:
      status === "failed"
        ? "failed"
        : status === "ready_for_reading"
          ? "ready"
          : "processing",
  };
}

/**
 * Re-fetch a media's source from the attempt the viewer saw; the refreshed facts
 * arrive through Imports. A refusal throws; acceptance and an unknown outcome are
 * huds. "confirm request" resends the same expectation, which answers the refresh
 * that landed. An access reply (401/403/404) settles nothing.
 */
export async function requestSourceRefresh(
  mediaId: string,
  expectedAttemptId: string | null,
  hud: { feedback: FeedbackContextValue; showMetadata: () => void },
): Promise<void> {
  if (expectedAttemptId === null) {
    // justify-defect: an available refresh carries the attempt it replaces.
    throw new TypeError("Source refresh lost its inspected expectation");
  }
  const hudKey = `source-refresh:${mediaId}`;
  const metadata = { label: "metadata…", onClick: hud.showMetadata };
  try {
    await apiFetch<ApiJson<"/media/{media_id}/refresh", "post">>(
      `/api/media/${encodeURIComponent(mediaId)}/refresh`,
      {
        method: "POST",
        body: JSON.stringify({
          expected_attempt_id: expectedAttemptId,
        } satisfies Schema<"RefreshSourceRequest">),
      },
    );
  } catch (error) {
    if (isApiError(error) && error.status >= 400 && error.status < 500) {
      if (![401, 403, 404].includes(error.status)) hud.feedback.resolve(hudKey);
      throw error;
    }
    const confirm = () =>
      void requestSourceRefresh(mediaId, expectedAttemptId, hud).catch(
        (refused: unknown) => {
          if (handleUnauthenticatedApiError(refused)) return;
          hud.feedback.publish({
            kind: "Hud",
            content: {
              tone: "Danger",
              title: "could not confirm source refresh",
              message: isApiError(refused) ? refused.message : undefined,
            },
          });
        },
      );
    hud.feedback.publish({
      kind: "Hud",
      key: hudKey,
      content: {
        tone: "Danger",
        title: "source refresh unconfirmed",
        message: "confirm this request to safely check whether it was accepted",
      },
      actions: [{ label: "confirm request", onClick: confirm }, metadata],
    });
    return;
  }
  publishImportsInvalidation();
  hud.feedback.publish({
    kind: "Hud",
    key: hudKey,
    content: { tone: "Neutral", title: "source refresh request confirmed" },
    actions: [metadata],
  });
}
