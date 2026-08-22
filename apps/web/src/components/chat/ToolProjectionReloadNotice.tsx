"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";

export default function ToolProjectionReloadNotice({
  requestId,
}: {
  requestId: string | undefined;
}) {
  return (
    <FeedbackNotice
      announcement="Assertive"
      content={{
        tone: "Warning",
        title: "Reload Nexus to continue",
        message: "This tab is using an older tool contract. Your draft is saved.",
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
