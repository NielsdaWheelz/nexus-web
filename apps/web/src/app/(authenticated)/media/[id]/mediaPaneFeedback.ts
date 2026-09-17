import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { PaneSubresourceFailure } from "@/lib/panes/paneResourceLoaders";

export type MediaPaneOperation =
  | "Consumption"
  | "Citation"
  | "Highlight"
  | "DocumentMap"
  | "Load"
  | "Navigation"
  | "Chat"
  | "Learn";

function mediaPaneOperationTitle(operation: MediaPaneOperation): string {
  switch (operation) {
    case "Consumption":
      return "Reading state wasn’t changed";
    case "Citation":
      return "Citation couldn’t be opened";
    case "Highlight":
      return "Highlight wasn’t changed";
    case "DocumentMap":
      return "Document Map couldn’t be loaded";
    case "Load":
      return "Media couldn’t be loaded";
    case "Navigation":
      return "Section couldn’t be opened";
    case "Chat":
      return "Conversation couldn’t be started";
    case "Learn":
      return "Lesson couldn’t be created";
  }
}

/** Finite copy adapter for media-pane resources and user-started commands. */
export function mediaPaneErrorMessage(
  error: unknown,
  operation: MediaPaneOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const requestId = error.requestId;
  const title = mediaPaneOperationTitle(operation);
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server couldn’t complete the request. Retry in a moment.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
    case "E_CHAPTER_NOT_FOUND":
    case "E_HIGHLIGHT_NOT_FOUND":
    case "E_EVIDENCE_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available. Return to your library.",
        requestId,
      };
    case "E_MEDIA_NOT_READY":
      return {
        tone: "Warning",
        title,
        message:
          "This item is still preparing. Wait for it to settle, then retry.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t make that change.",
        requestId,
      };
    case "E_CONFLICT":
    case "E_HIGHLIGHT_CONFLICT":
    case "E_READER_PROGRESS_CONFLICT":
    case "E_IDEMPOTENCY_CONFLICT":
      return {
        tone: "Warning",
        title,
        message: "The item changed. Refresh the pane, then retry.",
        requestId,
      };
    case "E_READER_CONTENT_CHANGED":
      return {
        tone: "Warning",
        title: "Reader content changed. Reload this document.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title,
        message: "The saved item can’t be used for this action.",
        requestId,
      };
    case "E_PODCAST_QUOTA_EXCEEDED":
    case "E_BILLING_REQUIRED":
    case "E_BILLING_DISABLED":
      return {
        tone: "Danger",
        title,
        message: "This action isn’t available for the current account.",
        requestId,
      };
    default:
      throw error;
  }
}

export function transcriptSeedErrorMessage(
  failure: PaneSubresourceFailure,
): FeedbackContent {
  switch (failure.code) {
    case "E_MEDIA_NOT_READY":
      return {
        tone: "Warning",
        title: "Transcript content is still being processed",
      };
    case null:
    case "E_NETWORK":
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_RATE_LIMITED":
    case "E_MEDIA_NOT_FOUND":
    case "E_NOT_FOUND":
    case "E_FORBIDDEN":
      return {
        tone: "Warning",
        title: "Transcript content couldn’t be loaded",
      };
    default:
      // justify-defect: the fragment seed is decoded same-system state.
      throw new Error(
        `Unsupported initial transcript error code: ${failure.code}`,
      );
  }
}
