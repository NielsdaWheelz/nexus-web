import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ConversationMessage } from "@/lib/conversations/types";
import UserMessage from "./UserMessage";
import SystemMessage from "./SystemMessage";

const timestamp = "2026-06-03T00:00:00Z";

function message(
  id: string,
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  return {
    id,
    seq: 1,
    role,
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "plain", text }],
    },
    parent_message_id: null,
    trust_trail: null,
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

// AC-3: deleting the assistant timestamp render site must not disturb the human
// rows — they still render their hover `.timestamp`, and (unlike the assistant)
// they never enter the machine register.
describe("chat human rows keep their hover timestamp (AC-3)", () => {
  it("user row renders the hover timestamp outside the machine register", () => {
    render(
      <UserMessage
        message={message("user-1", "user", "What is the capital of France?")}
        errorLabel=""
        timestampLabel="Jun 3"
        retrying={false}
      />,
    );

    const stamp = screen.getByText("Jun 3");
    expect(stamp).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: AC-3 contrast invariant — the human row must have no machine-origin ancestor
    expect(stamp.closest("[data-machine-origin]")).toBeNull();
  });

  it("system row renders the hover timestamp", () => {
    render(
      <SystemMessage
        message={message("system-1", "system", "Conversation renamed.")}
        errorLabel=""
        timestampLabel="Jun 4"
      />,
    );

    expect(screen.getByText("Jun 4")).toBeInTheDocument();
  });
});
