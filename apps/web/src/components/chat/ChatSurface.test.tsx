import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "@/lib/conversations/types";
import ChatSurface from "./ChatSurface";

const scrollMocks = vi.hoisted(() => ({
  scrollToMessage: vi.fn(),
}));

vi.mock("./useChatScroll", () => ({
  useChatScroll: () => ({
    spacerHeight: 0,
    isLatestBelowFold: false,
    scrollToLatest: vi.fn(),
    onComposerWheel: vi.fn(),
    onScroll: vi.fn(),
    beginUserScroll: vi.fn(),
    captureAnchor: vi.fn(),
    scrollToMessage: scrollMocks.scrollToMessage,
  }),
}));

const timestamp = "2026-07-20T00:00:00Z";

function message(id: string, seq: number, text: string): ConversationMessage {
  return {
    id,
    seq,
    role: "user",
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "plain", text }],
    },
    parent_message_id: null,
    trust_trail: null,
    status: "complete",
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("ChatSurface message activation", () => {
  afterEach(() => {
    scrollMocks.scrollToMessage.mockReset();
  });

  it("scrolls once when an exact target message is requested", async () => {
    const messages = [
      message("message-1", 1, "Earlier context"),
      message("message-2", 2, "Cited answer"),
    ];
    const { rerender } = render(
      <ChatSurface messages={messages} composer={null} />,
    );
    await screen.findByText("Cited answer");
    scrollMocks.scrollToMessage.mockClear();

    rerender(
      <ChatSurface
        messages={messages}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );

    await waitFor(() =>
      expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(1),
    );
    expect(scrollMocks.scrollToMessage).toHaveBeenLastCalledWith("message-2");
    rerender(
      <ChatSurface
        messages={messages}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );
    expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(1);

    rerender(<ChatSurface messages={messages} composer={null} />);
    rerender(
      <ChatSurface
        messages={messages}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );
    await waitFor(() =>
      expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(2),
    );

    rerender(
      <ChatSurface
        messages={[messages[0]]}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );
    expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(2);
    rerender(
      <ChatSurface
        messages={messages}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );
    await waitFor(() =>
      expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(3),
    );
  });

  it("waits for a changed target to exist before scrolling", async () => {
    const messages = [message("message-1", 1, "Earlier context")];
    const { rerender } = render(
      <ChatSurface
        messages={messages}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );

    await screen.findByText("Earlier context");
    expect(scrollMocks.scrollToMessage).not.toHaveBeenCalled();

    rerender(
      <ChatSurface
        messages={[...messages, message("message-2", 2, "Cited answer")]}
        composer={null}
        initialTargetMessageId="message-2"
      />,
    );
    await waitFor(() =>
      expect(scrollMocks.scrollToMessage).toHaveBeenCalledTimes(1),
    );
    expect(scrollMocks.scrollToMessage).toHaveBeenCalledWith("message-2");
  });
});
