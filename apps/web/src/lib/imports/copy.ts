/**
 * Import lines and feedback words (docs/modules/imports.md), composed from typed
 * facts. Shared intake phrases live in words.ts; catalog actions own their labels.
 * The failure catalog is
 * also the runtime failure vocabulary: it is exhaustive over the generated
 * `SafeFailureCode`, so a new server code is a type error until it is worded.
 */


import type { Line } from "@/components/feedback/stage";
import { isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { assertNever } from "@/lib/assertNever";
import { formatDisplayDate } from "@/lib/display/format";
import {
  UploadSessionError,
  type HistoryEntry,
  type ImportDetail,
  type ImportItem,
  type ImportFailureCode,
  type ImportObligation,
  type ImportStage,
  type RecoveryRestriction,
  type SafeFailureCode,
  type UploadSessionOutcome,
} from "@/lib/imports/api";
import { IMPORT_WORDS } from "@/lib/imports/words";
import {
  METADATA_FAILURE_COPY,
  metadataOperationSummary,
} from "@/lib/media/mediaMetadataCopy";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { formatLocalDateInTimeZone, shiftLocalDate } from "@/lib/localDate";

/** What one recorded failure code means to a reader; offers come from the server. */
interface FailureCopy {
  /** The ordinary row/history label, without a terminal period. */
  readonly reason: string;
  /** The complete feedback fact. */
  readonly title: string;
  /** An optional factual reason; fact and reason compose to at most 14 lowercase words. */
  readonly explanation: string | null;
}

export const FAILURE_COPY: Readonly<Record<SafeFailureCode, FailureCopy>> = {
  E_PART_SOURCE_PINNED: {
    reason: "pieces refer to this text",
    title: "couldn’t replace this source.",
    explanation: "pieces refer to its saved text.",
  },
  E_ARCHIVE_UNSAFE: {
    reason: "this epub can’t be opened safely",
    title: "this epub can’t be opened safely.",
    explanation: null,
  },
  E_CAPTURE_TOO_LARGE: {
    reason: "the page is too large",
    title: "this capture exceeds the size limit.",
    explanation: null,
  },
  E_EMBEDDING_NOT_CONFIGURED: {
    reason: "related matches are unavailable",
    title: "text search is ready; related matches are unavailable.",
    explanation: "the embedding provider is not configured.",
  },
  E_EMBEDDING_PROVIDER_UNAVAILABLE: {
    reason: "the search provider is unavailable",
    title: "related matches aren’t available.",
    explanation: null,
  },
  E_FILE_TOO_LARGE: {
    reason: IMPORT_WORDS.tooBig,
    title: "this file exceeds the import limit.",
    explanation: null,
  },
  E_FORBIDDEN: {
    reason: "the site refused nexus",
    title: "couldn’t process this source.",
    explanation: null,
  },
  E_INGEST_FAILED: {
    reason: "nexus couldn’t import it",
    title: "couldn’t import this source.",
    explanation: null,
  },
  E_INGEST_TIMEOUT: {
    reason: "it took too long",
    title: "this import took too long.",
    explanation: null,
  },
  E_INTERNAL: {
    reason: "the fault is in nexus",
    title: "couldn’t process this source.",
    explanation: null,
  },
  E_INVALID_CONTENT_TYPE: {
    reason: "not an article, pdf or epub",
    title: "nexus can’t use this source’s content type.",
    explanation: null,
  },
  E_INVALID_FILE_TYPE: {
    reason: "its contents aren’t pdf or epub",
    title: "nexus couldn’t read that file.",
    explanation: null,
  },
  E_INVALID_KIND: {
    reason: "nexus doesn’t import this kind",
    title: "nexus can’t import this kind of source.",
    explanation: null,
  },
  E_INVALID_REQUEST: {
    reason: IMPORT_WORDS.refused,
    title: "couldn’t import this source.",
    explanation: null,
  },
  E_MEDIA_NOT_FOUND: {
    reason: "removed while importing",
    title: "this source isn’t available.",
    explanation: null,
  },
  E_MEDIA_NOT_READY: {
    reason: "not ready for that yet",
    title: "this source wasn’t ready for that step.",
    explanation: null,
  },
  E_OWNER_REQUIRED: {
    reason: "only its importer can do this",
    title: "only this source’s creator can do that.",
    explanation: null,
  },
  E_PDF_PASSWORD_REQUIRED: {
    reason: "the pdf is password-protected",
    title: "this pdf is password-protected.",
    explanation: null,
  },
  E_PDF_TEXT_UNAVAILABLE: {
    reason: "no selectable text",
    title: "this pdf has no selectable text.",
    explanation: "search and quoting need text recognition.",
  },
  E_PODCAST_PROVIDER_UNAVAILABLE: {
    reason: "the podcast provider is unavailable",
    title: "the podcast source isn’t available.",
    explanation: null,
  },
  E_REPAIR_NOT_ALLOWED: {
    reason: "repair is no longer offered",
    title: "couldn’t repair this source.",
    explanation: null,
  },
  E_RESOURCE_CONFLICT: {
    reason: "it conflicts with what’s there now",
    title: "couldn’t update this import.",
    explanation: null,
  },
  E_RESOURCE_LIMIT: {
    reason: "too large for nexus to process",
    title: "processing reached a resource limit.",
    explanation: null,
  },
  E_RETRY_INVALID_STATE: {
    reason: "retry no longer applies",
    title: "couldn’t retry this source.",
    explanation: "its state didn’t allow it.",
  },
  E_RETRY_NOT_ALLOWED: {
    reason: "retry isn’t offered",
    title: "couldn’t retry this source.",
    explanation: null,
  },
  E_SANITIZATION_FAILED: {
    reason: "unsafe to display",
    title: "nexus couldn’t prepare this content for reading.",
    explanation: null,
  },
  E_SELECTION_CHANGED: {
    reason: "another copy became the kept one",
    title: "couldn’t update this source.",
    explanation: null,
  },
  E_SIGN_UPLOAD_FAILED: {
    reason: "the upload couldn’t be prepared",
    title: "couldn’t prepare this upload.",
    explanation: null,
  },
  E_SOURCE_ACCESS_DENIED: {
    reason: "this page blocked the import",
    title: "the source refused access.",
    explanation: null,
  },
  E_SOURCE_FETCH_FAILED: {
    reason: "the download failed",
    title: "couldn’t fetch this source.",
    explanation: null,
  },
  E_SOURCE_GONE: {
    reason: "nothing is at this address",
    title: "this source isn’t available.",
    explanation: null,
  },
  E_SOURCE_INTEGRITY: {
    reason: IMPORT_WORDS.integrity,
    title: "the stored file didn’t match this import.",
    explanation: null,
  },
  E_SOURCE_NOT_READABLE: {
    reason: "no readable text in it",
    title: "no readable content was found.",
    explanation: null,
  },
  E_FEED_PRIVATE_SOURCE: {
    reason: "this source cannot authorize the matching article",
    title: "the article is unavailable to this source’s readers.",
    explanation: null,
  },
  E_SOURCE_POSITION_UNMAPPABLE: {
    reason: "a reading spot has no clear match",
    title: "couldn’t refresh this source.",
    explanation: null,
  },
  E_SOURCE_TOO_LARGE: {
    reason: "the document is too large",
    title: "this source exceeds the processing limit.",
    explanation: null,
  },
  E_SSRF_BLOCKED: {
    reason: "nexus doesn’t fetch private addresses",
    title: "nexus can’t fetch this address.",
    explanation: null,
  },
  E_STORAGE_ERROR: {
    reason: "storage failed",
    title: "couldn’t process this source.",
    explanation: null,
  },
  E_STORAGE_MISSING: {
    reason: "the stored file is missing",
    title: "the source file isn’t available.",
    explanation: null,
  },
  E_TRANSCRIPTION_FAILED: {
    reason: "no transcript came back",
    title: "couldn’t transcribe this recording.",
    explanation: null,
  },
  E_TRANSCRIPTION_TIMEOUT: {
    reason: "transcribing took too long",
    title: "transcribing this recording took too long.",
    explanation: null,
  },
  E_TRANSCRIPT_UNAVAILABLE: {
    reason: "no transcript available",
    title: "no transcript is available.",
    explanation: "search and quoting need a transcript.",
  },
  E_UPLOAD_CAPABILITY_EXPIRED: {
    reason: IMPORT_WORDS.timedOut,
    title: "this upload link expired.",
    explanation: null,
  },
  E_WORKER_HANDLER_FAILED: {
    reason: "processing stopped",
    title: "couldn’t process this source.",
    explanation: null,
  },
  E_WORKER_INTERRUPTED: {
    reason: "processing was interrupted",
    title: "processing was interrupted.",
    explanation: null,
  },
  E_X_POST_UNAVAILABLE: {
    reason: "the post is gone or private",
    title: "this post isn’t available.",
    explanation: null,
  },
  E_X_ARTICLE_BODY_UNAVAILABLE: {
    reason: "x didn’t share the full article",
    title: "couldn’t read this article from x.",
    explanation: null,
  },
  E_X_ARTICLE_IDENTITY_CHANGED: {
    reason: "the post now points to a different article",
    title: "couldn’t import this article.",
    explanation: null,
  },
  E_X_IDENTITY_CONFLICT: {
    reason: "imported threads overlap",
    title: "couldn’t import this x source.",
    explanation: null,
  },
  E_X_SOURCE_CONFLICT: {
    reason: "x’s posts didn’t fit together",
    title: "couldn’t refresh from x.",
    explanation: null,
  },
  E_X_PROVIDER_AUTH_REJECTED: {
    reason: "x refused nexus’s credentials",
    title: "x imports aren’t available.",
    explanation: null,
  },
  E_X_PROVIDER_CREDITS_DEPLETED: {
    reason: "nexus’s x allowance is used up",
    title: "the x import allowance is used up.",
    explanation: null,
  },
  E_X_PROVIDER_RATE_LIMITED: {
    reason: "x is limiting imports",
    title: "x is limiting imports.",
    explanation: null,
  },
  E_X_PROVIDER_TIMEOUT: {
    reason: "x took too long to answer",
    title: "x didn’t answer in time.",
    explanation: null,
  },
  E_X_PROVIDER_UNAVAILABLE: {
    reason: "x is unavailable",
    title: "x imports aren’t available.",
    explanation: null,
  },
};

export function isSafeFailureCode(raw: string): raw is SafeFailureCode {
  return Object.hasOwn(FAILURE_COPY, raw);
}

export function importFailureCopy(code: ImportFailureCode): FailureCopy {
  if (isSafeFailureCode(code)) return FAILURE_COPY[code];
  const reason = METADATA_FAILURE_COPY[code];
  return { reason, title: "metadata operation failed.", explanation: reason };
}

/** Names and running phrases for source facts and recorded events. */
const STAGE_COPY: Readonly<
  Record<ImportStage, { readonly label: string; readonly working: string }>
> = {
  Upload: { label: "upload", working: "uploading" },
  Validate: { label: "validation", working: "validating" },
  Extract: { label: "extraction", working: "extracting" },
  Finalize: { label: "reader preparation", working: "preparing the reader" },
  Index: { label: "search indexing", working: "indexing for search" },
  Metadata: { label: "metadata", working: "updating metadata" },
  SourceProcessing: {
    label: "source processing",
    working: "processing the source",
  },
};

export function stageLabel(stage: ImportStage): string {
  return STAGE_COPY[stage].label;
}

const stageFailed = (stage: ImportStage) =>
  `${stageLabel(stage).toLowerCase()} failed`;

/** The bytes arrived and verification refused them (stage Validate). */
export const UPLOAD_REJECTED_LABEL = "upload rejected";
export const UNAVAILABLE_LINE = "this import isn’t available.";
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

/** One voice for the register and shelf; the server alone chooses its speaking slot. */
export function importLine(item: ImportItem, display: Display): { text: string; tone: "Neutral" | "Warning" | "Danger" } | null {
  const tone: "Neutral" | "Warning" | "Danger" = item.classification !== "NeedsAttention" ? "Neutral" : item.can_read || item.can_play ? "Warning" : "Danger";
  const said = (text: string) => ({ text, tone });
  switch (item.primary) {
    case null:
      return !item.can_read && !item.can_play && item.dismissed.length > 0
        ? said(`${IMPORT_WORDS.unreadable} · dismissed`) : null;
    case "metadata": {
      const metadata = item.obligations.metadata;
      const operation = item.classification === "Active" ? metadata?.unfinished_operation : metadata?.operation;
      if (operation === null || operation === undefined) throw new Error("Speaking metadata has no operation");
      return said(metadataOperationSummary(operation, at => new Intl.DateTimeFormat(display.displayLocale,
        { timeZone: display.displayTimeZone, timeStyle: "short" }).format(new Date(at)).toLowerCase()));
    }
    case "search":
      return said(item.classification === "Active" ? IMPORT_WORDS.searchPreparing
        : item.text_search_ready ? IMPORT_WORDS.relatedStopped : IMPORT_WORDS.searchStopped);
    case "source": {
      const source = item.obligations.source;
      if (source === null) throw new Error("Speaking source has no obligation");
      if (source.waiting_reason === "AwaitingUploadConfirmation") return said(IMPORT_WORDS.waitingUpload);
      if (source.failure_code === "E_UPLOAD_CAPABILITY_EXPIRED") return said(IMPORT_WORDS.timedOut);
      const failed = item.classification === "NeedsAttention";
      if (failed && item.media_id === null) return said(source.failure_code === null
        ? UPLOAD_REJECTED_LABEL : FAILURE_COPY[source.failure_code].reason);
      if (item.media_kind === "podcast_episode") {
        if (!failed) return said(IMPORT_WORDS.transcription);
        const code = source.failure_code;
        if (code === "E_TRANSCRIPTION_FAILED" || code === "E_TRANSCRIPTION_TIMEOUT" || code === "E_TRANSCRIPT_UNAVAILABLE")
          return said(FAILURE_COPY[code].reason);
        const reason = code === null ? null : FAILURE_COPY[code].reason;
        return said(reason === null ? "couldn’t transcribe" : `couldn’t transcribe · ${reason}`);
      }
      if (failed) {
        if (item.can_read) return said("couldn’t refresh · saved copy kept");
        const reason = reasonLine(item);
        return said(reason === null ? IMPORT_WORDS.unreadable : `${IMPORT_WORDS.unreadable} · ${reason}`);
      }
      if (source.status === "Queued") return said(source.next_retry_at === null ? IMPORT_WORDS.inLine
        : `trying again at ${new Intl.DateTimeFormat(display.displayLocale, { timeZone: display.displayTimeZone, timeStyle: "short" }).format(new Date(source.next_retry_at)).toLowerCase()}`);
      const progress = source.progress;
      if (progress?.kind === "Counted") return said(`extracting ${COUNTED_UNIT[progress.unit]} ${progress.completed} of ${progress.total}`);
      const stage = progress?.stage ?? source.stage;
      switch (stage) {
        case "Validate": return said(IMPORT_WORDS.checkingFile);
        case "Finalize": return said("preparing the reader…");
        case "Upload": case "Extract": case "SourceProcessing": return said(item.can_read ? "refreshing…" : IMPORT_WORDS.importing);
        case "Index": case "Metadata": throw new Error("Source obligation has another owner's stage");
        default: return assertNever(stage);
      }
    }
  }
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

/** The source obligation used by an embedded acquisition while its owner prepares it. */
export function obligationStatusLine(slot: ImportObligation): string {
  switch (slot.classification) {
    case "Active": {
      if (slot.status === "Queued") {
        // An unrecorded reason names the stage it waits for, never the queue.
        const waiting =
          slot.waiting_reason !== null
            ? WAITING[slot.waiting_reason]
            : `${stageLabel(slot.stage).toLowerCase()} queued`;
        return waiting;
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
      return stageFailed(slot.stage);
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
      return item.can_read ? null : importFailureCopy(code).reason;
    case "E_UPLOAD_CAPABILITY_EXPIRED":
      return item.media_id === null && speaking(item)?.stage === "Upload"
        ? null
        : importFailureCopy(code).reason;
    default:
      return importFailureCopy(code).reason;
  }
}

const RESTRICTION_LINE: Readonly<Record<RecoveryRestriction, string>> = {
  NotOwner: "only its importer can recover this work.",
  SameSourceTerminal:
    "retry isn’t available. import another copy if you have one.",
  SourceNotReacquirable:
    "this source can’t be processed again.",
  UploadRejected: "upload rejected. remove it and import the file again.",
};

/** Why the owner offers no recovery; commands carry no execution tutorial. */
export function recoveryLine(slot: ImportObligation): string | null {
  return slot.unavailable_reason === null ? null : RESTRICTION_LINE[slot.unavailable_reason];
}

const SOURCE_RECOVERY_LABEL = {
  RetrySource: "retry accepted",
  RepairSource: "repair accepted",
  ReprocessSource: "reprocessing accepted",
  CorrectSourceType: "source type corrected; processing queued",
} as const;

/** A recorded event's opening clause. */
function eventLabel(entry: HistoryEntry): string {
  const facts = entry.facts;
  const stage = entry.stage;
  switch (facts.kind) {
    case "MetadataOperation":
      return metadataOperationSummary(facts.operation);
    case "UploadAccepted":
      return "upload accepted";
    case "UploadRecoveryAccepted":
      return "upload retry accepted";
    case "UploadHistoryBaseline":
    case "SourceHistoryBaseline":
      return "detailed execution history was not recorded";
    case "UploadFailed":
      return UPLOAD_REJECTED_LABEL;
    case "UploadPublished":
      return "upload published";
    case "SourceAccepted":
      return "source accepted";
    case "SourceExecutionStarted":
      return "processing started";
    case "SourceStageChanged":
      return stage === null
        ? "processing continued"
        : `${stageLabel(stage)} started`;
    case "SourceRetryScheduled":
    case "IndexRetryScheduled":
      return "retry scheduled";
    case "SourceFailed":
    case "IndexFailed":
      return stage === null ? "failed" : stageFailed(stage);
    case "SourceRecoveryAccepted":
      return SOURCE_RECOVERY_LABEL[facts.recovery];
    case "SourceSucceeded":
      return "source processing finished";
    case "IndexAccepted":
      return "search indexing accepted";
    case "IndexRecoveryAccepted":
      return "search index rebuild accepted";
    case "IndexExecutionStarted":
      return `${stageLabel("Index")} started`;
    case "IndexSucceeded":
      return "search index ready";
    case "IndexSuperseded":
      return "superseded by a newer revision";
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
      return `${label}.${reason}${facts.operation.status === "failed" || facts.operation.status === "held" ? " no automatic retry is scheduled." : ""}`;
    case "UploadFailed":
      return `${label}.${reason} no automatic retry is scheduled.`;
    case "SourceHistoryBaseline":
      return facts.outcome === "Succeeded"
        ? `${label}. this attempt succeeded.`
        : facts.outcome === "InFlight"
          ? `${label}. this attempt was still running.`
          : `${label}. this attempt failed${facts.outcome_code === null ? "" : `: ${FAILURE_COPY[facts.outcome_code].reason}`}.`;
    case "SourceFailed":
    case "IndexFailed": {
      const outcome = facts.terminal ? " no automatic retry is scheduled." : " automatic recovery continues.";
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
            ? ` stopped at ${progress.unit.toLowerCase()} ${counted}.`
            : ` stopped at ${counted}.`;
      return `${label}.${reason}${outcome}${stopped}`;
    }
    default:
      return label;
  }
}

type Display = Pick<RenderEnvironment, "displayLocale" | "displayTimeZone">;

/** An instant the formatter cannot read prints as recorded. */
const shown = (value: string, formatted: string | null) => formatted ?? value;

/** Civil dates in the reader's zone; a day is never assumed to last 24 hours. */
export function registerDay(at: string, now: Date, timeZone: string): string {
  const day = formatLocalDateInTimeZone(new Date(at), timeZone);
  const today = formatLocalDateInTimeZone(now, timeZone);
  // justify-defect: imports uses the render environment's fixed supported display zone.
  if (day === null || today === null) throw new Error("display time zone is unavailable");
  if (day === today) return "today";
  if (day === shiftLocalDate(today, -1)) return "yesterday";
  const parts = new Intl.DateTimeFormat("en", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)!.value.toLowerCase();
  return `${part("weekday")} ${part("day")} ${part("month")}${day.slice(0, 4) === today.slice(0, 4) ? "" : ` ${part("year")}`}`;
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

export function attentionPhrase(count: number): string {
  return count === 1 ? "1 needs attention" : `${count} need attention`;
}

/** The complete description of a positive Imports attention observation. `_refreshFailed`
 * stays until the account menu stops passing it (L7): a failed refresh says nothing. */
export function importAttentionDescription(count: number): string {
  return `imports: ${attentionPhrase(count)}`;
}

/** A count as the badge and mode navigation print it; the exact count is spoken. */
export function countText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** An import revision conflict, only when owner evidence establishes it. A generic
 * E_RESOURCE_CONFLICT can instead be an edge busy refusal and proves no revision change. */
export const CONFLICT_REASON = "this import changed since it was shown.";

/** A modeled ApiError, or the defect rethrown for the screen boundary. */
function modeled(error: unknown): ApiError {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  return error;
}

/** What verification said about the stored bytes, as a reason. */
const verificationReason = (outcome: Extract<UploadSessionOutcome, { kind: "VerificationRejected" }>) => ({
  E_SOURCE_INTEGRITY: "the stored file didn’t match this upload.",
  E_INVALID_FILE_TYPE: "nexus couldn’t read that file.",
  E_FILE_TOO_LARGE: "it’s over the size limit.",
  E_CAPTURE_TOO_LARGE: "it’s over the capture size limit.",
})[outcome.code];

/** One reason per upload-session outcome, on every surface (lib/imports/ingest.ts OUTCOMES). */
const OUTCOME_REASON = {
  BytesMissing: undefined,
  Expired: "the upload expired.",
  Unresolved: "file storage isn’t answering.",
  UnsupportedFileType: "only pdf and epub files can be added.",
  FileTooLarge: "it’s over the size limit.",
  LibraryForbidden: "you can’t add to one of these libraries.",
  FileMismatch: "that file doesn’t match this upload.",
} satisfies Readonly<Record<Exclude<UploadSessionOutcome["kind"], "VerificationRejected" | "IntentMalformed" | "Superseded">, string | undefined>>;

export const UPLOAD_COMMAND_FACT: Readonly<Record<"RetryUpload" | "RemoveUpload", string>> = {
  RetryUpload: "couldn’t retry the upload.",
  RemoveUpload: "couldn’t remove this import.",
};

/** Imports' Retry upload, refused by its session, and whether choosing the file again can help:
 * the same session id gets a fresh upload, so all but lost access and rejected bytes can. The
 * file the import began with already passed type and size, so a refusal of either means another
 * file was chosen. Null when another attempt superseded it, which counts as done; a malformed
 * intent is a defect. */
export function retryUploadRefusal(error: UploadSessionError): { readonly line: Line; readonly retry: boolean } | null {
  const outcome = error.outcome;
  const fact = UPLOAD_COMMAND_FACT.RetryUpload;
  switch (outcome.kind) {
    case "IntentMalformed": throw error;
    case "Superseded": return null;
    case "VerificationRejected": return { line: { fact, reason: verificationReason(outcome) }, retry: false };
    case "LibraryForbidden": return { line: { fact, reason: OUTCOME_REASON.LibraryForbidden }, retry: false };
    case "UnsupportedFileType":
    case "FileTooLarge":
    case "FileMismatch": return { line: { fact, reason: OUTCOME_REASON.FileMismatch }, retry: true };
    case "BytesMissing":
    case "Expired":
    case "Unresolved": return { line: { fact, reason: OUTCOME_REASON[outcome.kind] }, retry: true };
    default: return assertNever(outcome, "Unreachable upload outcome");
  }
}

/** Attachments show no import-session row. A malformed upload intent is a defect. */
function outcomeReason(error: UploadSessionError): string | undefined {
  const outcome = error.outcome;
  switch (outcome.kind) {
    case "IntentMalformed": throw error;
    case "Superseded": return "this upload can’t continue.";
    case "VerificationRejected": return verificationReason(outcome);
    default: return OUTCOME_REASON[outcome.kind];
  }
}

/** The acquisition endpoints' domain codes, shared with intake lines. A conflict says only
 * that something changed; it does not attribute the refusal to a particular guard. */
export const CAPTURE_REFUSAL = {
  E_RESOURCE_CONFLICT: IMPORT_WORDS.changed,
  E_LIBRARY_FORBIDDEN: OUTCOME_REASON.LibraryForbidden,
  E_SOURCE_IMPORT_ACTIVE: "another import of this is running",
  E_X_IDENTITY_CONFLICT: "this post is in more than one imported thread.",
  E_X_SOURCE_CONFLICT: null,
  E_FILE_TOO_LARGE: OUTCOME_REASON.FileTooLarge,
  E_CAPTURE_TOO_LARGE: OUTCOME_REASON.FileTooLarge,
  E_INVALID_FILE_TYPE: OUTCOME_REASON.UnsupportedFileType,
  E_INVALID_REQUEST: "nexus can’t import from this address.",
  E_X_ARTICLE_POST_LINK_REQUIRED: "x articles import through their post’s link.",
  E_X_PROVIDER_UNAVAILABLE: "x imports aren’t available.",
  E_X_PROVIDER_CREDITS_DEPLETED: "x imports aren’t available.",
  E_X_PROVIDER_AUTH_REJECTED: "x imports aren’t available.",
  E_X_PROVIDER_RATE_LIMITED: "x is limiting imports.",
  E_X_PROVIDER_TIMEOUT: "x didn’t answer in time.",
  E_SOURCE_TARGET_AMBIGUOUS: "more than one import uses this address",
  E_MEDIA_DELETING: IMPORT_WORDS.deleting,
} as const;

/**
 * A failed attachment: its fact, with its domain code or upload outcome as
 * the reason, ahead of the transport. A malformed intent and same-system defects rethrow.
 */
export function captureErrorLine(error: unknown): Line {
  const fact = "couldn’t attach this file.";
  if (error instanceof UploadSessionError) return { fact, reason: outcomeReason(error) };
  const failure = modeled(error);
  if (Object.hasOwn(CAPTURE_REFUSAL, failure.code)) return { fact, reason: CAPTURE_REFUSAL[failure.code as keyof typeof CAPTURE_REFUSAL] ?? undefined };
  const transport = transportOf(failure);
  return TRANSPORT_LINES[transport].command(fact);
}

