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
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { assertNever } from "@/lib/assertNever";
import { formatDisplayDate, formatRelativeTime } from "@/lib/display/format";
import {
  UploadSessionError,
  type HistoryEntry,
  type ImportItem,
  type ImportStage,
  type ImportState,
  type ImportSummary,
  type ImportsView,
  type RecoveryOffer,
  type RecoveryRestriction,
  type SafeFailureCode,
  type UploadSessionOutcome,
} from "@/lib/imports/api";
import type { AcceptedIngest } from "@/lib/imports/ingest";
import type { MediaKind } from "@/lib/media/kind";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { pluralize } from "@/lib/text/pluralize";

/**
 * What one recorded failure code means to a reader, and whether the same
 * source can help. `recovery` is a fact about the code, never about this
 * viewer: the offer a viewer gets comes from the server, and no code the owner
 * lists as same-source terminal (`services/capabilities`) says `SameSource`.
 */
export interface FailureCopy {
  /** One short line for a row or an attempt. No terminal period. */
  readonly reason: string;
  /** The headline for a surface that explains the failure. */
  readonly title: string;
  /** What the reader can understand or do about the cause. */
  readonly explanation: string;
  readonly recovery?: "SameSource" | "OpenOriginal";
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
  E_IDEMPOTENCY_KEY_REPLAY_MISMATCH: {
    reason: "Replayed with different details",
    title: "This command was replayed with different details.",
    explanation: "Review the current status before commanding it again.",
  },
  E_INGEST_FAILED: {
    reason: "Import failed",
    title: "This source could not be imported.",
    explanation: "The import stopped before the reader was ready.",
    recovery: "SameSource",
  },
  E_INGEST_TIMEOUT: {
    reason: "Import timed out",
    title: "Processing took too long.",
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
    recovery: "SameSource",
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
    recovery: "SameSource",
  },
  E_STORAGE_MISSING: {
    reason: "Stored file is missing",
    title: "The stored file for this import is missing.",
    explanation: "Send the file again, or start a new import.",
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

// justify-type-assertion: the keys of a Record exhaustive over SafeFailureCode.
export const SAFE_FAILURE_CODES = Object.keys(
  FAILURE_COPY,
) as SafeFailureCode[];

export function isSafeFailureCode(raw: string): raw is SafeFailureCode {
  return Object.hasOwn(FAILURE_COPY, raw);
}

/**
 * One record per stage: the noun a filter and a group heading use, and the
 * line shown while it runs. A recorded start reads `<label> started` and a
 * failure `<label> failed`; Finalize never collapses into Extract.
 */
export const STAGE_COPY: Readonly<
  Record<ImportStage, { readonly label: string; readonly working: string }>
> = {
  Upload: { label: "Upload", working: "Uploading" },
  Validate: { label: "Validation", working: "Validating" },
  Extract: { label: "Extraction", working: "Extracting" },
  Finalize: { label: "Reader preparation", working: "Finalizing reader" },
  Index: { label: "Search indexing", working: "Indexing for search" },
  SourceProcessing: {
    label: "Source processing",
    working: "Source processing",
  },
};

export function stageLabel(stage: ImportStage): string {
  return STAGE_COPY[stage].label;
}

const stageReached = (stage: ImportStage) => `${stageLabel(stage)} started`;
const stageFailed = (stage: ImportStage) => `${stageLabel(stage)} failed`;

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
export const STATE_KIND_LABEL: Readonly<Record<ImportState["kind"], string>> = {
  Active: "In progress",
  NeedsAttention: "Needs attention",
  Complete: "Complete",
};

export const ORDER_LABEL: Readonly<Record<ImportsView, string>> = {
  NeedsAttention: "Stage, oldest failure first",
  InProgress: "Newest accepted first",
  History: "Newest matched event first",
};

/** The bytes arrived and verification refused them (stage Validate). */
const UPLOAD_REJECTED_LABEL = "Upload rejected";
/** The one upload offer; every media offer's label is the action catalog's. */
export const RETRY_UPLOAD_LABEL = "Retry upload";
/** Pending is what was started, never what was fixed. */
export const RECOVERY_PENDING_LABEL = "Starting…";
export const UNAVAILABLE_LINE = "This import is no longer available";
/** The mark on the one recorded event a History filter matched. */
export const MATCHED_LABEL = "Matched";
/** The same mark read inside the event's sentence. */
export const MATCHED_ANNOUNCEMENT = "Matched by your filter";

/**
 * An import whose obligation is still the upload: a session the server has not
 * published. Its Validate stage verifies the bytes this reader sent.
 */
function isUploadObligation(item: ImportItem): boolean {
  return item.ref.startsWith("upload:") && item.media_ref.kind === "Absent";
}

const WAITING = {
  Queue: "Waiting in queue",
  Capacity: "Waiting for capacity",
  RetryBackoff: "Waiting to retry",
} as const;

const COUNTED_UNIT = { Page: "page", Chapter: "chapter" } as const;

/** The one short status line for a row or the inspector. */
export function statusLine(item: ImportItem): string {
  const state = item.state;
  switch (state.kind) {
    case "Active": {
      if (state.status === "Queued") {
        // An unrecorded reason names the stage it waits for, never the queue.
        return state.waiting_reason.kind === "Present"
          ? WAITING[state.waiting_reason.value]
          : `${stageLabel(state.stage)} queued`;
      }
      if (state.progress.kind === "Absent") {
        return STAGE_COPY[state.stage].working;
      }
      const progress = state.progress.value;
      return progress.kind === "Stage"
        ? STAGE_COPY[progress.stage].working
        : `Extracting ${COUNTED_UNIT[progress.unit]} ${progress.completed} of ${progress.total}`;
    }
    case "NeedsAttention":
      if (!isUploadObligation(item)) return stageFailed(state.stage);
      if (state.stage !== "Upload") return UPLOAD_REJECTED_LABEL;
      return state.failure_code.kind === "Present" &&
        state.failure_code.value === "E_UPLOAD_CAPABILITY_EXPIRED"
        ? FAILURE_COPY.E_UPLOAD_CAPABILITY_EXPIRED.reason
        : stageFailed("Upload");
    case "Complete":
      return item.source_issue_count > 0
        ? `${pluralize(item.source_issue_count, "source issue")} recorded`
        : "Imported";
    default:
      return assertNever(state, "Unreachable import state");
  }
}

/** The reason beside the status line; a failure without a code gets none. */
export function reasonLine(item: ImportItem): string | null {
  const state = item.state;
  return state.kind === "NeedsAttention" &&
    state.failure_code.kind === "Present"
    ? FAILURE_COPY[state.failure_code.value].reason
    : null;
}

const STATE_TONE = {
  Active: "info",
  NeedsAttention: "warning",
  Complete: "success",
} as const;

/** The state pill: one label and one tone for a row and its inspector. */
export function stateBadge(item: ImportItem): {
  readonly label: string;
  readonly tone: "info" | "warning" | "success";
} {
  const state = item.state;
  const issues = item.source_issue_count > 0;
  let label = "Needs attention";
  if (state.kind === "Active") {
    label = state.status === "Queued" ? "Queued" : "In progress";
  } else if (state.kind === "Complete") {
    label = issues ? "Readable with issues" : "Complete";
  }
  return { label, tone: issues ? "warning" : STATE_TONE[state.kind] };
}

/**
 * What this import means for the reader now. Search indexing is the one stage
 * whose failure leaves a usable document, and only when it is readable.
 */
export function consequenceLine(item: ImportItem, canRead: boolean): string {
  const state = item.state;
  if (state.kind === "NeedsAttention" && state.stage === "Index") {
    return canRead
      ? "Search indexing failed. You can still read this document."
      : "Search indexing failed.";
  }
  if (
    state.kind === "NeedsAttention" &&
    state.failure_code.kind === "Present"
  ) {
    const copy = FAILURE_COPY[state.failure_code.value];
    return `${copy.title} ${copy.explanation}`;
  }
  if (state.kind !== "Complete") return statusLine(item);
  if (item.source_issue_count > 0 && canRead) {
    return "Some source content is unavailable. You can read the available content.";
  }
  return canRead ? "Imported. You can read this document." : "Imported.";
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

/**
 * The Recovery sentence: what the offered command reuses and repeats, why the
 * server offers none, or that the work finished. Running work has none.
 */
export function recoveryLine(item: ImportItem): string | null {
  const { recovery, unavailable_reason: restriction } = item.capabilities;
  if (recovery.kind === "Present") return offerLine(recovery.value);
  if (restriction.kind === "Present")
    return RESTRICTION_LINE[restriction.value];
  switch (item.state.kind) {
    case "Active":
      return null;
    case "NeedsAttention":
      return "No recovery is offered for this import.";
    case "Complete":
      return "This import finished. There is nothing to recover.";
    default:
      return assertNever(item.state, "Unreachable import state");
  }
}

/** The file a retry needs is the one this import already accepted. */
export function originalFileFeedback(filename: string): FeedbackContent {
  return {
    tone: "Warning",
    title: "Choose the original file",
    message: `This import needs ${filename}. Start a new import to bring in a different file.`,
  };
}

type Facts = HistoryEntry["facts"];
type TransportFailure = Extract<
  Extract<Facts, { kind: "UploadFailed" }>["transport"],
  { kind: "Present" }
>["value"];

function transportLine(failure: TransportFailure): string {
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

const SOURCE_RECOVERY_LABEL = {
  RetrySource: "Retry accepted",
  RepairSource: "Repair accepted",
  ReprocessSource: "Reprocessing accepted",
  CorrectSourceType: "Source type corrected; processing queued",
} as const;

/**
 * The short name of one recorded event: what a filter match is explained with,
 * and the opening clause of its narration. A failure names its stage only, so
 * `Matched: Extraction failed · Sep 6` stays one clause.
 */
function eventLabel(entry: HistoryEntry): string {
  const facts = entry.facts;
  const stage = entry.stage.kind === "Present" ? entry.stage.value : null;
  switch (facts.kind) {
    case "UploadAccepted":
      return "Upload accepted";
    case "UploadExecutionStarted":
      // Recorded when verification claims its lease, at the stage it claimed.
      return stage === null ? "Processing started" : stageReached(stage);
    case "UploadRecoveryAccepted":
      return "Upload retry accepted";
    case "UploadHistoryBaseline":
    case "SourceHistoryBaseline":
      return "Detailed execution history was not recorded";
    case "UploadFailed":
      return facts.transport.kind === "Present"
        ? stageFailed("Upload")
        : UPLOAD_REJECTED_LABEL;
    case "UploadPublished":
      return "Upload published";
    case "SourceAccepted":
      return "Source accepted";
    case "SourceExecutionStarted":
      return "Processing started";
    case "SourceStageChanged":
      return stage === null ? "Processing continued" : stageReached(stage);
    case "SourceRetryScheduled":
    case "IndexRetryScheduled":
      return "Retry scheduled";
    case "SourceFailed":
    case "IndexFailed":
      return stage === null ? "Failed" : stageFailed(stage);
    case "SourceRecoveryAccepted":
      return SOURCE_RECOVERY_LABEL[facts.recovery.kind];
    case "SourceSucceeded":
      return "Source processing finished";
    case "SourceSuperseded":
      return "Superseded by another import";
    case "IndexAccepted":
      return "Search indexing accepted";
    case "IndexRecoveryAccepted":
      return "Search index rebuild accepted";
    case "IndexExecutionStarted":
      return stageReached("Index");
    case "IndexSucceeded":
      return "Search index ready";
    case "IndexSuperseded":
      return "Superseded by a newer revision";
    default:
      return assertNever(facts, "Unreachable history facts");
  }
}

/**
 * How far a run had got when it stopped, from the counted snapshot recorded
 * at the failure: the unit as recorded, and no total that was not recorded.
 */
function failureProgress(
  progress: Extract<Facts, { kind: "SourceFailed" }>["progress"],
): string {
  if (progress.kind === "Absent") return "";
  const { completed, total, unit } = progress.value;
  const counted =
    total.kind === "Present"
      ? `${completed} of ${total.value}`
      : `${completed}`;
  return unit.kind === "Present"
    ? ` Stopped at ${unit.value.toLowerCase()} ${counted}.`
    : ` Stopped at ${counted}.`;
}

/**
 * One recorded event as the attempt list narrates it: the label, a baseline's
 * recorded outcome, and for a failure its cause, its reason, whether an
 * automatic retry follows and how far the run had got.
 */
export function eventLine(entry: HistoryEntry): string {
  const label = eventLabel(entry);
  const facts = entry.facts;
  const reason =
    entry.failure_code.kind === "Present"
      ? ` ${FAILURE_COPY[entry.failure_code.value].reason}.`
      : "";
  switch (facts.kind) {
    case "UploadFailed":
      // A transport failure records what the transport did; a rejection only
      // its verification code. Either way the reason is said once.
      return facts.transport.kind === "Present"
        ? `${label}. ${transportLine(facts.transport.value)}.`
        : `${label}.${reason}`;
    case "SourceHistoryBaseline":
      // A pre-cut attempt keeps the outcome it had; that is all its evidence.
      switch (facts.outcome.kind) {
        case "Succeeded":
          return `${label}. This attempt succeeded.`;
        case "Failed":
          return `${label}. This attempt failed: ${FAILURE_COPY[facts.outcome.failure_code].reason}.`;
        case "InFlight":
          return `${label}. This attempt was still running.`;
        default:
          return assertNever(facts.outcome, "Unreachable baseline outcome");
      }
    case "SourceFailed":
    case "IndexFailed": {
      const cause =
        facts.origin === "Execution"
          ? "The run failed"
          : "The import could not use this source";
      const outcome = facts.terminal
        ? "No more automatic retries."
        : "An automatic retry follows.";
      const progress =
        facts.kind === "SourceFailed" ? failureProgress(facts.progress) : "";
      return `${label}. ${cause}.${reason} ${outcome}${progress}`;
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
 * How old what a row says is: running work from its acceptance, stopped or
 * finished work from its last change, so a fresh failure never reads old.
 */
export function ageLine(
  item: ImportItem,
  display: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): { readonly dateTime: string; readonly text: string } {
  const active = item.state.kind === "Active";
  const value = active ? item.accepted_at : item.updated_at;
  const relative = shown(value, formatRelativeTime(value, display, now));
  return {
    dateTime: value,
    text: `${active ? "Started" : "Updated"} ${relative}`,
  };
}

export function coverageLine(recordedSince: string, display: Display): string {
  const day = formatDisplayDate(recordedSince, display, {
    dateStyle: "medium",
  });
  return `Detailed execution history was recorded from ${shown(recordedSince, day)}.`;
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

/** A count as the badge and the tabs print it; the exact count is spoken. */
export function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** `3 need attention · 2 in progress`, or that nothing is outstanding. */
export function summaryLine(summary: ImportSummary): string {
  const parts: string[] = [];
  if (summary.needs_attention_count > 0) {
    parts.push(attentionPhrase(summary.needs_attention_count));
  }
  if (summary.active_count > 0)
    parts.push(`${summary.active_count} in progress`);
  return parts.length === 0 ? "All imports are settled" : parts.join(" · ");
}

/**
 * The brief's second line: how much this view matched, then how old it is.
 * A segment the read has not answered is left out with its separator.
 */
export function briefSegments(
  matched: number | null,
  observedAt: string | null,
  display: Pick<RenderEnvironment, "displayLocale">,
  now: Date,
): string[] {
  const segments: string[] = [];
  if (matched !== null)
    segments.push(`${pluralize(matched, "import")} in this view`);
  if (observedAt !== null) {
    const age = formatRelativeTime(observedAt, display, now);
    segments.push(`Last checked ${shown(observedAt, age)}`);
  }
  return segments;
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

/** The same conflict for a channel that carries one sentence. */
const CONFLICT_SENTENCE = `${CONFLICT_NOTICE.title}. ${CONFLICT_NOTICE.message}.`;

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
        body: "An import that stops and needs you appears here.",
      };
    case "InProgress":
      return {
        title: "No imports are in progress",
        body: "An import being uploaded, extracted or indexed appears here.",
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
 * A surface's sentence for an upload-session outcome: its table, verification's
 * one reason, or a malformed intent rethrown as the defect it is.
 */
function outcomeSentence(
  error: UploadSessionError,
  table: Readonly<Record<PlainOutcome, string>>,
): string {
  const outcome = error.outcome;
  if (outcome.kind === "IntentMalformed") throw error;
  if (outcome.kind === "VerificationRejected") {
    return verificationSentence(outcome);
  }
  return table[outcome.kind];
}

const FILE_DOES_NOT_MATCH =
  "That file doesn’t match this import. Choose the same file, or start a new import.";

/** Imports' Retry upload and Remove: one truthful next step per outcome. */
const COMMAND_OUTCOME: Readonly<Record<PlainOutcome, string>> = {
  NeedsAttention:
    "The upload didn’t finish. Choose the original file to retry.",
  BytesMissing: "The upload didn’t finish. Choose the original file to retry.",
  Superseded: "This import moved on. Imports has been refreshed.",
  Conflicted: CONFLICT_SENTENCE,
  Unresolved: "Nexus is still verifying this upload. Refresh in a moment.",
  UnsupportedFileType: FILE_DOES_NOT_MATCH,
  FileTooLarge: FILE_DOES_NOT_MATCH,
  IntentChanged: FILE_DOES_NOT_MATCH,
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
  NeedsAttention: "Open Imports for the available next step.",
  BytesMissing: "Nexus never received this file. Attach it again.",
  Superseded: "This upload finished elsewhere. Open Imports to find it.",
  Conflicted: CONFLICT_SENTENCE,
  Unresolved:
    "Nexus couldn’t confirm this upload. Open Imports before attaching it again.",
  UnsupportedFileType: UNSUPPORTED_FILE,
  FileTooLarge: "This file is too large. Attach a smaller file.",
  LibraryForbidden:
    "You no longer have access to a destination library for this attachment.",
  IntentChanged: "This upload changed. Attach the file again.",
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
  E_X_PROVIDER_UNAVAILABLE:
    "X imports are temporarily unavailable. Retry in a moment.",
  E_X_PROVIDER_CREDITS_DEPLETED: X_UNAVAILABLE,
  E_X_PROVIDER_AUTH_REJECTED: X_UNAVAILABLE,
  E_X_PROVIDER_RATE_LIMITED:
    "X is limiting imports. Wait a moment, then retry.",
  E_X_PROVIDER_TIMEOUT: "X took too long to respond. Retry the capture.",
};

/**
 * A failed capture or attachment, always a hard failure except an upload that
 * Imports now holds. Anything this does not model, a programming error
 * included, is rethrown for the screen boundary.
 */
export function captureErrorFeedback(
  error: unknown,
  operation: CaptureOperation,
): FeedbackContent {
  const title =
    operation === "SaveSource" ? "Couldn’t save" : "Attachment wasn’t added";
  if (error instanceof UploadSessionError) {
    const message = outcomeSentence(error, CAPTURE_OUTCOME);
    return error.outcome.kind === "NeedsAttention"
      ? { tone: "Warning", title: "Upload needs attention", message }
      : { tone: "Danger", title, message };
  }
  const { code, requestId } = modeled(error);
  if (!Object.hasOwn(CAPTURE_REFUSAL, code)) throw error;
  return { tone: "Danger", title, message: CAPTURE_REFUSAL[code], requestId };
}

/** What a saved capture says: saved, already here, or saved but failed. */
export function captureStatusLine(result: AcceptedIngest): string {
  if (result.processing === "failed") return "Saved, but ingestion failed";
  return result.duplicate ? "Already in your library" : "Saved";
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

const notAdded = (message: string): AcceptanceFailure => ({
  kind: "Rejected",
  feedback: { tone: "Danger", title: "Couldn’t save", message },
});

/** Add's answer to each upload-session outcome of one frozen intent. */
const ADD_OUTCOME: Readonly<Record<PlainOutcome, AcceptanceFailure>> = {
  NeedsAttention: {
    kind: "Rejected",
    feedback: {
      tone: "Warning",
      title: "Upload needs attention",
      message:
        "Use Imports for the available next step, or restage this file as a new import.",
    },
  },
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
  Conflicted: notAdded(CONFLICT_SENTENCE),
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
  IntentChanged: notAdded("This import changed. Start a new import."),
  FileMismatch: notAdded(FILE_DOES_NOT_MATCH),
};

/**
 * Why an Add acceptance did not land: refused, unknown (replay the frozen
 * intent to find out), or superseded. A transport failure or a 5xx leaves the
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
  return {
    kind: "Rejected",
    feedback: captureErrorFeedback(error, "SaveSource"),
  };
}
