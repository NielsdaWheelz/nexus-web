import {
  type FeedbackContent,
  type FeedbackTone,
} from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";

export type MediaCaptureOperation =
  | "SaveSource"
  | "AddAttachment"
  | "ConfirmUpload";

function mediaCaptureTitle(operation: MediaCaptureOperation): string {
  switch (operation) {
    case "SaveSource":
      return "Couldn’t save";
    case "AddAttachment":
      return "Attachment wasn’t added";
    case "ConfirmUpload":
      return "Upload status couldn’t be confirmed";
  }
}

/** Finite product-copy adapter for the media-capture endpoint channel. */
export function mediaCaptureErrorMessage(
  error: unknown,
  operation: MediaCaptureOperation,
): FeedbackContent {
  const title = mediaCaptureTitle(operation);
  // The mapper owns tone. ConfirmUpload is only ever the accepted-but-uncertain
  // outcome (the file was taken; the confirmation result is unknown), so it is
  // a Warning; SaveSource/AddAttachment are hard failures, so they are Danger.
  // Callers must not re-author this tone.
  const tone: FeedbackTone =
    operation === "ConfirmUpload" ? "Warning" : "Danger";
  if ((error === null || error === undefined) && operation === "ConfirmUpload") {
    return {
      tone,
      title,
      message: "Nexus accepted the file. Check the item before uploading it again.",
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
