/**
 * The one copy owner for imports (docs/modules/imports.md): every string a
 * reader sees about an import, an upload or an acquisition, composed here from
 * typed facts, so one code is never explained two ways. The failure catalog is
 * also the runtime failure vocabulary: it is exhaustive over the generated
 * `SafeFailureCode`, so a new server code is a type error until it is worded.
 */

import type {
  FeedbackContent,
  FeedbackTone,
} from "@/components/feedback/Feedback";
import { apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { formatDisplayDate, formatRelativeTime } from "@/lib/display/format";
import {
  UploadSessionError,
  type HistoryEntry,
  type ImportDetail,
  type ImportItem,
  type ImportFailureCode,
  type ImportObligation,
  type ImportStage,
  type Classification,
  type ImportsView,
  type RecoveryOffer,
  type RecoveryRestriction,
  type SafeFailureCode,
  type UploadSessionOutcome,
} from "@/lib/imports/api";
import type { AcceptedIngest } from "@/lib/imports/ingest";
import {
  METADATA_FAILURE_COPY,
  metadataOperationName,
  metadataOperationSummary,
} from "@/lib/media/mediaMetadataCopy";
import type { MediaKind } from "@/lib/media/kind";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { pluralize } from "@/lib/text/pluralize";

/** What one recorded failure code means to a reader; offers come from the server. */
export interface FailureCopy {
  /** One short line for a row or an attempt. No terminal period. */
  readonly reason: string;
  /** The headline for a surface that explains the failure. */
  readonly title: string;
  /** What the reader can understand or do about the cause. */
  readonly explanation: string;
  /** The original page can help where Nexus could not (the media banner's Open source). */
  readonly recovery?: "OpenOriginal";
}

export const FAILURE_COPY: Readonly<Record<SafeFailureCode, FailureCopy>> = {
  E_ARCHIVE_UNSAFE: {
    reason: "Unsafe EPUB archive",
    title: "This EPUB cannot be opened safely.",
    explanation: "Use a valid EPUB from a trusted source.",
  },
  E_CAPTURE_TOO_LARGE: {
    reason: "Capture too large",
    title: "This capture is too large to import.",
    explanation: "Capture a smaller part of the page.",
  },
  E_EMBEDDING_PROVIDER_UNAVAILABLE: {
    reason: "Search provider unavailable",
    title: "The search indexing provider did not respond.",
    explanation: "Nothing about the source caused this.",
  },
  E_FILE_TOO_LARGE: {
    reason: "File too large",
    title: "This file exceeds the import limit.",
    explanation: "Remove this import and start a new one with a smaller file.",
  },
  E_FORBIDDEN: {
    reason: "Access refused",
    title: "Nexus was not allowed to read this source.",
    explanation: "Use a source you have access to.",
  },
  E_INGEST_FAILED: {
    reason: "Import failed",
    title: "This source could not be imported.",
    explanation: "The import stopped before the reader was ready.",
  },
  E_INGEST_TIMEOUT: {
    reason: "Import timed out",
    title: "Processing took too long.",
    explanation: "The source was still being processed when the time ran out.",
  },
  E_INTERNAL: {
    reason: "Nexus error",
    title: "Nexus failed while importing this source.",
    explanation: "Nothing about the source caused this.",
  },
  E_INVALID_CONTENT_TYPE: {
    reason: "Unexpected content type",
    title: "This source did not return the expected content type.",
    explanation: "Use a direct link to a PDF, an EPUB or an article.",
  },
  E_INVALID_FILE_TYPE: {
    reason: "Not a PDF or EPUB",
    title: "This file is not a valid PDF or EPUB.",
    explanation: "Use a valid PDF or EPUB, or a direct download link to one.",
  },
  E_INVALID_KIND: {
    reason: "Unsupported kind",
    title: "This source is not a kind Nexus imports.",
    explanation:
      "Import an article, a PDF, an EPUB, a podcast episode or a video.",
  },
  E_INVALID_REQUEST: {
    reason: "Import request refused",
    title: "This import request was refused.",
    explanation: "Start a new import from the source you want.",
  },
  E_MEDIA_NOT_FOUND: {
    reason: "Import no longer exists",
    title: "This import is no longer available.",
    explanation: "It was removed while the work was still running.",
  },
  E_MEDIA_NOT_READY: {
    reason: "Not ready for this step",
    title: "This import was not ready for that step.",
    explanation: "Review its current status before commanding it again.",
  },
  E_OWNER_REQUIRED: {
    reason: "Only the owner can do this",
    title: "Only the person who created this import can recover it.",
    explanation: "Ask them to retry it, or start your own import.",
  },
  E_PDF_PASSWORD_REQUIRED: {
    reason: "PDF is password-protected",
    title: "This PDF is password-protected.",
    explanation: "Upload an unlocked PDF to read it in Nexus.",
  },
  E_PDF_TEXT_UNAVAILABLE: {
    reason: "Imported without selectable text",
    title: "This PDF has no selectable text.",
    explanation: "It can be read as pages; search and quoting need OCR first.",
  },
  E_PODCAST_PROVIDER_UNAVAILABLE: {
    reason: "Podcast provider unavailable",
    title: "The podcast provider did not respond.",
    explanation: "The episode is unavailable until the provider answers again.",
  },
  E_REPAIR_NOT_ALLOWED: {
    reason: "Repair no longer offered",
    title: "This import can no longer be repaired.",
    explanation: "Its work moved on. Review its current status.",
  },
  E_RESOURCE_CONFLICT: {
    reason: "Import changed",
    title: "This import changed.",
    explanation: "Review its current status.",
  },
  E_RESOURCE_LIMIT: {
    reason: "Too large to process",
    title: "This source needs more resources than an import may use.",
    explanation: "Import a smaller or simpler source.",
  },
  E_RETRY_INVALID_STATE: {
    reason: "Retry no longer applies",
    title: "This import was not in a state that can be retried.",
    explanation: "Review its current status.",
  },
  E_RETRY_NOT_ALLOWED: {
    reason: "Retry not offered",
    title: "This import cannot be retried.",
    explanation: "Start a new import from a different source.",
  },
  E_SANITIZATION_FAILED: {
    reason: "Content could not be made safe",
    title: "Nexus could not make this content safe to read.",
    explanation: "Use a different source for this document.",
  },
  E_SELECTION_CHANGED: {
    reason: "Another copy won",
    title: "Another copy of this document became the one Nexus keeps.",
    explanation: "Open that copy; this one is no longer maintained.",
  },
  E_SIGN_UPLOAD_FAILED: {
    reason: "Upload could not be prepared",
    title: "Nexus could not prepare this upload.",
    explanation: "Storage did not issue an upload link.",
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
  },
  E_SOURCE_GONE: {
    reason: "Source no longer exists",
    title: "This source no longer exists.",
    explanation:
      "Its address answered that nothing is there. Use another copy.",
  },
  E_SOURCE_INTEGRITY: {
    reason: "Stored bytes did not verify",
    title: "Nexus could not verify the uploaded bytes.",
    explanation: "Remove this import and start a new one.",
  },
  E_SOURCE_NOT_READABLE: {
    reason: "No readable content found",
    title: "No readable content was found.",
    explanation: "Try another copy of this source with readable content.",
    recovery: "OpenOriginal",
  },
  E_SOURCE_POSITION_UNMAPPABLE: {
    reason: "a saved reading spot has no clear match",
    title:
      "refresh not applied: a saved reading spot has no clear match. saved copy kept.",
    explanation:
      "open the saved copy and deliberately save another reading spot before retrying, or retry after the source changes. retrying alone may reach the same conflict.",
  },
  E_SOURCE_ANNOTATION_UNMAPPABLE: {
    reason: "a saved highlight or passage has no clear match",
    title: "refresh not applied: a saved annotation has no clear match. saved copy kept.",
    explanation:
      "the replacement would lose or ambiguously move a saved highlight or passage. the saved copy and annotations remain available; retrying unchanged content will reach the same conflict.",
  },
  E_SOURCE_TOO_LARGE: {
    reason: "Source too large",
    title: "This document is too large to import.",
    explanation: "Use a smaller PDF or EPUB, or upload a smaller file.",
  },
  E_SSRF_BLOCKED: {
    reason: "Address not allowed",
    title: "This address is not one Nexus may fetch.",
    explanation: "Use a public link to the document.",
  },
  E_STORAGE_ERROR: {
    reason: "Storage failed",
    title: "Storage failed during this import.",
    explanation: "Nothing about the source caused this.",
  },
  E_STORAGE_MISSING: {
    reason: "Stored file is missing",
    title: "The stored file for this import is missing.",
    explanation: "Send the file again, or start a new import.",
  },
  E_TRANSCRIPTION_FAILED: {
    reason: "transcription failed",
    title: "This recording could not be transcribed.",
    explanation: "The audio was reached but no transcript came back.",
  },
  E_TRANSCRIPTION_TIMEOUT: {
    reason: "transcription timed out",
    title: "Transcribing this recording took too long.",
    explanation: "The recording was still being transcribed when time ran out.",
  },
  E_TRANSCRIPT_UNAVAILABLE: {
    reason: "no transcript available",
    title: "This recording has no transcript.",
    explanation: "It can be played; search and quoting need a transcript.",
  },
  E_UPLOAD_CAPABILITY_EXPIRED: {
    reason: "Upload link expired",
    title: "The upload link expired.",
    explanation: "Choose the original file to upload it again.",
  },
  E_WORKER_HANDLER_FAILED: {
    reason: "Processing failed",
    title: "Processing this import failed.",
    explanation: "Nothing about the source caused this.",
  },
  E_WORKER_INTERRUPTED: {
    reason: "Processing was interrupted",
    title: "Processing was interrupted.",
    explanation: "The run stopped before it could finish or fail.",
  },
  E_X_POST_UNAVAILABLE: {
    reason: "Post unavailable",
    title: "This post is not available.",
    explanation: "It was removed, or it is not public.",
  },
  E_X_ARTICLE_BODY_UNAVAILABLE: {
    reason: "article unavailable through x’s api",
    title: "article unavailable through x’s api",
    explanation: "x did not provide a complete structured article. open the original on x.",
    recovery: "OpenOriginal",
  },
  E_X_ARTICLE_IDENTITY_CHANGED: {
    reason: "the post now points to a different article",
    title: "this post’s article changed",
    explanation: "refresh the related thread to inspect the article now linked by this post.",
    recovery: "OpenOriginal",
  },
  E_X_PROVIDER_AUTH_REJECTED: {
    reason: "X rejected the request",
    title: "X rejected this import.",
    explanation: "X imports are unavailable until that is resolved.",
  },
  E_X_PROVIDER_CREDITS_DEPLETED: {
    reason: "X allowance used up",
    title: "Import allowance reached.",
    explanation:
      "This source can’t be imported right now because an import allowance was used up.",
  },
  E_X_PROVIDER_RATE_LIMITED: {
    reason: "X is limiting imports",
    title: "X is limiting imports right now.",
    explanation: "The post could not be read at this rate.",
  },
  E_X_PROVIDER_TIMEOUT: {
    reason: "X did not respond in time",
    title: "X took too long to respond.",
    explanation: "The post could not be read before the time ran out.",
  },
  E_X_PROVIDER_UNAVAILABLE: {
    reason: "X is unavailable",
    title: "X did not respond.",
    explanation: "The post is unavailable until X answers again.",
  },
};

// justify-type-assertion: the keys of a Record exhaustive over SafeFailureCode.
export const SAFE_FAILURE_CODES = Object.keys(
  FAILURE_COPY,
) as SafeFailureCode[];

export function isSafeFailureCode(raw: string): raw is SafeFailureCode {
  return Object.hasOwn(FAILURE_COPY, raw);
}

/** Metadata owns its reasons; imports only composes the two vocabularies. */
export const IMPORT_FAILURE_CODES: readonly ImportFailureCode[] = [
  ...SAFE_FAILURE_CODES,
  ...(Object.keys(
    METADATA_FAILURE_COPY,
  ) as (keyof typeof METADATA_FAILURE_COPY)[]),
];

export function importFailureCopy(code: ImportFailureCode): FailureCopy {
  if (isSafeFailureCode(code)) return FAILURE_COPY[code];
  const reason = METADATA_FAILURE_COPY[code];
  return { reason, title: "metadata operation failed.", explanation: reason };
}

/** The platform name must be recognizable in a mixed list of reasons. */
export function failureFilterLabel(code: ImportFailureCode): string {
  const reason = importFailureCopy(code).reason;
  return code.startsWith("E_X_")
    ? `X (posts): ${reason.startsWith("X ") ? reason.slice(2) : reason}`
    : reason;
}

/**
 * One record per stage: the noun a filter uses, and the
 * line shown while it runs. A recorded start reads `<label> started` and a
 * failure `<label> failed`; Finalize never collapses into Extract.
 */
export const STAGE_COPY: Readonly<
  Record<ImportStage, { readonly label: string; readonly working: string }>
> = {
  Upload: { label: "Upload", working: "uploading" },
  Validate: { label: "Validation", working: "validating" },
  Extract: { label: "Extraction", working: "extracting" },
  Finalize: { label: "Reader preparation", working: "preparing the reader" },
  Index: { label: "Search indexing", working: "indexing for search" },
  Metadata: { label: "Metadata", working: "updating metadata" },
  SourceProcessing: {
    label: "Source processing",
    working: "processing the source",
  },
};

export function stageLabel(stage: ImportStage): string {
  return STAGE_COPY[stage].label;
}

const stageFailed = (stage: ImportStage) =>
  `${stageLabel(stage).toLowerCase()} failed`;

export const KIND_LABEL: Readonly<Record<MediaKind, string>> = {
  web_article: "Web article",
  epub: "EPUB",
  pdf: "PDF",
  podcast_episode: "Podcast episode",
  video: "Video",
};

export const VIEW_LABEL: Readonly<Record<ImportsView, string>> = {
  NeedsAttention: "Needs attention",
  InProgress: "In progress",
  History: "History",
};

/** The wording of a state a reader can filter History by. */
export const STATE_KIND_LABEL: Readonly<Record<Classification, string>> = {
  Active: "In progress",
  NeedsAttention: "Needs attention",
  Complete: "Complete",
};

/** The bytes arrived and verification refused them (stage Validate). */
const UPLOAD_REJECTED_LABEL = "upload rejected";
export const UNAVAILABLE_LINE = "This import is no longer available";
/** The mark on the one recorded event a History filter matched. */
export const MATCHED_LABEL = "Matched";
/** The same mark read inside the event's sentence. */
export const MATCHED_ANNOUNCEMENT = "Matched by your filter";

/**
 * The stage and code of the obligation the server says speaks for the import (`primary`);
 * metadata's come from its retained operation. Null when the import is Complete.
 */
export function speaking(item: ImportItem): {
  readonly stage: ImportStage;
  readonly code: ImportFailureCode | null;
} | null {
  switch (item.primary) {
    case null:
      return null;
    case "metadata": {
      const operation = item.obligations.metadata?.operation ?? null;
      const failed =
        item.classification === "NeedsAttention" &&
        operation?.status === "failed";
      return { stage: "Metadata", code: failed ? operation.code : null };
    }
    default: {
      const slot = item.obligations[item.primary];
      return slot === null
        ? null
        : { stage: slot.stage, code: slot.failure_code };
    }
  }
}

const WAITING = {
  Queue: "waiting in queue",
  Capacity: "waiting for capacity",
  RetryBackoff: "waiting to retry",
  AwaitingUploadConfirmation: "awaiting upload confirmation",
} as const;

const COUNTED_UNIT = { Page: "page", Chapter: "chapter" } as const;

/** The one short status line for a row or the inspector. */
function statusLine(
  item: ImportItem,
  formatTime?: (value: string) => string,
): string {
  const source = item.obligations.source;
  if (item.primary === "source" && item.classification === "NeedsAttention") {
    const retained = sourceFailureLine(item);
    if (retained !== null) return retained;
  }
  const metadata = item.obligations.metadata;
  if (item.primary === "metadata" && metadata !== null) {
    const operation =
      item.classification === "Active"
        ? metadata.unfinished_operation
        : metadata.operation;
    if (operation !== null) {
      const latest = metadata.operation;
      return latest !== null && latest.job_id !== operation.job_id
        ? `${metadataOperationSummary(latest, formatTime)} · ${metadataOperationSummary(operation, formatTime)}`
        : metadataOperationSummary(operation, formatTime);
    }
  }
  if (item.primary === null)
    return `${pluralize(item.source_issue_count, "source issue")} recorded`;
  const slot =
    item.primary === "metadata" ? null : item.obligations[item.primary];
  return slot === null
    ? "complete"
    : obligationStatusLine(
        slot,
        item.media_id === null && slot === source,
        formatTime,
      );
}

/** A failed refresh is separate from the readable publication it retained. */
export function sourceFailureLine(item: ImportItem): string | null {
  const source = item.obligations.source;
  if (
    !item.can_read ||
    source === null ||
    source.classification !== "NeedsAttention"
  )
    return null;
  if (
    source.failure_code === "E_SOURCE_POSITION_UNMAPPABLE" ||
    source.failure_code === "E_SOURCE_ANNOTATION_UNMAPPABLE"
  )
    return FAILURE_COPY[source.failure_code].title;
  return "couldn’t refresh source · saved copy kept";
}

/** Each native article/thread pair reports source outcomes independently of other work. */
export function relatedSourceOutcomeLine(
  item: ImportItem,
  related: ImportDetail["related_imports"][number],
): string | null {
  const article = related.relation === "article" ? related.item : item;
  const thread = related.relation === "thread" ? related.item : item;
  const articleSource = article.obligations.source;
  const threadSource = thread.obligations.source;
  if (thread.can_read && !article.can_read &&
    articleSource?.classification === "NeedsAttention" && articleSource.failure_code !== null)
    return "thread saved · article unavailable";
  if (article.can_read && !thread.can_read &&
    threadSource?.classification === "NeedsAttention" && threadSource.failure_code !== null)
    return "article saved · thread unavailable";
  return null;
}

/** One source or search obligation's status; `upload` is an unpublished session's. */
export function obligationStatusLine(
  slot: ImportObligation,
  upload = false,
  formatTime?: (value: string) => string,
): string {
  switch (slot.classification) {
    case "Active": {
      if (slot.status === "Queued") {
        // An unrecorded reason names the stage it waits for, never the queue.
        const waiting =
          slot.waiting_reason !== null
            ? WAITING[slot.waiting_reason]
            : `${stageLabel(slot.stage).toLowerCase()} queued`;
        return slot.next_retry_at !== null && formatTime
          ? `${waiting} · ${formatTime(slot.next_retry_at)}`
          : waiting;
      }
      const progress = slot.progress;
      if (progress === null) return STAGE_COPY[slot.stage].working;
      return progress.kind === "Stage"
        ? STAGE_COPY[progress.stage].working
        : `extracting ${COUNTED_UNIT[progress.unit]} ${progress.completed} of ${progress.total}`;
    }
    case "NeedsAttention":
      if (
        slot.failure_code === "E_TRANSCRIPTION_FAILED" ||
        slot.failure_code === "E_TRANSCRIPTION_TIMEOUT" ||
        slot.failure_code === "E_TRANSCRIPT_UNAVAILABLE"
      )
        return FAILURE_COPY[slot.failure_code].reason;
      if (!upload) return stageFailed(slot.stage);
      if (slot.stage !== "Upload") return UPLOAD_REJECTED_LABEL;
      return slot.failure_code === "E_UPLOAD_CAPABILITY_EXPIRED"
        ? FAILURE_COPY.E_UPLOAD_CAPABILITY_EXPIRED.reason
        : stageFailed("Upload");
    case "Complete":
      return "complete";
    default:
      return assertNever(slot.classification, "Unreachable obligation state");
  }
}

/** Only causes that add information beyond the primary consequence. */
export function reasonLine(item: ImportItem): string | null {
  const code =
    item.classification === "NeedsAttention"
      ? (speaking(item)?.code ?? null)
      : null;
  switch (code) {
    case null:
    // These generic failures add no cause to the stage's failed status.
    case "E_INGEST_FAILED":
    case "E_WORKER_HANDLER_FAILED":
    case "execution_failed":
    // The primary consequence already names these specific transcript facts.
    case "E_TRANSCRIPTION_FAILED":
    case "E_TRANSCRIPTION_TIMEOUT":
    case "E_TRANSCRIPT_UNAVAILABLE":
      return null;
    case "E_SOURCE_POSITION_UNMAPPABLE":
      return sourceFailureLine(item) === null
        ? importFailureCopy(code).reason
        : null;
    case "E_UPLOAD_CAPABILITY_EXPIRED":
      return item.media_id === null && speaking(item)?.stage === "Upload"
        ? null
        : importFailureCopy(code).reason;
    default:
      return importFailureCopy(code).reason;
  }
}

/** Readiness and the speaking obligation are independent, equally current facts. */
export function consequenceLine(
  item: ImportItem,
  formatTime?: (value: string) => string,
): string {
  const access =
    item.can_read && item.can_play
      ? "ready to read and play"
      : item.can_read
        ? "ready to read"
        : item.can_play
          ? "ready to play"
          : null;
  const activity =
    item.primary !== null || item.source_issue_count > 0
      ? statusLine(item, formatTime)
      : null;
  return (
    [access, activity].filter((part) => part !== null).join(" · ") || "saved"
  );
}

const RESTRICTION_LINE: Readonly<Record<RecoveryRestriction, string>> = {
  NotOwner: "Only the person who created this import can recover it.",
  SameSourceTerminal:
    "No retry is currently available for this import. If you have another copy, start a new import.",
  SourceNotReacquirable:
    "The original file is no longer stored, so it cannot be processed again.",
  UploadRejected: "This upload was rejected. Remove it and start a new import.",
};

function offerLine(offer: RecoveryOffer): string {
  const stored = offer.input === "StoredSource";
  switch (offer.kind) {
    case "RetryUpload":
      return "Sends the same file again and repeats verification. Nothing already imported is replaced.";
    case "RetrySource":
      return stored
        ? "Starts a new attempt from the stored file. Extraction and search indexing run again."
        : "Fetches the source again in a new attempt. Extraction and search indexing run again.";
    case "RepairSource":
      return stored
        ? "Runs the stopped attempt again from the stored file. No new attempt is created."
        : "Fetches the source again for the stopped attempt. No new attempt is created.";
    case "RepairSearch":
      return "Rebuilds the search index from the text already imported. The source is not fetched or extracted again.";
    default:
      return assertNever(offer, "Unreachable recovery offer");
  }
}

/** What the offered command reuses and repeats, why none is offered, or nothing for running work. */
export function recoveryLine(slot: ImportObligation): string | null {
  if (slot.recovery !== null) return offerLine(slot.recovery);
  if (slot.unavailable_reason !== null)
    return RESTRICTION_LINE[slot.unavailable_reason];
  return slot.classification === "NeedsAttention"
    ? "No recovery is offered for this work."
    : null;
}

export function concurrentWorkLine(item: ImportItem): string | null {
  if (item.classification !== "NeedsAttention") return null;
  const attention: string[] = [];
  const active: string[] = [];
  for (const [key, label] of [
    ["source", "source processing"],
    ["search", "search indexing"],
  ] as const) {
    const slot = item.obligations[key];
    if (slot?.classification === "Active") active.push(label);
    if (slot?.classification === "NeedsAttention" && item.primary !== key)
      attention.push(label);
  }
  const metadata = item.obligations.metadata;
  if (metadata !== null) {
    if (metadata.unfinished_operation !== null)
      active.push(metadataOperationName(metadata.unfinished_operation.purpose));
    const latest = metadata.operation;
    if (
      item.primary !== "metadata" &&
      latest !== null &&
      (latest.status === "failed" ||
        (latest.status === "no_findings" && latest.reviewed_at === null))
    )
      attention.push(metadataOperationName(latest.purpose));
  }
  const parts = [];
  if (attention.length)
    parts.push(`also needs attention: ${attention.join(", ")}`);
  if (active.length) parts.push(`also in progress: ${active.join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

const SOURCE_RECOVERY_LABEL = {
  RetrySource: "Retry accepted",
  RepairSource: "Repair accepted",
  ReprocessSource: "Reprocessing accepted",
  CorrectSourceType: "Source type corrected; processing queued",
} as const;

/**
 * The short name of one recorded event: what a filter match is explained with, and the
 * opening clause of its narration. A failure names its stage only, so
 * `Matched: Extraction failed · Sep 6` stays one clause.
 */
function eventLabel(entry: HistoryEntry): string {
  const facts = entry.facts;
  const stage = entry.stage;
  switch (facts.kind) {
    case "MetadataOperation":
      return metadataOperationSummary(facts.operation);
    case "UploadAccepted":
      return "Upload accepted";
    case "UploadRecoveryAccepted":
      return "Upload retry accepted";
    case "UploadHistoryBaseline":
    case "SourceHistoryBaseline":
      return "Detailed execution history was not recorded";
    case "UploadFailed":
      return UPLOAD_REJECTED_LABEL;
    case "UploadPublished":
      return "Upload published";
    case "SourceAccepted":
      return "Source accepted";
    case "SourceExecutionStarted":
      return "Processing started";
    case "SourceStageChanged":
      return stage === null
        ? "Processing continued"
        : `${stageLabel(stage)} started`;
    case "SourceRetryScheduled":
    case "IndexRetryScheduled":
      return "Retry scheduled";
    case "SourceFailed":
    case "IndexFailed":
      return stage === null ? "Failed" : stageFailed(stage);
    case "SourceRecoveryAccepted":
      return SOURCE_RECOVERY_LABEL[facts.recovery];
    case "SourceSucceeded":
      return "Source processing finished";
    case "IndexAccepted":
      return "Search indexing accepted";
    case "IndexRecoveryAccepted":
      return "Search index rebuild accepted";
    case "IndexExecutionStarted":
      return `${stageLabel("Index")} started`;
    case "IndexSucceeded":
      return "Search index ready";
    case "IndexSuperseded":
      return "Superseded by a newer revision";
    default:
      return assertNever(facts, "Unreachable history facts");
  }
}

/**
 * One recorded event as the attempt list narrates it: the label, a baseline's recorded
 * outcome, and for a failure its cause, its reason, whether an automatic retry follows and
 * how far a source run had got (the unit as recorded, no total that was not recorded).
 */
export function eventLine(entry: HistoryEntry): string {
  const label = eventLabel(entry);
  const facts = entry.facts;
  const reason =
    entry.failure_code !== null
      ? ` ${importFailureCopy(entry.failure_code).reason}.`
      : "";
  switch (facts.kind) {
    case "MetadataOperation":
      return `${label}${reason}`;
    case "UploadFailed":
      return `${label}.${reason}`;
    case "SourceHistoryBaseline":
      return facts.outcome === "Succeeded"
        ? `${label}. This attempt succeeded.`
        : facts.outcome === "InFlight"
          ? `${label}. This attempt was still running.`
          : `${label}. This attempt failed${facts.outcome_code === null ? "" : `: ${FAILURE_COPY[facts.outcome_code].reason}`}.`;
    case "SourceFailed":
    case "IndexFailed": {
      const cause =
        facts.kind === "SourceFailed" && facts.origin === "Domain"
          ? "The import could not use this source"
          : "The run failed";
      const outcome = facts.terminal
        ? "No more automatic retries."
        : "An automatic retry follows.";
      const progress = facts.kind === "SourceFailed" ? facts.progress : null;
      const counted =
        progress === null
          ? ""
          : progress.total !== null
            ? `${progress.completed} of ${progress.total}`
            : `${progress.completed}`;
      const stopped =
        progress === null
          ? ""
          : progress.unit !== null
            ? ` Stopped at ${progress.unit.toLowerCase()} ${counted}.`
            : ` Stopped at ${counted}.`;
      return `${label}. ${cause}.${reason} ${outcome}${stopped}`;
    }
    default:
      return label;
  }
}

type Display = Pick<RenderEnvironment, "displayLocale" | "displayTimeZone">;

/** An instant the formatter cannot read prints as recorded. */
const shown = (value: string, formatted: string | null) => formatted ?? value;

/** A recorded day; another year than the reader's says which. */
function dayText(value: string, display: Display, now: Date): string {
  const year = (at: string | Date) =>
    formatDisplayDate(at, display, { year: "numeric" });
  const options: Intl.DateTimeFormatOptions =
    year(value) === year(now)
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return shown(value, formatDisplayDate(value, display, options));
}

/** A recorded instant as the date and time an attempt list shows. */
export function momentText(value: string, display: Display): string {
  return shown(
    value,
    formatDisplayDate(value, display, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
}

/** Why a row matched a History filter: `Matched: Extraction failed · Sep 6`. */
export function matchLine(
  entry: HistoryEntry,
  display: Display,
  now: Date,
): string {
  return `Matched: ${eventLabel(entry)} · ${dayText(entry.occurred_at, display, now)}`;
}

/**
 * How old what a row says is: running work from its acceptance, stopped or finished work
 * from its last change, so a fresh failure never reads old.
 */
export function ageLine(
  item: ImportItem,
  display: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): { readonly dateTime: string; readonly text: string } {
  const active = item.classification === "Active";
  const value = active ? item.accepted_at : item.updated_at;
  return {
    dateTime: value,
    text: `${active ? "Started" : "Updated"} ${shown(value, formatRelativeTime(value, display, now))}`,
  };
}

/**
 * Which recorded time a History date range bounds: the failure event when the
 * query asks about failures, any recorded event otherwise.
 */
export type DateBounds = "Failure" | "AnyEvent";

const dateVerb = (bounds: DateBounds) =>
  bounds === "Failure" ? "Failed" : "Recorded";

export function dateFilterLabel(bounds: DateBounds): string {
  return `${dateVerb(bounds)} during`;
}

/**
 * One end of the half-open range as a chip reads it away from the inputs:
 * `from` includes its day, `before` excludes it. The url carries UTC days, so
 * the day is named in UTC, with its year.
 */
export function dateChipLabel(
  bounds: DateBounds,
  edge: "From" | "Before",
  date: string,
  locale: string,
): string {
  const day = shown(
    date,
    formatDisplayDate(
      `${date}T00:00:00Z`,
      { displayLocale: locale, displayTimeZone: "UTC" },
      { year: "numeric", month: "short", day: "numeric" },
    ),
  );
  return `${dateVerb(bounds)} ${edge === "From" ? "on or after" : "before"} ${day}`;
}

export function attentionPhrase(count: number): string {
  return count === 1 ? "1 needs attention" : `${count} need attention`;
}

/** A count as the badge and mode navigation print it; the exact count is spoken. */
export function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export const STALE_NOTICE: FeedbackContent = {
  tone: "Warning",
  title: "Couldn’t refresh imports",
  message: "Showing the last update",
};

export const CONFLICT_NOTICE: FeedbackContent = {
  tone: "Warning",
  title: "This import changed",
  message: "Review its current status",
};

export function emptyCopy(
  view: ImportsView,
  hasSearch: boolean,
  hasFilters: boolean,
): { readonly title: string; readonly body: string } {
  if (hasSearch && hasFilters) {
    return {
      title: "No imports match this search and filters",
      body: "Change the search or clear filters to broaden the results.",
    };
  }
  if (hasSearch) {
    return {
      title: "No imports match this search",
      body: "Try another search or clear it.",
    };
  }
  if (hasFilters) {
    return {
      title: "No imports match these filters",
      body: "Change or clear filters to broaden the results.",
    };
  }
  switch (view) {
    case "NeedsAttention":
      return {
        title: "No imports need attention",
        body: "Failed work and unreviewed metadata results appear here.",
      };
    case "InProgress":
      return {
        title: "No imports are in progress",
        body: "Uploads, source processing, search indexing, and metadata operations appear here.",
      };
    case "History":
      return {
        title: "No imports have recorded history",
        body: "History shows every import with recorded evidence, including the ones that finished.",
      };
    default:
      return assertNever(view, "Unreachable imports view");
  }
}

/** A modeled ApiError, or the defect rethrown for the screen boundary. */
function modeled(error: unknown) {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return error;
}

/** A failed accepted-source read; undeclared codes and defects are rethrown. */
export function savedSourceReadFailure(error: unknown): FeedbackContent {
  const failure = modeled(error);
  const title = "couldn’t check this saved source";
  const transport = apiTransportFeedback(failure, title);
  if (transport !== null) return transport;
  if (failure.code === "E_IMPORT_NOT_FOUND" || failure.code === "E_INVALID_REQUEST")
    return { tone: "Warning", title, message: "this save link is invalid or no longer available." };
  throw error;
}

/** A failed Imports read; undeclared codes and defects are rethrown. */
export function loadFailure(error: unknown): FeedbackContent {
  const { code, requestId } = modeled(error);
  const failed = (
    tone: FeedbackTone,
    message: string,
    title = "Imports couldn’t be loaded",
  ): FeedbackContent => ({ tone, title, message, requestId });
  switch (code) {
    case "E_NETWORK":
      return failed("Danger", "Check your connection and refresh.");
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return failed(
        "Danger",
        "Nexus couldn’t complete the request. Wait a moment, then refresh.",
      );
    case "E_RATE_LIMITED":
      return failed("Warning", "Wait a moment, then refresh.");
    case "E_INVALID_CURSOR":
      return failed(
        "Danger",
        "Refresh this view to start loading again.",
        "More imports couldn’t be loaded",
      );
    default:
      throw error;
  }
}

/** The one reason a terminal upload verification gives, on every surface. */
function verificationSentence(
  outcome: Extract<UploadSessionOutcome, { kind: "VerificationRejected" }>,
): string {
  const copy = FAILURE_COPY[outcome.code];
  return `${copy.title} ${copy.explanation}`;
}

type PlainOutcome = Exclude<
  UploadSessionOutcome["kind"],
  "VerificationRejected" | "IntentMalformed"
>;

/**
 * A surface's sentence for an upload-session outcome: its table, or
 * verification's one reason. A malformed intent, or an outcome the surface
 * settles itself (Imports' commands treat Superseded as done), is rethrown as
 * the defect it is here.
 */
function outcomeSentence(
  error: UploadSessionError,
  table: Readonly<Partial<Record<PlainOutcome, string>>>,
): string {
  const outcome = error.outcome;
  if (outcome.kind === "VerificationRejected") {
    return verificationSentence(outcome);
  }
  const sentence =
    outcome.kind === "IntentMalformed" ? undefined : table[outcome.kind];
  if (sentence === undefined) throw error;
  return sentence;
}

const FILE_DOES_NOT_MATCH =
  "That file doesn’t match this import. Choose the same file, or start a new import.";

/** Imports' Retry upload and Remove: one truthful next step per outcome. */
const COMMAND_OUTCOME: Readonly<
  Record<Exclude<PlainOutcome, "Superseded">, string>
> = {
  BytesMissing: "The upload didn’t finish. Choose the original file to retry.",
  Unresolved: "Nexus is still verifying this upload. Refresh in a moment.",
  UnsupportedFileType: FILE_DOES_NOT_MATCH,
  FileTooLarge: FILE_DOES_NOT_MATCH,
  FileMismatch: FILE_DOES_NOT_MATCH,
  LibraryForbidden:
    "You no longer have access to a destination library for this import.",
};

const BUSY =
  "Nexus couldn’t complete this action. Wait a moment, then refresh.";

/** The upload commands' transport refusals; any other code is a defect. */
const COMMAND_REFUSAL: Readonly<Record<string, string>> = {
  E_NETWORK: "Check your connection and try again.",
  E_UPSTREAM: BUSY,
  E_UPSTREAM_TIMEOUT: BUSY,
  E_RATE_LIMITED: BUSY,
};

/** A refused upload command says what was refused, in the command's words. */
export function uploadCommandFeedback(
  command: "RetryUpload" | "RemoveUpload",
  error: unknown,
): FeedbackContent {
  const title =
    command === "RetryUpload"
      ? "Couldn’t retry the upload"
      : "Couldn’t remove the import";
  if (error instanceof UploadSessionError) {
    return {
      tone: "Danger",
      title,
      message: outcomeSentence(error, COMMAND_OUTCOME),
    };
  }
  const { code } = modeled(error);
  if (!Object.hasOwn(COMMAND_REFUSAL, code)) throw error;
  return { tone: "Danger", title, message: COMMAND_REFUSAL[code] };
}

export type CaptureOperation = "SaveSource" | "AddAttachment";

const UNSUPPORTED_FILE = "This file type isn’t supported. Use a PDF or EPUB.";

/**
 * Capture and attachments hold one file and no session row, so each outcome is
 * one sentence and, where Imports holds the obligation, a pointer to it.
 */
const CAPTURE_OUTCOME: Readonly<Record<PlainOutcome, string>> = {
  BytesMissing: "Nexus never received this file. Attach it again.",
  Superseded: "This upload finished elsewhere. Open Imports to find it.",
  Unresolved:
    "Nexus couldn’t confirm this upload. Open Imports before attaching it again.",
  UnsupportedFileType: UNSUPPORTED_FILE,
  FileTooLarge: "This file is too large. Attach a smaller file.",
  LibraryForbidden:
    "You no longer have access to a destination library for this attachment.",
  FileMismatch: "This upload changed. Attach the file again.",
};

const X_UNAVAILABLE = "X imports are temporarily unavailable.";

/** The capture endpoints' declared refusals; any other code is a defect. */
const CAPTURE_REFUSAL: Readonly<Record<string, string>> = {
  E_NETWORK: "Check your connection and retry.",
  E_UPSTREAM: "The source service is unavailable. Retry in a moment.",
  E_UPSTREAM_TIMEOUT: "The source took too long to respond. Retry the capture.",
  E_RATE_LIMITED: "Wait a moment, then retry.",
  E_FILE_TOO_LARGE: "This capture is too large. Save a smaller source.",
  E_CAPTURE_TOO_LARGE: "This capture is too large. Save a smaller source.",
  E_INVALID_FILE_TYPE: UNSUPPORTED_FILE,
  E_INVALID_REQUEST: "This link can’t be saved. Check it and retry.",
  E_X_ARTICLE_POST_LINK_REQUIRED: "use the article’s post link.",
  E_X_PROVIDER_UNAVAILABLE:
    "X imports are temporarily unavailable. Retry in a moment.",
  E_X_PROVIDER_CREDITS_DEPLETED: X_UNAVAILABLE,
  E_X_PROVIDER_AUTH_REJECTED: X_UNAVAILABLE,
  E_X_PROVIDER_RATE_LIMITED:
    "X is limiting imports. Wait a moment, then retry.",
  E_X_PROVIDER_TIMEOUT: "X took too long to respond. Retry the capture.",
};

/**
 * A failed capture or attachment. Anything this does not model, a programming
 * error included, is rethrown for the screen boundary.
 */
export function captureErrorFeedback(
  error: unknown,
  operation: CaptureOperation,
): FeedbackContent {
  const title =
    operation === "SaveSource" ? "Couldn’t save" : "Attachment wasn’t added";
  if (error instanceof UploadSessionError) {
    return {
      tone: "Danger",
      title,
      message: outcomeSentence(error, CAPTURE_OUTCOME),
    };
  }
  const { code, requestId } = modeled(error);
  if (!Object.hasOwn(CAPTURE_REFUSAL, code)) throw error;
  return { tone: "Danger", title, message: CAPTURE_REFUSAL[code], requestId };
}

/** Acceptance records a saved source, independently of processing success. */
export function captureStatusLine(result: AcceptedIngest): string {
  return result.processing === "failed" ? "saved · processing failed" : "saved";
}

export type AcceptanceFailure =
  | { readonly kind: "Rejected"; readonly feedback: FeedbackContent }
  | {
      readonly kind: "AcceptanceUnresolved";
      readonly reason: "StatusUnknown" | "UploadIncomplete";
      readonly feedback: FeedbackContent;
    }
  | { readonly kind: "Superseded" };

/** An Add row whose acceptance is unknown; Check status replays its intent. */
export const UNCONFIRMED: FeedbackContent = {
  tone: "Warning",
  title: "Couldn’t confirm",
  message:
    "Nexus could not confirm whether this was saved. Check status to find out.",
};

const notAdded = (
  message: string,
): Extract<AcceptanceFailure, { kind: "Rejected" }> => ({
  kind: "Rejected",
  feedback: { tone: "Danger", title: "Couldn’t save", message },
});

/** Add's answer to each upload-session outcome of one frozen intent. */
const ADD_OUTCOME = {
  BytesMissing: {
    kind: "AcceptanceUnresolved",
    reason: "UploadIncomplete",
    feedback: {
      tone: "Warning",
      title: "Upload didn’t complete",
      message:
        "Nexus never received this file. Retry the upload, or remove it and start a new import.",
    },
  },
  Superseded: { kind: "Superseded" },
  Unresolved: {
    kind: "AcceptanceUnresolved",
    reason: "StatusUnknown",
    feedback: UNCONFIRMED,
  },
  UnsupportedFileType: notAdded(
    "This file type isn’t supported. Start a new import with a PDF or EPUB.",
  ),
  FileTooLarge: notAdded(
    "This file exceeds the import limit. Start a new import with a smaller file.",
  ),
  LibraryForbidden: notAdded(
    "You no longer have access to a destination library. Choose different libraries and start a new import.",
  ),
  FileMismatch: notAdded(FILE_DOES_NOT_MATCH),
} satisfies Readonly<Record<PlainOutcome, AcceptanceFailure>>;

/**
 * Why an Add acceptance did not land: refused, unknown (send its id again to
 * find out), or superseded. A transport failure or a 5xx leaves the
 * acceptance unknown; defects and a malformed intent are rethrown.
 */
export function acceptanceFailure(error: unknown): AcceptanceFailure {
  if (error instanceof UploadSessionError) {
    if (error.outcome.kind === "IntentMalformed") throw error;
    if (error.outcome.kind === "VerificationRejected") {
      return {
        kind: "Rejected",
        feedback: {
          tone: "Danger",
          title: UPLOAD_REJECTED_LABEL,
          message: verificationSentence(error.outcome),
        },
      };
    }
    return ADD_OUTCOME[error.outcome.kind];
  }
  const { status, code, requestId } = modeled(error);
  if (
    status >= 500 ||
    code === "E_NETWORK" ||
    code === "E_UPSTREAM" ||
    code === "E_UPSTREAM_TIMEOUT"
  ) {
    return {
      kind: "AcceptanceUnresolved",
      reason: "StatusUnknown",
      feedback: { ...UNCONFIRMED, requestId },
    };
  }
  if (code === "E_LIBRARY_FORBIDDEN") {
    const failure = ADD_OUTCOME.LibraryForbidden;
    return { ...failure, feedback: { ...failure.feedback, requestId } };
  }
  return {
    kind: "Rejected",
    feedback: captureErrorFeedback(error, "SaveSource"),
  };
}
