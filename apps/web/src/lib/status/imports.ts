/**
 * The one copy owner for the Imports workspace: one record per
 * `SafeFailureCode`, one record per stage, and the deterministic templates the
 * pane, the inspector, the navigation badge, the Add sheet and the capture
 * surfaces all render. Every string a reader sees about an import is composed
 * here from typed facts, so a code can never be explained two different ways
 * (spec "Target behavior and content", contract §6).
 */

import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { formatDisplayDate, formatRelativeTime } from "@/lib/display/format";
import {
  uploadSessionHandle,
  type ImportStage,
  type ImportStateKind,
  type SafeFailureCode,
} from "@/lib/imports/importRef";
import type {
  HistoryEntry,
  ImportItem,
  ImportState,
  ImportSummary,
  ModeledRecoveryRestriction,
  RecoveryOffer,
} from "@/lib/imports/importsClient";
import { UploadSessionError } from "@/lib/media/ingestionClient";
import type { MediaKind } from "@/lib/media/kind";
import type { MediaSourceProgress } from "@/lib/media/sourceProgress";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type {
  UploadTransportFailure,
  UploadVerificationCode,
} from "@/lib/media/uploadVerification";
import { pluralize } from "@/lib/text/pluralize";

/**
 * What one recorded failure code means to a reader, and whether the same source
 * can help. `recovery` is a fact about the code, never about this viewer's
 * permissions: the offer a viewer actually gets comes from the server. It never
 * says `SameSource` for a code the owner lists as same-source terminal
 * (`services/capabilities._SAME_SOURCE_TERMINAL_ERROR_CODES`), so this record
 * and that policy can never offer a reader two different answers.
 */
export interface ImportFailureCopy {
  /** One short line for a row or an attempt. No terminal period. */
  readonly reason: string;
  /** The reader-facing headline for a surface that explains the failure. */
  readonly title: string;
  /** What the reader can understand or do about the cause. */
  readonly explanation: string;
  readonly recovery: "SameSource" | "OpenOriginal" | "None";
}

/**
 * Exhaustive over `SafeFailureCode` by construction: a code added to the
 * catalog (and so to the Python owner it mirrors) is a type error here until it
 * has reviewed wording, rather than reaching a reader as a bare token.
 */
export const IMPORT_FAILURE_COPY: Readonly<
  Record<SafeFailureCode, ImportFailureCopy>
