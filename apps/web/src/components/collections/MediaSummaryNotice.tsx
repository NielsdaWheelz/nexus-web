"use client";

import { FeedbackFailure, useFeedbackOccurrence, type FeedbackAnnouncement } from "@/components/feedback/Feedback";
import type { ApiError } from "@/lib/api/client";

export default function MediaSummaryNotice({ error, retry, busy = false, announcement = "Polite", returnFocus }: {
  error: ApiError | null;
  retry: () => void;
  busy?: boolean;
  announcement?: FeedbackAnnouncement;
  returnFocus?: () => HTMLElement | null;
}) {
  const occurrence = useFeedbackOccurrence(error !== null);
  if (error === null) return null;
  return <FeedbackFailure scope="Local" occurrence={occurrence}
    announcement={announcement}
    content={{ tone: "Warning", title: "couldn’t update items", requestId: error.requestId }}
    actions={[{ label: "try again", busy, onClick: retry }]}
    returnFocus={returnFocus}
  />;
}
