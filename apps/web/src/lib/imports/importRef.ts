/**
 * The Imports identities and closed wire vocabularies that carry no decoder and
 * no client directive, so the URL codec, the strict decoders and a server
 * component can all read them (contract §5, D18/D19).
 */

import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

export const IMPORT_STAGES = [
  "Upload",
  "Validate",
  "Extract",
  "Finalize",
  "Index",
  "SourceProcessing",
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export const IMPORT_STATE_KINDS = [
  "Active",
  "NeedsAttention",
  "Complete",
] as const;
export type ImportStateKind = (typeof IMPORT_STATE_KINDS)[number];

/**
 * The browser mirror of `SafeFailureCode` (`python/nexus/schemas/import_history.py`).
 * A Python kernel case reads this list and asserts set equality, so a code added
 * to the catalog on one side fails a proof rather than reaching a reader as an
 * unexplained token.
 */
export const SAFE_FAILURE_CODES = [
  "E_ARCHIVE_UNSAFE",
  "E_BILLING_REQUIRED",
  "E_CAPTURE_TOO_LARGE",
  "E_FILE_TOO_LARGE",
  "E_FORBIDDEN",
  "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH",
  "E_INGEST_FAILED",
  "E_INGEST_TIMEOUT",
  "E_INTERNAL",
  "E_INVALID_CONTENT_TYPE",
  "E_INVALID_FILE_TYPE",
  "E_INVALID_KIND",
  "E_INVALID_REQUEST",
  "E_MEDIA_NOT_FOUND",
  "E_MEDIA_NOT_READY",
  "E_OWNER_REQUIRED",
  "E_PDF_PASSWORD_REQUIRED",
  "E_PDF_TEXT_UNAVAILABLE",
  "E_PODCAST_PROVIDER_UNAVAILABLE",
  "E_PODCAST_QUOTA_EXCEEDED",
  "E_READER_CONTENT_TOO_LARGE",
  "E_REPAIR_NOT_ALLOWED",
  "E_RESOURCE_CONFLICT",
  "E_RESOURCE_LIMIT",
  "E_RETRY_INVALID_STATE",
  "E_RETRY_NOT_ALLOWED",
  "E_SANITIZATION_FAILED",
  "E_SELECTION_CHANGED",
  "E_SIGN_UPLOAD_FAILED",
  "E_SOURCE_ACCESS_DENIED",
  "E_SOURCE_FETCH_FAILED",
  "E_SOURCE_INTEGRITY",
  "E_SOURCE_NOT_READABLE",
  "E_SOURCE_TOO_LARGE",
  "E_SSRF_BLOCKED",
  "E_STORAGE_ERROR",
  "E_STORAGE_MISSING",
  "E_TRANSCRIPTION_FAILED",
  "E_TRANSCRIPTION_TIMEOUT",
  "E_TRANSCRIPT_UNAVAILABLE",
  "E_UPLOAD_CAPABILITY_EXPIRED",
  "E_UPLOAD_TRANSPORT_FAILED",
  "E_WORKER_HANDLER_FAILED",
  "E_WORKER_INTERRUPTED",
  "E_X_POST_UNAVAILABLE",
  "E_X_PROVIDER_AUTH_REJECTED",
  "E_X_PROVIDER_CREDITS_DEPLETED",
  "E_X_PROVIDER_RATE_LIMITED",
  "E_X_PROVIDER_TIMEOUT",
  "E_X_PROVIDER_UNAVAILABLE",
] as const;
export type SafeFailureCode = (typeof SAFE_FAILURE_CODES)[number];

export type ImportRef = string & { readonly __importRef: unique symbol };

const UPLOAD_REF_PREFIX = "upload:";
const UPLOAD_HANDLE_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse an import ref, returning null on any grammar violation. The media form
 * is the resource ref the rest of the app speaks, so `resourceRef` parses it —
 * this module never splits a ref on `:`. The upload form is not a resource: it
 * carries the server's opaque session handle, so only its URL-safe alphabet is
 * checked — pinning that handle's version or length here would turn a
 * server-side handle change into a browser defect.
 */
export function parseImportRef(raw: string): ImportRef | null {
  const resource = parseResourceRef(raw);
  const valid =
    resource === null
      ? raw.startsWith(UPLOAD_REF_PREFIX) &&
        UPLOAD_HANDLE_RE.test(raw.slice(UPLOAD_REF_PREFIX.length))
      : resource.scheme === "media";
  // justify-type-assertion: the two grammars above are the complete import ref
  // contract and this is their sole constructor.
  return valid ? (raw as ImportRef) : null;
}

/** The upload session this ref names, or null for a media import. */
export function uploadSessionHandle(ref: ImportRef): string | null {
  return ref.startsWith(UPLOAD_REF_PREFIX)
    ? ref.slice(UPLOAD_REF_PREFIX.length)
    : null;
}