> = {
  E_ARCHIVE_UNSAFE: {
    reason: "Unsafe EPUB archive",
    title: "This EPUB cannot be opened safely.",
    explanation: "Use a valid EPUB from a trusted source.",
    recovery: "None",
  },
  E_BILLING_REQUIRED: {
    reason: "Billing required",
    title: "Import needs billing set up.",
    explanation: "This import isn’t available on the current plan.",
    recovery: "None",
  },
  E_CAPTURE_TOO_LARGE: {
    reason: "Capture too large",
    title: "This capture is too large to import.",
    explanation: "Capture a smaller part of the page.",
    recovery: "None",
  },
  E_FILE_TOO_LARGE: {
    reason: "File too large",
    title: "This file exceeds the import limit.",
    explanation: "Remove this import and start a new one with a smaller file.",
    recovery: "None",
  },
  E_FORBIDDEN: {
    reason: "Access refused",
    title: "Nexus was not allowed to read this source.",
    explanation: "Use a source you have access to.",
    recovery: "None",
  },
  E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: {
    reason: "Replayed with different details",
    title: "This command was replayed with different details.",
    explanation: "Review the current status before commanding it again.",
    recovery: "None",
  },
  E_INGEST_FAILED: {
    reason: "Import failed",
    title: "This source could not be imported.",
    explanation: "The import stopped before the reader was ready.",
    recovery: "SameSource",
  },
  E_INGEST_TIMEOUT: {
    reason: "Import timed out",
    title: "This import took too long.",
    explanation: "The source was still being processed when the time ran out.",
    recovery: "SameSource",
  },
  E_INTERNAL: {
    reason: "Nexus error",
    title: "Nexus failed while importing this source.",
    explanation: "Nothing about the source caused this.",
    recovery: "SameSource",
  },
  E_INVALID_CONTENT_TYPE: {
    reason: "Unexpected content type",
    title: "This source did not return the expected content type.",
    explanation: "Use a direct link to a PDF, an EPUB or an article.",
    recovery: "SameSource",
  },
  E_INVALID_FILE_TYPE: {
    reason: "Not a PDF or EPUB",
    title: "This file is not a valid PDF or EPUB.",
    explanation: "Use a valid PDF or EPUB, or a direct download link to one.",
    recovery: "None",
  },
  E_INVALID_KIND: {
    reason: "Unsupported kind",
    title: "This source is not a kind Nexus imports.",
    explanation: "Import an article, a PDF, an EPUB, a podcast episode or a video.",
    recovery: "None",
  },
  E_INVALID_REQUEST: {
    reason: "Import request refused",
    title: "This import request was refused.",
    explanation: "Start a new import from the source you want.",
    recovery: "None",
  },
  E_MEDIA_NOT_FOUND: {
    reason: "Import no longer exists",
    title: "This import is no longer available.",
    explanation: "It was removed while the work was still running.",
    recovery: "None",
  },
  E_MEDIA_NOT_READY: {
    reason: "Not ready for this step",
    title: "This import was not ready for that step.",
    explanation: "Review its current status before commanding it again.",
    recovery: "None",
  },
  E_OWNER_REQUIRED: {
    reason: "Only the owner can do this",
    title: "Only the person who created this import can recover it.",
    explanation: "Ask them to retry it, or start your own import.",
    recovery: "None",
  },
  E_PDF_PASSWORD_REQUIRED: {
    reason: "PDF is password-protected",
    title: "This PDF is password-protected.",
    explanation: "Upload an unlocked PDF to read it in Nexus.",
    recovery: "None",
  },
  E_PDF_TEXT_UNAVAILABLE: {
    reason: "Imported without selectable text",
    title: "This PDF has no selectable text.",
    explanation: "It can be read as pages; search and quoting need OCR first.",
    recovery: "None",
  },
  E_PODCAST_PROVIDER_UNAVAILABLE: {
    reason: "Podcast provider unavailable",
    title: "The podcast provider did not respond.",
    explanation: "The episode is unavailable until the provider answers again.",
    recovery: "SameSource",
  },
  E_PODCAST_QUOTA_EXCEEDED: {
    reason: "Podcast allowance used up",
    title: "Import allowance reached.",
    explanation:
      "This source can’t be imported right now because an import allowance was used up.",
    recovery: "None",
  },
  E_REPAIR_NOT_ALLOWED: {
    reason: "Repair no longer offered",
    title: "This import can no longer be repaired.",
    explanation: "Its work moved on. Review its current status.",
    recovery: "None",
  },
  E_RESOURCE_CONFLICT: {
    reason: "Import changed",
    title: "This import changed.",
    explanation: "Review its current status.",
    recovery: "None",
  },
  E_RESOURCE_LIMIT: {
    reason: "Too large to process",
    title: "This source needs more resources than an import may use.",
    explanation: "Import a smaller or simpler source.",
    recovery: "None",
  },
  E_RETRY_INVALID_STATE: {
    reason: "Retry no longer applies",
    title: "This import was not in a state that can be retried.",
    explanation: "Review its current status.",
    recovery: "None",
  },
  E_RETRY_NOT_ALLOWED: {
    reason: "Retry not offered",
    title: "This import cannot be retried.",
    explanation: "Start a new import from a different source.",
    recovery: "None",
  },
  E_SANITIZATION_FAILED: {
    reason: "Content could not be made safe",
    title: "Nexus could not make this content safe to read.",
    explanation: "Use a different source for this document.",
    recovery: "None",
  },
  E_SELECTION_CHANGED: {
    reason: "Another copy won",
    title: "Another copy of this document became the one Nexus keeps.",
    explanation: "Open that copy; this one is no longer maintained.",
    recovery: "None",
  },
  E_SIGN_UPLOAD_FAILED: {
    reason: "Upload could not be prepared",
    title: "Nexus could not prepare this upload.",
    explanation: "Storage did not issue an upload link.",
    recovery: "SameSource",
  },
  E_SOURCE_ACCESS_DENIED: {
    reason: "Page blocked the import",
    title: "This page blocked the import.",
    explanation:
      "Open the original page in your browser and use Nexus Capture there.",
    recovery: "OpenOriginal",
  },
  E_SOURCE_FETCH_FAILED: {
    reason: "Source could not be fetched",
    title: "Nexus could not fetch this source.",
    explanation: "The source did not respond.",
    recovery: "SameSource",
  },
  E_SOURCE_INTEGRITY: {
    reason: "Stored bytes did not verify",
    title: "Nexus could not verify the uploaded bytes.",
    explanation: "Remove this import and start a new one.",
    recovery: "None",
  },
  E_SOURCE_NOT_READABLE: {
    reason: "No readable article found",
    title: "Nexus could not find a readable article.",
    explanation:
      "Use a different source, or open the original page and capture it from your browser.",
    recovery: "OpenOriginal",
  },
  E_SOURCE_TOO_LARGE: {
    reason: "Source too large",
    title: "This document is too large to import.",
    explanation: "Use a smaller PDF or EPUB, or upload a smaller file.",
    recovery: "None",
  },
  E_SSRF_BLOCKED: {
    reason: "Address not allowed",
    title: "This address is not one Nexus may fetch.",
    explanation: "Use a public link to the document.",
    recovery: "None",
  },
  E_STORAGE_ERROR: {
    reason: "Storage failed",
    title: "Storage failed during this import.",
    explanation: "Nothing about the source caused this.",
    recovery: "SameSource",
  },
  E_STORAGE_MISSING: {
    reason: "Stored file is missing",
    title: "The stored file for this import is missing.",
    explanation: "Send the file again, or start a new import.",
    recovery: "None",
  },
  E_TRANSCRIPTION_FAILED: {
    reason: "Transcription failed",
    title: "This recording could not be transcribed.",
    explanation: "The audio was reached but no transcript came back.",
    recovery: "SameSource",
  },
  E_TRANSCRIPTION_TIMEOUT: {
    reason: "Transcription timed out",
    title: "Transcribing this recording took too long.",
    explanation: "The recording was still being transcribed when time ran out.",
    recovery: "SameSource",
  },
  E_TRANSCRIPT_UNAVAILABLE: {
    reason: "No transcript available",
    title: "This recording has no transcript.",
    explanation: "It can be played; search and quoting need a transcript.",
    recovery: "None",
  },
  E_UPLOAD_CAPABILITY_EXPIRED: {
    reason: "Upload link expired",
    title: "The upload link expired.",
    explanation: "Choose the original file to upload it again.",
    recovery: "SameSource",
  },
  E_UPLOAD_TRANSPORT_FAILED: {
    reason: "Upload did not finish",
    title: "The upload did not finish.",
    explanation: "Choose the original file to upload it again.",
    recovery: "SameSource",
  },
  E_WORKER_HANDLER_FAILED: {
    reason: "Processing failed",
    title: "Processing this import failed.",
    explanation: "Nothing about the source caused this.",
    recovery: "SameSource",
  },
  E_WORKER_INTERRUPTED: {
    reason: "Processing was interrupted",
    title: "Processing was interrupted.",
    explanation: "The run stopped before it could finish or fail.",
    recovery: "SameSource",
  },
  E_X_POST_UNAVAILABLE: {
    reason: "Post unavailable",
    title: "This post is not available.",
    explanation: "It was removed, or it is not public.",
    recovery: "None",
  },
  E_X_PROVIDER_AUTH_REJECTED: {
    reason: "X rejected the request",
    title: "X rejected this import.",
    explanation: "X imports are unavailable until that is resolved.",
    recovery: "None",
  },
  E_X_PROVIDER_CREDITS_DEPLETED: {
    reason: "X allowance used up",
    title: "Import allowance reached.",
    explanation:
      "This source can’t be imported right now because an import allowance was used up.",
    recovery: "None",
  },
  E_X_PROVIDER_RATE_LIMITED: {
    reason: "X is limiting imports",
    title: "X is limiting imports right now.",
    explanation: "The post could not be read at this rate.",
    recovery: "SameSource",
  },
  E_X_PROVIDER_TIMEOUT: {
    reason: "X did not respond in time",
    title: "X took too long to respond.",
    explanation: "The post could not be read before the time ran out.",
    recovery: "SameSource",
  },
  E_X_PROVIDER_UNAVAILABLE: {
    reason: "X is unavailable",
    title: "X did not respond.",
    explanation: "The post is unavailable until X answers again.",
    recovery: "SameSource",
  },
};

