"use client";

/**
 * The Imports read model and recovery admissions (docs/modules/imports.md).
 * Every type derives from the generated wire contract, so nothing here decodes
 * a payload by hand; the invalidation signal is this tab's own.
 */

import { useState } from "react";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type ImportSummary = ApiJson<"/imports/summary", "get">["data"];
export type ImportPage = ApiJson<"/imports", "get">["data"];
export type ImportItem = Schema<"ImportItem">;
export type ImportState = ImportItem["state"];
export type ImportStage = Schema<"ImportStageGroup">["stage"];
export type ImportDetail = ApiJson<"/imports/{ref}", "get">["data"];
export type HistoryPage = ApiJson<"/imports/{ref}/history", "get">["data"];
export type HistoryEntry = Schema<"HistoryEntry">;
export type SafeFailureCode = Extract<
  Schema<"ImportStateNeedsAttention">["failure_code"],
  { kind: "Present" }
>["value"];
export type RecoveryOffer = Extract<
  ImportItem["capabilities"]["recovery"],
  { kind: "Present" }
>["value"];
export type RecoveryRestriction = Extract<
  ImportItem["capabilities"]["unavailable_reason"],
  { kind: "Present" }
>["value"];
export type ImportsView = "NeedsAttention" | "InProgress" | "History";
export type UploadVerificationCode = Extract<
  Schema<"NeedsAttention">["failure"],
  { kind: "VerificationFailed" }
>["code"];

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
        /** Imports owns an unresolved obligation for this session. */
        | "NeedsAttention"
        /** No staged bytes for this generation; send the same file again. */
        | "BytesMissing"
        /** This attempt no longer owns the session; Imports is authoritative. */
        | "Superseded"
        /** The identity this command named is stale. */
        | "Conflicted"
        /** Acceptance is unknown; replaying the same intent converges. */
        | "Unresolved"
        /** Terminal for this intent; only a new import can succeed. */
        | "UnsupportedFileType"
        | "FileTooLarge"
        | "LibraryForbidden"
        | "IntentChanged"
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

async function read<T>(path: ApiPath, signal: AbortSignal): Promise<T> {
  const body = await apiFetch<{ data: T }>(path, { cache: "no-store", signal });
  return body.data;
}

function withCursor(path: ApiPath, cursor: string | null): ApiPath {
  return cursor === null
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

const refPath = (ref: string): ApiPath =>
  `/api/imports/${encodeURIComponent(ref)}`;

export function fetchImportSummary(
  signal: AbortSignal,
): Promise<ImportSummary> {
  return read("/api/imports/summary", signal);
}

/** One server page of `query`, already narrowed to what its view correlates. */
export function fetchImportPage(
  query: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<ImportPage> {
  return read(withCursor(`/api/imports?${query}`, cursor), signal);
}

export function fetchImportDetail(
  ref: string,
  signal: AbortSignal,
): Promise<ImportDetail> {
  return read(refPath(ref), signal);
}

export function fetchImportHistory(
  ref: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<HistoryPage> {
  return read(withCursor(`${refPath(ref)}/history`, cursor), signal);
}

/**
 * A cursor-paged read held as its first pages (docs/modules/imports.md): every
 * `stale` change rereads that prefix, Load more asks for one page more, and a
 * new `key` starts again at one page. `short` holds while the longer read is
 * running or failed; a failed read keeps the shorter prefix.
 */
export function usePagePrefix<P extends { next_cursor: Presence<string> }>(
  key: string,
  stale: string,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<P>,
) {
  const [more, setMore] = useState({ key, pages: 1 });
  if (more.key !== key) setMore({ key, pages: 1 });
  const pages = more.key === key ? more.pages : 1;
  const prefix = usePaneFreeServerValue({
    key,
    stale: `${stale} ${pages}`,
    load: async (signal) => {
      const loaded: P[] = [];
      let cursor: string | null = null;
      do {
        const page = await fetchPage(cursor, signal);
        loaded.push(page);
        cursor =
          page.next_cursor.kind === "Present" ? page.next_cursor.value : null;
      } while (cursor !== null && loaded.length < pages);
      return { pages: loaded, asked: pages, more: cursor !== null };
    },
  });
  const short = prefix.status === "ready" && prefix.data.asked < pages;
  const loadMore = () => setMore({ key, pages: pages + 1 });
  return { prefix, short, loadMore };
}

/** Admit one media recovery; the admission changes what Imports owes. */
async function admit<T>(
  mediaId: string,
  verb: "retry" | "repair",
  body: object,
): Promise<T> {
  const response = await apiFetch<{ data: T }>(
    `/api/media/${encodeURIComponent(mediaId)}/${verb}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  publishImportsInvalidation();
  return response.data;
}

export function retrySourceImport(input: {
  readonly mediaId: string;
  readonly expectedAttemptId: string;
  readonly clientMutationId: string;
}): Promise<Schema<"SourceRetryAdmission">> {
  return admit(input.mediaId, "retry", {
    from_stage: "source",
    client_mutation_id: input.clientMutationId,
    expected_attempt_id: input.expectedAttemptId,
  } satisfies Schema<"RetrySourceRequest">);
}

export function repairSourceImport(input: {
  readonly mediaId: string;
  readonly expectedAttemptId: string;
  readonly expectedJobId: string;
  readonly clientMutationId: string;
}): Promise<Schema<"SourceRepairAdmission">> {
  return admit(input.mediaId, "repair", {
    kind: "Source",
    client_mutation_id: input.clientMutationId,
    expected_attempt_id: input.expectedAttemptId,
    expected_job_id: input.expectedJobId,
  } satisfies Schema<"SourceRepairRequest">);
}

export function repairSearchImport(input: {
  readonly mediaId: string;
  readonly expectedRevision: number;
  readonly expectedJobId: string;
  readonly clientMutationId: string;
}): Promise<Schema<"SearchRepairAdmission">> {
  return admit(input.mediaId, "repair", {
    kind: "Search",
    client_mutation_id: input.clientMutationId,
    expected_revision: input.expectedRevision,
    expected_job_id: input.expectedJobId,
  } satisfies Schema<"SearchRepairRequest">);
}

/** Re-fetch a media's source; the refreshed facts arrive through Imports. */
export async function refreshMediaSource(mediaId: string): Promise<void> {
  await apiFetch<unknown>(`/api/media/${encodeURIComponent(mediaId)}/refresh`, {
    method: "POST",
  });
  publishImportsInvalidation();
}
