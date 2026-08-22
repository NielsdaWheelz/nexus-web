import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type {
  MediaActivityMediaItem,
  MediaActivityUploadSessionItem,
  SourceProgress,
} from "@/lib/media/activityClient";
import { UploadSessionError } from "@/lib/media/ingestionClient";
import type { UploadVerificationCode } from "@/lib/media/uploadVerification";
import type { LibraryMediaKind } from "@/lib/libraries/mediaKind";
import { assertNever } from "@/lib/assertNever";

/** The exact queue evidence for a reclaimed attempt; never inferred. */
const WORKER_INTERRUPTED_CODE = "E_WORKER_INTERRUPTED";

export function mediaActivityKindLabel(kind: LibraryMediaKind): string {
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
  }
}

export function mediaActivityAttentionCopy(count: number): string {
  return count === 1
    ? "1 import needs attention"
    : `${count} imports need attention`;
}

export function mediaActivityAttentionLabel(count: number | null): string {
  return count === null || count === 0
    ? "Activity"
    : `Activity, ${mediaActivityAttentionCopy(count)}`;
}

export function mediaActivityProgressCopy(progress: SourceProgress): string {
  switch (progress.kind) {
    case "Stage":
      switch (progress.stage) {
        case "Validate":
          return "Validating source";
        case "Extract":
          return "Extracting source";
        case "Finalize":
          return "Finalizing reader";
        default:
          return assertNever(progress, "Unreachable progress stage");
      }
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

export function mediaActivityStatusCopy(item: MediaActivityMediaItem): string {
  switch (item.state.kind) {
    case "Active": {
      const { progress, stage, status, statusCode, waitingReason } = item.state;
      switch (status) {
        case "Queued":
          if (waitingReason.kind === "Absent") return "Waiting in queue";
          switch (waitingReason.value) {
            case "Queue":
              return "Waiting in queue";
            case "Capacity":
              return "Waiting for capacity";
            case "RetryBackoff":
              return "Waiting to retry";
            default:
              return assertNever(
                waitingReason.value,
                "Unreachable waiting reason",
              );
          }
        case "Processing":
          // A reclaimed attempt is running again but is recovering, not
          // progressing. The exact queue status code is the sole evidence.
          if (
            statusCode.kind === "Present" &&
            statusCode.value === WORKER_INTERRUPTED_CODE
          ) {
            return "Worker interrupted; recovering";
          }
          if (stage === "Index") return "Indexing for search";
          if (progress.kind === "Present") {
            return mediaActivityProgressCopy(progress.value);
          }
          switch (stage) {
            case "Validate":
              return "Validating source";
            case "Extract":
              return "Extracting source";
            case "Finalize":
              return "Finalizing reader";
            default:
              return assertNever(stage, "Unreachable processing stage");
          }
        default:
          return assertNever(status, "Unreachable active Activity status");
      }
    }
    case "NeedsAttention":
      return item.capabilities.canRepairSource || item.capabilities.canRepairSearch
        ? "Needs repair"
        : "Processing failed";
    default:
      return assertNever(item.state, "Unreachable Activity state");
  }
}

/**
 * The one safe-reason copy for a terminal upload verification rejection. Both
 * the Add sheet and Import Activity render this exact reason, so a session can
 * never be explained two different ways.
 */
export function uploadVerificationFailureCopy(
  code: UploadVerificationCode,
): string {
  switch (code) {
    case "E_FILE_TOO_LARGE":
      return "This file exceeds the import limit. Remove it and start a new import with a smaller file.";
    case "E_INVALID_FILE_TYPE":
      return "This file is not a valid PDF or EPUB. Remove it and start a new import.";
    case "E_SOURCE_INTEGRITY":
      return "Nexus could not verify the uploaded bytes. Remove this import and start a new one.";
    default:
      return assertNever(code, "Unreachable upload verification code");
  }
}

export function mediaActivityUploadAttentionCopy(
  item: MediaActivityUploadSessionItem,
): string {
  switch (item.attention.kind) {
    case "TransportFailed":
      return item.attention.failureKind === "HttpRejected"
        ? "The storage service rejected this upload. Choose the original file to retry."
        : "The upload did not finish. Choose the original file to retry.";
    case "CapabilityExpired":
      return "The upload link expired. Choose the original file to retry.";
    case "VerificationFailed":
      return uploadVerificationFailureCopy(item.attention.failureCode);
    default:
      return assertNever(item.attention, "Unreachable upload attention");
  }
}

/**
 * Finite copy adapter for the Import Activity upload-session actions. Every
 * outcome the upload-session channel declares gets one truthful next step; a
 * request this client composed wrongly stays a defect for the screen boundary.
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
        return "This import already finished. Activity has been refreshed.";
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

function ordinaryRequestErrorMessage(
  error: unknown,
  title: string,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and refresh.",
        requestId: error.requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "Nexus couldn’t complete the request. Wait a moment, then refresh.",
        requestId: error.requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Warning",
        title,
        message: "Wait a moment, then refresh.",
        requestId: error.requestId,
      };
    default:
      throw error;
  }
}

export function mediaActivityLoadErrorMessage(error: unknown): FeedbackContent {
  return ordinaryRequestErrorMessage(error, "Activity couldn’t be loaded");
}

export function mediaActivityRepairErrorMessage(
  error: unknown,
): FeedbackContent {
  if (isApiError(error) && error.code === "E_REPAIR_NOT_ALLOWED") {
    return {
      tone: "Warning",
      title: "Repair is no longer available",
      message: "Refresh Activity to see the current work.",
      requestId: error.requestId,
    };
  }
  return ordinaryRequestErrorMessage(error, "Repair couldn’t be started");
}