/**
 * One record per stage: the noun a filter and a group heading use, the line
 * shown while that stage is running, and the line shown when it failed.
 * `Finalize` never collapses into `Extract` and non-document source work never
 * claims a finer stage than the adapter recorded (spec).
 */
interface ImportStageCopy {
  readonly label: string;
  /** Work in flight now. */
  readonly working: string;
  /** A recorded moment at which this stage began. */
  readonly reached: string;
  readonly failed: string;
}

const IMPORT_STAGE_COPY: Readonly<Record<ImportStage, ImportStageCopy>> = {
  Upload: {
    label: "Upload",
    working: "Uploading",
    reached: "Upload started",
    failed: "Upload failed",
  },
  Validate: {
    label: "Validation",
    working: "Validating",
    reached: "Validation started",
    failed: "Validation failed",
  },
  Extract: {
    label: "Extraction",
    working: "Extracting",
    reached: "Extraction started",
    failed: "Extraction failed",
  },
  Finalize: {
    label: "Reader preparation",
    working: "Finalizing reader",
    reached: "Reader preparation started",
    failed: "Reader preparation failed",
  },
  Index: {
    label: "Search indexing",
    working: "Indexing for search",
    reached: "Search indexing started",
    failed: "Search indexing failed",
  },
  SourceProcessing: {
    label: "Source processing",
    working: "Source processing",
    reached: "Source processing started",
    failed: "Source processing failed",
  },
};

export function importStageLabel(stage: ImportStage): string {
  return IMPORT_STAGE_COPY[stage].label;
}

/**
 * The bytes arrived and the server's verification refused them (stage Validate).
 * `IMPORT_STAGE_COPY.Upload.failed` names a transfer that itself failed (stage
 * Upload); this owns the other fact, so the row and the attempt narration can
 * never drift apart.
 */
export const UPLOAD_REJECTED_LABEL = "Upload rejected";

