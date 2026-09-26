"use client";

import { FeedbackNotice } from "@/components/feedback/Feedback";
import {
  CHAT_CONTRACT_RELOAD_REQUIRED_CODE,
  TOOL_PROJECTION_RELOAD_REQUIRED_CODE,
  type ChatReloadRequired,
} from "@/lib/api/client";

export default function ChatReloadNotice({
  error,
}: {
  error: ChatReloadRequired;
}) {
  let message: string;
  switch (error.code) {
    case CHAT_CONTRACT_RELOAD_REQUIRED_CODE:
      message = "This tab is using an older chat contract. Your draft is saved.";
      break;
    case TOOL_PROJECTION_RELOAD_REQUIRED_CODE:
      message = "This tab is using an older tool contract. Your draft is saved.";
      break;
  }
  return (
    <FeedbackNotice
      announcement="Assertive"
      content={{
        tone: "Warning",
        title: "Reload Nexus to continue",
        message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
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
