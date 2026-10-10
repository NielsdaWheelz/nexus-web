"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ApiError } from "@/lib/api/client";

export default function MediaSummaryNotice({ error, retry }: {
  error: ApiError | null;
  retry: () => void;
}) {
  if (error === null) return null;
  return <FeedbackNotice
    announcement="Polite"
    content={{ tone: "Danger", title: "couldn’t update items", requestId: error.requestId }}
    actions={[{ label: "try again", onClick: retry }]}
  />;
}
