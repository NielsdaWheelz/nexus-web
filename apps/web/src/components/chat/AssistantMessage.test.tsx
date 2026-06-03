import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { ConversationMessage } from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";

function assistantMessage(text = "Alpha beta gamma"): ConversationMessage {
  return {
    id: "assistant-1",
    seq: 2,
    role: "assistant",
    status: "complete",
    error_code: null,
    can_retry_response: false,
    created_at: "2026-06-03T00:00:00Z",
    updated_at: "2026-06-03T00:00:00Z",
    message_document: {
      type: "message_document",
      version: 1,
      blocks: [{ type: "text", format: "plain", text }],
    },
  };
}

function selectText(root: HTMLElement, exact: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && !node.textContent?.includes(exact)) {
    node = walker.nextNode() as Text | null;
  }
  if (!node?.textContent) {
    throw new Error(`Missing text: ${exact}`);
  }

  const start = node.textContent.indexOf(exact);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + exact.length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("AssistantMessage", () => {
  it("captures assistant selection and branches from it", async () => {
    const user = userEvent.setup();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 80, 60, 20),
    );
    const onReplyToAssistant = vi.fn();

    render(
      <AssistantMessage
        message={assistantMessage()}
        forkOptions={[]}
        onReplyToAssistant={onReplyToAssistant}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.mouseUp(answer);

    await user.click(await screen.findByRole("button", { name: "Fork from selection" }));

    expect(onReplyToAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: "assistant-1",
        parentMessageSeq: 2,
        parentMessagePreview: "Alpha beta gamma",
        anchor: expect.objectContaining({
          kind: "assistant_selection",
          message_id: "assistant-1",
          exact: "beta",
          offset_status: "mapped",
          start_offset: 6,
          end_offset: 10,
          client_selection_id: expect.any(String),
        }),
      }),
    );
  });

  it("captures assistant selection from the keyboard path", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(120, 80, 60, 20),
    );
    render(
      <AssistantMessage
        message={assistantMessage()}
        forkOptions={[]}
        onReplyToAssistant={vi.fn()}
        errorLabel="The response failed."
        timestampLabel="Jun 3"
      />,
    );

    const answer = screen.getByText("Alpha beta gamma");
    selectText(answer, "beta");
    fireEvent.keyUp(answer);

    expect(
      await screen.findByRole("button", { name: "Fork from selection" }),
    ).toBeInTheDocument();
  });
});