export function importKindLabel(kind: MediaKind): string {
  switch (kind) {
    case "web_article":
      return "Web article";
    case "epub":
      return "EPUB";
    case "pdf":
      return "PDF";
    case "podcast_episode":
      return "Podcast episode";
    case "video":
      return "Video";
    default:
      return assertNever(kind, "Unreachable media kind");
  }
}

function progressLine(progress: MediaSourceProgress): string {
  switch (progress.kind) {
    case "Stage":
      return IMPORT_STAGE_COPY[progress.stage].working;
    case "Counted":
      switch (progress.unit) {
        case "Page":
          return `Extracting page ${progress.completed} of ${progress.total}`;
        case "Chapter":
          return `Extracting chapter ${progress.completed} of ${progress.total}`;
        default:
          return assertNever(progress.unit, "Unreachable counted unit");
      }
    default:
      return assertNever(progress, "Unreachable source progress");
  }
}

/**
 * An import whose obligation is still the upload itself: an upload session the
 * server has not published. Its Validate stage is server-side verification of
 * the bytes this reader sent, not extraction of a source Nexus fetched. The ref
 * owner is the only module that reads the grammar of a ref.
 */
export function isUploadObligation(item: ImportItem): boolean {
  return (
    uploadSessionHandle(item.ref) !== null && item.mediaRef.kind === "Absent"
  );
}

function attentionLine(item: ImportItem, state: Extract<ImportState, { kind: "NeedsAttention" }>): string {
  if (isUploadObligation(item)) {
    if (state.stage !== "Upload") return UPLOAD_REJECTED_LABEL;
    return state.failureCode.kind === "Present" &&
      state.failureCode.value === "E_UPLOAD_CAPABILITY_EXPIRED"
      ? IMPORT_FAILURE_COPY.E_UPLOAD_CAPABILITY_EXPIRED.reason
      : IMPORT_STAGE_COPY.Upload.failed;
  }
  return IMPORT_STAGE_COPY[state.stage].failed;
}

/** The one short status line for a row, a group heading or the inspector. */
export function importStatusLine(item: ImportItem): string {
  const state = item.state;
  switch (state.kind) {
    case "Active":
      switch (state.status) {
        case "Queued":
          // Why this is waiting was not recorded: name the stage it is queued
          // for rather than claim the queue as the reason (spec, absent
          // evidence).
          if (state.waitingReason.kind === "Absent") {
            return `${IMPORT_STAGE_COPY[state.stage].label} queued`;
          }
          switch (state.waitingReason.value) {
            case "Queue":
              return "Waiting in queue";
            case "Capacity":
              return "Waiting for capacity";
            case "RetryBackoff":
              return "Waiting to retry";
            default:
              return assertNever(
                state.waitingReason.value,
                "Unreachable waiting reason",
              );
          }
        case "Processing":
          return state.progress.kind === "Present"
            ? progressLine(state.progress.value)
            : IMPORT_STAGE_COPY[state.stage].working;
        default:
          return assertNever(state.status, "Unreachable active status");
      }
    case "NeedsAttention":
      return attentionLine(item, state);
    case "Complete":
      return "Imported";
    default:
      return assertNever(state, "Unreachable import state");
  }
}

/**
 * The reason beside the status line. Absent evidence stays absent: a failure
 * the server recorded without a code is never given an invented one.
 */
export function importReasonLine(item: ImportItem): string | null {
  const state = item.state;
  if (state.kind !== "NeedsAttention") return null;
  return state.failureCode.kind === "Present"
    ? IMPORT_FAILURE_COPY[state.failureCode.value].reason
    : null;
}

/** Which recorded time a History date range bounds. */
export type ImportsDateBounds = "Failure" | "AnyEvent";

/**
 * What a History date range bounds. With `Had failures` or a reason filter the
 * server correlates the range to the failure event; with neither it correlates
 * to any recorded event, and a reader is never left guessing which time they
 * bounded (spec "Target behavior and content").
 */
function importsDateVerb(bounds: ImportsDateBounds): string {
  switch (bounds) {
    case "Failure":
      return "Failed";
    case "AnyEvent":
      return "Recorded";
    default:
      return assertNever(bounds, "Unreachable date filter bounds");
  }
}

/** The name of the date pair a reader edits. */
export function importsDateFilterLabel(bounds: ImportsDateBounds): string {
  return `${importsDateVerb(bounds)} during`;
}

/**
 * One end of that range as its own sentence, for the applied filter a reader
 * reads away from the inputs. The range is half-open, so `from` includes its
 * day and `before` excludes it, and the chip says which.
 */
