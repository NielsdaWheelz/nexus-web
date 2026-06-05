import {
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";

export function toMediaCaptureFeedback(
  error: unknown,
  fallback = "Couldn’t save"
): FeedbackContent {
  return toFeedback(error, { fallback });
}

export const SAVED_INGEST_FAILED_STATUS = "Saved, but ingestion failed";

export function mediaCaptureStatus(duplicate: boolean, sourceFailed = false): string {
  if (sourceFailed) {
    return SAVED_INGEST_FAILED_STATUS;
  }
  return duplicate ? "Already in your library" : "Saved";
}
