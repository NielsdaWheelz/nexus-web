import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type {
  MediaActivityItem,
  SourceProgress,
} from "@/lib/media/activityClient";
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

export function mediaActivityStatusCopy(item: MediaActivityItem): string {
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
