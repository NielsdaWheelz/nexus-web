"use client";

import { FeedbackNotice, type FeedbackAnnouncement } from "@/components/feedback/Feedback";
import type { ApiError } from "@/lib/api/client";

export default function MediaSummaryNotice({ error, retry, busy = false, announcement = "Polite", returnFocus }: {
  error: ApiError | null;
  retry: () => void;
  busy?: boolean;
  announcement?: FeedbackAnnouncement;
  returnFocus?: () => HTMLElement | null;
}) {
  if (error === null) return null;
  return <FeedbackNotice
    announcement={announcement}
    content={{ tone: "Warning", title: "couldn’t update items", requestId: error.requestId }}
    actions={[{ label: "try again", busy, onClick: retry }]}
    returnFocus={returnFocus}
  />;
}