export function importsDateChipLabel(
  bounds: ImportsDateBounds,
  edge: "From" | "Before",
  date: string,
  locale: string,
): string {
  // The URL carries UTC calendar days (contract D17), so the day is named in
  // UTC — the viewer's own zone would name the day before the one they bounded
  // — and it carries its year: a bound read away from the inputs names one
  // absolute day, whatever range the reader asked for.
  const day = formattedInstant(
    date,
    formatDisplayDate(
      `${date}T00:00:00Z`,
      { displayLocale: locale, displayTimeZone: "UTC" },
      { year: "numeric", month: "short", day: "numeric" },
    ),
  );
  switch (edge) {
    case "From":
      return `${importsDateVerb(bounds)} on or after ${day}`;
    case "Before":
      return `${importsDateVerb(bounds)} before ${day}`;
    default:
      return assertNever(edge, "Unreachable date filter edge");
  }
}

/** The wording of a state a reader can filter History by. */
export const IMPORT_STATE_KIND_LABEL: Readonly<Record<ImportStateKind, string>> = {
  Active: "In progress",
  NeedsAttention: "Needs attention",
  Complete: "Complete",
};

/** The badge and Pill wording for a row's current state. */
export function importStateLabel(state: ImportState): string {
  switch (state.kind) {
    case "Active":
      return state.status === "Queued" ? "Queued" : "In progress";
    case "NeedsAttention":
      return "Needs attention";
    case "Complete":
      return "Complete";
    default:
      return assertNever(state, "Unreachable import state");
  }
}

/**
 * What this failure means for the reader now. Search indexing is the one stage
 * whose failure leaves a usable document, and only when the document is
 * actually readable (spec content rubric, inspector row).
 */
export function importConsequenceLine(
  item: ImportItem,
  readiness: { readonly canRead: boolean },
): string {
  const state = item.state;
  if (state.kind === "NeedsAttention" && state.stage === "Index") {
    return readiness.canRead
      ? "Search indexing failed. You can still read this document."
      : "Search indexing failed.";
  }
  if (state.kind === "NeedsAttention" && state.failureCode.kind === "Present") {
    const copy = IMPORT_FAILURE_COPY[state.failureCode.value];
    return `${copy.title} ${copy.explanation}`;
  }
  if (state.kind === "Complete") {
    return readiness.canRead
      ? "Imported. You can read this document."
      : "Imported.";
  }
  return importStatusLine(item);
}

/** What a recovery command reuses and what it repeats. */
export function importRecoveryScopeLine(offer: RecoveryOffer): string {
  switch (offer.kind) {
    case "RetryUpload":
      return "Sends the same file again and repeats verification. Nothing already imported is replaced.";
    case "RetrySource":
      return offer.input === "StoredSource"
        ? "Starts a new attempt from the stored file. Extraction and search indexing run again."
        : "Fetches the source again in a new attempt. Extraction and search indexing run again.";
    case "RepairSource":
      return offer.input === "StoredSource"
        ? "Runs the stopped attempt again from the stored file. No new attempt is created."
        : "Fetches the source again for the stopped attempt. No new attempt is created.";
    case "RepairSearch":
      return "Rebuilds the search index from the text already imported. The source is not fetched or extracted again.";
    default:
      return assertNever(offer, "Unreachable recovery offer");
  }
}

/** Why no recovery is offered, in the server's own modeled terms. */
export function importRecoveryRestrictionLine(
  reason: ModeledRecoveryRestriction,
): string {
  switch (reason) {
    case "NotOwner":
      return "Only the person who created this import can recover it.";
    case "SameSourceTerminal":
      return "The same source cannot succeed. Start a new import from a different source.";
    case "SourceNotReacquirable":
      return "The original file is no longer stored, so it cannot be processed again.";
    case "UploadRejected":
      return "This upload was rejected. Remove it and start a new import.";
    default:
      return assertNever(reason, "Unreachable recovery restriction");
  }
}

/**
 * What the Recovery section says when the server offered nothing and named no
 * restriction. Work still running has nothing to recover and nothing to
 * apologise for, so it gets no section at all; finished work says it finished
 * rather than reading as a problem (spec content rubric, inspector row).
 */
export function importRecoveryAbsenceLine(state: ImportState): string | null {
  switch (state.kind) {
    case "Active":
      return null;
    case "NeedsAttention":
      return "No recovery is offered for this import.";
    case "Complete":
      return "This import finished. There is nothing to recover.";
    default:
      return assertNever(state, "Unreachable import state");
  }
}

/**
 * The visible label of the one recovery command this owner names. Every media
 * offer is a resource action whose label the action catalog owns, so repeating
 * those three strings here would let the two drift apart.
 */
export const IMPORT_RETRY_UPLOAD_LABEL = "Retry upload";

/** Pending is what was started, never what was fixed. */
export const IMPORT_RECOVERY_PENDING_LABEL = "Starting…";

const IMPORT_ORIGINAL_FILE_HINT = "Choose the original file";

/** The file this retry needs is the one this import already accepted. */
export function importOriginalFileFeedback(filename: string): FeedbackContent {
  return {
    tone: "Warning",
    title: IMPORT_ORIGINAL_FILE_HINT,
    message: `This import needs ${filename}. Start a new import to bring in a different file.`,
  };
}

