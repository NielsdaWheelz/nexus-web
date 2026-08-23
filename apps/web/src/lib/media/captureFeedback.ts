import {
  type FeedbackContent,
  type FeedbackTone,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import {
  UploadSessionError,
  type UploadSessionOutcome,
} from "@/lib/media/ingestionClient";
import { uploadVerificationFailureCopy } from "@/lib/status/mediaActivity";
import { assertNever } from "@/lib/assertNever";

export type MediaCaptureOperation = "SaveSource" | "AddAttachment";

function mediaCaptureTitle(operation: MediaCaptureOperation): string {
  switch (operation) {
    case "SaveSource":
      return "Couldn’t save";
    case "AddAttachment":
      return "Attachment wasn’t added";
  }
}

/**
 * The capture surfaces attach one file at a time and own no session row, so
 * every upload-session outcome resolves to one message plus, where Import
 * Activity holds the obligation, a pointer to it.
 */
function uploadSessionCaptureMessage(
  outcome: Exclude<UploadSessionOutcome, { kind: "IntentMalformed" }>,
): string {
  switch (outcome.kind) {
    case "NeedsAttention":
      return "Open Import Activity for the available next step.";
    case "VerificationRejected":
      return uploadVerificationFailureCopy(outcome.code);
    case "BytesMissing":
      return "Nexus never received this file. Attach it again.";
    case "Superseded":
      return "This upload finished elsewhere. Open Import Activity to find it.";
    case "Unresolved":
      return "Nexus couldn’t confirm this upload. Open Import Activity before attaching it again.";
    case "UnsupportedFileType":
      return "This file type isn’t supported. Use a PDF or EPUB.";
    case "FileTooLarge":
      return "This file is too large. Attach a smaller file.";
    case "LibraryForbidden":
      return "You no longer have access to a destination library for this attachment.";
    case "IntentChanged":
    case "FileMismatch":
      return "This upload changed. Attach the file again.";
    default:
      return assertNever(outcome, "Unreachable upload session outcome");
  }
}

/** Finite product-copy adapter for the media-capture endpoint channel. */
export function mediaCaptureErrorMessage(
  error: unknown,
  operation: MediaCaptureOperation,
): FeedbackContent {
  const title = mediaCaptureTitle(operation);
  // The mapper owns tone: every capture failure it models is a hard failure.
  // Callers must not re-author this tone.
  const tone: FeedbackTone = "Danger";
  // A malformed intent means this client composed a request the endpoint
  // contract forbids; that stays a defect rather than becoming product copy.
  if (error instanceof UploadSessionError) {
    if (error.outcome.kind === "IntentMalformed") throw error;
    return {
      tone: error.outcome.kind === "NeedsAttention" ? "Warning" : tone,
      title:
        error.outcome.kind === "NeedsAttention"
          ? "Upload needs attention"
          : title,
      message: uploadSessionCaptureMessage(error.outcome),
    };
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name !== "AbortError")
  ) {
    return {
      tone,
      title,
      message: "Check your connection and retry.",
    };
  }
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone,
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM":
      return {
        tone,
        title,
        message: "The source service is unavailable. Retry in a moment.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone,
        title,
        message: "The source took too long to respond. Retry the capture.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone,
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_FILE_TOO_LARGE":
    case "E_CAPTURE_TOO_LARGE":
      return {
        tone,
        title,
        message: "This capture is too large. Save a smaller source.",
        requestId,
      };
    case "E_INVALID_FILE_TYPE":
      return {
        tone,
        title,
        message: "This file type isn’t supported. Use a PDF or EPUB.",
        requestId,
      };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      return {
        tone,
        title,
        message: "This link can’t be saved. Check it and retry.",
        requestId,
      };
    case "E_X_PROVIDER_UNAVAILABLE":
      return {
        tone,
        title,
        message: "X imports are temporarily unavailable. Retry in a moment.",
        requestId,
      };
    case "E_X_PROVIDER_CREDITS_DEPLETED":
    case "E_X_PROVIDER_AUTH_REJECTED":
      return {
        tone,
        title,
        message: "X imports are temporarily unavailable.",
        requestId,
      };
    case "E_X_PROVIDER_RATE_LIMITED":
      return {
        tone,
        title,
        message: "X is limiting imports. Wait a moment, then retry.",
        requestId,
      };
    case "E_X_PROVIDER_TIMEOUT":
      return {
        tone,
        title,
        message: "X took too long to respond. Retry the capture.",
        requestId,
      };
    default:
      throw error;
  }
}

export const SAVED_INGEST_FAILED_STATUS = "Saved, but ingestion failed";

export function mediaCaptureStatus(
  duplicate: boolean,
  sourceFailed = false,
): string {
  if (sourceFailed) {
    return SAVED_INGEST_FAILED_STATUS;
  }
  return duplicate ? "Already in your library" : "Saved";
}
