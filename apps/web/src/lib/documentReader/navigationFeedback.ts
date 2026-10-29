import type { FeedbackContent } from "@/components/feedback/Feedback";
import type { NavigationFailure } from "./navigator";

const NAVIGATION_TITLES: Record<NavigationFailure["operation"], string> = {
  Open: "couldn’t open that passage",
  Restore: "couldn’t restore your reading position",
  Return: "couldn’t return to your held place",
  Reflow: "couldn’t keep this passage in view",
  Continue: "couldn’t set your reading position here",
};

/** Copy follows the failed intention; capture has its own explanation except on adoption. */
export function navigationFailureContent(failure: NavigationFailure): FeedbackContent {
  return {
    tone: "Warning",
    title: failure.operation !== "Continue" && failure.reason === "CaptureUnavailable"
      ? "couldn’t hold your current place"
      : NAVIGATION_TITLES[failure.operation],
  };
}