/** A refused upload command says what was refused, in the channel's own words. */
export function importUploadCommandFeedback(
  command: "RetryUpload" | "RemoveUpload",
  error: unknown,
): FeedbackContent {
  return {
    tone: "Danger",
    title:
      command === "RetryUpload"
        ? "Couldn’t retry the upload"
        : "Couldn’t remove the import",
    message: uploadSessionActionErrorMessage(error),
  };
}

function transportFailureLine(failure: UploadTransportFailure): string {
  switch (failure.kind) {
    case "HttpRejected":
      return `The storage service rejected this upload (${failure.status})`;
    case "Timeout":
      return "The upload ran out of time";
    case "Aborted":
      return "The upload was stopped";
    case "Network":
      return "The upload lost its connection";
    default:
      return assertNever(failure, "Unreachable upload transport failure");
  }
}

/**
 * The short name of one recorded event: the label a filter match is explained
 * with, and the opening clause of the fuller attempt narration. A failure names
 * the stage that failed and nothing else, so `Matched: Extraction failed · Sep 6`
 * stays one clause (spec content rubric, contract §6).
 */
function historyEventLabel(entry: HistoryEntry): string {
  const facts = entry.facts;
  switch (facts.kind) {
    case "UploadAccepted":
      return "Upload accepted";
    case "UploadExecutionStarted":
      // The owner records this when the verification lease is claimed, at the
      // stage it claimed (`Validate`), so the label follows the recorded stage
      // rather than naming the transfer that already finished.
      return entry.stage.kind === "Present"
        ? IMPORT_STAGE_COPY[entry.stage.value].reached
        : "Processing started";
    case "UploadRecoveryAccepted":
      return "Upload retry accepted";
    case "UploadHistoryBaseline":
    case "SourceHistoryBaseline":
      return "Detailed execution history was not recorded";
    case "UploadFailed":
      return facts.transport.kind === "Present"
        ? IMPORT_STAGE_COPY.Upload.failed
        : UPLOAD_REJECTED_LABEL;
    case "UploadPublished":
      return "Upload published";
    case "SourceAccepted":
      return "Source accepted";
    case "SourceExecutionStarted":
      return "Processing started";
    case "SourceStageChanged":
      return entry.stage.kind === "Present"
        ? IMPORT_STAGE_COPY[entry.stage.value].reached
        : "Processing continued";
    case "SourceRetryScheduled":
    case "IndexRetryScheduled":
      return "Retry scheduled";
    case "SourceFailed":
    case "IndexFailed":
      return entry.stage.kind === "Present"
        ? IMPORT_STAGE_COPY[entry.stage.value].failed
        : "Failed";
    case "SourceRecoveryAccepted":
      return facts.recovery.kind === "RetrySource"
        ? "Retry accepted"
        : "Repair accepted";
    case "SourceSucceeded":
      return "Source processing finished";
    case "SourceSuperseded":
      return "Superseded by another import";
    case "IndexAccepted":
      return "Search indexing accepted";
    case "IndexRecoveryAccepted":
      return "Search index rebuild accepted";
    case "IndexExecutionStarted":
      return IMPORT_STAGE_COPY.Index.reached;
    case "IndexSucceeded":
      return "Search index ready";
    case "IndexSuperseded":
      return "Superseded by a newer revision";
    default:
      return assertNever(facts, "Unreachable history facts");
  }
}

/**
 * How far one run had got when it stopped, from the counted snapshot the owner
 * recorded at the failure. The recorded unit is named as it was recorded and no
 * total is claimed that was not (spec "Store safe codes and counted progress at
 * failure"; never an invented percentage or ETA).
 */
function failureProgressLine(
  progress: Extract<HistoryEntry["facts"], { kind: "SourceFailed" }>["progress"],
): string {
  if (progress.kind === "Absent") return "";
  const { completed, total, unit } = progress.value;
  const counted =
    total.kind === "Present" ? `${completed} of ${total.value}` : `${completed}`;
  return unit.kind === "Present"
    ? ` Stopped at ${unit.value.toLowerCase()} ${counted}.`
    : ` Stopped at ${counted}.`;
}

/**
 * One recorded event as the inspector's attempt list narrates it: the short
 * label, the outcome a baseline attempt carries instead of detail, and for a
 * failure the cause, the reason, whether the pipeline will try again on its own
 * and how far the run had got.
 */
