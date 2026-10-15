"use client";

/**
 * The Imports read model and recovery admissions (docs/modules/imports.md).
 * Every type derives from the generated wire contract, so nothing here decodes
 * a payload by hand; the invalidation signal is this tab's own.
 */

import type { FeedbackContextValue } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export type ImportSummary = ApiJson<"/imports/summary", "get">["data"];
export type ImportPage = ApiJson<"/imports", "get">["data"];
export type ImportItem = Schema<"ImportItem">;
export type ImportState = ImportItem["state"];
export type ImportStage = Schema<"ImportStateNeedsAttention">["stage"];
export type ImportDetail = ApiJson<"/imports/{ref}", "get">["data"];
export type HistoryPage = ApiJson<"/imports/{ref}/history", "get">["data"];
export type HistoryEntry = Schema<"HistoryEntry">;
export type ImportFailureCode = NonNullable<
  Schema<"ImportStateNeedsAttention">["failure_code"]
>;
export type SafeFailureCode = Exclude<
  ImportFailureCode,
  Schema<"MetadataFailureCode">
>;
export type SourceImportObligation = Schema<"SourceImportObligation">;
export type SearchImportObligation = Schema<"SearchImportObligation">;
export type RecoveryOffer = NonNullable<
  SourceImportObligation["recovery"] | SearchImportObligation["recovery"]
>;
export type RecoveryRestriction = NonNullable<
  SourceImportObligation["unavailable_reason"]
>;
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
      readonly kind: /** Imports owns an unresolved obligation for this session. */
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

/** A recovery of a media's own work (not a re-upload). */
export type MediaRecoveryOffer = Exclude<RecoveryOffer, { kind: "RetryUpload" }>;

/**
 * Admit the recovery `offer` authorizes, sent with the attempt, job or revision
 * the reader saw: a stale one conflicts (409) instead of acting on work the
 * reader never saw. The admission changes what Imports owes.
 */
export async function recoverMedia(
  mediaId: string,
  offer: MediaRecoveryOffer,
): Promise<void> {
  const client_mutation_id = crypto.randomUUID();
  const body =
    offer.kind === "RetrySource"
      ? ({
          from_stage: "source",
          client_mutation_id,
          expected_attempt_id: offer.expected_attempt_id,
        } satisfies Schema<"RetrySourceRequest">)
      : offer.kind === "RepairSource"
        ? ({
            kind: "Source",
            client_mutation_id,
            expected_attempt_id: offer.expected_attempt_id,
            expected_job_id: offer.expected_job_id,
          } satisfies Schema<"SourceRepairRequest">)
        : ({
            kind: "Search",
            client_mutation_id,
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

// A refresh whose outcome is unknown keeps its client id, keyed by the attempt
// the viewer saw, so "confirm request" replays it exactly; a settling answer
// forgets it. An access reply (401/403/404) precedes the server's replay lookup,
// so it settles nothing.
const unconfirmedRefreshes = new Map<string, string>();

/**
 * Re-fetch a media's source from the attempt the viewer saw (a typed,
 * replayable admission); the refreshed facts arrive through Imports. A refusal
 * throws; acceptance and an unknown outcome are huds.
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
  const key = `${mediaId}|${expectedAttemptId}`;
  const clientMutationId = unconfirmedRefreshes.get(key) ?? crypto.randomUUID();
  const hudKey = `source-refresh:${mediaId}`;
  const metadata = { label: "metadata…", onClick: hud.showMetadata };
  try {
    await apiFetch<ApiJson<"/media/{media_id}/refresh", "post">>(
      `/api/media/${encodeURIComponent(mediaId)}/refresh`,
      {
        method: "POST",
        body: JSON.stringify({
          client_mutation_id: clientMutationId,
          expected_attempt_id: expectedAttemptId,
        } satisfies Schema<"RefreshSourceRequest">),
      },
    );
  } catch (error) {
    if (isApiError(error) && error.status >= 400 && error.status < 500) {
      if (![401, 403, 404].includes(error.status)) {
        unconfirmedRefreshes.delete(key);
        hud.feedback.resolve(hudKey);
      }
      throw error;
    }
    unconfirmedRefreshes.set(key, clientMutationId);
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
  unconfirmedRefreshes.delete(key);
  publishImportsInvalidation();
  hud.feedback.publish({
    kind: "Hud",
    key: hudKey,
    content: { tone: "Neutral", title: "source refresh request confirmed" },
    actions: [metadata],
  });
}
