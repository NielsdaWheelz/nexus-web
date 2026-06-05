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

export function mediaCaptureStatus(duplicate: boolean): string {
  return duplicate ? "Already in your library" : "Saved";
}