export function historyEventLine(entry: HistoryEntry): string {
  const label = historyEventLabel(entry);
  const facts = entry.facts;
  const reason =
    entry.failureCode.kind === "Present"
      ? ` ${IMPORT_FAILURE_COPY[entry.failureCode.value].reason}.`
      : "";
  if (facts.kind === "UploadFailed") {
    // A transport failure records what the transport did; a rejection records
    // only the verification code. Either way the recorded reason is said once.
    return facts.transport.kind === "Present"
      ? `${label}. ${transportFailureLine(facts.transport.value)}.`
      : `${label}.${reason}`;
  }
  if (facts.kind === "SourceHistoryBaseline") {
    // The migration kept the outcome this attempt already had (contract D2), so
    // a pre-cut failure is never narrated as if it had succeeded. Its columns
    // carry no stage or code, so the outcome is the only evidence there is.
    switch (facts.outcome.kind) {
      case "Succeeded":
        return `${label}. This attempt succeeded.`;
      case "Failed":
        return `${label}. This attempt failed: ${
          IMPORT_FAILURE_COPY[facts.outcome.failureCode].reason
        }.`;
      case "InFlight":
        return `${label}. This attempt was still running.`;
      default:
        return assertNever(facts.outcome, "Unreachable baseline outcome");
    }
  }
  if (facts.kind !== "SourceFailed" && facts.kind !== "IndexFailed") {
    return label;
  }
  const cause =
    facts.origin === "Execution"
      ? "The run failed"
      : "The import could not use this source";
  const outcome = facts.terminal
    ? "No more automatic retries."
    : "An automatic retry follows.";
  const progress =
    facts.kind === "SourceFailed" ? failureProgressLine(facts.progress) : "";
  return `${label}. ${cause}.${reason} ${outcome}${progress}`;
}

type DisplayContext = Pick<
  RenderEnvironment,
  "displayLocale" | "displayTimeZone"
>;

/**
 * Every instant this owner formats reached it through the strict decoders, so a
 * formatter that cannot read one is a decode defect — never a raw instant to
 * put in front of a reader.
 */
function formattedInstant(value: string, formatted: string | null): string {
  // justify-defect: the Imports decoders admit instants and nothing else.
  if (formatted === null) {
    throw new Error(`Imports was given a value that is not an instant: ${value}`);
  }
  return formatted;
}

/**
 * A recorded instant as the short day a `Matched:` clause names. History spans
 * whatever range the reader asks for, so an event from another year says which
 * one and the reader's own year stays the bare day (spec content rubric,
 * `Matched: Extraction failed · Sep 6`).
 */
function importDayText(
  value: string,
  context: DisplayContext,
  now: Date,
): string {
  const options: Intl.DateTimeFormatOptions =
    formatDisplayDate(value, context, { year: "numeric" }) ===
    formatDisplayDate(now, context, { year: "numeric" })
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return formattedInstant(value, formatDisplayDate(value, context, options));
}

