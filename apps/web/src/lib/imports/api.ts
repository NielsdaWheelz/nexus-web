"use client";

/**
 * The Imports reads and the media recovery admission (docs/modules/imports.md).
 * Every type is the generated wire contract's; the invalidation signal is this
 * tab's own.
 */

import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { pageQuery, type ListPage } from "@/lib/api/useServerList";

export type ImportSummary = ApiJson<"/imports/summary", "get">["data"];
type ImportPage = ApiJson<"/imports", "get">["data"];
export type ImportItem = Schema<"ImportItem">;
/** The count from the latest page observation, not a traversal-wide total. */
export interface ImportPageMetadata {
  readonly matched_count: number;
}
export type ImportObligation = Schema<"ImportObligation">;
export type ImportDetail = ApiJson<"/imports/{ref}", "get">["data"];
type HistoryPage = ApiJson<"/imports/{ref}/history", "get">["data"];
export type HistoryEntry = Schema<"HistoryEntry">;
export type ImportStage = ImportObligation["stage"];
export type Classification = ImportItem["classification"];
export type ImportFailureCode = NonNullable<HistoryEntry["failure_code"]>;
export type SafeFailureCode = NonNullable<ImportObligation["failure_code"]>;
export type RecoveryOffer = NonNullable<ImportObligation["recovery"]>;
/** A recovery of a media's own work (not a re-upload). */
export type MediaRecoveryOffer = Exclude<
  RecoveryOffer,
  { kind: "RetryUpload" }
>;
export type RecoveryRestriction = NonNullable<
  ImportObligation["unavailable_reason"]
>;
export type ImportsView = "NeedsAttention" | "InProgress" | "History";
export type UploadVerificationCode = Schema<"Rejected">["code"];

/**
 * The closed set of outcomes the upload-session endpoints declare. Each
 * endpoint maps its error codes onto these (`ingest.ts`), so every surface
 * handles the channel exhaustively instead of reading an HTTP status class.
 */
export type UploadSessionOutcome =
  /** Verification rejected the stored bytes; terminal for this session. */
  | {
      readonly kind: "VerificationRejected";
      readonly code: UploadVerificationCode;
    }
  | {
      readonly kind:
        /** The bytes never landed; sending the same id again re-opens the upload. */
        | "BytesMissing"
        /** This attempt no longer owns the session; Imports is authoritative. */
        | "Superseded"
        /** Acceptance is unknown; sending the same id again converges. */
        | "Unresolved"
        /** Terminal for this intent; only a new import can succeed. */
        | "UnsupportedFileType"
        | "FileTooLarge"
        | "LibraryForbidden"
        | "FileMismatch"
        /** This client composed a request the endpoint forbids: a defect. */
        | "IntentMalformed";
    };

export class UploadSessionError extends Error {
  readonly outcome: UploadSessionOutcome;

  constructor(outcome: UploadSessionOutcome, options?: ErrorOptions) {
    super(`Upload session ${outcome.kind}`, options);
    this.name = "UploadSessionError";
    this.outcome = outcome;
  }
}

const INVALIDATED = "Imports.Invalidated";

/**
 * Something this tab did changed what Imports owes the reader. Other tabs catch
 * up on their next wake or poll; nothing crosses tabs.
 */
export function publishImportsInvalidation(): void {
  window.dispatchEvent(new Event(INVALIDATED));
}

export function subscribeImportsInvalidations(handler: () => void): () => void {
  window.addEventListener(INVALIDATED, handler);
  return () => window.removeEventListener(INVALIDATED, handler);
}

async function read<T>(
  path: ApiPath,
  signal: AbortSignal,
): Promise<T> {
  const body = await apiFetch<{ data: T }>(path, { cache: "no-store", signal });
  return body.data;
}

const refPath = (ref: string): ApiPath =>
  `/api/imports/${encodeURIComponent(ref)}`;

export function fetchImportSummary(
  signal: AbortSignal,
): Promise<ImportSummary> {
  return read("/api/imports/summary", signal);
}

/** One server page of `query`, already narrowed to what its view correlates. */
export async function fetchImportPage(
  query: string,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<ListPage<ImportItem, ImportPageMetadata>> {
  const page = await read<ImportPage>(`/api/imports?${pageQuery(query, cursor, limit)}`, signal);
  return { items: page.items, next_cursor: page.next_cursor, metadata: { matched_count: page.matched_count } };
}

export function fetchImportDetail(
  ref: string,
  signal: AbortSignal,
): Promise<ImportDetail> {
  return read(refPath(ref), signal);
}

export async function fetchImportHistory(
  ref: string,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<ListPage<HistoryEntry>> {
  const page = await read<HistoryPage>(`${refPath(ref)}/history?${pageQuery("", cursor, limit)}`, signal);
  return { items: page.entries, next_cursor: page.next_cursor };
}

/**
 * Admit the recovery `offer` authorizes, sent with the attempt, job or revision
 * the reader saw: a stale one conflicts (409) instead of acting on work the
 * reader never saw, and a resend after the first landed answers it again.
 */
export async function recoverMedia(
  mediaId: string,
  offer: MediaRecoveryOffer,
): Promise<void> {
  const body =
    offer.kind === "RetrySource"
      ? ({
          expected_attempt_id: offer.expected_attempt_id,
        } satisfies Schema<"RetrySourceRequest">)
      : offer.kind === "RepairSource"
        ? ({
            kind: "Source",
            expected_attempt_id: offer.expected_attempt_id,
            expected_job_id: offer.expected_job_id,
          } satisfies Schema<"SourceRepairRequest">)
        : ({
            kind: "Search",
            expected_revision: offer.expected_revision,
            expected_job_id: offer.expected_job_id,
          } satisfies Schema<"SearchRepairRequest">);
  const verb = offer.kind === "RetrySource" ? "retry" : "repair";
  await apiFetch(`/api/media/${encodeURIComponent(mediaId)}/${verb}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  publishImportsInvalidation();
}
