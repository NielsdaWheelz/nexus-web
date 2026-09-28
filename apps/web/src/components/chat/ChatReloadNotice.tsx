"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";

export default function ChatReloadNotice({
  requestId,
  message,
}: {
  requestId: string | undefined;
  message: string;
}) {
  return (
    <FeedbackNotice
      announcement="Assertive"
      content={{
        tone: "Warning",
        title: "Reload Nexus to continue",
        message,
        ...(requestId === undefined ? {} : { requestId }),
      }}
      actions={[
        {
          label: "Reload Nexus",
          onClick: () => window.location.reload(),
        },
      ]}
    />
  );
}