/** A recorded instant as the date and time an attempt list shows. */
export function importMomentText(value: string, context: DisplayContext): string {
  return formattedInstant(
    value,
    formatDisplayDate(value, context, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
}

/** The mark on the one recorded attempt a History filter matched. */
export const IMPORT_MATCHED_ATTEMPT_LABEL = "Matched";

/**
 * The same mark for a reader who meets it inside the attempt's sentence, where
 * a bare `Matched` would close that sentence in a participle and never say
 * matched what.
 */
export const IMPORT_MATCHED_ATTEMPT_ANNOUNCEMENT = "Matched by your filter";

/** The `Matched:` line that explains why a row matched a history filter. */
export function historyMatchLine(
  entry: HistoryEntry,
  context: DisplayContext,
  now: Date,
): string {
  return `Matched: ${historyEventLabel(entry)} · ${importDayText(entry.occurredAt, context, now)}`;
}

interface ImportAge {
  readonly dateTime: string;
  readonly text: string;
}

/**
 * How old what a row says is: work still running is dated from when this work
 * unit was accepted, and work that stopped or finished from its last recorded
 * change, so a three-minute-old failure never reads like a three-month-old one
 * (spec content rubric "Rows / status design").
 */
export function importAgeLine(
  item: ImportItem,
  context: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): ImportAge {
  const active = item.state.kind === "Active";
  const value = active ? item.acceptedAt : item.updatedAt;
  const relative = formattedInstant(
    value,
    formatRelativeTime(value, context, now),
  );
  return {
    dateTime: value,
    text: `${active ? "Started" : "Updated"} ${relative}`,
  };
}

export function historyCoverageLine(
  recordedSince: string,
  context: DisplayContext,
): string {
  return `Detailed execution history was recorded from ${formattedInstant(
    recordedSince,
    formatDisplayDate(recordedSince, context, { dateStyle: "medium" }),
  )}.`;
}

export const IMPORT_UNAVAILABLE_LINE = "This import is no longer available";

// --- Navigation and counts -------------------------------------------------

export function importsAttentionPhrase(count: number): string {
  return count === 1 ? "1 needs attention" : `${count} need attention`;
}

function importsActivePhrase(count: number): string {
  return `${count} in progress`;
}

/** Nothing outstanding: distinct from the empty state of any one view. */
export const IMPORTS_SETTLED_LINE = "All imports are settled";

/** The one summary line: `3 need attention · 2 in progress`. */
export function importsSummaryLine(summary: ImportSummary): string {
  const parts: string[] = [];
  if (summary.needsAttentionCount > 0) {
    parts.push(importsAttentionPhrase(summary.needsAttentionCount));
  }
  if (summary.activeCount > 0) {
    parts.push(importsActivePhrase(summary.activeCount));
  }
  return parts.length === 0 ? IMPORTS_SETTLED_LINE : parts.join(" · ");
}

/**
 * The brief's second line, in the order a reader reads it: how much this view
 * matched, then how old what they are looking at is (spec content rubric
 * "Freshness/conflict", contract §6). Only the segments this read actually has
 * are returned — a count the page has not answered yet, or an observation that
 * has not landed, takes its separator with it, so the line can never open with
 * one.
 */
export function importsBriefSegments(
  matchedCount: number | null,
  observedAt: string | null,
  context: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): readonly string[] {
  const segments: string[] = [];
  if (matchedCount !== null) {
    segments.push(`${pluralize(matchedCount, "import")} in this view`);
  }
  if (observedAt !== null) {
    segments.push(
      `Last checked ${formattedInstant(observedAt, formatRelativeTime(observedAt, context, now))}`,
    );
  }
  return segments;
}

// --- Notices ---------------------------------------------------------------

export const IMPORTS_STALE_REFRESH_NOTICE: FeedbackContent = {
  tone: "Warning",
  title: "Couldn’t refresh imports",
  message: "Showing the last update",
};

export const IMPORTS_CONFLICT_NOTICE: FeedbackContent = {
  tone: "Warning",
  title: "This import changed",
  message: "Review its current status",
};

/** The same conflict wording for a channel that carries one sentence. */
export const IMPORTS_CONFLICT_MESSAGE = "This import changed. Review its current status.";

/**
 * The one safe-reason copy for a terminal upload verification rejection. The
 * Add sheet, capture and Imports all render this exact reason, so a session can
 * never be explained two different ways.
 */
export function uploadVerificationFailureCopy(
  code: UploadVerificationCode,
): string {
  const copy = IMPORT_FAILURE_COPY[code];
  return `${copy.title} ${copy.explanation}`;
}

/**
 * Finite copy adapter for the Imports upload-session commands. Every outcome
 * the upload-session channel declares gets one truthful next step; a request
 * this client composed wrongly stays a defect for the screen boundary.
 */
export function uploadSessionActionErrorMessage(error: unknown): string {
  if (error instanceof UploadSessionError) {
    const outcome = error.outcome;
    switch (outcome.kind) {
      case "NeedsAttention":
      case "BytesMissing":
        return "The upload didn’t finish. Choose the original file to retry.";
      case "VerificationRejected":
        return uploadVerificationFailureCopy(outcome.code);
      case "Superseded":
        return "This import moved on. Imports has been refreshed.";
      case "Conflicted":
        return IMPORTS_CONFLICT_MESSAGE;
      case "Unresolved":
        return "Nexus is still verifying this upload. Refresh in a moment.";
      case "UnsupportedFileType":
      case "FileTooLarge":
      case "IntentChanged":
      case "FileMismatch":
        return "That file doesn’t match this import. Choose the same file, or start a new import.";
      case "LibraryForbidden":
        return "You no longer have access to a destination library for this import.";
      case "IntentMalformed":
        throw error;
      default:
        return assertNever(outcome, "Unreachable upload session outcome");
    }
  }
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return "Check your connection and try again.";
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
      return "Nexus couldn’t complete this action. Wait a moment, then refresh.";
    default:
      throw error;
  }
}

/** The screen-boundary adapter for a failed Imports read. */
export function importsLoadErrorMessage(error: unknown): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title: "Imports couldn’t be loaded",
        message: "Check your connection and refresh.",
        requestId: error.requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title: "Imports couldn’t be loaded",
        message: "Nexus couldn’t complete the request. Wait a moment, then refresh.",
        requestId: error.requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Warning",
        title: "Imports couldn’t be loaded",
        message: "Wait a moment, then refresh.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

// --- Empty states ----------------------------------------------------------

export interface ImportsEmptyCopy {
  readonly title: string;
  readonly body: string;
}

export function importsEmptyCopy(
  view: "NeedsAttention" | "InProgress" | "History",
  filtered: boolean,
): ImportsEmptyCopy {
  if (filtered) {
    return {
      title: "No imports match these filters",
      body: "Clear the filters to see this view again.",
    };
  }
  switch (view) {
    case "NeedsAttention":
      return {
        title: "No imports need attention",
        body: "An import that stops and needs you appears here.",
      };
    case "InProgress":
      return {
        title: "No imports are in progress",
        body: "An import being uploaded, extracted or indexed appears here.",
      };
    case "History":
      // Any applied bound routes to the filtered copy above, so this branch is
      // reached only where no date range exists to name.
      return {
        title: "No imports have recorded history",
        body: "History shows every import with recorded evidence, including the ones that finished.",
      };
    default:
      return assertNever(view, "Unreachable imports view");
  }
}
